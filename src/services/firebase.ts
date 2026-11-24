import { getApps, initializeApp } from 'firebase/app';
import {
  GoogleAuthProvider,
  getAuth,
  onAuthStateChanged,
  signInWithPopup,
  type User,
} from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  getFirestore,
  onSnapshot,
  orderBy,
  query,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import {
  get,
  getDatabase,
  onValue,
  ref,
  remove,
  set,
  type Database,
} from 'firebase/database';
import appletConfig from '../../firebase-applet-config.json';
import rtdbConfig from '../../firebase-rtdb-config.json';
import {
  hasAnyLeadContent,
  normalizeLeadRecord,
  sanitizeLeadInput,
  type LeadFormInput,
  type LeadRecord,
  type LeadStatus,
} from '../utils/leadLogic';

// Primary AI Studio Firebase App (Auth + Firestore)
const primaryAppName = 'prestier-primary-app';
const primaryApp =
  getApps().find((a) => a.name === primaryAppName) ||
  initializeApp(appletConfig, primaryAppName);

const auth = getAuth(primaryApp);
const firestore = getFirestore(primaryApp, appletConfig.firestoreDatabaseId);

// Secondary 24x7 Firebase Realtime Database App (prestier-final)
const rtdbAppName = 'prestier-rtdb-client';
let rtdbClient: Database | null = null;

function getRtdbClient(): Database | null {
  if (rtdbClient) return rtdbClient;
  if (!rtdbConfig.databaseURL) return null;
  try {
    const app =
      getApps().find((a) => a.name === rtdbAppName) ||
      initializeApp(rtdbConfig, rtdbAppName);
    rtdbClient = getDatabase(app, rtdbConfig.databaseURL);
    return rtdbClient;
  } catch {
    return null;
  }
}

