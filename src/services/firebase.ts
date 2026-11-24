import { initializeApp } from 'firebase/app';
import { getAnalytics, isSupported as isAnalyticsSupported } from 'firebase/analytics';
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  type User,
} from 'firebase/auth';
import {
  getDatabase,
  onValue,
  ref as dbRef,
  remove as removeRtdb,
  set as setRtdb,
  update as updateRtdb,
} from 'firebase/database';
import {
  collection,
  doc,
  getDocFromServer,
  getFirestore,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  deleteDoc,
  type Unsubscribe,
} from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';
import rtdbConfig from '../../firebase-rtdb-config.json';
import {
  LEAD_FIELD_LIMITS,
  normalizeLeadRecord,
  normalizeProductInterests,
  sanitizeLeadInput,
  type LeadFormInput,
  type LeadRecord,
  type LeadStatus,
} from '../utils/leadLogic';

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);

// Dedicated 24x7 Firebase Realtime Database instance (prestier-final)
const rtdbApp = initializeApp(rtdbConfig, 'prestier-rtdb');
export const rtdb = getDatabase(rtdbApp, rtdbConfig.databaseURL);

if (typeof window !== 'undefined') {
  void isAnalyticsSupported()
    .then((supported) => {
      if (supported) {
        getAnalytics(rtdbApp);
      }
    })
    .catch(() => {});
}

export const GOOGLE_SHEETS_SCOPES = ['https://www.googleapis.com/auth/spreadsheets'] as const;

const googleProvider = new GoogleAuthProvider();
for (const scope of GOOGLE_SHEETS_SCOPES) {
  googleProvider.addScope(scope);
}
googleProvider.setCustomParameters({ prompt: 'select_account' });

// In-memory OAuth access token cache (never stored in localStorage/sessionStorage)
let isSigningIn = false;
let cachedAccessToken: string | null = null;

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid ?? null,
      email: auth.currentUser?.email ?? null,
      emailVerified: auth.currentUser?.emailVerified ?? null,
      isAnonymous: auth.currentUser?.isAnonymous ?? null,
      tenantId: auth.currentUser?.tenantId ?? null,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// Startup connectivity test per Firebase Integration skill
async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}
void testConnection();

export function initGoogleAuth(
  onAuthSuccess?: (user: User, token: string) => void,
  onAuthFailure?: () => void
): Unsubscribe {
  return onAuthStateChanged(auth, (user) => {
    if (user) {
      if (cachedAccessToken) {
        onAuthSuccess?.(user, cachedAccessToken);
      } else if (!isSigningIn) {
        cachedAccessToken = null;
        onAuthFailure?.();
      }
    } else {
      cachedAccessToken = null;
      onAuthFailure?.();
    }
  });
}

export async function signInWithGoogleSheets(): Promise<{ user: User; accessToken: string }> {
  try {
    isSigningIn = true;
    const result = await signInWithPopup(auth, googleProvider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      throw new Error('Google Sheets access token was not returned by Google Sign-In.');
    }
    cachedAccessToken = credential.accessToken;
    return { user: result.user, accessToken: cachedAccessToken };
  } finally {
    isSigningIn = false;
  }
}

export function getGoogleAccessToken(): string | null {
  return cachedAccessToken;
}

export async function signOutGoogle(): Promise<void> {
  await auth.signOut();
  cachedAccessToken = null;
}

const createdFirestoreDrafts = new Set<string>();

