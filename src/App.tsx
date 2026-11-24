import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  MessageCircle,
  ShieldCheck,
  X,
} from 'lucide-react';
import {
  buildWhatsAppConfirmationMessage,
  buildWhatsAppDirectUrl,
  generateLeadId,
  generateSessionToken,
  hasAnyLeadContent,
  sanitizeLeadInput,
  validateLeadForSubmit,
  type LeadFormInput,
  type LeadRecord,
} from './utils/leadLogic';
import {
  deleteFirestoreLead,
  getGoogleAccessToken,
  initGoogleAuth,
  markFirestoreLeadSynced,
  saveLeadToFirestore,
  signInWithGoogleSheets,
} from './services/firebase';
import {
  createPrestierSpreadsheet,
  inspectSpreadsheet,
  syncAllLeadsToGoogleSheet,
  upsertLeadInGoogleSheet,
  type ConnectedSpreadsheet,
} from './services/googleSheets';
import { LeadCaptureForm } from './components/LeadCaptureForm';
import { LiveGoogleSheetTable } from './components/LiveGoogleSheetTable';
import { HiddenWhatsAppSidebar } from './components/HiddenWhatsAppSidebar';

const STEEL_BG_SRC = '/src/assets/images/steel_manufacturing_bg_1795501416598.jpg';

const INITIAL_FORM: LeadFormInput = {
  name: '',
  phone: '+91 ',
  companyName: '',
  outletsCount: '',
  productInterest: '',
};

