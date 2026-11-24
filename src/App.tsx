// Main Prestier System LLP Lead Capture & Admin Portal application
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  FileSpreadsheet,
  Loader2,
  Lock,
  MessageCircle,
  X,
} from 'lucide-react';
import {
  buildWhatsAppConfirmationMessage,
  buildWhatsAppDirectUrl,
  generateLeadId,
  generateSessionToken,
  hasAnyLeadContent,
  normalizeLeadRecord,
  sanitizeLeadInput,
  validateLeadForSubmit,
  type LeadFormInput,
  type LeadRecord,
  type LeadStatus,
} from './utils/leadLogic';
import {
  deleteFirestoreLead,
  deleteRealtimeDbLead,
  getGoogleAccessToken,
  initGoogleAuth,
  markFirestoreLeadSynced,
  saveLeadToFirestore,
  saveLeadToRealtimeDb,
  signInWithGoogleSheets,
  subscribeAdminFirestoreLeads,
  subscribeAdminRealtimeDbLeads,
} from './services/firebase';
import {
  createPrestierSpreadsheet,
  deleteLeadFromGoogleSheet,
  inspectSpreadsheet,
  syncAllLeadsToGoogleSheet,
  upsertLeadInGoogleSheet,
  type ConnectedSpreadsheet,
} from './services/googleSheets';
import { LeadCaptureForm } from './components/LeadCaptureForm';
import {
  LiveGoogleSheetTable,
  type RtdbAdminStatus,
} from './components/LiveGoogleSheetTable';
import { HiddenWhatsAppSidebar } from './components/HiddenWhatsAppSidebar';
import { GoogleSheetAppsScriptPanel } from './components/GoogleSheetAppsScriptPanel';

const FACTORY_BG_SRC =
  '/src/assets/images/stainless_steel_equipment_factory_1795544754673.jpg';

const INITIAL_FORM: LeadFormInput = {
  name: '',
  designation: '',
  phone: '+91 ',
  companyName: '',
  city: '',
  emailAddress: '',
  outletsCount: '',
  productInterest: [],
};

