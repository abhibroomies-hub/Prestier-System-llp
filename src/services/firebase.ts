import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  type User,
} from 'firebase/auth';
import {
  collection,
  doc,
  getDocFromServer,
  getFirestore,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  deleteDoc,
  type Unsubscribe,
} from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';
import {
  LEAD_FIELD_LIMITS,
  sanitizeLeadInput,
  type LeadFormInput,
  type LeadRecord,
  type LeadStatus,
} from '../utils/leadLogic';

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);

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
        phone: sanitized.phone,
        companyName: sanitized.companyName,
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
        phone: sanitized.phone,
        companyName: sanitized.companyName,
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
          phone: String(d.phone || ''),
          companyName: String(d.companyName || ''),
          outletsCount: String(d.outletsCount || ''),
          productInterest: (d.productInterest || '') as LeadRecord['productInterest'],
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
  try {
    await deleteDoc(doc(db, 'leads', leadId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}
