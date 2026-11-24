import React, { useEffect, useState } from 'react';
import {
  CheckCircle2,
  KeyRound,
  Loader2,
  Lock,
  LogOut,
  MessageCircle,
  QrCode,
  RefreshCw,
  Send,
  ShieldCheck,
  Smartphone,
  Unlink,
  X,
} from 'lucide-react';

interface WhatsAppStatusPayload {
  status: 'disconnected' | 'connecting' | 'qr_ready' | 'pairing_ready' | 'connected';
  qrDataUrl: string | null;
  pairingCode: string | null;
  connectedNumber: string | null;
  connectedName: string | null;
  lastConnectedAt: string | null;
  reconnectAttempts: number;
  lastError: string | null;
  hasSavedSession: boolean;
  authDir: string;
  settings: {
    autoReplyEnabled: boolean;
    messageTemplate: string;
    adminNotifyPhone: string;
  };
}

interface HiddenWhatsAppSidebarProps {
  isOpen: boolean;
  adminToken: string | null;
  isConfigured: boolean;
  onOpenTrigger: () => void;
  onClose: () => void;
  onAdminAuthenticated: (token: string) => void;
  onAdminLogout: () => void;
}

export const HiddenWhatsAppSidebar: React.FC<HiddenWhatsAppSidebarProps> = ({
  isOpen,
  adminToken,
  isConfigured,
  onOpenTrigger,
  onClose,
  onAdminAuthenticated,
  onAdminLogout,
}) => {
  const [passwordInput, setPasswordInput] = useState('');
  const [confirmPasswordInput, setConfirmPasswordInput] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);
  const [isAuthenticating, setIsAuthenticating] = useState(false);

  const [waStatus, setWaStatus] = useState<WhatsAppStatusPayload | null>(null);
  const [isLoadingWa, setIsLoadingWa] = useState(false);
  const [pairingPhone, setPairingPhone] = useState('');
  const [testPhone, setTestPhone] = useState('');
  const [testFeedback, setTestFeedback] = useState<string | null>(null);
  const [settingsFeedback, setSettingsFeedback] = useState<string | null>(null);

  const [autoReplyEnabled, setAutoReplyEnabled] = useState(true);
  const [messageTemplate, setMessageTemplate] = useState('');
  const [adminNotifyPhone, setAdminNotifyPhone] = useState('');
  const [showUnlinkConfirm, setShowUnlinkConfirm] = useState(false);

  const fetchWhatsAppStatus = async (token: string, syncFormFields = false) => {
    try {
      const res = await fetch('/api/whatsapp/status', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const data: WhatsAppStatusPayload = await res.json();
      setWaStatus(data);
      if (syncFormFields && data.settings) {
        setAutoReplyEnabled(data.settings.autoReplyEnabled);
        setMessageTemplate(data.settings.messageTemplate);
        setAdminNotifyPhone(data.settings.adminNotifyPhone);
      }
    } catch {
      // ignore transient network errors
    }
  };

  useEffect(() => {
    if (!isOpen || !adminToken) return;
    setIsLoadingWa(true);
    fetchWhatsAppStatus(adminToken, true).finally(() => setIsLoadingWa(false));

    const interval = setInterval(() => {
      fetchWhatsAppStatus(adminToken, false);
    }, 3500);
    return () => clearInterval(interval);
  }, [isOpen, adminToken]);

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);

    if (!passwordInput.trim()) {
      setAuthError('Please enter your admin password.');
      return;
    }

    if (!isConfigured && passwordInput.trim() !== confirmPasswordInput.trim()) {
      setAuthError('Passwords do not match.');
      return;
    }

    setIsAuthenticating(true);
    try {
      const endpoint = isConfigured ? '/api/admin/login' : '/api/admin/setup';
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: passwordInput.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setAuthError(data.error || 'Authentication failed.');
        return;
      }
      setPasswordInput('');
      setConfirmPasswordInput('');
      onAdminAuthenticated(data.token);
    } catch {
      setAuthError('Unable to reach server.');
    } finally {
      setIsAuthenticating(false);
    }
  };

  const handleStartWhatsApp = async (usePairingPhone = false) => {
    if (!adminToken) return;
    setIsLoadingWa(true);
    setTestFeedback(null);
    try {
      await fetch('/api/whatsapp/connect', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          pairingPhone: usePairingPhone ? pairingPhone.trim() : '',
        }),
      });
      setTimeout(() => {
        fetchWhatsAppStatus(adminToken, false);
      }, 1200);
    } finally {
      setIsLoadingWa(false);
    }
  };

  const handleUnlinkWhatsApp = async () => {
    if (!adminToken) return;
    setIsLoadingWa(true);
    setShowUnlinkConfirm(false);
    try {
      await fetch('/api/whatsapp/disconnect', {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      await fetchWhatsAppStatus(adminToken, false);
    } finally {
      setIsLoadingWa(false);
    }
  };

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!adminToken) return;
    setSettingsFeedback(null);
    const res = await fetch('/api/whatsapp/settings', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        autoReplyEnabled,
        messageTemplate,
        adminNotifyPhone,
      }),
    });
    if (res.ok) {
      setSettingsFeedback('24x7 WhatsApp automation rules saved.');
      fetchWhatsAppStatus(adminToken, false);
    }
  };

  const handleSendTestMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!adminToken || !testPhone.trim()) return;
    setTestFeedback(null);
    const res = await fetch('/api/whatsapp/test-message', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ phone: testPhone.trim() }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      setTestFeedback(`Test message delivered to ${testPhone.trim()}.`);
    } else {
      setTestFeedback(data.error || 'Could not dispatch test message.');
    }
  };

  return (
    <>
      {/* Specific Color Secret Edge Trigger Tab (Amber-Gold / Emerald Industrial Color Strip on Right Edge) */}
      <button
        type="button"
        onClick={onOpenTrigger}
        aria-label="Open Hidden WhatsApp Admin Sidebar"
        title="Admin Access — Click Amber Color Tab"
        className="fixed right-0 top-1/2 -translate-y-1/2 z-40 h-24 w-3.5 hover:w-5 rounded-l-xl bg-amber-500 hover:bg-amber-400 shadow-lg shadow-amber-500/30 border-l border-y border-amber-300/60 transition-all cursor-pointer flex items-center justify-center group"
      >
        <span className="sr-only">Open Hidden WhatsApp Admin Sidebar</span>
        <span className="h-10 w-1 rounded-full bg-slate-950/60 group-hover:bg-slate-950" />
      </button>

      {/* Slide-Over Hidden Drawer */}
      {isOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="hidden-wa-sidebar-title"
          className="fixed inset-0 z-50 flex justify-end bg-slate-950/75 backdrop-blur-sm"
        >
          <aside className="relative w-full max-w-md bg-slate-900 border-l border-slate-800 h-full overflow-y-auto p-6 flex flex-col justify-between shadow-2xl">
            <div className="space-y-6">
              {/* Drawer Header */}
              <div className="flex items-center justify-between border-b border-slate-800 pb-4">
                <div className="flex items-center gap-2.5">
                  <div className="h-9 w-9 rounded-xl bg-amber-500/15 border border-amber-500/40 flex items-center justify-center text-amber-400">
                    <MessageCircle className="h-5 w-5" />
                  </div>
                  <div>
                    <h2
                      id="hidden-wa-sidebar-title"
                      className="font-display text-base font-bold text-white"
                    >
                      24x7 Persistent WhatsApp Vault
                    </h2>
                    <p className="text-xs text-slate-400">
                      Prestier System LLP · Railway &amp; Cloud Keep-Alive
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={onClose}
                  aria-label="Close WhatsApp Admin Sidebar"
                  className="rounded-lg p-2 text-slate-400 hover:text-white hover:bg-slate-800 transition-colors cursor-pointer"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              {!adminToken ? (
                <form onSubmit={handlePasswordSubmit} className="space-y-4 pt-2">
                  <div className="rounded-xl border border-amber-500/30 bg-amber-950/25 p-4 space-y-1.5">
                    <div className="flex items-center gap-2 text-amber-300 font-semibold text-sm">
                      <Lock className="h-4 w-4 shrink-0" />
                      <span>Protected Admin Access</span>
                    </div>
                    <p className="text-xs text-slate-300 leading-relaxed">
                      Enter admin password (default: <span className="font-mono text-amber-300">5060</span>) to unlock WhatsApp automation &amp; lead controls.
                    </p>
                  </div>

                  <div>
                    <label
                      htmlFor="admin-vault-password"
                      className="block text-xs font-medium text-slate-300 mb-1.5"
                    >
                      Admin Password
                    </label>
                    <div className="relative">
                      <KeyRound className="h-4 w-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                      <input
                        id="admin-vault-password"
                        type="password"
                        required
                        value={passwordInput}
                        onChange={(e) => setPasswordInput(e.target.value)}
                        placeholder="Enter password (e.g. 5060)"
                        className="w-full rounded-xl border border-slate-700 bg-slate-950 pl-10 pr-4 py-2.5 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-amber-400"
                      />
                    </div>
                  </div>

                  {authError && (
                    <p role="alert" className="text-xs text-rose-400">
                      {authError}
                    </p>
                  )}

                  <button
                    type="submit"
                    disabled={isAuthenticating}
                    className="w-full rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-display font-bold text-sm py-3 px-4 transition-colors flex items-center justify-center gap-2 cursor-pointer"
                  >
                    {isAuthenticating ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        <span>Verifying…</span>
                      </>
                    ) : (
                      <>
                        <ShieldCheck className="h-4 w-4" />
                        <span>Unlock Admin Vault</span>
                      </>
                    )}
                  </button>
                </form>
              ) : (
                <div className="space-y-5">
                  {/* Live Connection Status Banner */}
                  <div className="rounded-xl border border-slate-800 bg-slate-950/90 p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-xs text-slate-400">24x7 Multi-Device Session</p>
                        <p className="font-display text-sm font-bold text-white mt-0.5">
                          {waStatus?.status === 'connected'
                            ? `Connected (${waStatus.connectedNumber || 'Active'})`
                            : waStatus?.status === 'qr_ready'
                              ? 'Ready to Scan QR Code'
                              : waStatus?.status === 'pairing_ready'
                                ? 'Pairing Code Ready'
                                : waStatus?.status === 'connecting'
                                  ? 'Connecting to WhatsApp…'
                                  : 'Not Linked Yet'}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleStartWhatsApp(false)}
                        disabled={isLoadingWa}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium px-3 py-1.5 transition-colors cursor-pointer"
                      >
                        <RefreshCw className={`h-3.5 w-3.5 ${isLoadingWa ? 'animate-spin' : ''}`} />
                        <span>
                          {waStatus?.status === 'connected' ? 'Ping Keep-Alive' : 'Generate QR'}
                        </span>
                      </button>
                    </div>

                    <p className="text-xs text-slate-400 leading-relaxed">
                      Credentials persist in{' '}
                      <span className="font-mono text-slate-300">
                        {waStatus?.authDir || './data/whatsapp_auth'}
                      </span>{' '}
                      with automatic exponential-backoff reconnect and 4-minute presence heartbeat so
                      your WhatsApp never logs out on Railway.
                    </p>

                    {waStatus?.lastError && (
                      <p className="text-xs text-amber-300 bg-amber-950/40 border border-amber-500/30 rounded-lg px-3 py-2">
                        {waStatus.lastError}
                      </p>
                    )}

                    {/* QR Code Display */}
                    {waStatus?.qrDataUrl && waStatus.status !== 'connected' && (
                      <div className="flex flex-col items-center justify-center rounded-xl bg-white p-4 space-y-2">
                        <img
                          src={waStatus.qrDataUrl}
                          alt="WhatsApp Multi-Device Login QR Code"
                          className="h-56 w-56 object-contain"
                        />
                        <p className="text-xs font-medium text-slate-800 text-center">
                          Open WhatsApp on your phone → Linked Devices → Link a Device
                        </p>
                      </div>
                    )}

                    {/* Phone Number Pairing Code Alternative */}
                    {waStatus?.status !== 'connected' && (
                      <div className="pt-2 border-t border-slate-800/80 space-y-2">
                        <label
                          htmlFor="wa-pairing-phone"
                          className="block text-xs font-medium text-slate-300"
                        >
                          Or Link with Phone Number Pairing Code:
                        </label>
                        <div className="flex items-center gap-2">
                          <input
                            id="wa-pairing-phone"
                            type="tel"
                            value={pairingPhone}
                            onChange={(e) => setPairingPhone(e.target.value)}
                            placeholder="e.g. 919876543210"
                            className="flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-white placeholder:text-slate-500 focus:outline-none focus:border-sky-400 tabular-nums"
                          />
                          <button
                            type="button"
                            onClick={() => handleStartWhatsApp(true)}
                            disabled={isLoadingWa || !pairingPhone.trim()}
                            className="inline-flex items-center gap-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white text-xs font-semibold px-3 py-2 transition-colors whitespace-nowrap cursor-pointer"
                          >
                            <Smartphone className="h-3.5 w-3.5" />
                            <span>Get Code</span>
                          </button>
                        </div>
                        {waStatus?.pairingCode && (
                          <div className="rounded-lg bg-emerald-950/60 border border-emerald-500/40 p-3 text-center">
                            <p className="text-xs text-emerald-300">Enter this code in WhatsApp:</p>
                            <p className="font-mono text-xl font-bold tracking-widest text-white mt-1">
                              {waStatus.pairingCode}
                            </p>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Connected State Actions */}
                    {waStatus?.status === 'connected' && (
                      <div className="flex items-center justify-between pt-2 border-t border-slate-800">
                        <span className="text-xs text-emerald-400 font-medium flex items-center gap-1.5">
                          <CheckCircle2 className="h-4 w-4" />
                          24x7 Auto-Keepalive Active
                        </span>
                        <button
                          type="button"
                          onClick={() => setShowUnlinkConfirm(true)}
                          className="inline-flex items-center gap-1 text-xs text-rose-400 hover:text-rose-300 font-medium cursor-pointer"
                        >
                          <Unlink className="h-3.5 w-3.5" />
                          <span>Unlink Device</span>
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Confirmation Modal before Unlinking WhatsApp */}
                  {showUnlinkConfirm && (
                    <div className="rounded-xl border border-rose-500/40 bg-rose-950/30 p-4 space-y-3">
                      <p className="text-xs text-slate-200 font-medium">
                        Unlink this WhatsApp session? You will need to scan a new QR code to resume
                        automated 24x7 messages.
                      </p>
                      <div className="flex items-center justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => setShowUnlinkConfirm(false)}
                          className="rounded-lg border border-slate-700 bg-slate-800 text-slate-200 text-xs px-3 py-1.5 cursor-pointer"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={handleUnlinkWhatsApp}
                          className="rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold px-3 py-1.5 cursor-pointer"
                        >
                          Confirm Unlink
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Automated Reply Settings Form */}
                  <form
                    onSubmit={handleSaveSettings}
                    className="rounded-xl border border-slate-800 bg-slate-950/70 p-4 space-y-3.5"
                  >
                    <div className="flex items-center justify-between">
                      <label
                        htmlFor="wa-auto-reply-toggle"
                        className="text-xs font-semibold text-white"
                      >
                        Instant Auto-WhatsApp on Lead Submit
                      </label>
                      <input
                        id="wa-auto-reply-toggle"
                        type="checkbox"
                        checked={autoReplyEnabled}
                        onChange={(e) => setAutoReplyEnabled(e.target.checked)}
                        className="h-4 w-4 accent-emerald-500"
                      />
                    </div>

                    <div>
                      <label
                        htmlFor="wa-admin-notify-phone"
                        className="block text-xs font-medium text-slate-300 mb-1"
                      >
                        Admin Alert WhatsApp Number (Optional)
                      </label>
                      <input
                        id="wa-admin-notify-phone"
                        type="tel"
                        value={adminNotifyPhone}
                        onChange={(e) => setAdminNotifyPhone(e.target.value)}
                        placeholder="Receive instant lead alerts (e.g. 919876543210)"
                        className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-white placeholder:text-slate-500 focus:outline-none focus:border-sky-400 tabular-nums"
                      />
                    </div>

                    <div>
                      <label
                        htmlFor="wa-template-input"
                        className="block text-xs font-medium text-slate-300 mb-1"
                      >
                        Customer WhatsApp Confirmation Template
                      </label>
                      <textarea
                        id="wa-template-input"
                        rows={5}
                        value={messageTemplate}
                        onChange={(e) => setMessageTemplate(e.target.value)}
                        className="w-full rounded-lg border border-slate-700 bg-slate-900 p-2.5 text-xs text-white font-mono focus:outline-none focus:border-sky-400"
                      />
                      <p className="text-[11px] text-slate-400 mt-1">
                        Variables: {'{{name}}'}, {'{{companyName}}'}, {'{{outletsCount}}'},{' '}
                        {'{{productInterest}}'}
                      </p>
                    </div>

                    {settingsFeedback && (
                      <p className="text-xs text-emerald-400">{settingsFeedback}</p>
                    )}

                    <button
                      type="submit"
                      className="w-full rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold py-2.5 px-4 transition-colors cursor-pointer"
                    >
                      Save 24x7 Automation Settings
                    </button>
                  </form>

                  {/* Send Live Test Message */}
                  <form
                    onSubmit={handleSendTestMessage}
                    className="rounded-xl border border-slate-800 bg-slate-950/70 p-4 space-y-2.5"
                  >
                    <label
                      htmlFor="wa-test-phone"
                      className="block text-xs font-semibold text-white"
                    >
                      Send Test WhatsApp Message
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        id="wa-test-phone"
                        type="tel"
                        value={testPhone}
                        onChange={(e) => setTestPhone(e.target.value)}
                        placeholder="Recipient phone (e.g. 9876543210)"
                        className="flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-white placeholder:text-slate-500 focus:outline-none focus:border-sky-400 tabular-nums"
                      />
                      <button
                        type="submit"
                        className="inline-flex items-center gap-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-white text-xs font-semibold px-3 py-2 transition-colors cursor-pointer"
                      >
                        <Send className="h-3.5 w-3.5" />
                        <span>Test</span>
                      </button>
                    </div>
                    {testFeedback && <p className="text-xs text-sky-300">{testFeedback}</p>}
                  </form>
                </div>
              )}
            </div>

            {/* Footer Lock & Railway Deployment Note */}
            <div className="pt-6 border-t border-slate-800 mt-6 flex items-center justify-between text-xs text-slate-400">
              <div className="flex items-center gap-1.5">
                <QrCode className="h-3.5 w-3.5 text-amber-400" />
                <span>Railway Volume Ready</span>
              </div>
              {adminToken && (
                <button
                  type="button"
                  onClick={onAdminLogout}
                  className="inline-flex items-center gap-1 text-slate-300 hover:text-white font-medium cursor-pointer"
                >
                  <LogOut className="h-3.5 w-3.5" />
                  <span>Lock Sidebar</span>
                </button>
              )}
            </div>
          </aside>
        </div>
      )}
    </>
  );
};
