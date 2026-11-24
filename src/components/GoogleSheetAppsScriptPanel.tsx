import React, { useCallback, useEffect, useState } from 'react';
import {
  Check,
  CheckCircle2,
  Copy,
  ExternalLink,
  FileSpreadsheet,
  Loader2,
  RefreshCw,
  Unlink,
} from 'lucide-react';
import {
  formatReadableTimestamp,
  GOOGLE_APPS_SCRIPT_CODE,
} from '../utils/leadLogic';

interface SheetScriptStatus {
  enabled: boolean;
  webhookUrl: string;
  isEnvConfigured?: boolean;
  spreadsheetName: string;
  sheetName: string;
  spreadsheetUrl: string;
  lastSyncedAt: string | null;
  lastError: string | null;
  totalLeads: number;
  syncedLeads: number;
}

interface GoogleSheetAppsScriptPanelProps {
  adminToken: string | null;
  onSyncComplete?: () => void;
}

export const GoogleSheetAppsScriptPanel: React.FC<GoogleSheetAppsScriptPanelProps> = ({
  adminToken,
  onSyncComplete,
}) => {
  const [status, setStatus] = useState<SheetScriptStatus | null>(null);
  const [webhookInput, setWebhookInput] = useState('');
  const [isLoadingStatus, setIsLoadingStatus] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isSyncingAll, setIsSyncingAll] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [copiedScript, setCopiedScript] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    if (!adminToken) return;
    try {
      const res = await fetch('/api/sheets-script/status', {
        cache: 'no-store',
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      if (res.ok) {
        const data: SheetScriptStatus = await res.json();
        setStatus(data);
        setWebhookInput((prev) => prev || data.webhookUrl || '');
      }
    } catch {
      // ignore transient error
    } finally {
      setIsLoadingStatus(false);
    }
  }, [adminToken]);

  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  const handleCopyScript = async () => {
    try {
      await navigator.clipboard.writeText(GOOGLE_APPS_SCRIPT_CODE);
      setCopiedScript(true);
      setTimeout(() => setCopiedScript(false), 2500);
    } catch {
      setErrorMsg('Unable to copy automatically. Please select the script box below and copy.');
    }
  };

  const handleConnectAndSync = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!adminToken) return;
    const trimmed = webhookInput.trim();
    if (!trimmed) {
      setErrorMsg('Please paste your Google Apps Script Web App URL (ending in /exec).');
      return;
    }

    setIsSaving(true);
    setErrorMsg(null);
    setSuccessMsg(null);
    try {
      const res = await fetch('/api/sheets-script/config', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          webhookUrl: trimmed,
          enabled: true,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErrorMsg(
          data.error ||
            'Could not connect to Google Apps Script. Ensure "Who has access" is set to "Anyone".'
        );
        return;
      }

      if (data.status) {
        setStatus(data.status);
      } else {
        await fetchStatus();
      }
      setSuccessMsg(
        `Google Sheet integrated & synced across all servers! Synced ${data.synced ?? 0} leads in India Time (IST).`
      );
      onSyncComplete?.();
    } catch {
      setErrorMsg('Network error while connecting Google Apps Script.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleSyncAllNow = async () => {
    if (!adminToken) return;
    setIsSyncingAll(true);
    setErrorMsg(null);
    setSuccessMsg(null);
    try {
      const res = await fetch('/api/sheets-script/sync-all', {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErrorMsg(data.error || 'Failed to sync leads to Google Sheet.');
        return;
      }
      if (data.status) {
        setStatus(data.status);
      } else {
        await fetchStatus();
      }
      setSuccessMsg(`Synced all ${data.synced ?? 0} leads to Google Sheet in IST.`);
      onSyncComplete?.();
    } catch {
      setErrorMsg('Network error while syncing leads.');
    } finally {
      setIsSyncingAll(false);
    }
  };

  const handleDisconnect = async () => {
    if (!adminToken) return;
    setIsDisconnecting(true);
    setErrorMsg(null);
    setSuccessMsg(null);
    try {
      const res = await fetch('/api/sheets-script/disconnect', {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      if (res.ok) {
        setWebhookInput('');
        await fetchStatus();
        setSuccessMsg('Disconnected Google Apps Script URL.');
      }
    } catch {
      setErrorMsg('Failed to disconnect Apps Script URL.');
    } finally {
      setIsDisconnecting(false);
    }
  };

  const isConnected = Boolean(status?.enabled && status?.webhookUrl);

  return (
    <section
      aria-label="Google Sheet Apps Script 24x7 Live Sync"
      className="w-full rounded-xl border border-slate-200 bg-white overflow-hidden divide-y divide-slate-200"
    >
      <div className="p-4 sm:p-6 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold text-emerald-700">
              24x7 Multi-Deployment Google Sheet Sync (AI Studio · Railway)
            </p>
            <h3 className="font-display text-lg sm:text-xl font-bold text-slate-900 mt-0.5">
              Google Sheet Apps Script Live Sync
            </h3>
            <p className="text-xs text-slate-600 mt-1 max-w-2xl leading-relaxed">
              Your Google Sheet settings sync automatically in real time across AI Studio and Railway—every inquiry, edit, and deletion updates your Sheet 24x7 in India Time (IST).
            </p>
          </div>

          {status?.spreadsheetUrl && (
            <a
              href={status.spreadsheetUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="min-h-11 sm:min-h-9 inline-flex items-center justify-center gap-1.5 rounded-lg bg-emerald-50 border border-emerald-200 hover:border-emerald-300 text-emerald-800 text-xs font-semibold px-3.5 py-2 transition-colors whitespace-nowrap shrink-0"
            >
              <FileSpreadsheet className="h-4 w-4 text-emerald-700" />
              <span>Open Connected Google Sheet</span>
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 divide-x divide-y sm:divide-y-0 divide-slate-200 border border-slate-200 rounded-xl bg-slate-50/60 overflow-hidden">
          <div className="px-3.5 sm:px-4 py-2.5 sm:py-3">
            <p className="text-[11px] sm:text-xs text-slate-500 font-medium">Integration Status</p>
            <p
              className={`text-sm font-bold mt-0.5 ${
                isLoadingStatus
                  ? 'text-slate-500'
                  : isConnected
                    ? 'text-emerald-700'
                    : 'text-amber-700'
              }`}
            >
              {isLoadingStatus ? 'Checking…' : isConnected ? 'Connected · 24x7 Live' : 'Not Linked Yet'}
            </p>
          </div>
          <div className="px-3.5 sm:px-4 py-2.5 sm:py-3">
            <p className="text-[11px] sm:text-xs text-slate-500 font-medium">Target Sheet Tab</p>
            <p className="text-sm font-semibold text-slate-900 truncate mt-0.5">
              {status?.spreadsheetName
                ? `${status.spreadsheetName} (${status.sheetName || 'Prestier Leads'})`
                : 'Prestier Leads'}
            </p>
          </div>
          <div className="px-3.5 sm:px-4 py-2.5 sm:py-3">
            <p className="text-[11px] sm:text-xs text-slate-500 font-medium">Synced Leads</p>
            <p className="font-mono text-sm sm:text-base font-bold text-slate-900 tabular-nums mt-0.5">
              {status ? `${status.syncedLeads} / ${status.totalLeads}` : '—'}
            </p>
          </div>
          <div className="px-3.5 sm:px-4 py-2.5 sm:py-3">
            <p className="text-[11px] sm:text-xs text-slate-500 font-medium">Last Live Sync</p>
            <p className="text-xs font-medium text-slate-800 tabular-nums mt-1">
              {status?.lastSyncedAt ? formatReadableTimestamp(status.lastSyncedAt) : 'Not synced yet'}
            </p>
          </div>
        </div>

        {(errorMsg || status?.lastError) && (
          <p
            role="alert"
            className="text-xs font-medium text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3.5 py-2.5"
          >
            {errorMsg || status?.lastError}
          </p>
        )}

        {successMsg && (
          <p
            role="status"
            className="text-xs font-medium text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-3.5 py-2.5 flex items-center gap-2"
          >
            <CheckCircle2 className="h-4 w-4 text-emerald-700 shrink-0" />
            <span>{successMsg}</span>
          </p>
        )}
      </div>

      <div className="p-4 sm:p-6 space-y-5">
        <div className="space-y-2">
          <h4 className="font-display text-sm sm:text-base font-bold text-slate-900">
            01. Quick 1-Minute Setup Guide
          </h4>
          <ol className="space-y-1.5 text-xs text-slate-700 leading-relaxed list-decimal list-inside">
            <li>
              Open any Google Sheet on your Google account and click{' '}
              <span className="font-semibold text-slate-900">Extensions → Apps Script</span>.
            </li>
            <li>
              Click <span className="font-semibold text-slate-900">Copy Apps Script Code</span> below,
              replace all code inside Apps Script, and save (<span className="font-mono">Ctrl+S</span>).
            </li>
            <li>
              Click <span className="font-semibold text-slate-900">Deploy → New deployment</span>,
              choose <span className="font-semibold text-slate-900">Web app</span>, set{' '}
              <span className="font-semibold text-slate-900">Execute as: Me</span> and{' '}
              <span className="font-semibold text-slate-900">Who has access: Anyone</span>, then click{' '}
              <span className="font-semibold text-slate-900">Deploy</span>.
            </li>
            <li>
              Copy the generated <span className="font-semibold text-slate-900">Web app URL</span>{' '}
              (ending with <span className="font-mono">/exec</span>) and paste it below.
            </li>
          </ol>
        </div>

        <form onSubmit={handleConnectAndSync} className="space-y-3">
          <label
            htmlFor="apps-script-webhook-input"
            className="block text-xs font-semibold text-slate-900"
          >
            02. Paste Deployed Google Apps Script Web App URL
          </label>
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5">
            <input
              id="apps-script-webhook-input"
              type="url"
              value={webhookInput}
              disabled={Boolean(status?.isEnvConfigured)}
              onChange={(e) => {
                setWebhookInput(e.target.value);
                if (errorMsg) setErrorMsg(null);
              }}
              placeholder="https://script.google.com/macros/s/AKfycb.../exec"
              className="flex-1 rounded-xl border border-slate-300 bg-white px-3.5 py-3 text-base sm:text-xs font-mono text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-sky-600 focus:ring-3 focus:ring-sky-600/15 disabled:bg-slate-100"
            />
            <button
              type="submit"
              disabled={isSaving || !webhookInput.trim()}
              className="min-h-11 inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-700 hover:bg-emerald-600 disabled:opacity-55 text-white text-xs font-semibold px-5 py-2.5 transition-colors cursor-pointer whitespace-nowrap shrink-0"
            >
              {isSaving ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>Connecting &amp; Syncing…</span>
                </>
              ) : (
                <>
                  <FileSpreadsheet className="h-4 w-4" />
                  <span>{isConnected ? 'Update & Sync All Leads' : 'Connect & Sync All Leads'}</span>
                </>
              )}
            </button>
          </div>

          {isConnected && (
            <div className="flex flex-wrap items-center gap-2.5 pt-1">
              <button
                type="button"
                onClick={handleSyncAllNow}
                disabled={isSyncingAll}
                className="min-h-10 inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-800 text-xs font-semibold px-3.5 py-2 transition-colors cursor-pointer whitespace-nowrap shrink-0"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${isSyncingAll ? 'animate-spin text-sky-600' : ''}`} />
                <span>{isSyncingAll ? 'Syncing All Leads…' : 'Sync All Existing Leads Now'}</span>
              </button>

              {!status?.isEnvConfigured && (
                <button
                  type="button"
                  onClick={handleDisconnect}
                  disabled={isDisconnecting}
                  className="min-h-10 inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 bg-white hover:bg-rose-50 hover:border-rose-200 text-slate-600 hover:text-rose-700 text-xs font-medium px-3.5 py-2 transition-colors cursor-pointer whitespace-nowrap shrink-0"
                >
                  <Unlink className="h-3.5 w-3.5" />
                  <span>Disconnect Script</span>
                </button>
              )}
            </div>
          )}
        </form>
      </div>

      <div className="p-4 sm:p-6 space-y-3 bg-slate-50/50">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
          <div>
            <h4 className="font-display text-sm sm:text-base font-bold text-slate-900">
              03. Google Apps Script Code (Copy &amp; Paste into Google Sheet)
            </h4>
            <p className="text-xs text-slate-600 mt-0.5">
              Writes exact India Time (IST) timestamps, syncs live Admin edits &amp; deletions automatically, and keeps rows clean without duplicates. (If you connected an older script earlier, paste &amp; redeploy New Version once so deleted rows auto-remove in Sheet too.)
            </p>
          </div>

          <button
            type="button"
            onClick={handleCopyScript}
            className="min-h-11 sm:min-h-9 inline-flex items-center justify-center gap-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold px-4 py-2 transition-colors cursor-pointer whitespace-nowrap shrink-0"
          >
            {copiedScript ? (
              <>
                <Check className="h-3.5 w-3.5 text-emerald-400" />
                <span>Copied Script!</span>
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5" />
                <span>Copy Apps Script Code</span>
              </>
            )}
          </button>
        </div>

        <div className="rounded-xl border border-slate-200 bg-slate-950 text-slate-100 p-3.5 sm:p-4 max-h-80 overflow-auto">
          <pre className="font-mono text-[11px] sm:text-xs leading-relaxed select-all">
            <code>{GOOGLE_APPS_SCRIPT_CODE}</code>
          </pre>
        </div>
      </div>
    </section>
  );
};
