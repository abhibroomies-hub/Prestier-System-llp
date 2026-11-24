import React, { useEffect, useState } from 'react';
import {
  Loader2,
  MessageCircle,
  RefreshCw,
  RotateCcw,
  Send,
  Unlink,
} from 'lucide-react';
import {
  DEFAULT_PRESTAIR_WHATSAPP_REPLY,
  PRESTAIR_REPLY_IMAGES,
} from '../utils/leadLogic';

interface WhatsAppStatusPayload {
  status: 'disconnected' | 'connecting' | 'qr_ready' | 'pairing_ready' | 'connected';
  qrDataUrl: string | null;
  pairingCode: string | null;
  connectedNumber: string | null;
  cloudWorkerConnected?: boolean;
  cloudConnectedNumber?: string | null;
  lastError: string | null;
  settings: {
    autoReplyEnabled: boolean;
    messageTemplate: string;
    adminNotifyPhone: string;
  };
}

interface HiddenWhatsAppSidebarProps {
  adminToken: string | null;
}

export const HiddenWhatsAppSidebar: React.FC<HiddenWhatsAppSidebarProps> = ({ adminToken }) => {
  const [waStatus, setWaStatus] = useState<WhatsAppStatusPayload | null>(null);
  const [isLoadingWa, setIsLoadingWa] = useState(false);
  const [pairingPhone, setPairingPhone] = useState('');
  const [testPhone, setTestPhone] = useState('');
  const [isSendingTest, setIsSendingTest] = useState(false);
  const [testFeedback, setTestFeedback] = useState<string | null>(null);
  const [settingsFeedback, setSettingsFeedback] = useState<string | null>(null);

  const [autoReplyEnabled, setAutoReplyEnabled] = useState(true);
  const [messageTemplate, setMessageTemplate] = useState(DEFAULT_PRESTAIR_WHATSAPP_REPLY);
  const [adminNotifyPhone, setAdminNotifyPhone] = useState('');
  const [showUnlinkConfirm, setShowUnlinkConfirm] = useState(false);
  const [isEditingSettings, setIsEditingSettings] = useState(false);

  const fetchWhatsAppStatus = async (syncFormFields = false) => {
    try {
      const res = await fetch('/api/whatsapp/status', {
        cache: 'no-store',
        headers: adminToken ? { Authorization: `Bearer ${adminToken}` } : {},
      });
      if (!res.ok) return;
      const data: WhatsAppStatusPayload = await res.json();
      setWaStatus(data);
      if ((syncFormFields || !isEditingSettings) && data.settings) {
        setAutoReplyEnabled(data.settings.autoReplyEnabled);
        setMessageTemplate(data.settings.messageTemplate || DEFAULT_PRESTAIR_WHATSAPP_REPLY);
        setAdminNotifyPhone(data.settings.adminNotifyPhone || '');
      }
    } catch {
      // ignore transient network error
    }
  };

  useEffect(() => {
    setIsLoadingWa(true);
    void fetchWhatsAppStatus(true).finally(() => setIsLoadingWa(false));
    const interval = setInterval(() => {
      void fetchWhatsAppStatus(false);
    }, 3500);
    return () => clearInterval(interval);
  }, [adminToken, isEditingSettings]);

  const handleStartWhatsApp = async (usePairingPhone = false) => {
    setIsLoadingWa(true);
    setTestFeedback(null);
    try {
      await fetch('/api/whatsapp/connect', {
        method: 'POST',
        headers: {
          ...(adminToken ? { Authorization: `Bearer ${adminToken}` } : {}),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          pairingPhone: usePairingPhone ? pairingPhone.trim() : '',
        }),
      });
      setTimeout(() => {
        void fetchWhatsAppStatus(false);
      }, 1200);
    } finally {
      setIsLoadingWa(false);
    }
  };

  const handleUnlinkWhatsApp = async () => {
    setIsLoadingWa(true);
    setShowUnlinkConfirm(false);
    try {
      await fetch('/api/whatsapp/disconnect', {
        method: 'POST',
        headers: adminToken ? { Authorization: `Bearer ${adminToken}` } : {},
      });
      await fetchWhatsAppStatus(false);
    } finally {
      setIsLoadingWa(false);
    }
  };

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setSettingsFeedback(null);
    const res = await fetch('/api/whatsapp/settings', {
      method: 'POST',
      headers: {
        ...(adminToken ? { Authorization: `Bearer ${adminToken}` } : {}),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        autoReplyEnabled,
        messageTemplate,
        adminNotifyPhone,
      }),
    });
    if (res.ok) {
      setIsEditingSettings(false);
      setSettingsFeedback(
        'WhatsApp auto-reply message & settings saved and synced in real time across all deployments.'
      );
      void fetchWhatsAppStatus(true);
    }
  };

  const handleSendTestMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!testPhone.trim()) return;
    setIsSendingTest(true);
    setTestFeedback(null);
    try {
      const res = await fetch('/api/whatsapp/test-message', {
        method: 'POST',
        headers: {
          ...(adminToken ? { Authorization: `Bearer ${adminToken}` } : {}),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          phone: testPhone.trim(),
          text: messageTemplate,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setTestFeedback(
          data.relayedViaCloud
            ? `Queued test reply + showcase image via active 24x7 Cloud Worker for ${testPhone.trim()}.`
            : `Delivered Prestair reply + showcase image to ${testPhone.trim()}.`
        );
      } else {
        setTestFeedback(data.error || 'Could not dispatch test message.');
      }
    } finally {
      setIsSendingTest(false);
    }
  };

  const isLocalConnected = waStatus?.status === 'connected';
  const isAnyWorkerConnected = isLocalConnected || Boolean(waStatus?.cloudWorkerConnected);
  const activeNumber =
    waStatus?.connectedNumber || waStatus?.cloudConnectedNumber || 'Active';

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
      {/* Left Column: 24x7 Connection & Test Dispatch */}
      <div className="lg:col-span-5 space-y-5">
        <div className="rounded-xl border border-slate-200 bg-white p-5 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <div className="h-9 w-9 rounded-lg bg-emerald-50 border border-emerald-200 flex items-center justify-center text-emerald-700 shrink-0">
                <MessageCircle className="h-5 w-5" />
              </div>
              <div>
                <p className="text-xs text-slate-500">24x7 Persistent WhatsApp Session</p>
                <h3 className="font-display text-sm font-bold text-slate-900">
                  {isLocalConnected
                    ? `Connected (${activeNumber})`
                    : waStatus?.cloudWorkerConnected
                      ? `24x7 Cloud Active (${activeNumber})`
                      : waStatus?.status === 'qr_ready'
                        ? 'Scan QR Code Below'
                        : waStatus?.status === 'pairing_ready'
                          ? 'Enter Pairing Code on Phone'
                          : waStatus?.status === 'connecting'
                            ? 'Connecting to WhatsApp…'
                            : 'Not Linked Yet'}
                </h3>
              </div>
            </div>

            <button
              type="button"
              onClick={() => void handleStartWhatsApp(false)}
              disabled={isLoadingWa}
              className="min-h-10 inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-xs font-medium px-3 py-2 transition-colors cursor-pointer whitespace-nowrap shrink-0"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isLoadingWa ? 'animate-spin' : ''}`} />
              <span>{isAnyWorkerConnected ? 'Check Status' : 'Generate QR'}</span>
            </button>
          </div>

          <p className="text-xs text-slate-600 leading-relaxed">
            Auto-keepalive heartbeat runs every 20 seconds with logout-safe session protection. If linked on your 24x7 Railway server, AI Studio automatically relays messages through it without logging out your session.
          </p>

          {waStatus?.lastError && (
            <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              {waStatus.lastError}
            </p>
          )}

          {waStatus?.qrDataUrl && !isLocalConnected && (
            <div className="flex flex-col items-center justify-center rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-2">
              <img
                src={waStatus.qrDataUrl}
                alt="WhatsApp Multi-Device Login QR Code"
                referrerPolicy="no-referrer"
                className="h-52 w-52 sm:h-56 sm:w-56 object-contain rounded-lg bg-white p-2 border border-slate-200"
              />
              <p className="text-xs font-medium text-slate-700 text-center">
                Open WhatsApp on your phone → Linked Devices → Link a Device
              </p>
            </div>
          )}

          {waStatus?.pairingCode && !isLocalConnected && (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-center space-y-1">
              <p className="text-xs font-medium text-emerald-800">
                Enter this 8-character Pairing Code on WhatsApp:
              </p>
              <p className="font-mono text-xl font-bold tracking-widest text-emerald-950 tabular-nums">
                {waStatus.pairingCode}
              </p>
            </div>
          )}

          {!isAnyWorkerConnected && (
            <div className="pt-3 border-t border-slate-200 space-y-2">
              <label
                htmlFor="wa-pairing-phone"
                className="block text-xs font-semibold text-slate-700"
              >
                Or Link with Phone Number Pairing Code
              </label>
              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                <input
                  id="wa-pairing-phone"
                  type="tel"
                  value={pairingPhone}
                  onChange={(e) => setPairingPhone(e.target.value)}
                  placeholder="e.g. 919876543210"
                  className="flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2.5 sm:py-2 text-base sm:text-xs text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-sky-600 tabular-nums"
                />
                <button
                  type="button"
                  onClick={() => void handleStartWhatsApp(true)}
                  disabled={isLoadingWa || !pairingPhone.trim()}
                  className="min-h-10 rounded-lg bg-slate-900 hover:bg-slate-800 disabled:opacity-50 text-white text-xs font-semibold px-3.5 py-2 transition-colors cursor-pointer whitespace-nowrap shrink-0"
                >
                  Get Code
                </button>
              </div>
            </div>
          )}

          {isLocalConnected && !showUnlinkConfirm && (
            <div className="pt-2 border-t border-slate-100 flex justify-end">
              <button
                type="button"
                onClick={() => setShowUnlinkConfirm(true)}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-rose-600 transition-colors cursor-pointer"
              >
                <Unlink className="h-3.5 w-3.5" />
                <span>Unlink WhatsApp Device</span>
              </button>
            </div>
          )}

          {showUnlinkConfirm && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 space-y-2.5">
              <p className="text-xs text-rose-900 font-medium">
                Unlink this WhatsApp device? You will need to scan a QR code again to resume 24x7 auto-replies.
              </p>
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowUnlinkConfirm(false)}
                  className="rounded-lg border border-slate-300 bg-white text-slate-700 text-xs px-3 py-1.5 cursor-pointer whitespace-nowrap"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void handleUnlinkWhatsApp()}
                  className="rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold px-3 py-1.5 cursor-pointer whitespace-nowrap"
                >
                  Confirm Unlink
                </button>
              </div>
            </div>
          )}
        </div>

        <form
          onSubmit={handleSendTestMessage}
          className="rounded-xl border border-slate-200 bg-white p-5 space-y-3"
        >
          <label
            htmlFor="wa-test-phone"
            className="block text-sm font-bold text-slate-900"
          >
            Send Test Reply + Attached Image
          </label>
          <p className="text-xs text-slate-600">
            Verify instant background delivery of your message and the single Prestair showcase image to any WhatsApp number.
          </p>
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
            <input
              id="wa-test-phone"
              type="tel"
              value={testPhone}
              onChange={(e) => setTestPhone(e.target.value)}
              placeholder="Recipient WhatsApp (e.g. 9876543210)"
              className="flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2.5 sm:py-2 text-base sm:text-xs text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-sky-600 tabular-nums"
            />
            <button
              type="submit"
              disabled={isSendingTest || !testPhone.trim()}
              className="min-h-11 sm:min-h-9 inline-flex items-center justify-center gap-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 disabled:opacity-50 text-white text-xs font-semibold px-4 py-2 transition-colors cursor-pointer whitespace-nowrap shrink-0"
            >
              {isSendingTest ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Send className="h-3.5 w-3.5" />
              )}
              <span>Send Test</span>
            </button>
          </div>
          {testFeedback && (
            <p className="text-xs font-medium text-sky-800 bg-sky-50 border border-sky-200 rounded-lg px-3 py-2">
              {testFeedback}
            </p>
          )}
        </form>
      </div>

      {/* Right Column: Real-Time Synced Auto-Reply Settings */}
      <div className="lg:col-span-7">
        <form
          onSubmit={handleSaveSettings}
          className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5 space-y-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-3.5">
            <div>
              <h3 className="font-display text-sm font-bold text-slate-900">
                Instant Customer Reply &amp; Attached Image (Real-Time Synced)
              </h3>
              <p className="text-xs text-slate-600">
                Synced automatically across AI Studio &amp; Railway—dispatched in the background as soon as a customer submits the form.
              </p>
            </div>
            <label className="min-h-9 inline-flex items-center gap-2 text-xs font-semibold text-slate-800 cursor-pointer shrink-0">
              <input
                type="checkbox"
                checked={autoReplyEnabled}
                onChange={(e) => {
                  setIsEditingSettings(true);
                  setAutoReplyEnabled(e.target.checked);
                }}
                className="h-4 w-4 accent-emerald-600 rounded"
              />
              <span>Auto-Reply Enabled</span>
            </label>
          </div>

          <div>
            <p className="text-xs font-semibold text-slate-700 mb-2">
              Attached WhatsApp Image (1 Image Sent Automatically with Message)
            </p>
            <div className="max-w-sm">
              {PRESTAIR_REPLY_IMAGES.map((src) => (
                <div
                  key={src}
                  className="overflow-hidden rounded-lg border border-slate-200 bg-slate-50 aspect-[16/10]"
                >
                  <img
                    src={src}
                    alt="Prestair WhatsApp Attachment"
                    referrerPolicy="no-referrer"
                    className="h-full w-full object-cover"
                  />
                </div>
              ))}
            </div>
          </div>

          <div>
            <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5">
              <label
                htmlFor="wa-template-input"
                className="block text-xs font-semibold text-slate-700"
              >
                Customer Reply Message
              </label>
              <button
                type="button"
                onClick={() => {
                  setIsEditingSettings(true);
                  setMessageTemplate(DEFAULT_PRESTAIR_WHATSAPP_REPLY);
                }}
                className="inline-flex items-center gap-1 text-xs font-medium text-sky-700 hover:text-sky-800 cursor-pointer whitespace-nowrap"
              >
                <RotateCcw className="h-3 w-3" />
                <span>Restore Default Message</span>
              </button>
            </div>
            <textarea
              id="wa-template-input"
              rows={9}
              value={messageTemplate}
              onChange={(e) => {
                setIsEditingSettings(true);
                setMessageTemplate(e.target.value);
              }}
              className="w-full rounded-lg border border-slate-300 bg-white p-3 text-base sm:text-xs text-slate-900 leading-relaxed focus:outline-none focus:border-sky-600"
            />
          </div>

          <div>
            <label
              htmlFor="wa-admin-notify-phone"
              className="block text-xs font-semibold text-slate-700 mb-1"
            >
              Admin Alert WhatsApp Number (Optional)
            </label>
            <input
              id="wa-admin-notify-phone"
              type="tel"
              value={adminNotifyPhone}
              onChange={(e) => {
                setIsEditingSettings(true);
                setAdminNotifyPhone(e.target.value);
              }}
              placeholder="Receive instant lead summary alerts (e.g. +917318531953)"
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 sm:py-2 text-base sm:text-xs text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-sky-600 tabular-nums"
            />
          </div>

          {settingsFeedback && (
            <p className="text-xs font-medium text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
              {settingsFeedback}
            </p>
          )}

          <button
            type="submit"
            className="w-full min-h-11 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-white text-xs font-semibold py-2.5 px-4 transition-colors cursor-pointer whitespace-nowrap"
          >
            Save WhatsApp Automation Settings
          </button>
        </form>
      </div>
    </div>
  );
};