export async function saveLeadToFirestore(params: {
  leadId: string;
  sessionToken: string;
  input: LeadFormInput;
  status: LeadStatus;
}): Promise<boolean> {
  const { leadId, sessionToken, input, status } = params;
  const sanitized = sanitizeLeadInput(input);
  const path = `leads/${leadId}`;
  const ref = doc(db, 'leads', leadId);

  try {
    if (!createdFirestoreDrafts.has(leadId)) {
      await setDoc(ref, {
        leadId: leadId.slice(0, LEAD_FIELD_LIMITS.leadId),
        sessionToken: sessionToken.slice(0, LEAD_FIELD_LIMITS.sessionToken),
        name: sanitized.name,
        designation: sanitized.designation,
        phone: sanitized.phone,
        companyName: sanitized.companyName,
        city: sanitized.city,
        emailAddress: sanitized.emailAddress,
        outletsCount: sanitized.outletsCount,
        productInterest: sanitized.productInterest,
        status,
        whatsappSent: false,
        sheetSynced: false,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      createdFirestoreDrafts.add(leadId);
    } else {
      await updateDoc(ref, {
        name: sanitized.name,
        designation: sanitized.designation,
        phone: sanitized.phone,
        companyName: sanitized.companyName,
        city: sanitized.city,
        emailAddress: sanitized.emailAddress,
        outletsCount: sanitized.outletsCount,
        productInterest: sanitized.productInterest,
        status,
        updatedAt: serverTimestamp(),
      });
    }
    return true;
  } catch (error) {
    // Log structured context without crashing public form if rules or offline state intervene
    console.warn('Firestore real-time lead sync deferred:', {
      path,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export function subscribeAdminFirestoreLeads(
  onUpdate: (leads: LeadRecord[]) => void,
  onError?: (err: Error) => void
): Unsubscribe {
  const path = 'leads';
  const q = query(collection(db, path));
  return onSnapshot(
    q,
    (snapshot) => {
      const records: LeadRecord[] = snapshot.docs.map((docSnap) => {
        const d = docSnap.data();
        const toIso = (val: any) =>
          val && typeof val.toDate === 'function'
            ? val.toDate().toISOString()
            : typeof val === 'string'
              ? val
              : new Date().toISOString();
        return {
          leadId: String(d.leadId || docSnap.id),
          name: String(d.name || ''),
          designation: String(d.designation || ''),
          phone: String(d.phone || ''),
          companyName: String(d.companyName || ''),
          city: String(d.city || ''),
          emailAddress: String(d.emailAddress || ''),
          outletsCount: String(d.outletsCount || ''),
          productInterest: normalizeProductInterests(d.productInterest),
          status: d.status === 'confirmed' ? 'confirmed' : 'partial',
          whatsappSent: Boolean(d.whatsappSent),
          sheetSynced: Boolean(d.sheetSynced),
          createdAt: toIso(d.createdAt),
          updatedAt: toIso(d.updatedAt),
        };
      });
      records.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
      onUpdate(records);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, path);
      } catch (wrapped) {
        onError?.(wrapped as Error);
      }
    }
  );
}

export async function markFirestoreLeadSynced(leadId: string): Promise<void> {
  const path = `leads/${leadId}`;
  try {
    await updateDoc(doc(db, 'leads', leadId), {
      sheetSynced: true,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function deleteFirestoreLead(leadId: string): Promise<void> {
  const path = `leads/${leadId}`;
  createdFirestoreDrafts.delete(leadId);
  try {
    await deleteDoc(doc(db, 'leads', leadId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

// --- 24x7 Google Firebase Realtime Database (prestier-final) Client Helpers ---
const createdRtdbDrafts = new Set<string>();

function toSafeRtdbLeadKey(leadId: string): string | null {
  const trimmed = leadId.trim().slice(0, LEAD_FIELD_LIMITS.leadId);
  return /^[a-zA-Z0-9_-]{4,128}$/.test(trimmed) ? trimmed : null;
}

export async function saveLeadToRealtimeDb(params: {
  leadId: string;
  input: LeadFormInput;
  status: LeadStatus;
}): Promise<boolean> {
  const safeKey = toSafeRtdbLeadKey(params.leadId);
  if (!safeKey) return false;

  const sanitized = sanitizeLeadInput(params.input);
  const phoneDigits = sanitized.phone.replace(/\D/g, '');
  const cleanedPhone = phoneDigits === '91' ? '' : sanitized.phone;
  const nowIso = new Date().toISOString();

  const updatePayload: Record<string, unknown> = {
    leadId: safeKey,
    name: sanitized.name,
    designation: sanitized.designation,
    phone: cleanedPhone,
    companyName: sanitized.companyName,
    city: sanitized.city,
    emailAddress: sanitized.emailAddress,
    outletsCount: sanitized.outletsCount,
    productInterest: sanitized.productInterest,
    status: params.status,
    updatedAt: nowIso,
  };

  if (!createdRtdbDrafts.has(safeKey)) {
    updatePayload.createdAt = nowIso;
    createdRtdbDrafts.add(safeKey);
  }

  try {
    await updateRtdb(dbRef(rtdb, `leads/${safeKey}`), updatePayload);
    return true;
  } catch (error) {
    console.warn('Realtime Database client sync deferred:', {
      leadId: safeKey,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export function subscribeAdminRealtimeDbLeads(
  onUpdate: (leads: LeadRecord[]) => void,
  onError?: (err: Error) => void
): Unsubscribe {
  const leadsRef = dbRef(rtdb, 'leads');
  return onValue(
    leadsRef,
    (snapshot) => {
      const val = snapshot.val();
      if (!val || typeof val !== 'object') {
        onUpdate([]);
        return;
      }
      const records: LeadRecord[] = [];
      for (const [key, rawItem] of Object.entries(val as Record<string, unknown>)) {
        if (rawItem && typeof rawItem === 'object') {
          const itemWithId = { leadId: key, ...(rawItem as Record<string, unknown>) };
          records.push(normalizeLeadRecord(itemWithId));
        }
      }
      records.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
      onUpdate(records);
    },
    (error) => {
      onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  );
}

export async function deleteRealtimeDbLead(leadId: string): Promise<void> {
  const safeKey = toSafeRtdbLeadKey(leadId);
  if (!safeKey) return;
  createdRtdbDrafts.delete(safeKey);
  try {
    await Promise.all([
      removeRtdb(dbRef(rtdb, `leads/${safeKey}`)),
      setRtdb(dbRef(rtdb, `deletedLeads/${safeKey}`), new Date().toISOString()),
    ]);
  } catch (error) {
    console.warn('Realtime Database delete warning:', {
      leadId: safeKey,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

