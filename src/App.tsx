/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  Building2,
  Phone,
  User,
  Store,
  Layers,
  Send,
  CheckCircle2,
  Clock,
  ShieldCheck,
  Lock,
  Unlock,
  FileSpreadsheet,
  QrCode,
  Smartphone,
  RefreshCw,
  LogOut,
  Sparkles,
  Check,
  AlertCircle,
  ExternalLink,
  ChevronRight,
  Database,
  Search,
  Trash2,
} from 'lucide-react';
import {
  PRODUCT_OPTIONS,
  sanitizeLeadInput,
  validateLeadForSubmit,
  generateSessionToken,
  buildWhatsAppDirectUrl,
  buildWhatsAppConfirmationMessage,
  type LeadFormInput,
  type LeadRecord,
} from './utils/leadLogic';
import {
  initGoogleAuth,
  signInWithGoogleSheets,
  signOutGoogle,
  getGoogleAccessToken,
  saveLeadToFirestore,
  subscribeAdminFirestoreLeads,
} from './services/firebase';
import {
  createPrestierSpreadsheet,
  inspectSpreadsheet,
  upsertLeadInGoogleSheet,
  type ConnectedSpreadsheet,
} from './services/googleSheets';

export default function App() {
  // --- Form State ---
  const [formData, setFormData] = useState<LeadFormInput>({
    name: '',
    phone: '',
    companyName: '',
    outletsCount: '',
    productInterest: '',
  });

  const [leadId, setLeadId] = useState<string>('');
  const [sessionToken, setSessionToken] = useState<string>('');
  const [errors, setErrors] = useState<Partial<Record<keyof LeadFormInput, string>>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submittedSuccess, setSubmittedSuccess] = useState(false);
  const [autoSaveStatus, setAutoSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');

  // --- Leads Store & Live Feed ---
  const [leads, setLeads] = useState<LeadRecord[]>([]);
  const [liveSyncActive, setLiveSyncActive] = useState(true);

  // --- Google Sheets Integration ---
  const [googleUser, setGoogleUser] = useState<any>(null);
  const [connectedSheet, setConnectedSheet] = useState<ConnectedSpreadsheet | null>(() => {
    try {
      const saved = localStorage.getItem('prestier_connected_sheet');
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  });
  const [sheetLinkInput, setSheetLinkInput] = useState('');
  const [isConnectingSheet, setIsConnectingSheet] = useState(false);
  const [sheetModalOpen, setSheetModalOpen] = useState(false);
  const [sheetSyncing, setSheetSyncing] = useState(false);

  // --- Hidden Color Sidebar / Admin State ---
  const [adminSidebarOpen, setAdminSidebarOpen] = useState(false);
  const [adminAuthenticated, setAdminAuthenticated] = useState(false);
  const [adminPasscodeConfigured, setAdminPasscodeConfigured] = useState(true);
  const [adminPasswordInput, setAdminPasswordInput] = useState('');
  const [adminLoginError, setAdminLoginError] = useState('');
  const [adminTab, setAdminTab] = useState<'leads' | 'whatsapp' | 'sheets'>('leads');
  const [adminSearchQuery, setAdminSearchQuery] = useState('');

  // --- WhatsApp Engine State ---
  const [waEngineState, setWaEngineState] = useState<any>({
    status: 'disconnected',
    qrDataUrl: null,
    pairingCode: null,
    connectedNumber: null,
    connectedName: null,
    hasSavedSession: false,
    settings: {
      autoReplyEnabled: true,
      messageTemplate: '',
      adminNotifyPhone: '',
    },
  });
  const [pairingPhoneInput, setPairingPhoneInput] = useState('');
  const [testWhatsAppPhone, setTestWhatsAppPhone] = useState('');
  const [testWhatsAppText, setTestWhatsAppText] = useState('');
  const [waLoading, setWaLoading] = useState(false);

  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Initialize Lead ID & Session Token on mount
  useEffect(() => {
    const existingTok = localStorage.getItem('prestier_session_token');
    const existingId = localStorage.getItem('prestier_lead_id');
    const tok = existingTok || generateSessionToken();
    const lid = existingId || `lead_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    setSessionToken(tok);
    setLeadId(lid);
    localStorage.setItem('prestier_session_token', tok);
    localStorage.setItem('prestier_lead_id', lid);
  }, []);

  // Fetch initial leads from Express server & subscribe to SSE
  useEffect(() => {
    fetch('/api/leads')
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data.leads)) {
          setLeads(data.leads);
        }
      })
      .catch((err) => console.error('Failed to load leads:', err));

    const eventSource = new EventSource('/api/leads/stream');
    eventSource.addEventListener('leads', (e) => {
      try {
        const parsed = JSON.parse(e.data);
        if (parsed.type === 'upsert' && parsed.payload) {
          const updated = parsed.payload as LeadRecord;
          setLeads((prev) => {
            const idx = prev.findIndex((l) => l.leadId === updated.leadId);
            if (idx >= 0) {
              const copy = [...prev];
              copy[idx] = updated;
              return copy;
            }
            return [updated, ...prev];
          });
        } else if (parsed.type === 'delete' && parsed.payload?.leadId) {
          const delId = parsed.payload.leadId;
          setLeads((prev) => prev.filter((l) => l.leadId !== delId));
        }
      } catch (err) {
        console.error('SSE parse error:', err);
      }
    });

    // Also subscribe to Firestore admin snapshot if authenticated
    let unsubscribeFirestore: (() => void) | undefined;
    try {
      unsubscribeFirestore = subscribeAdminFirestoreLeads((firestoreLeads) => {
        if (firestoreLeads.length > 0) {
          setLeads(firestoreLeads);
        }
      });
    } catch {
      // fallback to server API if firestore rules restrict unauthenticated snapshot
    }

    return () => {
      eventSource.close();
      unsubscribeFirestore?.();
    };
  }, []);

  // Initialize Google Auth state
  useEffect(() => {
    const unsubscribeAuth = initGoogleAuth(
      (user, token) => {
        setGoogleUser(user);
      },
      () => {
        setGoogleUser(null);
      }
    );
    return () => unsubscribeAuth();
  }, []);

  // Check admin auth status on mount
  useEffect(() => {
    const savedToken = localStorage.getItem('prestier_admin_token');
    if (savedToken) {
      fetch('/api/admin/auth-status', {
        headers: { Authorization: `Bearer ${savedToken}` },
      })
        .then((res) => res.json())
        .then((data) => {
          setAdminPasscodeConfigured(data.isConfigured);
          if (data.authenticated) {
            setAdminAuthenticated(true);
          } else {
            localStorage.removeItem('prestier_admin_token');
          }
        })
        .catch(() => {});
    } else {
      fetch('/api/admin/auth-status')
        .then((res) => res.json())
        .then((data) => {
          setAdminPasscodeConfigured(data.isConfigured);
        })
        .catch(() => {});
    }
  }, []);

  // Fetch WhatsApp Engine Status periodically when admin sidebar is open
  useEffect(() => {
    if (!adminSidebarOpen || !adminAuthenticated) return;
    const fetchWaStatus = () => {
      const token = localStorage.getItem('prestier_admin_token');
      fetch('/api/whatsapp/status', {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then((res) => res.json())
        .then((data) => {
          setWaEngineState(data);
        })
        .catch(() => {});
    };
    fetchWaStatus();
    const interval = setInterval(fetchWaStatus, 3000);
    return () => clearInterval(interval);
  }, [adminSidebarOpen, adminAuthenticated]);

  // --- Real-Time Automatic Partial Lead Capture (Keystroke Auto-Save) ---
  const handleInputChange = (field: keyof LeadFormInput, value: string) => {
    const updated = { ...formData, [field]: value };
    setFormData(updated);
    if (errors[field]) {
      setErrors((prev) => ({ ...prev, [field]: undefined }));
    }

    // Debounced real-time auto-save to backend and Firestore
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    setAutoSaveStatus('saving');

    autoSaveTimerRef.current = setTimeout(async () => {
      try {
        const sanitized = sanitizeLeadInput(updated);
        if (!sanitized.name && !sanitized.phone && !sanitized.companyName) {
          setAutoSaveStatus('idle');
          return;
        }

        // 1. Save to Express server (and auto-sync to Sheets if connected)
        const res = await fetch('/api/leads/upsert', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            leadId,
            sessionToken,
            ...sanitized,
            status: 'partial',
          }),
        });
        const json = await res.json();

        // 2. Save to Firestore in parallel
        await saveLeadToFirestore({
          leadId,
          sessionToken,
          input: sanitized,
          status: 'partial',
        });

        // 3. If live Google Sheet is connected, upsert row in background
        const token = getGoogleAccessToken();
        if (connectedSheet && token && json.lead) {
          try {
            await upsertLeadInGoogleSheet(token, connectedSheet, json.lead);
            await fetch('/api/leads/mark-synced', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${localStorage.getItem('prestier_admin_token') || ''}`,
              },
              body: JSON.stringify({ leadIds: [leadId] }),
            });
          } catch (sheetErr) {
            console.error('Auto Sheet sync error:', sheetErr);
          }
        }

        setAutoSaveStatus('saved');
        setTimeout(() => setAutoSaveStatus('idle'), 2500);
      } catch (err) {
        console.error('Auto-save draft error:', err);
        setAutoSaveStatus('idle');
      }
    }, 750);
  };

  // --- Final Form Submission ---
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const validation = validateLeadForSubmit(formData);
    if (!validation.valid) {
      setErrors(validation.errors);
      return;
    }
    setErrors({});
    setIsSubmitting(true);

    try {
      const sanitized = sanitizeLeadInput(formData);

      // 1. Submit confirmed lead to backend
      const res = await fetch('/api/leads/upsert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          leadId,
          sessionToken,
          ...sanitized,
          status: 'confirmed',
        }),
      });
      const data = await res.json();

      // 2. Sync to Firestore
      await saveLeadToFirestore({
        leadId,
        sessionToken,
        input: sanitized,
        status: 'confirmed',
      });

      // 3. Sync to Google Sheets if connected
      const token = getGoogleAccessToken();
      if (connectedSheet && token && data.lead) {
        try {
          await upsertLeadInGoogleSheet(token, connectedSheet, data.lead);
          await fetch('/api/leads/mark-synced', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${localStorage.getItem('prestier_admin_token') || ''}`,
            },
            body: JSON.stringify({ leadIds: [leadId] }),
          });
        } catch (err) {
          console.error('Final sheet sync error:', err);
        }
      }

      setSubmittedSuccess(true);
    } catch (err) {
      console.error('Submission failed:', err);
      alert('Unable to submit inquiry. Please check your network connection.');
    } finally {
      setIsSubmitting(false);
    }
  };

  // --- Google Sheets Connection Handlers ---
  const handleGoogleSignInForSheets = async () => {
    try {
      setIsConnectingSheet(true);
      const result = await signInWithGoogleSheets();
      setGoogleUser(result.user);
      // Automatically create a gorgeous new sheet if none connected
      if (!connectedSheet) {
        const newSheet = await createPrestierSpreadsheet(result.accessToken);
        setConnectedSheet(newSheet);
        localStorage.setItem('prestier_connected_sheet', JSON.stringify(newSheet));
      }
      setSheetModalOpen(false);
    } catch (err: any) {
      console.error('Google Sign-In / Sheets error:', err);
      alert(err?.message || 'Failed to connect Google Sheets.');
    } finally {
      setIsConnectingSheet(false);
    }
  };

  const handleConnectExistingSheet = async () => {
    const token = getGoogleAccessToken();
    if (!token) {
      handleGoogleSignInForSheets();
      return;
    }
    if (!sheetLinkInput.trim()) {
      alert('Please enter a valid Google Sheets URL or Spreadsheet ID.');
      return;
    }
    try {
      setIsConnectingSheet(true);
      const sheet = await inspectSpreadsheet(token, sheetLinkInput.trim());
      setConnectedSheet(sheet);
      localStorage.setItem('prestier_connected_sheet', JSON.stringify(sheet));
      setSheetLinkInput('');
      setSheetModalOpen(false);
    } catch (err: any) {
      alert(err?.message || 'Unable to connect spreadsheet. Check permissions.');
    } finally {
      setIsConnectingSheet(false);
    }
  };

  const handleCreateNewSheet = async () => {
    const token = getGoogleAccessToken();
    if (!token) {
      handleGoogleSignInForSheets();
      return;
    }
    try {
      setIsConnectingSheet(true);
      const sheet = await createPrestierSpreadsheet(token);
      setConnectedSheet(sheet);
      localStorage.setItem('prestier_connected_sheet', JSON.stringify(sheet));
      setSheetModalOpen(false);
    } catch (err: any) {
      alert(err?.message || 'Failed to create spreadsheet.');
    } finally {
      setIsConnectingSheet(false);
    }
  };

  const handleSyncAllToSheet = async () => {
    const token = getGoogleAccessToken();
    if (!token || !connectedSheet) {
      setSheetModalOpen(true);
      return;
    }
    try {
      setSheetSyncing(true);
      await syncAllLeadsToGoogleSheet(token, connectedSheet, leads);
      const ids = leads.map((l) => l.leadId);
      await fetch('/api/leads/mark-synced', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('prestier_admin_token') || ''}`,
        },
        body: JSON.stringify({ leadIds: ids }),
      });
      alert(`Successfully synced ${leads.length} leads to Google Sheets!`);
    } catch (err: any) {
      alert(err?.message || 'Sync failed.');
    } finally {
      setSheetSyncing(false);
    }
  };

  // --- Admin Authentication Handlers ---
  const handleAdminLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setAdminLoginError('');
    const endpoint = adminPasscodeConfigured ? '/api/admin/login' : '/api/admin/setup';
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: adminPasswordInput }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Authentication failed.');
      }
      localStorage.setItem('prestier_admin_token', data.token);
      setAdminAuthenticated(true);
      setAdminPasscodeConfigured(true);
      setAdminPasswordInput('');
    } catch (err: any) {
      setAdminLoginError(err?.message || 'Invalid passcode.');
    }
  };

  // --- WhatsApp Engine Handlers ---
  const handleStartWhatsAppConnect = async () => {
    const token = localStorage.getItem('prestier_admin_token');
    setWaLoading(true);
    try {
      await fetch('/api/whatsapp/connect', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ pairingPhone: pairingPhoneInput }),
      });
    } catch (err) {
      console.error('WhatsApp connect trigger error:', err);
    } finally {
      setWaLoading(false);
    }
  };

  const handleDisconnectWhatsApp = async () => {
    const token = localStorage.getItem('prestier_admin_token');
    if (!confirm('Are you sure you want to unlink WhatsApp? 24x7 automated messaging will pause.'))
      return;
    try {
      await fetch('/api/whatsapp/disconnect', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (err) {
      console.error('WhatsApp disconnect error:', err);
    }
  };

  const handleSaveWhatsAppSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    const token = localStorage.getItem('prestier_admin_token');
    try {
      const res = await fetch('/api/whatsapp/settings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(waEngineState.settings),
      });
      if (res.ok) {
        alert('WhatsApp settings saved successfully!');
      }
    } catch {
      alert('Failed to save settings.');
    }
  };

  const handleSendTestWhatsApp = async (e: React.FormEvent) => {
    e.preventDefault();
    const token = localStorage.getItem('prestier_admin_token');
    try {
      const res = await fetch('/api/whatsapp/test-message', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          phone: testWhatsAppPhone,
          text: testWhatsAppText,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      alert('Test WhatsApp message sent successfully!');
      setTestWhatsAppPhone('');
      setTestWhatsAppText('');
    } catch (err: any) {
      alert(err?.message || 'Failed to send test message.');
    }
  };

  // Filter leads for admin table
  const filteredLeads = leads.filter((l) => {
    if (!adminSearchQuery.trim()) return true;
    const q = adminSearchQuery.toLowerCase();
    return (
      l.name.toLowerCase().includes(q) ||
      l.companyName.toLowerCase().includes(q) ||
      l.phone.toLowerCase().includes(q) ||
      l.productInterest.toLowerCase().includes(q) ||
      l.leadId.toLowerCase().includes(q)
    );
  });

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col relative selection:bg-amber-500/30 selection:text-amber-200">
      {/* Steel Manufacturing Background Image with Dark Scrim */}
      <div className="absolute inset-0 z-0 overflow-hidden pointer-events-none">
        <img
          src="/src/assets/images/steel_manufacturing_bg_1795501416598.jpg"
          alt="Prestier Steel Manufacturing Facility"
          className="w-full h-full object-cover opacity-22 scale-105 filter brightness-75 contrast-125"
          referrerPolicy="no-referrer"
        />
        <div className="absolute inset-0 bg-gradient-to-b from-slate-950/90 via-slate-950/80 to-slate-950/95" />
      </div>

      {/* --- Top Header Contract --- */}
      <header className="relative z-10 flex items-center justify-between gap-4 px-6 md:px-12 py-5 border-b border-slate-800/80 backdrop-blur-md bg-slate-950/60">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl overflow-hidden shadow-lg border border-amber-500/30 shrink-0 bg-slate-900">
            <img
              src="/src/assets/images/prestier_logo_emblem_1795501498338.jpg"
              alt="Prestier System LLP Logo"
              className="w-full h-full object-cover"
              referrerPolicy="no-referrer"
            />
          </div>
          <div>
            <span className="text-lg md:text-xl font-bold tracking-tight text-white whitespace-nowrap">
              Prestier System LLP
            </span>
            <p className="text-[11px] font-medium text-amber-400 tracking-wide uppercase">
              Precision Steel Manufacturing & Retail Systems
            </p>
          </div>
        </div>

        <div className="hidden lg:flex items-center gap-8 text-sm font-medium text-slate-300">
          <span className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-emerald-400" />
            ISO 9001 Certified OEM
          </span>
          <span className="flex items-center gap-2">
            <Database className="w-4 h-4 text-sky-400" />
            Real-Time Google Sheets Sync
          </span>
          <span className="flex items-center gap-2">
            <Smartphone className="w-4 h-4 text-amber-400" />
            24x7 WhatsApp Engine
          </span>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <button
            onClick={() => setSheetModalOpen(true)}
            className="flex items-center gap-2 px-3.5 py-2 text-xs font-semibold rounded-lg bg-emerald-600/20 border border-emerald-500/40 text-emerald-300 hover:bg-emerald-600/30 transition-colors shadow-sm"
          >
            <FileSpreadsheet className="w-4 h-4 text-emerald-400" />
            <span className="hidden sm:inline">
              {connectedSheet ? 'Connected Sheet' : 'Link Google Sheet'}
            </span>
          </button>
        </div>
      </header>

      {/* --- Main Content Area --- */}
      <main className="relative z-10 flex-1 flex flex-col items-center justify-center px-4 py-10 md:py-16">
        <div className="w-full max-w-2xl mx-auto">
          {/* Hero Intro */}
          <div className="text-center mb-8">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs font-semibold mb-3">
              <Sparkles className="w-3.5 h-3.5 text-amber-400" />
              Industrial Partner Portal
            </div>
            <h1 className="text-3xl md:text-4xl font-extrabold tracking-tight text-white mb-3 text-balance">
              Request Stainless Steel Equipment Quote
            </h1>
            <p className="text-sm md:text-base text-slate-400 max-w-lg mx-auto">
              Fill out your requirements below. Every keystroke is auto-saved in real time and synced instantly to our secure live database and Google Sheet.
            </p>
          </div>

          {/* Lead Capture Form Card */}
          <div className="bg-slate-900/90 border border-slate-800 rounded-2xl shadow-2xl backdrop-blur-xl p-6 md:p-8 relative overflow-hidden">
            {/* Top Accent Line */}
            <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-amber-500 via-sky-500 to-emerald-500" />

            {submittedSuccess ? (
              <div className="py-12 text-center space-y-4">
                <div className="w-16 h-16 bg-emerald-500/20 border border-emerald-500/50 rounded-full flex items-center justify-center mx-auto text-emerald-400">
                  <CheckCircle2 className="w-8 h-8" />
                </div>
                <h3 className="text-2xl font-bold text-white">Inquiry Successfully Submitted!</h3>
                <p className="text-sm text-slate-300 max-w-md mx-auto">
                  Thank you, <strong className="text-white">{formData.name}</strong>. Your requirement has been confirmed and synced to Prestier System LLP's live Google Sheet & WhatsApp dispatch queue.
                </p>
                <div className="pt-4 flex flex-col sm:flex-row items-center justify-center gap-3">
                  <a
                    href={buildWhatsAppDirectUrl(
                      formData.phone,
                      buildWhatsAppConfirmationMessage(formData)
                    )}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-6 py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-sm transition-colors shadow-lg shadow-emerald-900/30"
                  >
                    <Send className="w-4 h-4" />
                    Open WhatsApp Confirmation
                  </a>
                  <button
                    onClick={() => {
                      setSubmittedSuccess(false);
                      setFormData({
                        name: '',
                        phone: '',
                        companyName: '',
                        outletsCount: '',
                        productInterest: '',
                      });
                      const newTok = generateSessionToken();
                      const newId = `lead_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
                      setSessionToken(newTok);
                      setLeadId(newId);
                      localStorage.setItem('prestier_session_token', newTok);
                      localStorage.setItem('prestier_lead_id', newId);
                    }}
                    className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-6 py-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold text-sm transition-colors border border-slate-700"
                  >
                    <RefreshCw className="w-4 h-4" />
                    Submit Another Inquiry
                  </button>
                </div>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-5">
                {/* Auto-save status indicator */}
                <div className="flex items-center justify-between text-xs text-slate-400 px-1">
                  <span>Complete all fields to submit</span>
                  <span className="flex items-center gap-1.5 font-medium">
                    {autoSaveStatus === 'saving' && (
                      <>
                        <RefreshCw className="w-3.5 h-3.5 animate-spin text-amber-400" />
                        <span className="text-amber-400">Auto-saving live draft...</span>
                      </>
                    )}
                    {autoSaveStatus === 'saved' && (
                      <>
                        <Check className="w-3.5 h-3.5 text-emerald-400" />
                        <span className="text-emerald-400">Live synced to sheet</span>
                      </>
                    )}
                    {autoSaveStatus === 'idle' && (
                      <>
                        <span className="w-2 h-2 rounded-full bg-emerald-500 inline-block animate-pulse" />
                        <span>Real-time sync active</span>
                      </>
                    )}
                  </span>
                </div>

                {/* Full Name */}
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider text-slate-300 mb-1.5">
                    Full Name <span className="text-amber-400">*</span>
                  </label>
                  <div className="relative">
                    <span className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-500">
                      <User className="w-4 h-4" />
                    </span>
                    <input
                      type="text"
                      required
                      value={formData.name}
                      onChange={(e) => handleInputChange('name', e.target.value)}
                      placeholder="e.g. Rajesh Sharma"
                      className="w-full pl-10 pr-4 py-3 bg-slate-950/60 border border-slate-800 rounded-xl text-sm text-white placeholder-slate-500 focus:outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500 transition-colors"
                    />
                  </div>
                  {errors.name && <p className="text-xs text-rose-400 mt-1">{errors.name}</p>}
                </div>

                {/* Phone Number (Placed right under Name as requested) */}
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider text-slate-300 mb-1.5">
                    Phone / WhatsApp Number <span className="text-amber-400">*</span>
                  </label>
                  <div className="relative">
                    <span className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-500">
                      <Phone className="w-4 h-4" />
                    </span>
                    <input
                      type="tel"
                      required
                      value={formData.phone}
                      onChange={(e) => handleInputChange('phone', e.target.value)}
                      placeholder="e.g. +91 98765 43210"
                      className="w-full pl-10 pr-4 py-3 bg-slate-950/60 border border-slate-800 rounded-xl text-sm text-white placeholder-slate-500 focus:outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500 transition-colors"
                    />
                  </div>
                  {errors.phone && <p className="text-xs text-rose-400 mt-1">{errors.phone}</p>}
                </div>

                {/* Company Name */}
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider text-slate-300 mb-1.5">
                    Company / Brand Name <span className="text-amber-400">*</span>
                  </label>
                  <div className="relative">
                    <span className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-500">
                      <Building2 className="w-4 h-4" />
                    </span>
                    <input
                      type="text"
                      required
                      value={formData.companyName}
                      onChange={(e) => handleInputChange('companyName', e.target.value)}
                      placeholder="e.g. Apex Hypermarket Chains"
                      className="w-full pl-10 pr-4 py-3 bg-slate-950/60 border border-slate-800 rounded-xl text-sm text-white placeholder-slate-500 focus:outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500 transition-colors"
                    />
                  </div>
                  {errors.companyName && (
                    <p className="text-xs text-rose-400 mt-1">{errors.companyName}</p>
                  )}
                </div>

                {/* Number of Outlets */}
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider text-slate-300 mb-1.5">
                    Number of Outlets <span className="text-amber-400">*</span>
                  </label>
                  <div className="relative">
                    <span className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-500">
                      <Store className="w-4 h-4" />
                    </span>
                    <input
                      type="number"
                      min="1"
                      required
                      value={formData.outletsCount}
                      onChange={(e) => handleInputChange('outletsCount', e.target.value)}
                      placeholder="e.g. 15"
                      className="w-full pl-10 pr-4 py-3 bg-slate-950/60 border border-slate-800 rounded-xl text-sm text-white placeholder-slate-500 focus:outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500 transition-colors tabular-nums"
                    />
                  </div>
                  {errors.outletsCount && (
                    <p className="text-xs text-rose-400 mt-1">{errors.outletsCount}</p>
                  )}
                </div>

                {/* Product Interest Selection (3 required options) */}
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider text-slate-300 mb-2">
                    Product Interest (Select One) <span className="text-amber-400">*</span>
                  </label>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    {PRODUCT_OPTIONS.map((opt) => {
                      const selected = formData.productInterest === opt.value;
                      return (
                        <button
                          type="button"
                          key={opt.value}
                          onClick={() => handleInputChange('productInterest', opt.value)}
                          className={`p-3.5 rounded-xl border text-left transition-all flex flex-col justify-between ${
                            selected
                              ? 'bg-amber-500/15 border-amber-500 text-white shadow-md shadow-amber-950/40 ring-1 ring-amber-500'
                              : 'bg-slate-950/40 border-slate-800 text-slate-300 hover:border-slate-700 hover:bg-slate-900/60'
                          }`}
                        >
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-xs font-bold uppercase tracking-wider text-amber-400">
                              {opt.shortLabel}
                            </span>
                            <div
                              className={`w-4 h-4 rounded-full border flex items-center justify-center ${
                                selected
                                  ? 'border-amber-400 bg-amber-400 text-slate-950'
                                  : 'border-slate-700 bg-slate-900'
                              }`}
                            >
                              {selected && <Check className="w-3 h-3 stroke-[3]" />}
                            </div>
                          </div>
                          <p className="text-xs text-slate-400 leading-snug">{opt.description}</p>
                        </button>
                      );
                    })}
                  </div>
                  {errors.productInterest && (
                    <p className="text-xs text-rose-400 mt-1.5">{errors.productInterest}</p>
                  )}
                </div>

                {/* Submit Button */}
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="w-full mt-4 py-3.5 px-6 rounded-xl bg-gradient-to-r from-amber-500 via-amber-600 to-amber-700 hover:from-amber-400 hover:to-amber-600 text-slate-950 font-bold text-sm tracking-wide shadow-lg shadow-amber-600/30 transition-all flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
                >
                  {isSubmitting ? (
                    <>
                      <RefreshCw className="w-4 h-4 animate-spin" />
                      Processing Inquiry...
                    </>
                  ) : (
                    <>
                      <Send className="w-4 h-4" />
                      Submit & Confirm Quote Request
                    </>
                  )}
                </button>
              </form>
            )}
          </div>
        </div>
      </main>

      {/* --- Footer with Specific Hidden Color Sidebar Trigger --- */}
      <footer className="relative z-10 border-t border-slate-800/80 bg-slate-950/80 px-6 py-6 text-center text-xs text-slate-500 flex flex-col sm:flex-row items-center justify-between gap-4">
        <div>
          © {new Date().getFullYear()} Prestier System LLP. All rights reserved. Precision Steel & Retail Solutions.
        </div>
        <div className="flex items-center gap-3">
          <span>Admin & WhatsApp Portal:</span>
          {/* Specific Hidden Color Box Trigger */}
          <button
            onClick={() => setAdminSidebarOpen(true)}
            title="Click to open Admin Dashboard & 24x7 WhatsApp Manager"
            className="w-6 h-6 rounded-md bg-amber-500 hover:bg-amber-400 transition-transform hover:scale-110 shadow-md shadow-amber-500/30 cursor-pointer border border-amber-300"
          />
        </div>
      </footer>

      {/* --- Google Sheet Connection Modal --- */}
      {sheetModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-md p-6 shadow-2xl relative">
            <h3 className="text-lg font-bold text-white mb-2 flex items-center gap-2">
              <FileSpreadsheet className="w-5 h-5 text-emerald-400" />
              Google Sheets Live Sync
            </h3>
            <p className="text-xs text-slate-400 mb-6">
              Connect Prestier System LLP to Google Sheets so every customer lead (both live partial drafts and confirmed submissions) appears instantly in a colorful table.
            </p>

            {!googleUser ? (
              <div className="space-y-4">
                <button
                  onClick={handleGoogleSignInForSheets}
                  disabled={isConnectingSheet}
                  className="w-full py-3 px-4 rounded-xl bg-white hover:bg-slate-100 text-slate-900 font-semibold text-sm transition-colors flex items-center justify-center gap-3 shadow-md"
                >
                  <svg className="w-5 h-5" viewBox="0 0 24 24">
                    <path
                      fill="#4285F4"
                      d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.66-5.17 3.66-9.17z"
                    />
                    <path
                      fill="#34A853"
                      d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.11-6.72-4.95H1.2v3.15C3.16 21.32 7.21 24 12 24z"
                    />
                    <path
                      fill="#FBBC05"
                      d="M5.28 14.25c-.25-.72-.38-1.5-.38-2.25s.13-1.53.38-2.25V6.6H1.2C.44 8.14 0 9.89 0 12s.44 3.86 1.2 5.4l4.08-3.15z"
                    />
                    <path
                      fill="#EA4335"
                      d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.21 0 3.16 2.68 1.2 6.6l4.08 3.15c.95-2.84 3.6-4.95 6.72-4.95z"
                    />
                  </svg>
                  Sign in with Google & Connect Sheets
                </button>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="p-3 bg-slate-950/60 border border-slate-800 rounded-xl flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center font-bold text-xs">
                      {googleUser.email?.[0]?.toUpperCase() || 'G'}
                    </div>
                    <div className="text-xs">
                      <p className="font-semibold text-white">{googleUser.displayName || 'Google User'}</p>
                      <p className="text-slate-400">{googleUser.email}</p>
                    </div>
                  </div>
                  <button
                    onClick={() => signOutGoogle()}
                    className="text-xs text-slate-400 hover:text-white underline"
                  >
                    Sign out
                  </button>
                </div>

                <div className="pt-2 border-t border-slate-800 space-y-3">
                  <button
                    onClick={handleCreateNewSheet}
                    disabled={isConnectingSheet}
                    className="w-full py-3 px-4 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-sm transition-colors flex items-center justify-center gap-2 shadow-lg"
                  >
                    <FileSpreadsheet className="w-4 h-4" />
                    {isConnectingSheet ? 'Creating Spreadsheet...' : 'Create New Colorful Google Sheet'}
                  </button>

                  <div className="relative flex py-1 items-center">
                    <div className="flex-grow border-t border-slate-800"></div>
                    <span className="flex-shrink mx-4 text-xs text-slate-500">OR LINK EXISTING</span>
                    <div className="flex-grow border-t border-slate-800"></div>
                  </div>

                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={sheetLinkInput}
                      onChange={(e) => setSheetLinkInput(e.target.value)}
                      placeholder="Paste Google Sheet URL or ID"
                      className="flex-1 px-3 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:border-amber-500"
                    />
                    <button
                      onClick={handleConnectExistingSheet}
                      disabled={isConnectingSheet}
                      className="px-4 py-2.5 bg-slate-800 hover:bg-slate-700 text-white font-semibold text-xs rounded-xl transition-colors"
                    >
                      Connect
                    </button>
                  </div>
                </div>

                {connectedSheet && (
                  <div className="mt-4 p-3 bg-emerald-950/30 border border-emerald-500/30 rounded-xl text-xs space-y-1">
                    <p className="font-semibold text-emerald-300 flex items-center gap-1.5">
                      <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                      Connected Spreadsheet Active:
                    </p>
                    <p className="text-slate-300 truncate font-mono">{connectedSheet.title}</p>
                    <a
                      href={connectedSheet.spreadsheetUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-sky-400 hover:underline pt-1"
                    >
                      Open in Google Sheets <ExternalLink className="w-3 h-3" />
                    </a>
                  </div>
                )}
              </div>
            )}

            <div className="mt-6 flex justify-end">
              <button
                onClick={() => setSheetModalOpen(false)}
                className="px-4 py-2 text-xs font-semibold text-slate-400 hover:text-white transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* --- Hidden Color Sidebar / Admin Dashboard --- */}
      {adminSidebarOpen && (
        <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/80 backdrop-blur-sm">
          <div className="w-full max-w-4xl bg-slate-900 border-l border-slate-800 h-full flex flex-col shadow-2xl overflow-hidden animate-in slide-in-from-right duration-300">
            {/* Sidebar Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-950/50">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-amber-500/20 text-amber-400 flex items-center justify-center font-bold">
                  P
                </div>
                <div>
                  <h2 className="text-base font-bold text-white">Prestier Admin & 24x7 WhatsApp Portal</h2>
                  <p className="text-xs text-slate-400">Live Leads Dashboard & Persistent Bot Manager</p>
                </div>
              </div>
              <button
                onClick={() => setAdminSidebarOpen(false)}
                className="p-2 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-white transition-colors"
              >
                ✕
              </button>
            </div>

            {!adminAuthenticated ? (
              <div className="flex-1 flex items-center justify-center p-6">
                <div className="bg-slate-950 border border-slate-800 rounded-2xl p-8 max-w-md w-full shadow-xl">
                  <div className="w-12 h-12 bg-amber-500/20 text-amber-400 rounded-xl flex items-center justify-center mx-auto mb-4">
                    <Lock className="w-6 h-6" />
                  </div>
                  <h3 className="text-lg font-bold text-white text-center mb-2">
                    {adminPasscodeConfigured ? 'Admin Authentication Required' : 'First-Run Admin Passcode Setup'}
                  </h3>
                  <p className="text-xs text-slate-400 text-center mb-6">
                    {adminPasscodeConfigured
                      ? 'Enter your admin passcode to access customer leads and WhatsApp automation settings.'
                      : 'Choose a secure passcode for this server instance to protect your leads and WhatsApp credentials.'}
                  </p>

                  <form onSubmit={handleAdminLogin} className="space-y-4">
                    <div>
                      <input
                        type="password"
                        required
                        value={adminPasswordInput}
                        onChange={(e) => setAdminPasswordInput(e.target.value)}
                        placeholder="Enter admin passcode"
                        className="w-full px-4 py-3 bg-slate-900 border border-slate-800 rounded-xl text-sm text-white placeholder-slate-500 focus:outline-none focus:border-amber-500"
                      />
                    </div>
                    {adminLoginError && (
                      <p className="text-xs text-rose-400 text-center">{adminLoginError}</p>
                    )}
                    <button
                      type="submit"
                      className="w-full py-3 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-sm transition-colors shadow-lg shadow-amber-500/20"
                    >
                      {adminPasscodeConfigured ? 'Unlock Admin Portal' : 'Save & Initialize Admin'}
                    </button>
                  </form>
                </div>
              </div>
            ) : (
              <div className="flex-1 flex flex-col overflow-hidden">
                {/* Admin Tabs */}
                <div className="flex items-center gap-2 px-6 py-3 border-b border-slate-800 bg-slate-950/30 overflow-x-auto">
                  <button
                    onClick={() => setAdminTab('leads')}
                    className={`px-4 py-2 rounded-xl text-xs font-semibold transition-colors flex items-center gap-2 whitespace-nowrap ${
                      adminTab === 'leads'
                        ? 'bg-amber-500 text-slate-950 shadow-md'
                        : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                    }`}
                  >
                    <Database className="w-4 h-4" />
                    Live Leads ({leads.length})
                  </button>
                  <button
                    onClick={() => setAdminTab('whatsapp')}
                    className={`px-4 py-2 rounded-xl text-xs font-semibold transition-colors flex items-center gap-2 whitespace-nowrap ${
                      adminTab === 'whatsapp'
                        ? 'bg-emerald-500 text-slate-950 shadow-md'
                        : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                    }`}
                  >
                    <Smartphone className="w-4 h-4" />
                    24x7 WhatsApp Engine ({waEngineState.status})
                  </button>
                  <button
                    onClick={() => setAdminTab('sheets')}
                    className={`px-4 py-2 rounded-xl text-xs font-semibold transition-colors flex items-center gap-2 whitespace-nowrap ${
                      adminTab === 'sheets'
                        ? 'bg-sky-500 text-slate-950 shadow-md'
                        : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                    }`}
                  >
                    <FileSpreadsheet className="w-4 h-4" />
                    Google Sheets Sync
                  </button>

                  <div className="ml-auto flex items-center gap-2">
                    <button
                      onClick={() => {
                        localStorage.removeItem('prestier_admin_token');
                        setAdminAuthenticated(false);
                      }}
                      className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold flex items-center gap-1.5"
                    >
                      <LogOut className="w-3.5 h-3.5" /> Lock
                    </button>
                  </div>
                </div>

                {/* Tab Content */}
                <div className="flex-1 overflow-y-auto p-6">
                  {adminTab === 'leads' && (
                    <div className="space-y-4">
                      <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
                        <div className="relative w-full sm:w-80">
                          <span className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-500">
                            <Search className="w-4 h-4" />
                          </span>
                          <input
                            type="text"
                            value={adminSearchQuery}
                            onChange={(e) => setAdminSearchQuery(e.target.value)}
                            placeholder="Search leads by name, company..."
                            className="w-full pl-9 pr-4 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:border-amber-500"
                          />
                        </div>

                        <div className="flex items-center gap-2 w-full sm:w-auto">
                          <button
                            onClick={handleSyncAllToSheet}
                            disabled={sheetSyncing}
                            className="flex-1 sm:flex-none px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs transition-colors flex items-center justify-center gap-2 shadow-md"
                          >
                            <FileSpreadsheet className="w-4 h-4" />
                            {sheetSyncing ? 'Syncing...' : 'Sync All to Google Sheet'}
                          </button>
                        </div>
                      </div>

                      {/* Colorful Leads Table */}
                      <div className="border border-slate-800 rounded-2xl overflow-hidden bg-slate-950/40">
                        <div className="overflow-x-auto">
                          <table className="w-full text-left border-collapse text-xs">
                            <thead>
                              <tr className="bg-slate-900 text-slate-300 font-semibold border-b border-slate-800">
                                <th className="p-3">Status</th>
                                <th className="p-3">Full Name</th>
                                <th className="p-3">Phone</th>
                                <th className="p-3">Company Name</th>
                                <th className="p-3">Outlets</th>
                                <th className="p-3">Product Interest</th>
                                <th className="p-3">WhatsApp</th>
                                <th className="p-3">Synced</th>
                                <th className="p-3 text-right">Actions</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-800/60">
                              {filteredLeads.length === 0 ? (
                                <tr>
                                  <td colSpan={9} className="p-8 text-center text-slate-500">
                                    No customer leads captured yet.
                                  </td>
                                </tr>
                              ) : (
                                filteredLeads.map((lead) => {
                                  const isConfirmed = lead.status === 'confirmed';
                                  return (
                                    <tr
                                      key={lead.leadId}
                                      className={`transition-colors hover:bg-slate-900/50 ${
                                        isConfirmed ? 'bg-emerald-950/10' : 'bg-amber-950/10'
                                      }`}
                                    >
                                      <td className="p-3 font-medium">
                                        {isConfirmed ? (
                                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 text-[10px] font-bold">
                                            <CheckCircle2 className="w-3 h-3" /> CONFIRMED
                                          </span>
                                        ) : (
                                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 text-[10px] font-bold animate-pulse">
                                            <Clock className="w-3 h-3" /> PARTIAL DRAFT
                                          </span>
                                        )}
                                      </td>
                                      <td className="p-3 font-semibold text-white">{lead.name || '—'}</td>
                                      <td className="p-3 font-mono text-slate-300">{lead.phone || '—'}</td>
                                      <td className="p-3 text-slate-300">{lead.companyName || '—'}</td>
                                      <td className="p-3 tabular-nums text-slate-300">{lead.outletsCount || '—'}</td>
                                      <td className="p-3">
                                        <span className="px-2 py-0.5 rounded-md bg-slate-800 text-amber-400 font-medium">
                                          {lead.productInterest || 'Pending'}
                                        </span>
                                      </td>
                                      <td className="p-3">
                                        {lead.whatsappSent ? (
                                          <span className="text-emerald-400 font-medium">Sent</span>
                                        ) : (
                                          <span className="text-slate-500">Pending</span>
                                        )}
                                      </td>
                                      <td className="p-3">
                                        {lead.sheetSynced ? (
                                          <span className="text-sky-400 font-medium">Synced</span>
                                        ) : (
                                          <span className="text-slate-500">Not Synced</span>
                                        )}
                                      </td>
                                      <td className="p-3 text-right">
                                        <div className="flex items-center justify-end gap-2">
                                          <a
                                            href={buildWhatsAppDirectUrl(
                                              lead.phone,
                                              buildWhatsAppConfirmationMessage(lead)
                                            )}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            title="Send WhatsApp Message"
                                            className="p-1.5 rounded-lg bg-emerald-600/20 hover:bg-emerald-600/40 text-emerald-300 transition-colors"
                                          >
                                            <Send className="w-3.5 h-3.5" />
                                          </a>
                                          <button
                                            onClick={async () => {
                                              if (!confirm('Delete this lead record?')) return;
                                              const token = localStorage.getItem('prestier_admin_token');
                                              await fetch(`/api/leads/${lead.leadId}`, {
                                                method: 'DELETE',
                                                headers: { Authorization: `Bearer ${token}` },
                                              });
                                              setLeads((prev) => prev.filter((l) => l.leadId !== lead.leadId));
                                            }}
                                            title="Delete Lead"
                                            className="p-1.5 rounded-lg bg-rose-600/20 hover:bg-rose-600/40 text-rose-300 transition-colors"
                                          >
                                            <Trash2 className="w-3.5 h-3.5" />
                                          </button>
                                        </div>
                                      </td>
                                    </tr>
                                  );
                                })
                              )}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    </div>
                  )}

                  {adminTab === 'whatsapp' && (
                    <div className="space-y-6 max-w-2xl mx-auto">
                      <div className="p-6 bg-slate-950 border border-slate-800 rounded-2xl space-y-4">
                        <div className="flex items-center justify-between">
                          <div>
                            <h3 className="text-sm font-bold text-white flex items-center gap-2">
                              <Smartphone className="w-4 h-4 text-emerald-400" />
                              24x7 Persistent WhatsApp Automation
                            </h3>
                            <p className="text-xs text-slate-400 mt-0.5">
                              Never logs out. Auto-dispatches instant quote confirmations whenever a customer submits an inquiry.
                            </p>
                          </div>
                          <span
                            className={`px-2.5 py-1 rounded-full text-xs font-bold uppercase tracking-wider ${
                              waEngineState.status === 'connected'
                                ? 'bg-emerald-500/20 text-emerald-300'
                                : waEngineState.status === 'qr_ready'
                                  ? 'bg-amber-500/20 text-amber-300 animate-pulse'
                                  : 'bg-slate-800 text-slate-400'
                            }`}
                          >
                            {waEngineState.status}
                          </span>
                        </div>

                        {waEngineState.status === 'connected' ? (
                          <div className="p-4 bg-emerald-950/30 border border-emerald-500/30 rounded-xl space-y-2">
                            <p className="text-xs font-semibold text-emerald-300 flex items-center gap-2">
                              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                              WhatsApp Connected Successfully!
                            </p>
                            <p className="text-xs text-slate-300 font-mono">
                              Linked Number: {waEngineState.connectedNumber} ({waEngineState.connectedName || 'Device'})
                            </p>
                            <button
                              onClick={handleDisconnectWhatsApp}
                              className="mt-2 px-3 py-1.5 rounded-lg bg-rose-600/20 hover:bg-rose-600/30 text-rose-300 text-xs font-semibold transition-colors"
                            >
                              Unlink WhatsApp Session
                            </button>
                          </div>
                        ) : waEngineState.status === 'qr_ready' && waEngineState.qrDataUrl ? (
                          <div className="p-6 bg-white rounded-xl text-slate-900 text-center space-y-3">
                            <p className="text-xs font-bold uppercase tracking-wider text-slate-600">
                              Scan QR Code with WhatsApp Mobile
                            </p>
                            <img
                              src={waEngineState.qrDataUrl}
                              alt="WhatsApp QR Code"
                              className="w-56 h-56 mx-auto rounded-lg border shadow-sm"
                            />
                            <p className="text-[11px] text-slate-500">
                              Open WhatsApp on your phone &gt; Linked Devices &gt; Link a Device.
                            </p>
                          </div>
                        ) : (
                          <div className="space-y-4 pt-2">
                            <p className="text-xs text-slate-300">
                              Click below to start the WhatsApp Baileys engine and generate your pairing QR code.
                            </p>
                            <button
                              onClick={handleStartWhatsAppConnect}
                              disabled={waLoading}
                              className="w-full py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs transition-colors flex items-center justify-center gap-2 shadow-lg"
                            >
                              <QrCode className="w-4 h-4" />
                              {waLoading ? 'Starting WhatsApp Engine...' : 'Generate QR Code & Connect WhatsApp'}
                            </button>
                          </div>
                        )}
                      </div>

                      {/* WhatsApp Settings & Test Dispatch */}
                      <form onSubmit={handleSaveWhatsAppSettings} className="p-6 bg-slate-950 border border-slate-800 rounded-2xl space-y-4">
                        <h4 className="text-xs font-bold uppercase tracking-wider text-amber-400">
                          Automated Message Template
                        </h4>
                        <div>
                          <textarea
                            rows={5}
                            value={waEngineState.settings.messageTemplate}
                            onChange={(e) =>
                              setWaEngineState({
                                ...waEngineState,
                                settings: {
                                  ...waEngineState.settings,
                                  messageTemplate: e.target.value,
                                },
                              })
                            }
                            className="w-full p-3 bg-slate-900 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-amber-500 font-mono"
                          />
                          <p className="text-[11px] text-slate-500 mt-1">
                            Available variables: <code>{'{{name}}'}</code>, <code>{'{{companyName}}'}</code>, <code>{'{{outletsCount}}'}</code>, <code>{'{{productInterest}}'}</code>
                          </p>
                        </div>
                        <button
                          type="submit"
                          className="px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-white text-xs font-semibold transition-colors"
                        >
                          Save WhatsApp Settings
                        </button>
                      </form>
                    </div>
                  )}

                  {adminTab === 'sheets' && (
                    <div className="space-y-6 max-w-xl mx-auto">
                      <div className="p-6 bg-slate-950 border border-slate-800 rounded-2xl space-y-4">
                        <h3 className="text-sm font-bold text-white flex items-center gap-2">
                          <FileSpreadsheet className="w-4 h-4 text-sky-400" />
                          Google Sheets Live Synchronization
                        </h3>
                        <p className="text-xs text-slate-400">
                          Connect Prestier System LLP to Google Sheets for real-time live data persistence.
                        </p>

                        {connectedSheet ? (
                          <div className="p-4 bg-emerald-950/30 border border-emerald-500/30 rounded-xl space-y-2">
                            <p className="text-xs font-bold text-emerald-300">Connected Spreadsheet:</p>
                            <p className="text-xs font-mono text-white">{connectedSheet.title}</p>
                            <a
                              href={connectedSheet.spreadsheetUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-xs text-sky-400 hover:underline pt-1"
                            >
                              Open in Google Sheets <ExternalLink className="w-3 h-3" />
                            </a>
                          </div>
                        ) : (
                          <button
                            onClick={() => setSheetModalOpen(true)}
                            className="w-full py-3 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-semibold text-xs transition-colors flex items-center justify-center gap-2"
                          >
                            <FileSpreadsheet className="w-4 h-4" />
                            Connect Google Sheet Now
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
