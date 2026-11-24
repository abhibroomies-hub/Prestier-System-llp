// Live Admin Lead Table with inline edit, permanent delete, and Google Sheet sync
import React, { useMemo, useState } from 'react';
import {
  Check,
  CheckCircle2,
  Copy,
  Download,
  ExternalLink,
  FileSpreadsheet,
  Loader2,
  Mail,
  Pencil,
  Phone,
  RefreshCw,
  Search,
  Send,
  Trash2,
  X,
} from 'lucide-react';
import {
  computeLeadMetrics,
  formatReadableTimestamp,
  leadsToCsv,
  normalizeLeadRecord,
  PRODUCT_OPTIONS,
  type LeadFormInput,
  type LeadRecord,
  type LeadStatus,
} from '../utils/leadLogic';
import type { ConnectedSpreadsheet } from '../services/googleSheets';

const RECOMMENDED_RTDB_RULES_JSON = `{
  "rules": {
    "leads": {
      ".read": true,
      ".write": true
    },
    "deletedLeads": {
      ".read": true,
      ".write": true
    },
    "meta": {
      ".read": true,
      ".write": true
    }
  }
}`;

export interface RtdbAdminStatus {
  connected: boolean;
  writeVerified?: boolean;
  projectId: string;
  databaseUrl: string;
  lastSyncedAt: string | null;
  lastError: string | null;
  remoteLeadCount: number;
}

interface LiveGoogleSheetTableProps {
  leads: LeadRecord[];
  activeDraftId: string | null;
  googleUserEmail: string | null;
  connectedSheet: ConnectedSpreadsheet | null;
  rtdbStatus?: RtdbAdminStatus | null;
  isSigningInGoogle: boolean;
  isSyncingSheet: boolean;
  isSyncingRtdb?: boolean;
  isRefreshingLeads?: boolean;
  resendingLeadId?: string | null;
  sheetError: string | null;
  sheetSuccessMsg: string | null;
  isAdminAuthenticated: boolean;
  onRefreshLeads?: () => void;
  onSyncRtdbNow?: () => void;
  onResendWhatsApp?: (lead: LeadRecord) => void;
  onGoogleSignIn: () => void;
  onCreateNewGoogleSheet: () => void;
  onConnectExistingSheet: (idOrUrl: string) => void;
  onSyncAllToSheet: () => void;
  onEditLead?: (
    leadId: string,
    updated: LeadFormInput & { status: LeadStatus }
  ) => Promise<void> | void;
  onDeleteLead: (lead: LeadRecord) => void;
  onOpenAppsScriptSetup?: () => void;
}

