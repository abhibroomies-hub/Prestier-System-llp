import React, { useEffect, useState } from 'react';
import {
  CheckCircle2,
  Loader2,
  MessageCircle,
  RefreshCw,
  RotateCcw,
  Send,
  Smartphone,
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
  adminToken: string | null;
}

export const HiddenWhatsAppSidebar: React.FC<HiddenWhatsAppSidebarProps> = ({
  adminToken,
}) => {
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

  const fetchWhatsAppStatus = async (syncFormFields = false) => {
    try {
      const res = await fetch('/api/whatsapp/status', {
        headers: adminToken ? { Authorization: `Bearer ${adminToken}` } : {},
      });
      if (!res.ok) return;
      const data: WhatsAppStatusPayload = await res.json();
      setWaStatus(data);
      if (syncFormFields && data.settings) {
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
    fetchWhatsAppStatus(true).finally(() => setIsLoadingWa(false));

    const interval = setInterval(() => {
      void fetchWhatsAppStatus(false);
    }, 3500);
    return () => clearInterval(interval);
  }, [adminToken]);

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
      setSettingsFeedback('WhatsApp auto-reply message and settings saved.');
      void fetchWhatsAppStatus(false);
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
          `Delivered Prestair reply + showcase image to ${testPhone.trim()}.`
        );
      } else {
        setTestFeedback(data.error || 'Could not dispatch test message.');
      }
    } finally {
      setIsSendingTest(false);
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
      {/* Left Column: 24x7 Multi-Device Link & Test Dispatch */}
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
                  {waStatus?.status === 'connected'
                    ? `Connected (${waStatus.connectedNumber || 'Active'})`
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
              onClick={() => handleStartWhatsApp(false)}
              disabled={isLoadingWa}
              className="min-h-10 inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-xs font-medium px-3 py-2 transition-colors cursor-pointer whitespace-nowrap shrink-0"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isLoadingWa ? 'animate-spin' : ''}`} />
              <span>{waStatus?.status === 'connected' ? 'Check Status' : 'Generate QR'}</span>
            </button>
          </div>

          <p className="text-xs text-slate-600 leading-relaxed">
            Auto-keepalive heartbeat runs every 20 seconds with automatic background reconnect so
            your linked WhatsApp stays active 24x7 without logging out.
          </p>

          {waStatus?.lastError && (
            <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              {waStatus.lastError}
            </p>
          )}

          {/* QR Code Display */}
          {waStatus?.qrDataUrl && waStatus.status !== 'connected' && (
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

          {/* Pairing Code Option */}
          {waStatus?.status !== 'connected' && (
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
                  onClick={() => handleStartWhatsApp(true)}
                  disabled={isLoadingWa || !pairingPhone.trim()}
                  className="min-h-11 sm:min-h-9 inline-flex items-center justify-center gap-1.5 rounded-lg bg-sky-700 hover:bg-sky-600 disabled:opacity-50 text-white text-xs font-semibold px-3.5 py-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Smartphone className="h-3.5 w-3.5" />
                  <span>Get Code</span>
                </button>
              </div>
              {waStatus?.pairingCode && (
                <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-3 text-center">
                  <p className="text-xs text-emerald-800">Enter this code in WhatsApp:</p>
                  <p className="font-mono text-xl font-bold tracking-widest text-slate-900 mt-1">
                    {waStatus.pairingCode}
                  </p>
                </div>
              )}
            </div>
          )}

          {waStatus?.status === 'connected' && (
            <div className="flex items-center justify-between pt-3 border-t border-slate-200">
              <span className="text-xs text-emerald-700 font-semibold flex items-center gap-1.5">
                <CheckCircle2 className="h-4 w-4" />
                24x7 Keep-Alive Active
              </span>
              <button
                type="button"
                onClick={() => setShowUnlinkConfirm(true)}
                className="inline-flex items-center gap-1 text-xs text-rose-600 hover:text-rose-700 font-medium cursor-pointer"
              >
                <Unlink className="h-3.5 w-3.5" />
                <span>Unlink Device</span>
              </button>
            </div>
          )}

          {showUnlinkConfirm && (
            <div className="rounded-xl border border-rose-200 bg-rose-50 p-3.5 space-y-3">
              <p className="text-xs text-slate-800 font-medium">
                Unlink this WhatsApp device? You will need to scan a QR code again to send
                automatic replies.
              </p>
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowUnlinkConfirm(false)}
                  className="rounded-lg border border-slate-300 bg-white text-slate-700 text-xs px-3 py-1.5 cursor-pointer"
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
        </div>

        {/* Send Test Message with Images */}
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
            Verify instant background delivery of your message and the Prestair showcase image to
            any WhatsApp number.
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

      {/* Right Column: Auto-Reply Message & Single Attached Prestair Image */}
      <div className="lg:col-span-7">
        <form
          onSubmit={handleSaveSettings}
          className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5 space-y-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-3.5">
            <div>
              <h3 className="font-display text-sm font-bold text-slate-900">
                Instant Customer Reply &amp; Attached Image
              </h3>
              <p className="text-xs text-slate-600">
                Dispatched automatically in the background as soon as a customer submits the form.
              </p>
            </div>
            <label className="min-h-9 inline-flex items-center gap-2 text-xs font-semibold text-slate-800 cursor-pointer shrink-0">
              <input
                type="checkbox"
                checked={autoReplyEnabled}
                onChange={(e) => setAutoReplyEnabled(e.target.checked)}
                className="h-4 w-4 accent-emerald-600 rounded"
              />
              <span>Auto-Reply Enabled</span>
            </label>
          </div>

          {/* Single Attached Image Preview */}
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
                onClick={() => setMessageTemplate(DEFAULT_PRESTAIR_WHATSAPP_REPLY)}
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
              onChange={(e) => setMessageTemplate(e.target.value)}
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
              onChange={(e) => setAdminNotifyPhone(e.target.value)}
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