function sanitizeRtdbKey(rawId: string): string {
  return String(rawId || '')
    .trim()
    .replace(/[.#$[\]/]/g, '_')
    .slice(0, 128);
}

// Keep Google Sheets OAuth token strictly in JS memory
let inMemoryGoogleAccessToken: string | null = null;

export function getGoogleAccessToken(): string | null {
  return inMemoryGoogleAccessToken;
}

export function initGoogleAuth(
  onSignedIn: (user: User) => void,
  onSignedOut: () => void
): () => void {
  return onAuthStateChanged(auth, (user) => {
    if (user) {
      onSignedIn(user);
    } else {
      inMemoryGoogleAccessToken = null;
      onSignedOut();
    }
  });
}

export async function signInWithGoogleSheets(): Promise<{
  user: User;
  accessToken: string;
}> {
  const provider = new GoogleAuthProvider();
  provider.addScope('https://www.googleapis.com/auth/spreadsheets');
  provider.addScope('https://www.googleapis.com/auth/drive.file');
  provider.setCustomParameters({ prompt: 'consent' });

  const result = await signInWithPopup(auth, provider);
  const credential = GoogleAuthProvider.credentialFromResult(result);
  const token = credential?.accessToken;
  if (!token) {
    throw new Error('Could not retrieve Google Sheets access token.');
  }
  inMemoryGoogleAccessToken = token;
  return {
    user: result.user,
    accessToken: token,
  };
}

// ============================================================================
// Firebase Realtime Database (prestier-final) Live Client Sync
// ============================================================================

export async function saveLeadToRealtimeDb(params: {
  leadId: string;
  input: LeadFormInput;
  status: LeadStatus;
  createdAt?: string;
}): Promise<void> {
  const db = getRtdbClient();
  if (!db) return;

  const safeKey = sanitizeRtdbKey(params.leadId);
  if (!safeKey) return;

  const sanitized = sanitizeLeadInput(params.input);
  const phoneDigits = sanitized.phone.replace(/\D/g, '');
  const cleanedPhone = phoneDigits === '91' ? '' : sanitized.phone;
  if (params.status === 'partial' && !hasAnyLeadContent({ ...sanitized, phone: cleanedPhone })) {
    return;
  }

  try {
    const delSnap = await get(ref(db, `deletedLeads/${safeKey}`));
    if (delSnap.exists()) return;

    const existingSnap = await get(ref(db, `leads/${safeKey}`));
    const existing = existingSnap.exists()
      ? normalizeLeadRecord(existingSnap.val())
      : null;

    const nowIso = new Date().toISOString();
    const record: LeadRecord = {
      leadId: params.leadId,
      name: sanitized.name,
      designation: sanitized.designation,
      phone: cleanedPhone,
      companyName: sanitized.companyName,
      city: sanitized.city,
      emailAddress: sanitized.emailAddress,
      outletsCount: sanitized.outletsCount,
      productInterest: sanitized.productInterest,
      status: params.status,
      whatsappSent: existing?.whatsappSent || false,
      sheetSynced: false,
      sheetRowNumber: existing?.sheetRowNumber ?? null,
      createdAt: params.createdAt || existing?.createdAt || nowIso,
      updatedAt: nowIso,
    };

    await set(ref(db, `leads/${safeKey}`), record);
  } catch {
    // Server-side /api/leads/upsert also persists to RTDB
  }
}

export async function deleteRealtimeDbLead(leadId: string): Promise<void> {
  const db = getRtdbClient();
  if (!db) return;
  const safeKey = sanitizeRtdbKey(leadId);
  if (!safeKey) return;

  try {
    await Promise.all([
      remove(ref(db, `leads/${safeKey}`)),
      set(ref(db, `deletedLeads/${safeKey}`), {
        leadId,
        deletedAt: new Date().toISOString(),
      }),
    ]);
  } catch {
    // Server-side DELETE /api/leads/:leadId also syncs deletion
  }
}

export function subscribeAdminRealtimeDbLeads(
  onLeads: (leads: LeadRecord[]) => void,
  onError?: (err: Error) => void
): () => void {
  const db = getRtdbClient();
  if (!db) return () => {};

  const leadsRef = ref(db, 'leads');
  const unsub = onValue(
    leadsRef,
    (snapshot) => {
      const val = snapshot.val();
      if (!val || typeof val !== 'object') {
        onLeads([]);
        return;
      }
      const list = Object.values(val as Record<string, unknown>).map((item) =>
        normalizeLeadRecord(item)
      );
      onLeads(list);
    },
    (err) => {
      onError?.(err);
    }
  );
  return () => unsub();
}

// ============================================================================
// Firestore Secondary Backup Sync
// ============================================================================

export async function saveLeadToFirestore(params: {
  leadId: string;
  sessionToken: string;
  input: LeadFormInput;
  status: LeadStatus;
}): Promise<void> {
  const sanitized = sanitizeLeadInput(params.input);
  const phoneDigits = sanitized.phone.replace(/\D/g, '');
  const cleanedPhone = phoneDigits === '91' ? '' : sanitized.phone;
  if (params.status === 'partial' && !hasAnyLeadContent({ ...sanitized, phone: cleanedPhone })) {
    return;
  }

  try {
    const nowIso = new Date().toISOString();
    const leadRef = doc(firestore, 'leads', params.leadId);
    await setDoc(
      leadRef,
      {
        leadId: params.leadId,
        sessionToken: params.sessionToken,
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
      },
      { merge: true }
    );
  } catch {
    // Firestore is optional secondary storage alongside RTDB + server store
  }
}

export async function markFirestoreLeadSynced(leadId: string): Promise<void> {
  try {
    const leadRef = doc(firestore, 'leads', leadId);
    await updateDoc(leadRef, {
      sheetSynced: true,
      updatedAt: new Date().toISOString(),
    });
  } catch {
    // ignore if doc doesn't exist in Firestore
  }
}

export async function deleteFirestoreLead(leadId: string): Promise<void> {
  try {
    const leadRef = doc(firestore, 'leads', leadId);
    await deleteDoc(leadRef);
  } catch {
    // ignore if unauthenticated with Google OAuth
  }
}

export function subscribeAdminFirestoreLeads(
  onLeads: (leads: LeadRecord[]) => void,
  onError?: (err: Error) => void
): () => void {
  try {
    const q = query(collection(firestore, 'leads'), orderBy('updatedAt', 'desc'));
    return onSnapshot(
      q,
      (snap) => {
        const list: LeadRecord[] = [];
        snap.forEach((docSnap) => {
          list.push(normalizeLeadRecord(docSnap.data()));
        });
        onLeads(list);
      },
      (err) => {
        onError?.(err);
      }
    );
  } catch {
    return () => {};
  }
}