export default function App() {
  const [form, setForm] = useState<LeadFormInput>(INITIAL_FORM);
  const [errors, setErrors] = useState<Partial<Record<keyof LeadFormInput, string>>>({});
  const [activeLeadId, setActiveLeadId] = useState<string>(() => generateLeadId());
  const [sessionToken, setSessionToken] = useState<string>(() => generateSessionToken());
  const [bgFailed, setBgFailed] = useState(false);

  const [syncState, setSyncState] = useState<'idle' | 'saving' | 'saved_partial' | 'confirmed'>(
    'idle'
  );
  const [lastSavedTime, setLastSavedTime] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submittedLeadId, setSubmittedLeadId] = useState<string | null>(null);
  const [whatsappSentAuto, setWhatsappSentAuto] = useState(false);
  const [whatsappDirectUrl, setWhatsappDirectUrl] = useState<string | null>(null);

  const [leads, setLeads] = useState<LeadRecord[]>([]);
  const [rtdbStatus, setRtdbStatus] = useState<RtdbAdminStatus | null>(null);
  const [isRefreshingLeads, setIsRefreshingLeads] = useState(false);
  const [isSyncingRtdb, setIsSyncingRtdb] = useState(false);
  const [resendingLeadId, setResendingLeadId] = useState(null as string | null);

  // Google Sheets OAuth State
  const [googleUserEmail, setGoogleUserEmail] = useState<string | null>(null);
  const [connectedSheet, setConnectedSheet] = useState<ConnectedSpreadsheet | null>(null);
  const [isSigningInGoogle, setIsSigningInGoogle] = useState(false);
  const [isSyncingSheet, setIsSyncingSheet] = useState(false);
  const [sheetError, setSheetError] = useState<string | null>(null);
  const [sheetSuccessMsg, setSheetSuccessMsg] = useState<string | null>(null);

  // Admin Workspace & Password Gate State (in-memory session only, never persisted to localStorage)
  const [adminToken, setAdminToken] = useState<string | null>(null);
  const [isAdminModalOpen, setIsAdminModalOpen] = useState(false);
  const [adminTab, setAdminTab] = useState<'leads' | 'sheets' | 'whatsapp'>('leads');
  const [isPasscodeConfigured, setIsPasscodeConfigured] = useState<boolean | null>(null);
  const [isCheckingAuthStatus, setIsCheckingAuthStatus] = useState(false);
  const [adminPasscodeInput, setAdminPasscodeInput] = useState('');
  const [isUnlockingAdmin, setIsUnlockingAdmin] = useState(false);
  const [adminAuthError, setAdminAuthError] = useState<string | null>(null);

  useEffect(() => {
    try {
      localStorage.removeItem('prestier_admin_token');
    } catch {
      // ignore storage restriction
    }
  }, []);

  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectedSheetRef = useRef<ConnectedSpreadsheet | null>(null);
  connectedSheetRef.current = connectedSheet;
  const deletedLeadIdsRef = useRef<Set<string>>(
    new Set(['lead_seed_101', 'lead_seed_102', 'lead_seed_103', 'lead_seed_104'])
  );

  const registerDeletedIds = useCallback((ids: unknown) => {
    if (!Array.isArray(ids)) return;
    for (const raw of ids) {
      if (typeof raw === 'string' && raw.trim()) {
        deletedLeadIdsRef.current.add(raw.trim());
      }
    }
  }, []);

  const applyServerSnapshot = useCallback(
    (incomingLeads: unknown, deletedIds?: unknown, incomingRtdb?: unknown) => {
      registerDeletedIds(deletedIds);
      if (incomingRtdb && typeof incomingRtdb === 'object') {
        setRtdbStatus(incomingRtdb as RtdbAdminStatus);
      }
      if (Array.isArray(incomingLeads)) {
        const cleaned = incomingLeads
          .map((item) => normalizeLeadRecord(item))
          .filter((item) => !deletedLeadIdsRef.current.has(item.leadId))
          .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
        setLeads(cleaned);
      }
    },
    [registerDeletedIds]
  );

  const mergeIncomingLeads = useCallback((incomingList: LeadRecord[]) => {
    setLeads((prev) => {
      const map = new Map<string, LeadRecord>();
      for (const item of prev) {
        const norm = normalizeLeadRecord(item);
        if (!deletedLeadIdsRef.current.has(norm.leadId)) {
          map.set(norm.leadId, norm);
        }
      }
      for (const item of incomingList) {
        const norm = normalizeLeadRecord(item);
        if (deletedLeadIdsRef.current.has(norm.leadId)) continue;
        const existing = map.get(norm.leadId);
        if (!existing) {
          map.set(norm.leadId, norm);
        } else if (new Date(norm.updatedAt).getTime() >= new Date(existing.updatedAt).getTime()) {
          map.set(norm.leadId, {
            ...norm,
            whatsappSent: existing.whatsappSent || norm.whatsappSent,
          });
        } else if (norm.whatsappSent && !existing.whatsappSent) {
          map.set(norm.leadId, {
            ...existing,
            whatsappSent: true,
          });
        }
      }
      return Array.from(map.values()).sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      );
    });
  }, []);

  const fetchInitialLeads = useCallback(
    async (tokenOverride?: string | null) => {
      const tokenToUse = tokenOverride !== undefined ? tokenOverride : adminToken;
      if (!tokenToUse) return;

      setIsRefreshingLeads(true);
      try {
        const res = await fetch(`/api/leads?t=${Date.now()}`, {
          cache: 'no-store',
          headers: {
            Authorization: `Bearer ${tokenToUse}`,
          },
        });
        if (res.status === 401) {
          setAdminToken(null);
          return;
        }
        if (res.ok) {
          const data = await res.json();
          applyServerSnapshot(data.leads, data.deletedIds, data.rtdb);
        }
      } catch {
        // ignore transient network error
      } finally {
        setIsRefreshingLeads(false);
      }
    },
    [adminToken, applyServerSnapshot]
  );

  // Attach 24x7 Firebase Realtime Database live stream ONLY when Admin is unlocked
  useEffect(() => {
    if (!isAdminModalOpen || !adminToken) return;
    let unsubscribeRtdb: (() => void) | undefined;
    try {
      unsubscribeRtdb = subscribeAdminRealtimeDbLeads(
        (rtdbLeads) => {
          if (rtdbLeads && rtdbLeads.length > 0) {
            mergeIncomingLeads(rtdbLeads);
          }
        },
        () => {}
      );
    } catch {
      // ignore
    }
    return () => {
      unsubscribeRtdb?.();
    };
  }, [isAdminModalOpen, adminToken, mergeIncomingLeads]);

  // Attach Firestore real-time listener ONLY when Admin is unlocked & authenticated with Google
  useEffect(() => {
    if (!googleUserEmail || !adminToken) return;
    let unsubscribeFirestore: (() => void) | undefined;
    try {
      unsubscribeFirestore = subscribeAdminFirestoreLeads(
        (firestoreLeads) => {
          if (firestoreLeads && firestoreLeads.length > 0) {
            mergeIncomingLeads(firestoreLeads);
          }
        },
        () => {}
      );
    } catch {
      // ignore
    }
    return () => {
      unsubscribeFirestore?.();
    };
  }, [googleUserEmail, adminToken, mergeIncomingLeads]);

  // Instant <10ms Server-Sent Events (SSE) stream + fallback sync while Admin Modal is unlocked
  useEffect(() => {
    if (!isAdminModalOpen || !adminToken) return;

    let cancelled = false;
    let abortController: AbortController | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connectLiveStream = async () => {
      if (cancelled) return;
      abortController = new AbortController();
      try {
        const res = await fetch('/api/leads/stream', {
          method: 'GET',
          cache: 'no-store',
          headers: {
            Authorization: `Bearer ${adminToken}`,
            Accept: 'text/event-stream',
          },
          signal: abortController.signal,
        });

        if (res.status === 401) {
          setAdminToken(null);
          return;
        }

        if (!res.ok || !res.body) {
          throw new Error('SSE stream unavailable');
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (!cancelled) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let boundaryIdx = buffer.indexOf('\n\n');
          while (boundaryIdx !== -1) {
            const rawEvent = buffer.slice(0, boundaryIdx);
            buffer = buffer.slice(boundaryIdx + 2);

            for (const line of rawEvent.split('\n')) {
              if (line.startsWith('data:')) {
                const jsonStr = line.slice(5).trim();
                if (jsonStr) {
                  try {
                    const parsed = JSON.parse(jsonStr);
                    if (parsed && parsed.type === 'snapshot') {
                      applyServerSnapshot(parsed.leads, parsed.deletedIds, parsed.rtdb);
                    }
                  } catch {
                    // ignore malformed SSE frame
                  }
                }
              }
            }

            boundaryIdx = buffer.indexOf('\n\n');
          }
        }
      } catch {
        // Reconnect below unless cancelled
      }

      if (!cancelled) {
        reconnectTimer = setTimeout(() => {
          void connectLiveStream();
        }, 1500);
      }
    };

    void connectLiveStream();

    const fallbackPollTimer = setInterval(() => {
      void fetchInitialLeads(adminToken);
    }, 15000);

    return () => {
      cancelled = true;
      abortController?.abort();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      clearInterval(fallbackPollTimer);
    };
  }, [isAdminModalOpen, adminToken, applyServerSnapshot, fetchInitialLeads]);

  // Initialize Firebase Google Auth Listener
  useEffect(() => {
    const unsub = initGoogleAuth(
      (user) => {
        const email = user.email || user.displayName || 'Connected User';
        setGoogleUserEmail(email);
      },
      () => {
        setGoogleUserEmail(null);
      }
    );
    return () => unsub();
  }, []);

  const handleOpenAdminModal = async () => {
    setAdminTab('leads');
    setAdminPasscodeInput('');
    setAdminAuthError(null);
    setIsAdminModalOpen(true);

    setIsCheckingAuthStatus(true);
    try {
      const res = await fetch('/api/admin/auth-status', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setIsPasscodeConfigured(Boolean(data.isConfigured));
      } else {
        setIsPasscodeConfigured(true);
      }
    } catch {
      setIsPasscodeConfigured(true);
    } finally {
      setIsCheckingAuthStatus(false);
    }
  };

  const handleCloseAdminModal = () => {
    const currentToken = adminToken;
    setIsAdminModalOpen(false);
    setAdminToken(null);
    setAdminPasscodeInput('');
    setAdminAuthError(null);
    setLeads([]);

    if (currentToken) {
      void fetch('/api/admin/logout', {
        method: 'POST',
        headers: { Authorization: `Bearer ${currentToken}` },
      }).catch(() => {});
    }
  };

  const handleAdminAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = adminPasscodeInput.trim();
    if (!trimmed) {
      setAdminAuthError('Please enter the admin password.');
      return;
    }

    setIsUnlockingAdmin(true);
    setAdminAuthError(null);
    try {
      const endpoint = isPasscodeConfigured === false ? '/api/admin/setup' : '/api/admin/login';
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: trimmed }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok || !data.token) {
        if (res.status === 409) {
          setIsPasscodeConfigured(endpoint === '/api/admin/setup');
        }
        setAdminAuthError(data.error || 'Incorrect password. Please try again.');
        return;
      }

      setIsPasscodeConfigured(true);
      setAdminPasscodeInput('');
      applyServerSnapshot(data.leads, data.deletedIds, data.rtdb);
      setAdminToken(data.token);
    } catch {
      setAdminAuthError('Unable to verify password right now. Please try again.');
    } finally {
      setIsUnlockingAdmin(false);
    }
  };

  const pushLeadToConnectedGoogleSheet = useCallback(async (lead: LeadRecord) => {
    const token = getGoogleAccessToken();
    const sheet = connectedSheetRef.current;
    if (!token || !sheet) return;
    try {
      await upsertLeadInGoogleSheet(token, sheet, lead);
      void markFirestoreLeadSynced(lead.leadId).catch(() => {});
    } catch (err: any) {
      console.warn('Live Google Sheet row sync warning:', err?.message);
    }
  }, []);

  const persistLeadRealTime = useCallback(
    async (
      currentLeadId: string,
      currentSessionToken: string,
      input: LeadFormInput,
      status: 'partial' | 'confirmed'
    ) => {
      if (deletedLeadIdsRef.current.has(currentLeadId)) return null;
      const sanitized = sanitizeLeadInput(input);
      if (status === 'partial' && !hasAnyLeadContent(sanitized)) return null;

      setSyncState('saving');

      const apiPromise = fetch('/api/leads/upsert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          leadId: currentLeadId,
          ...sanitized,
          status,
        }),
      }).then(async (res) => (res.ok ? res.json() : null));

      void saveLeadToRealtimeDb({
        leadId: currentLeadId,
        input: sanitized,
        status,
      });

      void saveLeadToFirestore({
        leadId: currentLeadId,
        sessionToken: currentSessionToken,
        input: sanitized,
        status,
      });

      const apiResult = await apiPromise;

      const nowFormatted = new Date().toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
      setLastSavedTime(nowFormatted);
      setSyncState(status === 'confirmed' ? 'confirmed' : 'saved_partial');

      if (apiResult?.lead && !deletedLeadIdsRef.current.has(currentLeadId)) {
        const savedRecord = normalizeLeadRecord(apiResult.lead);
        mergeIncomingLeads([savedRecord]);
        void pushLeadToConnectedGoogleSheet(savedRecord);
      }

      return apiResult;
    },
    [mergeIncomingLeads, pushLeadToConnectedGoogleSheet]
  );

  const handleFieldChange = <K extends keyof LeadFormInput>(
    field: K,
    value: LeadFormInput[K]
  ) => {
    const effectiveLeadId = deletedLeadIdsRef.current.has(activeLeadId)
      ? generateLeadId()
      : activeLeadId;
    if (effectiveLeadId !== activeLeadId) {
      setActiveLeadId(effectiveLeadId);
    }

    const updatedForm: LeadFormInput = {
      ...form,
      [field]: value,
    };
    setForm(updatedForm);

    if (errors[field]) {
      setErrors((prev) => ({ ...prev, [field]: undefined }));
    }

    const targetStatus = syncState === 'confirmed' ? 'confirmed' : 'partial';

    const sanitized = sanitizeLeadInput(updatedForm);
    if (hasAnyLeadContent(sanitized)) {
      const nowIso = new Date().toISOString();
      setLeads((prev) => {
        const idx = prev.findIndex((item) => item.leadId === effectiveLeadId);
        const optimisticRecord: LeadRecord = {
          leadId: effectiveLeadId,
          name: sanitized.name,
          designation: sanitized.designation,
          phone: sanitized.phone,
          companyName: sanitized.companyName,
          city: sanitized.city,
          emailAddress: sanitized.emailAddress,
          outletsCount: sanitized.outletsCount,
          productInterest: sanitized.productInterest,
          status: targetStatus,
          whatsappSent: idx >= 0 ? prev[idx].whatsappSent : false,
          sheetSynced: idx >= 0 ? prev[idx].sheetSynced : Boolean(connectedSheetRef.current),
          createdAt: idx >= 0 ? prev[idx].createdAt : nowIso,
          updatedAt: nowIso,
        };
        if (idx >= 0) {
          const copy = [...prev];
          copy[idx] = optimisticRecord;
          return copy;
        }
        return [optimisticRecord, ...prev];
      });
    }

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    debounceTimerRef.current = setTimeout(() => {
      void persistLeadRealTime(effectiveLeadId, sessionToken, updatedForm, targetStatus);
    }, 120);
  };

  useEffect(() => {
    const handlePageHide = () => {
      if (deletedLeadIdsRef.current.has(activeLeadId)) return;
      const sanitized = sanitizeLeadInput(form);
      if (!hasAnyLeadContent(sanitized)) return;
      const payload = JSON.stringify({
        leadId: activeLeadId,
        ...sanitized,
        status: syncState === 'confirmed' ? 'confirmed' : 'partial',
      });
      if (navigator.sendBeacon) {
        const blob = new Blob([payload], { type: 'application/json' });
        navigator.sendBeacon('/api/leads/upsert', blob);
      }
    };
    window.addEventListener('pagehide', handlePageHide);
    return () => window.removeEventListener('pagehide', handlePageHide);
  }, [form, activeLeadId, syncState]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }

    const sanitized = sanitizeLeadInput(form);
    const validation = validateLeadForSubmit(sanitized);
    if (!validation.valid) {
      setErrors(validation.errors);
      if (hasAnyLeadContent(sanitized)) {
        void persistLeadRealTime(activeLeadId, sessionToken, sanitized, 'partial');
      }
      return;
    }

    setErrors({});
    setIsSubmitting(true);
    try {
      const result = await persistLeadRealTime(
        activeLeadId,
        sessionToken,
        sanitized,
        'confirmed'
      );
      setSubmittedLeadId(activeLeadId);
      setWhatsappSentAuto(Boolean(result?.whatsappQueuedInBackground));
      const waMsg = buildWhatsAppConfirmationMessage(sanitized);
      setWhatsappDirectUrl(buildWhatsAppDirectUrl(sanitized.phone, waMsg));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleStartNewLead = useCallback(() => {
    setForm(INITIAL_FORM);
    setErrors({});
    setActiveLeadId(generateLeadId());
    setSessionToken(generateSessionToken());
    setSyncState('idle');
    setSubmittedLeadId(null);
    setWhatsappSentAuto(false);
    setWhatsappDirectUrl(null);
  }, []);

  const handleGoogleSignIn = async () => {
    setIsSigningInGoogle(true);
    setSheetError(null);
    setSheetSuccessMsg(null);
    try {
      const { user, accessToken } = await signInWithGoogleSheets();
      const email = user.email || user.displayName || 'Connected User';
      setGoogleUserEmail(email);

      setIsSyncingSheet(true);
      const created = await createPrestierSpreadsheet(accessToken);
      setConnectedSheet(created);
      await syncAllLeadsToGoogleSheet(accessToken, created, leads);
      setSheetSuccessMsg(
        `Created & synced "${created.title}" (${leads.length} rows).`
      );
    } catch (err: any) {
      setSheetError(err?.message || 'Google Sign-In failed. Please try again.');
    } finally {
      setIsSigningInGoogle(false);
      setIsSyncingSheet(false);
    }
  };

  const handleCreateNewGoogleSheet = async () => {
    const token = getGoogleAccessToken();
    if (!token) {
      await handleGoogleSignIn();
      return;
    }
    setIsSyncingSheet(true);
    setSheetError(null);
    setSheetSuccessMsg(null);
    try {
      const created = await createPrestierSpreadsheet(token);
      setConnectedSheet(created);
      await syncAllLeadsToGoogleSheet(token, created, leads);
      setSheetSuccessMsg(`Live Google Sheet "${created.title}" created & synced.`);
    } catch (err: any) {
      setSheetError(err?.message || 'Could not create Google Sheet.');
    } finally {
      setIsSyncingSheet(false);
    }
  };

  const handleConnectExistingSheet = async (idOrUrl: string) => {
    const token = getGoogleAccessToken();
    if (!token) {
      setSheetError('Please Connect Google Sheets first.');
      return;
    }
    setIsSyncingSheet(true);
    setSheetError(null);
    setSheetSuccessMsg(null);
    try {
      const inspected = await inspectSpreadsheet(token, idOrUrl);
      setConnectedSheet(inspected);
      await syncAllLeadsToGoogleSheet(token, inspected, leads);
      setSheetSuccessMsg(`Connected to "${inspected.title}" (${inspected.sheetName}) & synced.`);
    } catch (err: any) {
      setSheetError(err?.message || 'Unable to connect to that Google Sheet.');
    } finally {
      setIsSyncingSheet(false);
    }
  };

  const handleSyncAllToSheet = async () => {
    const token = getGoogleAccessToken();
    if (!token || !connectedSheet) return;
    setIsSyncingSheet(true);
    setSheetError(null);
    setSheetSuccessMsg(null);
    try {
      const count = await syncAllLeadsToGoogleSheet(token, connectedSheet, leads);
      setSheetSuccessMsg(`Synced all ${count} rows to Google Sheet (${connectedSheet.sheetName}).`);
      await fetch('/api/leads/mark-synced', {
        method: 'POST',
        headers: {
          ...(adminToken ? { Authorization: `Bearer ${adminToken}` } : {}),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ leadIds: leads.map((l) => l.leadId) }),
      });
    } catch (err: any) {
      setSheetError(err?.message || 'Failed to sync rows to Google Sheet.');
    } finally {
      setIsSyncingSheet(false);
    }
  };

  const handleResendWhatsApp = async (lead: LeadRecord) => {
    setResendingLeadId(lead.leadId);
    setSheetError(null);
    setSheetSuccessMsg(null);
    try {
      const res = await fetch(
        `/api/leads/${encodeURIComponent(lead.leadId)}/resend-whatsapp`,
        {
          method: 'POST',
          headers: adminToken ? { Authorization: `Bearer ${adminToken}` } : {},
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSheetError(
          data.error ||
            'Could not send WhatsApp message. Check WhatsApp tab to ensure QR is linked.'
        );
      } else {
        setSheetSuccessMsg(
          `Queued Prestair WhatsApp reply + showcase image in background for ${lead.name || lead.phone}.`
        );
      }
    } catch {
      setSheetError('Network error while triggering WhatsApp message.');
    } finally {
      setResendingLeadId(null);
    }
  };

  const handleSyncRtdbNow = async () => {
    if (!adminToken) return;
    setIsSyncingRtdb(true);
    setSheetError(null);
    setSheetSuccessMsg(null);
    try {
      const res = await fetch('/api/rtdb/sync-all', {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      const data = await res.json().catch(() => ({}));
      if (data.rtdb) {
        setRtdbStatus(data.rtdb as RtdbAdminStatus);
      }
      if (!res.ok) {
        setSheetError(
          data.error ||
            'Firebase Realtime Database write denied. Paste the RTDB Rules into Firebase Console and click Publish.'
        );
      } else {
        setSheetSuccessMsg(
          `Verified & synced ${data.count ?? leads.length} leads to Google Realtime Database (prestier-final).`
        );
      }
    } catch {
      setSheetError('Network error while verifying Firebase Realtime Database.');
    } finally {
      setIsSyncingRtdb(false);
    }
  };

  const handleEditLead = async (
    leadId: string,
    updatedInput: LeadFormInput & { status: LeadStatus }
  ) => {
    if (!adminToken) return;
    setSheetError(null);
    setSheetSuccessMsg(null);

    const sanitized = sanitizeLeadInput(updatedInput);
    const phoneDigitsOnly = sanitized.phone.replace(/\D/g, '');
    const cleanedPhone = phoneDigitsOnly === '91' ? '' : sanitized.phone;
    const nowIso = new Date().toISOString();

    setLeads((prev) =>
      prev.map((item) =>
        item.leadId === leadId
          ? {
              ...item,
              ...sanitized,
              phone: cleanedPhone,
              status: updatedInput.status,
              updatedAt: nowIso,
            }
          : item
      )
    );

    if (leadId === activeLeadId) {
      setForm({
        ...sanitized,
        phone: cleanedPhone || '+91 ',
      });
    }

    try {
      const res = await fetch(`/api/leads/${encodeURIComponent(leadId)}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ...sanitized,
          phone: cleanedPhone,
          status: updatedInput.status,
        }),
      });

      if (res.status === 401) {
        setAdminToken(null);
        setAdminAuthError('Admin session expired. Please unlock Admin again.');
        return;
      }

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSheetError(data.error || 'Could not save edited lead.');
        return;
      }

      if (data.lead) {
        const savedRecord = normalizeLeadRecord(data.lead);
        mergeIncomingLeads([savedRecord]);
        void saveLeadToRealtimeDb({
          leadId: savedRecord.leadId,
          input: sanitized,
          status: savedRecord.status,
          createdAt: savedRecord.createdAt,
        });
        void saveLeadToFirestore({
          leadId: savedRecord.leadId,
          sessionToken: savedRecord.sessionToken || sessionToken,
          input: sanitized,
          status: savedRecord.status,
        }).catch(() => {});
        void pushLeadToConnectedGoogleSheet(savedRecord);
      }

      setSheetSuccessMsg(
        `Updated lead for ${sanitized.name || cleanedPhone || leadId} and synced to RTDB & Google Sheet.`
      );
    } catch {
      setSheetError('Network error while saving lead changes.');
    }
  };

  const handleDeleteLead = async (lead: LeadRecord) => {
    deletedLeadIdsRef.current.add(lead.leadId);
    setLeads((prev) => prev.filter((item) => item.leadId !== lead.leadId));

    if (lead.leadId === activeLeadId) {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      setForm(INITIAL_FORM);
      setErrors({});
      setActiveLeadId(generateLeadId());
      setSessionToken(generateSessionToken());
      setSyncState('idle');
      setSubmittedLeadId(null);
    }

    void deleteRealtimeDbLead(lead.leadId);
    void deleteFirestoreLead(lead.leadId).catch(() => {});

    const oauthToken = getGoogleAccessToken();
    const oauthSheet = connectedSheetRef.current;
    if (oauthToken && oauthSheet) {
      void deleteLeadFromGoogleSheet(oauthToken, oauthSheet, lead.leadId).catch(() => {});
    }

    try {
      const res = await fetch(`/api/leads/${encodeURIComponent(lead.leadId)}`, {
        method: 'DELETE',
        headers: adminToken ? { Authorization: `Bearer ${adminToken}` } : {},
      });
      if (res.status === 401) {
        setAdminToken(null);
        setAdminAuthError('Admin session expired. Please unlock Admin again.');
        return;
      }
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        registerDeletedIds(data.deletedIds);
      }
    } catch {
      // ignore transient network error; local & cloud tombstones already applied
    }
  };

  return (
    <div className="relative min-h-screen flex flex-col items-center justify-center overflow-x-hidden px-3 py-6 sm:p-6 bg-slate-900 text-slate-900">
      {/* Stainless Steel Commercial Food Service Equipment Manufacturing Factory Background */}
      <div className="fixed inset-0 -z-10 bg-slate-900">
        {!bgFailed ? (
          <img
            src={FACTORY_BG_SRC}
            alt="Prestier System LLP Stainless Steel Food Service Equipment Manufacturing Facility"
            referrerPolicy="no-referrer"
            onError={() => setBgFailed(true)}
            className="h-full w-full object-cover object-center"
          />
        ) : (
          <div className="h-full w-full bg-gradient-to-br from-slate-900 via-slate-800 to-sky-950" />
        )}
        <div
          className="absolute inset-0 bg-gradient-to-b from-slate-950/30 via-slate-950/15 to-slate-950/35"
          aria-hidden="true"
        />
      </div>

      {/* Top-Right Discreet Green Dot Admin Trigger */}
      <div className="fixed top-3 right-3 sm:top-4 sm:right-4 z-40">
        <button
          type="button"
          onClick={handleOpenAdminModal}
          className="group flex h-11 w-11 items-center justify-center rounded-full bg-transparent hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50 transition-colors cursor-pointer"
          aria-label="Protected Access"
        >
          <span
            className="h-3 w-3 rounded-full bg-emerald-500 ring-2 ring-white shadow-sm group-hover:scale-110 transition-transform"
            aria-hidden="true"
          />
        </button>
      </div>

      {/* Centered Transparent Glass Customer Inquiry Form */}
      <main className="w-full max-w-xl my-auto py-4 sm:py-8">
        <LeadCaptureForm
          form={form}
          errors={errors}
          syncState={syncState}
          lastSavedTime={lastSavedTime}
          isSubmitting={isSubmitting}
          submittedLeadId={submittedLeadId}
          whatsappSentAuto={whatsappSentAuto}
          whatsappDirectUrl={whatsappDirectUrl}
          onFieldChange={handleFieldChange}
          onSubmit={handleSubmit}
          onStartNewLead={handleStartNewLead}
        />
      </main>

      {/* Mobile-Friendly Password-Protected Admin Modal */}
      {isAdminModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="admin-dashboard-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 backdrop-blur-xs p-0 sm:p-6 overflow-y-auto"
        >
          {!adminToken ? (
            <div className="m-4 sm:my-auto w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-5 sm:p-6 shadow-2xl space-y-5">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-xl bg-emerald-50 border border-emerald-200 flex items-center justify-center text-emerald-700 shrink-0">
                    <Lock className="h-5 w-5" />
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-sky-700">Prestier System LLP</p>
                    <h2
                      id="admin-dashboard-title"
                      className="font-display text-lg font-bold text-slate-900"
                    >
                      {isPasscodeConfigured === false
                        ? 'Set Admin Password'
                        : 'Admin Password Required'}
                    </h2>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={handleCloseAdminModal}
                  aria-label="Close password prompt"
                  className="min-h-11 min-w-11 flex items-center justify-center -mr-2 -mt-1 rounded-lg text-slate-400 hover:text-slate-900 hover:bg-slate-100 transition-colors cursor-pointer"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              {isCheckingAuthStatus ? (
                <div className="py-6 flex items-center justify-center gap-2 text-xs text-slate-600">
                  <Loader2 className="h-4 w-4 animate-spin text-sky-600" />
                  <span>Checking admin security…</span>
                </div>
              ) : (
                <form onSubmit={handleAdminAuthSubmit} className="space-y-4">
                  <p className="text-xs text-slate-600 leading-relaxed">
                    {isPasscodeConfigured === false
                      ? 'First-time setup: Set your 4-digit PIN or password once—it syncs securely across AI Studio and Railway.'
                      : 'Enter your Admin PIN / password to view customer leads, Google Sheet sync, and WhatsApp settings.'}
                  </p>

                  <div>
                    <label
                      htmlFor="admin-pin-input"
                      className="block text-xs font-semibold text-slate-800 mb-1.5"
                    >
                      {isPasscodeConfigured === false
                        ? 'Create Admin PIN / Password'
                        : 'Password / PIN'}
                    </label>
                    <input
                      id="admin-pin-input"
                      type="password"
                      autoFocus
                      autoComplete={
                        isPasscodeConfigured === false ? 'new-password' : 'current-password'
                      }
                      value={adminPasscodeInput}
                      onChange={(e) => {
                        setAdminPasscodeInput(e.target.value);
                        if (adminAuthError) setAdminAuthError(null);
                      }}
                      placeholder={
                        isPasscodeConfigured === false
                          ? 'Enter new PIN (min 4 characters)'
                          : 'Enter admin password'
                      }
                      className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-base sm:text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-sky-600 focus:ring-3 focus:ring-sky-600/15 tabular-nums"
                    />
                  </div>

                  {adminAuthError && (
                    <p
                      role="alert"
                      className="text-xs font-medium text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2"
                    >
                      {adminAuthError}
                    </p>
                  )}

                  <div className="grid grid-cols-2 sm:flex sm:items-center sm:justify-end gap-2.5 pt-1">
                    <button
                      type="button"
                      onClick={handleCloseAdminModal}
                      className="min-h-11 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold px-4 py-2.5 transition-colors cursor-pointer whitespace-nowrap shrink-0"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={isUnlockingAdmin || !adminPasscodeInput.trim()}
                      className="min-h-11 inline-flex items-center justify-center gap-2 rounded-xl bg-slate-900 hover:bg-slate-800 disabled:opacity-50 text-white text-xs font-semibold px-5 py-2.5 transition-colors cursor-pointer whitespace-nowrap shrink-0"
                    >
                      {isUnlockingAdmin ? (
                        <>
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          <span>Verifying…</span>
                        </>
                      ) : (
                        <span>
                          {isPasscodeConfigured === false ? 'Set PIN & Open' : 'Unlock Admin'}
                        </span>
                      )}
                    </button>
                  </div>
                </form>
              )}
            </div>
          ) : (
            <div className="w-full h-dvh sm:h-auto sm:max-h-[92vh] max-w-7xl sm:my-auto rounded-none sm:rounded-2xl border-0 sm:border border-slate-200 bg-slate-50 shadow-2xl overflow-hidden flex flex-col">
              <div className="border-b border-slate-200 bg-white px-4 sm:px-6 py-3 sm:py-4 shrink-0 space-y-2.5 sm:space-y-0 sm:flex sm:items-center sm:justify-between sm:gap-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[11px] sm:text-xs font-semibold text-sky-700 truncate">
                      Food service equipment
                    </p>
                    <h2
                      id="admin-dashboard-title"
                      className="font-display text-base sm:text-lg font-bold text-slate-900 truncate"
                    >
                      Prestier System LLP · Admin
                    </h2>
                  </div>

                  <button
                    type="button"
                    onClick={handleCloseAdminModal}
                    aria-label="Lock and close Admin Dashboard"
                    className="sm:hidden min-h-11 min-w-11 flex items-center justify-center -mr-2 rounded-lg text-slate-500 hover:text-slate-900 hover:bg-slate-100 transition-colors cursor-pointer shrink-0"
                  >
                    <X className="h-5 w-5" />
                  </button>
                </div>

                <div className="flex items-center gap-3">
                  <div
                    role="tablist"
                    aria-label="Admin workspace sections"
                    className="grid grid-cols-3 sm:inline-flex items-center gap-1 p-1 rounded-xl bg-slate-100 border border-slate-200 w-full sm:w-auto"
                  >
                    <button
                      type="button"
                      role="tab"
                      aria-selected={adminTab === 'leads'}
                      onClick={() => setAdminTab('leads')}
                      className={`min-h-10 inline-flex items-center justify-center gap-1.5 px-2 sm:px-3.5 py-2 sm:py-1.5 rounded-lg text-[11px] sm:text-xs font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                        adminTab === 'leads'
                          ? 'bg-white text-slate-900 shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      <FileSpreadsheet className="hidden sm:block h-3.5 w-3.5 text-sky-700 shrink-0" />
                      <span className="tabular-nums">Leads ({leads.length})</span>
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={adminTab === 'sheets'}
                      onClick={() => setAdminTab('sheets')}
                      className={`min-h-10 inline-flex items-center justify-center gap-1.5 px-2 sm:px-3.5 py-2 sm:py-1.5 rounded-lg text-[11px] sm:text-xs font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                        adminTab === 'sheets'
                          ? 'bg-white text-slate-900 shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      <FileSpreadsheet className="hidden sm:block h-3.5 w-3.5 text-emerald-700 shrink-0" />
                      <span>Sheet Script</span>
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={adminTab === 'whatsapp'}
                      onClick={() => setAdminTab('whatsapp')}
                      className={`min-h-10 inline-flex items-center justify-center gap-1.5 px-2 sm:px-3.5 py-2 sm:py-1.5 rounded-lg text-[11px] sm:text-xs font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                        adminTab === 'whatsapp'
                          ? 'bg-white text-slate-900 shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      <MessageCircle className="hidden sm:block h-3.5 w-3.5 text-emerald-700 shrink-0" />
                      <span>WhatsApp</span>
                    </button>
                  </div>

                  <button
                    type="button"
                    onClick={handleCloseAdminModal}
                    aria-label="Lock and close Admin Dashboard"
                    className="hidden sm:flex min-h-10 min-w-10 items-center justify-center rounded-lg text-slate-500 hover:text-slate-900 hover:bg-slate-100 transition-colors cursor-pointer shrink-0"
                  >
                    <X className="h-5 w-5" />
                  </button>
                </div>
              </div>

              <div className="p-3 sm:p-6 overflow-y-auto flex-1 overscroll-contain">
                {adminTab === 'leads' ? (
                  <LiveGoogleSheetTable
                    leads={leads}
                    activeDraftId={activeLeadId}
                    googleUserEmail={googleUserEmail}
                    connectedSheet={connectedSheet}
                    rtdbStatus={rtdbStatus}
                    isSigningInGoogle={isSigningInGoogle}
                    isSyncingSheet={isSyncingSheet}
                    isSyncingRtdb={isSyncingRtdb}
                    isRefreshingLeads={isRefreshingLeads}
                    resendingLeadId={resendingLeadId}
                    sheetError={sheetError}
                    sheetSuccessMsg={sheetSuccessMsg}
                    isAdminAuthenticated={true}
                    onRefreshLeads={() => void fetchInitialLeads(adminToken)}
                    onSyncRtdbNow={() => void handleSyncRtdbNow()}
                    onResendWhatsApp={handleResendWhatsApp}
                    onGoogleSignIn={handleGoogleSignIn}
                    onCreateNewGoogleSheet={handleCreateNewGoogleSheet}
                    onConnectExistingSheet={handleConnectExistingSheet}
                    onSyncAllToSheet={handleSyncAllToSheet}
                    onEditLead={handleEditLead}
                    onDeleteLead={handleDeleteLead}
                    onOpenAppsScriptSetup={() => setAdminTab('sheets')}
                  />
                ) : adminTab === 'sheets' ? (
                  <GoogleSheetAppsScriptPanel
                    adminToken={adminToken}
                    onSyncComplete={() => void fetchInitialLeads(adminToken)}
                  />
                ) : (
                  <HiddenWhatsAppSidebar adminToken={adminToken} />
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