export default function App() {
  const [form, setForm] = useState<LeadFormInput>(INITIAL_FORM);
  const [errors, setErrors] = useState<Partial<Record<keyof LeadFormInput, string>>>({});
  const [activeLeadId, setActiveLeadId] = useState<string>(() => generateLeadId());
  const [sessionToken, setSessionToken] = useState<string>(() => generateSessionToken());

  const [syncState, setSyncState] = useState<'idle' | 'saving' | 'saved_partial' | 'confirmed'>(
    'idle'
  );
  const [lastSavedTime, setLastSavedTime] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submittedLeadId, setSubmittedLeadId] = useState<string | null>(null);
  const [whatsappSentAuto, setWhatsappSentAuto] = useState(false);
  const [whatsappDirectUrl, setWhatsappDirectUrl] = useState<string | null>(null);

  const [leads, setLeads] = useState<LeadRecord[]>([]);

  // Google Sheets OAuth State (in-memory access token)
  const [googleUserEmail, setGoogleUserEmail] = useState<string | null>(null);
  const [connectedSheet, setConnectedSheet] = useState<ConnectedSpreadsheet | null>(null);
  const [isSigningInGoogle, setIsSigningInGoogle] = useState(false);
  const [isSyncingSheet, setIsSyncingSheet] = useState(false);
  const [sheetError, setSheetError] = useState<string | null>(null);
  const [sheetSuccessMsg, setSheetSuccessMsg] = useState<string | null>(null);

  // Admin & Modals State
  const [adminToken, setAdminToken] = useState<string | null>(null);
  const [isAdminConfigured, setIsAdminConfigured] = useState(false);
  const [isAdminModalOpen, setIsAdminModalOpen] = useState(false);
  const [showSuccessModal, setShowSuccessModal] = useState(false);

  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectedSheetRef = useRef<ConnectedSpreadsheet | null>(null);
  connectedSheetRef.current = connectedSheet;

  // 1. Load initial leads + subscribe to real-time SSE stream
  const fetchInitialLeads = useCallback(async () => {
    try {
      const res = await fetch('/api/leads');
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.leads)) {
          setLeads(data.leads);
        }
      }
    } catch {
      // ignore offline error
    }
  }, []);

  useEffect(() => {
    void fetchInitialLeads();

    const es = new EventSource('/api/leads/stream');
    es.addEventListener('leads', (event) => {
      try {
        const parsed = JSON.parse((event as MessageEvent).data);
        if (parsed.type === 'upsert' && parsed.payload) {
          const incoming: LeadRecord = parsed.payload;
          setLeads((prev) => {
            const idx = prev.findIndex((item) => item.leadId === incoming.leadId);
            if (idx >= 0) {
              const copy = [...prev];
              copy[idx] = incoming;
              return copy;
            }
            return [incoming, ...prev];
          });
        } else if (parsed.type === 'delete' && parsed.payload?.leadId) {
          setLeads((prev) => prev.filter((item) => item.leadId !== parsed.payload.leadId));
        } else if (parsed.type === 'sync') {
          void fetchInitialLeads();
        }
      } catch {
        // ignore malformed event
      }
    });

    return () => {
      es.close();
    };
  }, [fetchInitialLeads]);

  // 2. Check Admin Password Configuration Status
  const checkAdminStatus = useCallback(async (token?: string | null) => {
    try {
      const res = await fetch('/api/admin/auth-status', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (res.ok) {
        const data = await res.json();
        setIsAdminConfigured(Boolean(data.isConfigured));
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    void checkAdminStatus(adminToken);
  }, [adminToken, checkAdminStatus]);

  // 3. Initialize Firebase Google Auth Listener
  useEffect(() => {
    const unsub = initGoogleAuth(
      (user) => {
        const email = user.email || user.displayName || 'Connected User';
        setGoogleUserEmail(email);
        void fetch('/api/admin/google-login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email }),
        })
          .then((r) => r.json())
          .then((d) => {
            if (d.token) {
              setAdminToken(d.token);
              setIsAdminConfigured(true);
            }
          })
          .catch(() => {});
      },
      () => {
        setGoogleUserEmail(null);
      }
    );
    return () => unsub();
  }, []);

  // 4. Sync a single lead to Google Sheets if a spreadsheet is connected
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

  // 5. Core Real-Time Persist Function (runs automatically on keystrokes AND on submit)
  const persistLeadRealTime = useCallback(
    async (
      currentLeadId: string,
      currentSessionToken: string,
      input: LeadFormInput,
      status: 'partial' | 'confirmed'
    ) => {
      const sanitized = sanitizeLeadInput(input);
      if (!hasAnyLeadContent(sanitized)) return null;

      setSyncState('saving');

      const firestorePromise = saveLeadToFirestore({
        leadId: currentLeadId,
        sessionToken: currentSessionToken,
        input: sanitized,
        status,
      });

      const apiPromise = fetch('/api/leads/upsert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          leadId: currentLeadId,
          ...sanitized,
          status,
        }),
      }).then(async (res) => (res.ok ? res.json() : null));

      const [, apiResult] = await Promise.all([firestorePromise, apiPromise]);

      const nowFormatted = new Date().toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
      setLastSavedTime(nowFormatted);
      setSyncState(status === 'confirmed' ? 'confirmed' : 'saved_partial');

      if (apiResult?.lead) {
        void pushLeadToConnectedGoogleSheet(apiResult.lead as LeadRecord);
      }

      return apiResult;
    },
    [pushLeadToConnectedGoogleSheet]
  );

  // 6. Field change handler with instant optimistic table reflection + 380ms debounced auto-save
  const handleFieldChange = <K extends keyof LeadFormInput>(
    field: K,
    value: LeadFormInput[K]
  ) => {
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
        const idx = prev.findIndex((item) => item.leadId === activeLeadId);
        const optimisticRecord: LeadRecord = {
          leadId: activeLeadId,
          name: sanitized.name,
          phone: sanitized.phone,
          companyName: sanitized.companyName,
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
      void persistLeadRealTime(activeLeadId, sessionToken, updatedForm, targetStatus);
    }, 380);
  };

  // Flush pending draft if customer closes tab without clicking Submit
  useEffect(() => {
    const handlePageHide = () => {
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

  // 7. Full Confirmed Form Submission + WhatsApp Dispatch
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
      const result = await persistLeadRealTime(activeLeadId, sessionToken, sanitized, 'confirmed');
      setSubmittedLeadId(activeLeadId);
      setWhatsappSentAuto(Boolean(result?.whatsappDispatchedNow));
      const waMsg = buildWhatsAppConfirmationMessage(sanitized);
      setWhatsappDirectUrl(buildWhatsAppDirectUrl(sanitized.phone, waMsg));
      setShowSuccessModal(true);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleStartNewLead = () => {
    setForm(INITIAL_FORM);
    setErrors({});
    setActiveLeadId(generateLeadId());
    setSessionToken(generateSessionToken());
    setSyncState('idle');
    setSubmittedLeadId(null);
    setWhatsappSentAuto(false);
    setWhatsappDirectUrl(null);
  };

  // 8. Google Sheets OAuth Handlers (Seamless Single Login for Sheets, WhatsApp & Admin)
  const handleGoogleSignIn = async () => {
    setIsSigningInGoogle(true);
    setSheetError(null);
    setSheetSuccessMsg(null);
    try {
      const { user, accessToken } = await signInWithGoogleSheets();
      const email = user.email || user.displayName || 'Connected User';
      setGoogleUserEmail(email);

      // Seamless admin token acquisition using same Google sign-in
      const adminRes = await fetch('/api/admin/google-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (adminRes.ok) {
        const adminData = await adminRes.json();
        if (adminData.token) {
          setAdminToken(adminData.token);
          setIsAdminConfigured(true);
        }
      }

      setIsSyncingSheet(true);
      const created = await createPrestierSpreadsheet(accessToken);
      setConnectedSheet(created);
      await syncAllLeadsToGoogleSheet(accessToken, created, leads);
      setSheetSuccessMsg(
        `Created & synced "${created.title}" (${leads.length} rows including partial drafts).`
      );
      setIsAdminModalOpen(true);
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
      setSheetError('Please Sign in with Google first.');
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
      if (adminToken) {
        await fetch('/api/leads/mark-synced', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${adminToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ leadIds: leads.map((l) => l.leadId) }),
        });
      }
    } catch (err: any) {
      setSheetError(err?.message || 'Failed to sync rows to Google Sheet.');
    } finally {
      setIsSyncingSheet(false);
    }
  };

  const handleDeleteLead = async (lead: LeadRecord) => {
    if (!adminToken) return;
    try {
      await fetch(`/api/leads/${encodeURIComponent(lead.leadId)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      void deleteFirestoreLead(lead.leadId).catch(() => {});
    } catch {
      // ignore
    }
  };

  return (
    <div className="relative min-h-screen flex flex-col items-center justify-center overflow-x-hidden p-4 sm:p-6">
      {/* Steel Manufacturing Full-Viewport Background Image with Measured Contrast Scrim */}
      <div className="fixed inset-0 -z-10 bg-slate-950">
        <img
          src={STEEL_BG_SRC}
          alt="Prestier System LLP Stainless Steel Manufacturing Facility"
          referrerPolicy="no-referrer"
          className="h-full w-full object-cover object-center opacity-45"
        />
        <div
          className="absolute inset-0 bg-gradient-to-b from-slate-950/85 via-slate-950/75 to-slate-950/95"
          aria-hidden="true"
        />
      </div>

      {/* Top-Right Corner Green Dot for Admin Login / Dashboard */}
      <div className="fixed top-4 right-4 z-40">
        <button
          type="button"
          onClick={() => {
            setIsAdminModalOpen(true);
          }}
          title="Admin Dashboard"
          className="h-4 w-4 rounded-full bg-emerald-500 hover:bg-emerald-400 shadow-lg shadow-emerald-500/80 ring-2 ring-emerald-400/60 transition-all cursor-pointer block"
          aria-label="Admin Dashboard"
        />
      </div>

      {/* Home Page: ONLY the form and nothing else (no header, no live sheet, no core manufacturing divisions) */}
      <main className="w-full max-w-xl my-auto">
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

      {/* Success Popup Modal after Submit */}
      {showSuccessModal && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-md p-4"
        >
          <div className="w-full max-w-md rounded-2xl border border-emerald-500/40 bg-slate-900 p-6 shadow-2xl space-y-4 animate-in fade-in zoom-in-95 duration-200">
            <div className="flex items-center gap-3">
              <div className="h-12 w-12 rounded-full bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-emerald-400 shrink-0">
                <CheckCircle2 className="h-6 w-6" />
              </div>
              <div>
                <h3 className="font-display text-lg font-bold text-white">
                  Inquiry Submitted Successfully!
                </h3>
                <p className="text-xs text-slate-300">
                  Your details have been logged to the live system.
                </p>
              </div>
            </div>
            <div className="rounded-xl bg-slate-950 p-4 space-y-2 text-xs text-slate-300 border border-slate-800">
              <p>
                <span className="text-slate-400">Name:</span>{' '}
                <strong className="text-white">{form.name}</strong>
              </p>
              <p>
                <span className="text-slate-400">Company:</span>{' '}
                <strong className="text-white">{form.companyName}</strong>
              </p>
              <p>
                <span className="text-slate-400">Outlets:</span>{' '}
                <strong className="text-white">{form.outletsCount}</strong>
              </p>
              <p>
                <span className="text-slate-400">Requirement:</span>{' '}
                <strong className="text-emerald-300">{form.productInterest}</strong>
              </p>
            </div>
            <div className="flex flex-col sm:flex-row items-center gap-3 pt-2">
              {whatsappDirectUrl && (
                <a
                  href={whatsappDirectUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-sm px-4 py-3 transition-colors"
                >
                  <MessageCircle className="h-4 w-4" />
                  Open on WhatsApp
                </a>
              )}
              <button
                type="button"
                onClick={() => {
                  setShowSuccessModal(false);
                  handleStartNewLead();
                }}
                className="w-full inline-flex items-center justify-center gap-2 rounded-xl border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-200 font-medium text-sm px-4 py-3 transition-colors cursor-pointer"
              >
                Enter New Inquiry
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Admin Dashboard Modal (Containing Real-Time Google Sheets Table & WhatsApp Panel) */}
      {isAdminModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-md p-4 overflow-y-auto"
        >
          <div className="w-full max-w-5xl max-h-[90vh] overflow-y-auto rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl space-y-6">
            <div className="flex items-center justify-between border-b border-slate-800 pb-4">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-xl bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-emerald-400">
                  <ShieldCheck className="h-5 w-5" />
                </div>
                <div>
                  <h2 className="font-display text-lg font-bold text-white">
                    Prestier System LLP · Admin Dashboard
                  </h2>
                  <p className="text-xs text-slate-400">
                    Real-Time Google Sheets, Database Stream &amp; 24x7 WhatsApp Vault
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsAdminModalOpen(false)}
                className="rounded-lg p-2 text-slate-400 hover:text-white hover:bg-slate-800 transition-colors cursor-pointer"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="space-y-8">
              {/* Live Google Sheet & Leads Table */}
              <LiveGoogleSheetTable
                leads={leads}
                activeDraftId={activeLeadId}
                googleUserEmail={googleUserEmail}
                connectedSheet={connectedSheet}
                isSigningInGoogle={isSigningInGoogle}
                isSyncingSheet={isSyncingSheet}
                sheetError={sheetError}
                sheetSuccessMsg={sheetSuccessMsg}
                isAdminAuthenticated={Boolean(adminToken)}
                onGoogleSignIn={handleGoogleSignIn}
                onCreateNewGoogleSheet={handleCreateNewGoogleSheet}
                onConnectExistingSheet={handleConnectExistingSheet}
                onSyncAllToSheet={handleSyncAllToSheet}
                onDeleteLead={handleDeleteLead}
              />

              {/* 24x7 WhatsApp Sidebar/Vault Embedded Controls */}
              <div className="rounded-2xl border border-slate-800 bg-slate-950/80 p-6 space-y-4">
                <h3 className="font-display text-base font-bold text-white flex items-center gap-2">
                  <MessageCircle className="h-5 w-5 text-amber-400" />
                  <span>24x7 Persistent WhatsApp Vault &amp; Automation</span>
                </h3>
                <HiddenWhatsAppSidebar
                  isOpen={true}
                  adminToken={adminToken}
                  isConfigured={isAdminConfigured}
                  onOpenTrigger={() => {}}
                  onClose={() => setIsAdminModalOpen(false)}
                  onAdminAuthenticated={(token) => {
                    setAdminToken(token);
                    setIsAdminConfigured(true);
                  }}
                  onAdminLogout={async () => {
                    if (adminToken) {
                      await fetch('/api/admin/logout', {
                        method: 'POST',
                        headers: { Authorization: `Bearer ${adminToken}` },
                      }).catch(() => {});
                    }
                    setAdminToken(null);
                    setIsAdminModalOpen(false);
                  }}
                />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