export const LiveGoogleSheetTable: React.FC<LiveGoogleSheetTableProps> = ({
  leads,
  activeDraftId,
  googleUserEmail,
  connectedSheet,
  rtdbStatus = null,
  isSigningInGoogle,
  isSyncingSheet,
  isSyncingRtdb = false,
  isRefreshingLeads = false,
  resendingLeadId = null,
  sheetError,
  sheetSuccessMsg,
  isAdminAuthenticated,
  onRefreshLeads,
  onSyncRtdbNow,
  onResendWhatsApp,
  onGoogleSignIn,
  onCreateNewGoogleSheet,
  onConnectExistingSheet,
  onSyncAllToSheet,
  onEditLead,
  onDeleteLead,
  onOpenAppsScriptSetup,
}) => {
  const [filterStatus, setFilterStatus] = useState<'all' | 'confirmed' | 'partial'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [sheetInputUrl, setSheetInputUrl] = useState('');
  const [showConnectExisting, setShowConnectExisting] = useState(false);
  const [leadToDelete, setLeadToDelete] = useState<LeadRecord | null>(null);
  const [leadToEdit, setLeadToEdit] = useState<LeadRecord | null>(null);
  const [editForm, setEditForm] = useState<LeadFormInput>({
    name: '',
    designation: '',
    phone: '',
    companyName: '',
    city: '',
    emailAddress: '',
    outletsCount: '',
    productInterest: [],
  });
  const [editStatus, setEditStatus] = useState<LeadStatus>('confirmed');
  const [isSavingEdit, setIsSavingEdit] = useState(false);
  const [copiedRtdbRules, setCopiedRtdbRules] = useState(false);

  const openEditModal = (lead: LeadRecord) => {
    setLeadToEdit(lead);
    setEditForm({
      name: lead.name || '',
      designation: lead.designation || '',
      phone: lead.phone || '',
      companyName: lead.companyName || '',
      city: lead.city || '',
      emailAddress: lead.emailAddress || '',
      outletsCount: lead.outletsCount || '',
      productInterest: Array.isArray(lead.productInterest) ? [...lead.productInterest] : [],
    });
    setEditStatus(lead.status);
  };

  const toggleEditProductInterest = (val: string) => {
    setEditForm((prev) => {
      const current = Array.isArray(prev.productInterest) ? [...prev.productInterest] : [];
      const idx = current.indexOf(val);
      if (idx >= 0) {
        current.splice(idx, 1);
      } else {
        current.push(val);
      }
      return { ...prev, productInterest: current };
    });
  };

  const handleSaveEditSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!leadToEdit || !onEditLead) return;
    setIsSavingEdit(true);
    try {
      await onEditLead(leadToEdit.leadId, {
        ...editForm,
        status: editStatus,
      });
      setLeadToEdit(null);
    } finally {
      setIsSavingEdit(false);
    }
  };

  const normalizedLeads = useMemo(
    () => leads.map((item) => normalizeLeadRecord(item)),
    [leads]
  );

  const metrics = useMemo(() => computeLeadMetrics(normalizedLeads), [normalizedLeads]);

  const filteredLeads = useMemo(() => {
    return normalizedLeads.filter((lead) => {
      if (filterStatus !== 'all' && lead.status !== filterStatus) return false;
      if (!searchQuery.trim()) return true;
      const q = searchQuery.toLowerCase();
      const interestsStr = lead.productInterest.join(' ').toLowerCase();
      return (
        lead.name.toLowerCase().includes(q) ||
        lead.designation.toLowerCase().includes(q) ||
        lead.phone.toLowerCase().includes(q) ||
        lead.companyName.toLowerCase().includes(q) ||
        lead.city.toLowerCase().includes(q) ||
        lead.emailAddress.toLowerCase().includes(q) ||
        interestsStr.includes(q) ||
        lead.leadId.toLowerCase().includes(q)
      );
    });
  }, [normalizedLeads, filterStatus, searchQuery]);

  const handleDownloadCsv = () => {
    const csv = leadsToCsv(filteredLeads);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `prestier-system-leads-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section
      aria-label="Live Customer Lead Registry"
      className="w-full rounded-xl border border-slate-200 bg-white overflow-hidden flex flex-col"
    >
      {/* Top Toolbar & Summary Metrics */}
      <div className="p-4 sm:p-6 border-b border-slate-200 space-y-4 sm:space-y-5">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3.5 sm:gap-4">
          <div>
            <p className="text-xs font-semibold text-sky-700">
              Real-Time Multi-Cloud Sync (AI Studio · Railway · Google Sheet)
            </p>
            <h3 className="font-display text-lg sm:text-xl font-bold text-slate-900 mt-0.5">
              All Customer Leads ({metrics.total})
            </h3>
            <p className="text-xs text-slate-600 mt-0.5">
              Live leads, edits, and deletions stay synchronized 24x7 across all deployments and Google Sheets.
            </p>
            {rtdbStatus && (
              <p className="text-[11px] font-medium mt-1 text-slate-600 tabular-nums">
                Google RTDB ({rtdbStatus.projectId}):{' '}
                {rtdbStatus.lastError ? (
                  <span className="text-amber-700 font-semibold">
                    Rules Locked in Firebase Console ({rtdbStatus.lastError})
                  </span>
                ) : rtdbStatus.writeVerified ? (
                  <span className="text-emerald-700 font-semibold">
                    24x7 Live Store Verified · Cloud Leads: {rtdbStatus.remoteLeadCount} · Instant Multi-Server Sync Active
                  </span>
                ) : rtdbStatus.connected ? (
                  <span className="text-emerald-700 font-semibold">
                    24x7 Live Connected · Verifying Cloud Storage…
                  </span>
                ) : (
                  <span className="text-sky-700 font-semibold">Connecting to Asia-Southeast1…</span>
                )}
              </p>
            )}
          </div>

          {/* Mobile-Friendly Action Controls */}
          <div className="flex flex-wrap items-center gap-2">
            {onRefreshLeads && (
              <button
                type="button"
                onClick={onRefreshLeads}
                disabled={isRefreshingLeads}
                className="min-h-11 sm:min-h-9 inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold px-3.5 py-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 ${isRefreshingLeads ? 'animate-spin text-sky-600' : ''}`}
                />
                <span>Refresh</span>
              </button>
            )}

            {onOpenAppsScriptSetup && (
              <button
                type="button"
                onClick={onOpenAppsScriptSetup}
                className="min-h-11 sm:min-h-9 inline-flex items-center justify-center gap-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-white text-xs font-semibold px-3.5 py-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <FileSpreadsheet className="h-3.5 w-3.5 shrink-0" />
                <span>Google Sheet Script (24x7)</span>
              </button>
            )}

            {!googleUserEmail ? (
              <button
                type="button"
                onClick={onGoogleSignIn}
                disabled={isSigningInGoogle}
                className="gsi-material-button min-h-11 sm:min-h-9"
              >
                <div className="gsi-material-button-icon">
                  <svg
                    version="1.1"
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 48 48"
                    className="block"
                  >
                    <path
                      fill="#EA4335"
                      d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
                    />
                    <path
                      fill="#4285F4"
                      d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
                    />
                    <path
                      fill="#FBBC05"
                      d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
                    />
                    <path
                      fill="#34A853"
                      d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
                    />
                  </svg>
                </div>
                <span className="whitespace-nowrap">
                  {isSigningInGoogle ? 'Connecting…' : 'Connect Google Sheets'}
                </span>
              </button>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                {!connectedSheet ? (
                  <>
                    <button
                      type="button"
                      onClick={onCreateNewGoogleSheet}
                      disabled={isSyncingSheet}
                      className="min-h-11 sm:min-h-9 inline-flex items-center gap-2 rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:opacity-60 text-white text-xs font-semibold px-3.5 py-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      {isSyncingSheet ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <FileSpreadsheet className="h-3.5 w-3.5" />
                      )}
                      <span>Create Live Sheet</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowConnectExisting((prev) => !prev)}
                      className="min-h-11 sm:min-h-9 inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-xs font-medium px-3 py-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <span>Link Sheet ID</span>
                    </button>
                  </>
                ) : (
                  <>
                    <a
                      href={connectedSheet.spreadsheetUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="min-h-11 sm:min-h-9 inline-flex items-center gap-1.5 rounded-lg bg-emerald-50 border border-emerald-200 hover:border-emerald-300 text-emerald-800 text-xs font-semibold px-3.5 py-2 transition-colors whitespace-nowrap shrink-0"
                    >
                      <FileSpreadsheet className="h-3.5 w-3.5 text-emerald-700" />
                      <span>Open Sheet ({connectedSheet.sheetName})</span>
                      <ExternalLink className="h-3 w-3" />
                    </a>
                    <button
                      type="button"
                      onClick={onSyncAllToSheet}
                      disabled={isSyncingSheet}
                      className="min-h-11 sm:min-h-9 inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-xs font-medium px-3 py-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <RefreshCw
                        className={`h-3.5 w-3.5 ${isSyncingSheet ? 'animate-spin text-sky-600' : ''}`}
                      />
                      <span>Sync Sheet</span>
                    </button>
                  </>
                )}
              </div>
            )}

            <button
              type="button"
              onClick={handleDownloadCsv}
              className="min-h-11 sm:min-h-9 inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold px-3.5 py-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Download className="h-3.5 w-3.5" />
              <span>Export CSV</span>
            </button>
          </div>
        </div>

        {/* Connect Existing Spreadsheet Input Box */}
        {showConnectExisting && googleUserEmail && (
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
            <input
              type="text"
              value={sheetInputUrl}
              onChange={(e) => setSheetInputUrl(e.target.value)}
              placeholder="Paste Google Sheet URL or Spreadsheet ID..."
              aria-label="Google Sheet URL or Spreadsheet ID"
              className="flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-base sm:text-xs text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-sky-600"
            />
            <button
              type="button"
              onClick={() => {
                if (sheetInputUrl.trim()) {
                  onConnectExistingSheet(sheetInputUrl.trim());
                  setShowConnectExisting(false);
                }
              }}
              className="min-h-11 sm:min-h-9 rounded-lg bg-sky-700 hover:bg-sky-600 text-white text-xs font-semibold px-4 py-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              Connect Sheet
            </button>
          </div>
        )}

        {/* Actionable Firebase RTDB Rules Helper if prestier-final is in Locked Mode */}
        {rtdbStatus?.lastError && (
          <div className="rounded-xl border border-amber-200 bg-amber-50/70 p-3.5 space-y-2.5">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
              <div className="text-xs text-amber-900 space-y-0.5">
                <p className="font-semibold">
                  Enable Read/Write Rules in Firebase Realtime Database ({rtdbStatus.projectId})
                </p>
                <p className="text-[11px] text-amber-800">
                  Your leads are safe on server &amp; Google Sheet, but Firebase Console blocked RTDB write ({rtdbStatus.lastError}). Copy rules below, paste into Firebase Console &rarr; Realtime Database &rarr; Rules, click Publish, then click Verify &amp; Sync RTDB.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard.writeText(RECOMMENDED_RTDB_RULES_JSON).then(() => {
                      setCopiedRtdbRules(true);
                      setTimeout(() => setCopiedRtdbRules(false), 2000);
                    });
                  }}
                  className="min-h-9 inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-white hover:bg-amber-50 text-amber-900 text-xs font-semibold px-3 py-1.5 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  {copiedRtdbRules ? (
                    <>
                      <Check className="h-3.5 w-3.5 text-emerald-700" />
                      <span>Copied Rules</span>
                    </>
                  ) : (
                    <>
                      <Copy className="h-3.5 w-3.5" />
                      <span>Copy RTDB Rules</span>
                    </>
                  )}
                </button>
                <a
                  href={`https://console.firebase.google.com/project/${encodeURIComponent(rtdbStatus.projectId)}/database/${encodeURIComponent(rtdbStatus.projectId)}-default-rtdb/rules`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="min-h-9 inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-white hover:bg-amber-50 text-amber-900 text-xs font-semibold px-3 py-1.5 transition-colors whitespace-nowrap shrink-0"
                >
                  <span>Open Firebase Rules</span>
                  <ExternalLink className="h-3 w-3" />
                </a>
                {onSyncRtdbNow && (
                  <button
                    type="button"
                    onClick={onSyncRtdbNow}
                    disabled={isSyncingRtdb}
                    className="min-h-9 inline-flex items-center gap-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 disabled:opacity-60 text-white text-xs font-semibold px-3.5 py-1.5 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${isSyncingRtdb ? 'animate-spin' : ''}`} />
                    <span>Verify &amp; Sync RTDB</span>
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Status Notifications */}
        {sheetError && (
          <p
            role="alert"
            className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2"
          >
            {sheetError}
          </p>
        )}
        {sheetSuccessMsg && (
          <p
            role="status"
            className="text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 flex items-center gap-1.5"
          >
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-700" />
            <span>{sheetSuccessMsg}</span>
          </p>
        )}

        {/* Clean Hairline Summary Strip */}
        <div className="grid grid-cols-2 sm:grid-cols-4 divide-x divide-y sm:divide-y-0 divide-slate-200 border border-slate-200 rounded-xl bg-slate-50/60 overflow-hidden">
          <div className="px-3.5 sm:px-4 py-2.5 sm:py-3">
            <p className="text-[11px] sm:text-xs text-slate-500 font-medium">Total Leads</p>
            <p className="font-mono text-lg sm:text-xl font-bold text-slate-900 tabular-nums mt-0.5">
              {metrics.total}
            </p>
          </div>
          <div className="px-3.5 sm:px-4 py-2.5 sm:py-3">
            <p className="text-[11px] sm:text-xs text-emerald-800 font-medium">Confirmed</p>
            <p className="font-mono text-lg sm:text-xl font-bold text-emerald-700 tabular-nums mt-0.5">
              {metrics.confirmed}
            </p>
          </div>
          <div className="px-3.5 sm:px-4 py-2.5 sm:py-3">
            <p className="text-[11px] sm:text-xs text-amber-800 font-medium">Partial Drafts</p>
            <p className="font-mono text-lg sm:text-xl font-bold text-amber-700 tabular-nums mt-0.5">
              {metrics.partial}
            </p>
          </div>
          <div className="px-3.5 sm:px-4 py-2.5 sm:py-3">
            <p className="text-[11px] sm:text-xs text-sky-800 font-medium">WhatsApp Sent</p>
            <p className="font-mono text-lg sm:text-xl font-bold text-sky-700 tabular-nums mt-0.5">
              {metrics.whatsappSent}
            </p>
          </div>
        </div>

        {/* Interactive Segmented Filter Controls & Search */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div
            role="group"
            aria-label="Filter leads by status"
            className="grid grid-cols-3 sm:inline-flex items-center gap-1 p-1 rounded-xl bg-slate-100 w-full sm:w-auto"
          >
            <button
              type="button"
              onClick={() => setFilterStatus('all')}
              className={`min-h-10 sm:min-h-8 px-2.5 sm:px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer tabular-nums ${
                filterStatus === 'all'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              All ({metrics.total})
            </button>
            <button
              type="button"
              onClick={() => setFilterStatus('confirmed')}
              className={`min-h-10 sm:min-h-8 px-2.5 sm:px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer tabular-nums ${
                filterStatus === 'confirmed'
                  ? 'bg-white text-emerald-800 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Confirmed ({metrics.confirmed})
            </button>
            <button
              type="button"
              onClick={() => setFilterStatus('partial')}
              className={`min-h-10 sm:min-h-8 px-2.5 sm:px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer tabular-nums ${
                filterStatus === 'partial'
                  ? 'bg-white text-amber-800 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Drafts ({metrics.partial})
            </button>
          </div>

          <div className="relative w-full sm:w-80">
            <Search className="h-4 w-4 sm:h-3.5 sm:w-3.5 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search name, phone, company, city..."
              aria-label="Search leads"
              className="w-full rounded-xl border border-slate-300 bg-white pl-9 pr-3 py-2.5 sm:py-2 text-base sm:text-xs text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-sky-600"
            />
          </div>
        </div>
      </div>

      {/* Mobile Lead Cards */}
      <div className="md:hidden divide-y divide-slate-200">
        {filteredLeads.length === 0 ? (
          <div className="py-10 px-5 text-center text-xs text-slate-500">
            No customer leads match this filter yet. Submitted inquiries appear here immediately.
          </div>
        ) : (
          filteredLeads.map((lead, idx) => {
            const isCurrentDraft = activeDraftId === lead.leadId;
            const isConfirmed = lead.status === 'confirmed';
            const isResending = resendingLeadId === lead.leadId;

            return (
              <article
                key={lead.leadId}
                className={`p-4 space-y-3 ${isCurrentDraft ? 'bg-amber-50/50' : 'bg-white'}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="font-mono text-xs text-slate-400 tabular-nums shrink-0">
                        #{idx + 1}
                      </span>
                      <h4 className="font-display text-sm font-bold text-slate-900 truncate">
                        {lead.name || 'Unnamed Visitor'}
                      </h4>
                    </div>
                    <p className="text-xs text-slate-600 mt-0.5 truncate">
                      {[lead.designation, lead.companyName].filter(Boolean).join(' · ') || '—'}
                    </p>
                  </div>

                  <div className="text-right shrink-0">
                    <span
                      className={`text-xs font-semibold block ${
                        isConfirmed ? 'text-emerald-700' : 'text-amber-700'
                      }`}
                    >
                      {isConfirmed ? 'Confirmed' : 'Partial Draft'}
                    </span>
                    <span className="text-[11px] text-slate-500 block">
                      {isConfirmed
                        ? lead.whatsappSent
                          ? 'WA Reply Sent'
                          : 'WA Pending'
                        : isCurrentDraft
                          ? 'Typing Live'
                          : 'Auto-Saved'}
                    </span>
                  </div>
                </div>

                <div className="space-y-1.5 text-xs text-slate-700">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    {lead.phone ? (
                      <a
                        href={`tel:${lead.phone.replace(/\s+/g, '')}`}
                        className="inline-flex items-center gap-1.5 font-mono font-semibold text-sky-800 hover:underline tabular-nums"
                      >
                        <Phone className="h-3.5 w-3.5 text-sky-700 shrink-0" />
                        <span>{lead.phone}</span>
                      </a>
                    ) : (
                      <span className="text-slate-400">No phone</span>
                    )}
                    {lead.city && (
                      <>
                        <span aria-hidden="true" className="text-slate-300">
                          ·
                        </span>
                        <span>{lead.city}</span>
                      </>
                    )}
                    {lead.outletsCount && (
                      <>
                        <span aria-hidden="true" className="text-slate-300">
                          ·
                        </span>
                        <span className="font-mono tabular-nums">
                          {lead.outletsCount} {Number(lead.outletsCount) === 1 ? 'Outlet' : 'Outlets'}
                        </span>
                      </>
                    )}
                  </div>

                  {lead.emailAddress && (
                    <div className="flex items-center gap-1.5 text-slate-600 break-all">
                      <Mail className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                      <span>{lead.emailAddress}</span>
                    </div>
                  )}

                  <div className="pt-0.5">
                    <span className="text-slate-500">Equipment: </span>
                    {lead.productInterest.length > 0 ? (
                      <span className="font-semibold text-slate-900">
                        {lead.productInterest.join(' · ')}
                      </span>
                    ) : (
                      <span className="text-slate-400">Pending selection</span>
                    )}
                  </div>
                </div>

                <div className="pt-2.5 border-t border-slate-100 flex items-center justify-between gap-2">
                  <span className="text-[11px] text-slate-500 tabular-nums">
                    {formatReadableTimestamp(lead.updatedAt)}
                  </span>

                  {isAdminAuthenticated && (
                    <div className="inline-flex items-center gap-2">
                      {onResendWhatsApp && lead.phone && (
                        <button
                          type="button"
                          onClick={() => onResendWhatsApp(lead)}
                          disabled={isResending}
                          className="min-h-10 inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 hover:bg-sky-50 hover:border-sky-300 text-slate-800 text-xs font-semibold px-3 py-2 transition-colors cursor-pointer whitespace-nowrap shrink-0"
                        >
                          {isResending ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Send className="h-3.5 w-3.5 text-sky-700" />
                          )}
                          <span>{lead.whatsappSent ? 'Resend WA' : 'Send WA'}</span>
                        </button>
                      )}
                      {onEditLead && (
                        <button
                          type="button"
                          onClick={() => openEditModal(lead)}
                          aria-label={`Edit lead for ${lead.name || lead.leadId}`}
                          className="min-h-10 inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold px-3 py-2 transition-colors cursor-pointer whitespace-nowrap shrink-0"
                        >
                          <Pencil className="h-3.5 w-3.5 text-slate-600" />
                          <span>Edit</span>
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => setLeadToDelete(lead)}
                        aria-label={`Delete lead for ${lead.name || lead.leadId}`}
                        className="min-h-10 min-w-10 inline-flex items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:text-rose-600 hover:border-rose-200 hover:bg-rose-50 transition-colors cursor-pointer"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  )}
                </div>
              </article>
            );
          })
        )}
      </div>

      {/* Desktop High-Density Customer Leads Data Grid */}
      <div className="hidden md:block overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-700">
              <th className="py-3 pl-4 pr-2 font-mono">#</th>
              <th className="py-3 px-3">Status</th>
              <th className="py-3 px-3">Customer &amp; Designation</th>
              <th className="py-3 px-3">Phone &amp; Email</th>
              <th className="py-3 px-3">Company &amp; City</th>
              <th className="py-3 px-2 text-right">Outlets</th>
              <th className="py-3 px-3">Equipment Selected</th>
              <th className="py-3 px-3">Updated (IST)</th>
              {isAdminAuthenticated && (
                <th className="py-3 pl-2 pr-4 text-right">Actions</th>
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200 text-xs text-slate-800">
            {filteredLeads.length === 0 ? (
              <tr>
                <td
                  colSpan={isAdminAuthenticated ? 9 : 8}
                  className="py-12 px-6 text-center text-slate-500"
                >
                  No customer leads match this filter yet. Submitted inquiries appear here immediately.
                </td>
              </tr>
            ) : (
              filteredLeads.map((lead, idx) => {
                const isCurrentDraft = activeDraftId === lead.leadId;
                const isConfirmed = lead.status === 'confirmed';
                const isResending = resendingLeadId === lead.leadId;

                const rowBg = isCurrentDraft
                  ? 'bg-amber-50/60 hover:bg-amber-50'
                  : 'bg-white hover:bg-slate-50/90';

                return (
                  <tr key={lead.leadId} className={`transition-colors ${rowBg}`}>
                    <td className="py-3.5 pl-4 pr-2 font-mono text-slate-500 tabular-nums align-top">
                      {idx + 1}
                    </td>

                    <td className="py-3.5 px-3 whitespace-nowrap align-top">
                      {isConfirmed ? (
                        <div className="space-y-0.5">
                          <span className="font-semibold text-emerald-700 block">
                            Confirmed
                          </span>
                          <span className="text-[11px] text-slate-500 block">
                            {lead.whatsappSent ? 'WA Reply Sent' : 'WA Pending'}
                          </span>
                        </div>
                      ) : (
                        <div className="space-y-0.5">
                          <span className="font-semibold text-amber-700 block">
                            Partial Draft
                          </span>
                          <span className="text-[11px] text-slate-500 block">
                            {isCurrentDraft ? 'Typing Live' : 'Auto-Saved'}
                          </span>
                        </div>
                      )}
                    </td>

                    <td className="py-3.5 px-3 align-top">
                      <div className="font-semibold text-slate-900">
                        {lead.name || 'Unnamed Visitor'}
                      </div>
                      <div className="text-[11px] text-slate-500 mt-0.5">
                        {lead.designation || '—'}
                      </div>
                    </td>

                    <td className="py-3.5 px-3 align-top">
                      <div className="font-mono font-medium text-slate-900 tabular-nums whitespace-nowrap">
                        {lead.phone || '—'}
                      </div>
                      <div className="text-[11px] text-slate-500 mt-0.5 break-all">
                        {lead.emailAddress || '—'}
                      </div>
                    </td>

                    <td className="py-3.5 px-3 align-top">
                      <div className="font-medium text-slate-900">
                        {lead.companyName || '—'}
                      </div>
                      <div className="text-[11px] text-slate-500 mt-0.5">
                        {lead.city ? `City: ${lead.city}` : '—'}
                      </div>
                    </td>

                    <td className="py-3.5 px-2 text-right font-mono font-semibold text-slate-900 tabular-nums align-top">
                      {lead.outletsCount || '—'}
                    </td>

                    <td className="py-3.5 px-3 align-top max-w-xs">
                      {lead.productInterest.length > 0 ? (
                        <span className="text-slate-800 font-medium leading-snug">
                          {lead.productInterest.join(' · ')}
                        </span>
                      ) : (
                        <span className="text-slate-400">Pending selection</span>
                      )}
                    </td>

                    <td className="py-3.5 px-3 text-slate-500 tabular-nums whitespace-nowrap align-top">
                      {formatReadableTimestamp(lead.updatedAt)}
                    </td>

                    {isAdminAuthenticated && (
                      <td className="py-3.5 pl-2 pr-4 text-right whitespace-nowrap align-top">
                        <div className="inline-flex items-center justify-end gap-1.5">
                          {onResendWhatsApp && lead.phone && (
                            <button
                              type="button"
                              onClick={() => onResendWhatsApp(lead)}
                              disabled={isResending}
                              title="Send Prestair WhatsApp Reply & Showcase Image"
                              className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white hover:bg-sky-50 hover:border-sky-300 text-slate-700 hover:text-sky-800 text-[11px] font-medium px-2.5 py-1.5 transition-colors cursor-pointer whitespace-nowrap shrink-0"
                            >
                              {isResending ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                <Send className="h-3 w-3" />
                              )}
                              <span>{lead.whatsappSent ? 'Resend WA' : 'Send WA'}</span>
                            </button>
                          )}
                          {onEditLead && (
                            <button
                              type="button"
                              onClick={() => openEditModal(lead)}
                              aria-label={`Edit lead for ${lead.name || lead.leadId}`}
                              title="Edit Lead & Auto-Sync to Sheet"
                              className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-[11px] font-medium px-2.5 py-1.5 transition-colors cursor-pointer whitespace-nowrap shrink-0"
                            >
                              <Pencil className="h-3 w-3" />
                              <span>Edit</span>
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => setLeadToDelete(lead)}
                            aria-label={`Delete lead for ${lead.name || lead.leadId}`}
                            title="Delete Lead & Auto-Sync to Sheet"
                            className="p-1.5 rounded-md text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition-colors cursor-pointer"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Edit Lead Modal */}
      {leadToEdit && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="edit-lead-dialog-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/55 backdrop-blur-xs p-3 sm:p-4 overflow-y-auto"
        >
          <div className="w-full max-w-xl my-auto rounded-2xl border border-slate-200 bg-white p-5 sm:p-6 shadow-2xl space-y-4">
            <div className="flex items-start justify-between gap-3 border-b border-slate-200 pb-3.5">
              <div>
                <p className="text-xs font-semibold text-sky-700">
                  Live Edit · Syncs to RTDB &amp; Google Sheet
                </p>
                <h3
                  id="edit-lead-dialog-title"
                  className="font-display text-lg font-bold text-slate-900 mt-0.5"
                >
                  Edit Customer Lead
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setLeadToEdit(null)}
                aria-label="Close edit lead dialog"
                className="min-h-10 min-w-10 flex items-center justify-center -mr-1.5 -mt-1 rounded-lg text-slate-400 hover:text-slate-900 hover:bg-slate-100 transition-colors cursor-pointer"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <form onSubmit={handleSaveEditSubmit} className="space-y-3.5">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <div>
                  <label
                    htmlFor="edit-lead-name"
                    className="block text-xs font-semibold text-slate-800 mb-1"
                  >
                    Full Name
                  </label>
                  <input
                    id="edit-lead-name"
                    type="text"
                    value={editForm.name}
                    onChange={(e) => setEditForm((prev) => ({ ...prev, name: e.target.value }))}
                    placeholder="Customer full name"
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-base sm:text-xs text-slate-900 focus:outline-none focus:border-sky-600"
                  />
                </div>

                <div>
                  <label
                    htmlFor="edit-lead-designation"
                    className="block text-xs font-semibold text-slate-800 mb-1"
                  >
                    Designation
                  </label>
                  <input
                    id="edit-lead-designation"
                    type="text"
                    value={editForm.designation}
                    onChange={(e) =>
                      setEditForm((prev) => ({ ...prev, designation: e.target.value }))
                    }
                    placeholder="e.g. Owner, Director"
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-base sm:text-xs text-slate-900 focus:outline-none focus:border-sky-600"
                  />
                </div>

                <div>
                  <label
                    htmlFor="edit-lead-phone"
                    className="block text-xs font-semibold text-slate-800 mb-1"
                  >
                    Phone / WhatsApp
                  </label>
                  <input
                    id="edit-lead-phone"
                    type="tel"
                    value={editForm.phone}
                    onChange={(e) => setEditForm((prev) => ({ ...prev, phone: e.target.value }))}
                    placeholder="+91 9876543210"
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-base sm:text-xs font-mono tabular-nums text-slate-900 focus:outline-none focus:border-sky-600"
                  />
                </div>

                <div>
                  <label
                    htmlFor="edit-lead-company"
                    className="block text-xs font-semibold text-slate-800 mb-1"
                  >
                    Company / Store Name
                  </label>
                  <input
                    id="edit-lead-company"
                    type="text"
                    value={editForm.companyName}
                    onChange={(e) =>
                      setEditForm((prev) => ({ ...prev, companyName: e.target.value }))
                    }
                    placeholder="Bakery or company name"
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-base sm:text-xs text-slate-900 focus:outline-none focus:border-sky-600"
                  />
                </div>

                <div>
                  <label
                    htmlFor="edit-lead-city"
                    className="block text-xs font-semibold text-slate-800 mb-1"
                  >
                    City
                  </label>
                  <input
                    id="edit-lead-city"
                    type="text"
                    value={editForm.city}
                    onChange={(e) => setEditForm((prev) => ({ ...prev, city: e.target.value }))}
                    placeholder="City"
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-base sm:text-xs text-slate-900 focus:outline-none focus:border-sky-600"
                  />
                </div>

                <div>
                  <label
                    htmlFor="edit-lead-email"
                    className="block text-xs font-semibold text-slate-800 mb-1"
                  >
                    Email Address
                  </label>
                  <input
                    id="edit-lead-email"
                    type="email"
                    value={editForm.emailAddress}
                    onChange={(e) =>
                      setEditForm((prev) => ({ ...prev, emailAddress: e.target.value }))
                    }
                    placeholder="customer@company.com"
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-base sm:text-xs text-slate-900 focus:outline-none focus:border-sky-600"
                  />
                </div>

                <div>
                  <label
                    htmlFor="edit-lead-outlets"
                    className="block text-xs font-semibold text-slate-800 mb-1"
                  >
                    No. of Outlets
                  </label>
                  <input
                    id="edit-lead-outlets"
                    type="number"
                    min={0}
                    max={100000}
                    value={editForm.outletsCount}
                    onChange={(e) =>
                      setEditForm((prev) => ({ ...prev, outletsCount: e.target.value }))
                    }
                    placeholder="e.g. 5"
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-base sm:text-xs font-mono tabular-nums text-slate-900 focus:outline-none focus:border-sky-600"
                  />
                </div>

                <div>
                  <label
                    htmlFor="edit-lead-status"
                    className="block text-xs font-semibold text-slate-800 mb-1"
                  >
                    Lead Status
                  </label>
                  <select
                    id="edit-lead-status"
                    value={editStatus}
                    onChange={(e) =>
                      setEditStatus(e.target.value === 'partial' ? 'partial' : 'confirmed')
                    }
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-base sm:text-xs font-semibold text-slate-900 focus:outline-none focus:border-sky-600"
                  >
                    <option value="confirmed">Confirmed</option>
                    <option value="partial">Partial Draft</option>
                  </select>
                </div>
              </div>

              <fieldset>
                <legend className="block text-xs font-semibold text-slate-800 mb-1.5">
                  Equipment Selected
                </legend>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  {PRODUCT_OPTIONS.map((opt) => {
                    const checked = editForm.productInterest.includes(opt.value);
                    return (
                      <label
                        key={opt.value}
                        className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium cursor-pointer transition-colors ${
                          checked
                            ? 'border-sky-600 bg-sky-50 text-slate-900'
                            : 'border-slate-200 bg-white hover:bg-slate-50 text-slate-700'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleEditProductInterest(opt.value)}
                          className="h-3.5 w-3.5 rounded accent-sky-700 shrink-0"
                        />
                        <span className="truncate">{opt.shortLabel}</span>
                      </label>
                    );
                  })}
                </div>
              </fieldset>

              <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setLeadToEdit(null)}
                  className="min-h-10 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold px-4 py-2 transition-colors cursor-pointer whitespace-nowrap shrink-0"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSavingEdit}
                  className="min-h-10 inline-flex items-center gap-1.5 rounded-lg bg-sky-700 hover:bg-sky-600 disabled:opacity-60 text-white text-xs font-semibold px-4 py-2 transition-colors cursor-pointer whitespace-nowrap shrink-0"
                >
                  {isSavingEdit ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      <span>Saving…</span>
                    </>
                  ) : (
                    <span>Save &amp; Sync</span>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Confirmation Dialog before Destructive Delete */}
      {leadToDelete && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-lead-dialog-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-xs p-4"
        >
          <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl space-y-4">
            <h3
              id="delete-lead-dialog-title"
              className="font-display text-lg font-bold text-slate-900"
            >
              Delete Lead Record?
            </h3>
            <p className="text-sm text-slate-600">
              Permanently remove the inquiry for{' '}
              <span className="font-semibold text-slate-900">
                {leadToDelete.name || leadToDelete.phone || leadToDelete.leadId}
              </span>{' '}
              ({leadToDelete.companyName || 'Unlisted Company'}) from Admin, RTDB &amp; Google Sheet?
            </p>
            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setLeadToDelete(null)}
                className="rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold px-4 py-2 transition-colors cursor-pointer whitespace-nowrap"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  onDeleteLead(leadToDelete);
                  setLeadToDelete(null);
                }}
                className="rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold px-4 py-2 transition-colors cursor-pointer whitespace-nowrap"
              >
                Delete Lead
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
};
