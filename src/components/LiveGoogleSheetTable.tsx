import React, { useState } from 'react';
import {
  CheckCircle2,
  Download,
  ExternalLink,
  FileSpreadsheet,
  Loader2,
  RefreshCw,
  Search,
  Trash2,
  Mail,
  MapPin,
  Briefcase,
} from 'lucide-react';
import {
  computeLeadMetrics,
  formatReadableTimestamp,
  leadsToCsv,
  type LeadRecord,
} from '../utils/leadLogic';
import type { ConnectedSpreadsheet } from '../services/googleSheets';

interface LiveGoogleSheetTableProps {
  leads: LeadRecord[];
  activeDraftId: string | null;
  googleUserEmail: string | null;
  connectedSheet: ConnectedSpreadsheet | null;
  isSigningInGoogle: boolean;
  isSyncingSheet: boolean;
  sheetError: string | null;
  sheetSuccessMsg: string | null;
  isAdminAuthenticated: boolean;
  onGoogleSignIn: () => void;
  onCreateNewGoogleSheet: () => void;
  onConnectExistingSheet: (idOrUrl: string) => void;
  onSyncAllToSheet: () => void;
  onDeleteLead: (lead: LeadRecord) => void;
}

export const LiveGoogleSheetTable: React.FC<LiveGoogleSheetTableProps> = ({
  leads,
  activeDraftId,
  googleUserEmail,
  connectedSheet,
  isSigningInGoogle,
  isSyncingSheet,
  sheetError,
  sheetSuccessMsg,
  isAdminAuthenticated,
  onGoogleSignIn,
  onCreateNewGoogleSheet,
  onConnectExistingSheet,
  onSyncAllToSheet,
  onDeleteLead,
}) => {
  const [filterStatus, setFilterStatus] = useState<'all' | 'confirmed' | 'partial'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [sheetInputUrl, setSheetInputUrl] = useState('');
  const [showConnectExisting, setShowConnectExisting] = useState(false);
  const [leadToDelete, setLeadToDelete] = useState<LeadRecord | null>(null);

  const metrics = computeLeadMetrics(leads);

  const filteredLeads = leads.filter((lead) => {
    if (filterStatus !== 'all' && lead.status !== filterStatus) return false;
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    const interestsStr = Array.isArray(lead.productInterest) ? lead.productInterest.join(' ') : lead.productInterest;
    return (
      lead.name.toLowerCase().includes(q) ||
      lead.designation.toLowerCase().includes(q) ||
      lead.phone.toLowerCase().includes(q) ||
      lead.companyName.toLowerCase().includes(q) ||
      lead.city.toLowerCase().includes(q) ||
      lead.emailAddress.toLowerCase().includes(q) ||
      interestsStr.toLowerCase().includes(q) ||
      lead.leadId.toLowerCase().includes(q)
    );
  });

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
      aria-label="Live Google Sheet Lead Registry"
      className="w-full rounded-2xl border border-slate-200 bg-white shadow-xl overflow-hidden flex flex-col"
    >
      {/* Top Spreadsheet Toolbar & Live Metrics */}
      <div className="p-5 sm:p-6 border-b border-slate-200 space-y-4 bg-slate-50/50">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-xs text-emerald-700 font-semibold">
              <FileSpreadsheet className="h-4 w-4 shrink-0" />
              <span>Real-Time Google Sheets &amp; Database Stream</span>
            </div>
            <h2 className="font-display text-lg sm:text-xl font-bold text-slate-900 mt-0.5">
              Live Customer Lead Registry &amp; Admin Dashboard
            </h2>
            <p className="text-xs text-slate-600 mt-0.5">
              Comprehensive customer inquiries with designation, company, city, email, and multi-product interests.
            </p>
          </div>

          {/* Google Sheets OAuth Connection Controls */}
          <div className="flex flex-wrap items-center gap-2.5">
            {!googleUserEmail ? (
              <button
                type="button"
                onClick={onGoogleSignIn}
                disabled={isSigningInGoogle}
                className="gsi-material-button"
              >
                <div className="gsi-material-button-icon">
                  <svg
                    version="1.1"
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 48 48"
                    style={{ display: 'block' }}
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
                <span>
                  {isSigningInGoogle ? 'Connecting Google Sheets…' : 'Sign in with Google'}
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
                      className="inline-flex items-center gap-2 rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:opacity-60 text-white text-xs font-semibold px-3.5 py-2.5 transition-colors whitespace-nowrap shrink-0 cursor-pointer shadow-sm"
                    >
                      {isSyncingSheet ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <FileSpreadsheet className="h-3.5 w-3.5" />
                      )}
                      <span>Create Live Google Sheet</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowConnectExisting((prev) => !prev)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-xs font-medium px-3 py-2.5 transition-colors whitespace-nowrap shrink-0 cursor-pointer shadow-sm"
                    >
                      <span>Link Existing Sheet ID</span>
                    </button>
                  </>
                ) : (
                  <>
                    <a
                      href={connectedSheet.spreadsheetUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-50 border border-emerald-300 hover:border-emerald-400 text-emerald-800 text-xs font-semibold px-3.5 py-2 transition-colors whitespace-nowrap shrink-0 shadow-sm"
                    >
                      <FileSpreadsheet className="h-3.5 w-3.5 text-emerald-700" />
                      <span>Open Google Sheet ({connectedSheet.sheetName})</span>
                      <ExternalLink className="h-3 w-3" />
                    </a>
                    <button
                      type="button"
                      onClick={onSyncAllToSheet}
                      disabled={isSyncingSheet}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-xs font-medium px-3 py-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer shadow-sm"
                    >
                      <RefreshCw
                        className={`h-3.5 w-3.5 ${isSyncingSheet ? 'animate-spin text-sky-600' : ''}`}
                      />
                      <span>Sync All Rows</span>
                    </button>
                  </>
                )}
              </div>
            )}

            <button
              type="button"
              onClick={handleDownloadCsv}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-xs font-medium px-3.5 py-2.5 transition-colors whitespace-nowrap shrink-0 cursor-pointer shadow-sm"
            >
              <Download className="h-3.5 w-3.5" />
              <span>Download CSV</span>
            </button>
          </div>
        </div>

        {/* Connect Existing Spreadsheet Input Box */}
        {showConnectExisting && googleUserEmail && (
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
            <input
              type="text"
              value={sheetInputUrl}
              onChange={(e) => setSheetInputUrl(e.target.value)}
              placeholder="Paste Google Sheet URL or Spreadsheet ID..."
              aria-label="Google Sheet URL or Spreadsheet ID"
              className="flex-1 rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-xs text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-sky-600"
            />
            <button
              type="button"
              onClick={() => {
                if (sheetInputUrl.trim()) {
                  onConnectExistingSheet(sheetInputUrl.trim());
                  setShowConnectExisting(false);
                }
              }}
              className="rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold px-4 py-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              Connect Sheet
            </button>
          </div>
        )}

        {/* Status notifications for Google Sheets */}
        {sheetError && (
          <p role="alert" className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">
            {sheetError}
          </p>
        )}
        {sheetSuccessMsg && (
          <p role="status" className="text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 flex items-center gap-1.5">
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-700" />
            <span>{sheetSuccessMsg}</span>
          </p>
        )}

        {/* Summary Metric Strip */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-1">
          <div className="rounded-xl border border-slate-200 bg-white p-3.5 shadow-sm">
            <p className="text-xs text-slate-500 font-medium">Total Leads</p>
            <p className="font-mono text-xl font-bold text-slate-900 tabular-nums mt-0.5">
              {metrics.total}
            </p>
          </div>
          <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-3.5 shadow-sm">
            <p className="text-xs text-emerald-800 font-medium">Confirmed Leads</p>
            <p className="font-mono text-xl font-bold text-emerald-700 tabular-nums mt-0.5">
              {metrics.confirmed}
            </p>
          </div>
          <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-3.5 shadow-sm">
            <p className="text-xs text-amber-800 font-medium">Auto-Saved Drafts</p>
            <p className="font-mono text-xl font-bold text-amber-700 tabular-nums mt-0.5">
              {metrics.partial}
            </p>
          </div>
          <div className="rounded-xl border border-sky-200 bg-sky-50/60 p-3.5 shadow-sm">
            <p className="text-xs text-sky-800 font-medium">WhatsApp Dispatched</p>
            <p className="font-mono text-xl font-bold text-sky-700 tabular-nums mt-0.5">
              {metrics.whatsappSent}
            </p>
          </div>
        </div>

        {/* Filter Bar & Search */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-1">
          <div
            role="group"
            aria-label="Filter leads by status"
            className="inline-flex items-center gap-1 p-1 rounded-xl bg-white border border-slate-200 shadow-sm self-start"
          >
            <button
              type="button"
              onClick={() => setFilterStatus('all')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                filterStatus === 'all'
                  ? 'bg-sky-600 text-white shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              All Leads ({metrics.total})
            </button>
            <button
              type="button"
              onClick={() => setFilterStatus('confirmed')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                filterStatus === 'confirmed'
                  ? 'bg-emerald-600 text-white shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Confirmed ({metrics.confirmed})
            </button>
            <button
              type="button"
              onClick={() => setFilterStatus('partial')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                filterStatus === 'partial'
                  ? 'bg-amber-600 text-white shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Partial Drafts ({metrics.partial})
            </button>
          </div>

          <div className="relative w-full sm:w-72">
            <Search className="h-3.5 w-3.5 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search name, designation, company, city..."
              aria-label="Search leads"
              className="w-full rounded-xl border border-slate-300 bg-white pl-9 pr-3 py-2 text-xs text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-sky-600 shadow-sm"
            />
          </div>
        </div>
      </div>

      {/* Spreadsheet Data Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-100 text-[11px] font-bold text-slate-700 tracking-wider uppercase">
              <th className="py-3 pl-4 pr-2 font-mono">#</th>
              <th className="py-3 px-3">Status</th>
              <th className="py-3 px-3">Customer &amp; Designation</th>
              <th className="py-3 px-3">Contact (Phone &amp; Email)</th>
              <th className="py-3 px-3">Company &amp; City</th>
              <th className="py-3 px-2 text-right">Outlets</th>
              <th className="py-3 px-3">Equipment Interest</th>
              <th className="py-3 pl-2 pr-4">Updated</th>
              {isAdminAuthenticated && <th className="py-3 pl-2 pr-4 text-right">Action</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200 text-xs text-slate-800">
            {filteredLeads.length === 0 ? (
              <tr>
                <td
                  colSpan={isAdminAuthenticated ? 9 : 8}
                  className="py-12 px-6 text-center text-slate-500"
                >
                  No leads match your search or filter. New submissions will appear here instantly.
                </td>
              </tr>
            ) : (
              filteredLeads.map((lead, idx) => {
                const isCurrentDraft = activeDraftId === lead.leadId;
                const isConfirmed = lead.status === 'confirmed';

                const rowBg = isCurrentDraft
                  ? 'bg-amber-50/80 hover:bg-amber-100/60'
                  : isConfirmed
                    ? 'bg-white hover:bg-slate-50'
                    : 'bg-amber-50/40 hover:bg-amber-50/80';

                const interestsList = Array.isArray(lead.productInterest) ? lead.productInterest : [];

                return (
                  <tr key={lead.leadId} className={`transition-colors ${rowBg}`}>
                    <td className="py-3 pl-4 pr-2 font-mono text-slate-500 tabular-nums">
                      {idx + 1}
                    </td>
                    <td className="py-3 px-3 whitespace-nowrap">
                      {isConfirmed ? (
                        <span className="inline-flex items-center gap-1 font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2.5 py-1 rounded-full">
                          <CheckCircle2 className="h-3 w-3" />
                          Confirmed {lead.whatsappSent ? '· WA' : ''}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 font-semibold text-amber-800 bg-amber-50 border border-amber-200 px-2.5 py-1 rounded-full">
                          Partial {isCurrentDraft ? '· Live' : '· Draft'}
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-3">
                      <div className="font-bold text-slate-900">{lead.name || '—'}</div>
                      <div className="text-slate-500 text-[11px] flex items-center gap-1 mt-0.5">
                        <Briefcase className="h-3 w-3 text-slate-400 shrink-0" />
                        <span>{lead.designation || 'No designation'}</span>
                      </div>
                    </td>
                    <td className="py-3 px-3">
                      <div className="font-mono text-slate-950 tabular-nums">{lead.phone || '—'}</div>
                      <div className="text-slate-500 text-[11px] flex items-center gap-1 mt-0.5">
                        <Mail className="h-3 w-3 text-slate-400 shrink-0" />
                        <span>{lead.emailAddress || 'No email'}</span>
                      </div>
                    </td>
                    <td className="py-3 px-3">
                      <div className="font-semibold text-slate-900">{lead.companyName || '—'}</div>
                      <div className="text-slate-500 text-[11px] flex items-center gap-1 mt-0.5">
                        <MapPin className="h-3 w-3 text-slate-400 shrink-0" />
                        <span>{lead.city || 'No city'}</span>
                      </div>
                    </td>
                    <td className="py-3 px-2 text-right font-mono font-semibold text-slate-900 tabular-nums">
                      {lead.outletsCount || '—'}
                    </td>
                    <td className="py-3 px-3">
                      {interestsList.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {interestsList.map((item) => (
                            <span
                              key={item}
                              className="inline-block rounded-md bg-sky-50 border border-sky-200 text-sky-800 text-[11px] font-medium px-2 py-0.5"
                            >
                              {item}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="text-slate-400 italic">None selected</span>
                      )}
                    </td>
                    <td className="py-3 pl-2 pr-4 text-slate-500 tabular-nums whitespace-nowrap">
                      {formatReadableTimestamp(lead.updatedAt)}
                    </td>
                    {isAdminAuthenticated && (
                      <td className="py-3 pl-2 pr-4 text-right">
                        <button
                          type="button"
                          onClick={() => setLeadToDelete(lead)}
                          aria-label={`Delete lead for ${lead.name || lead.leadId}`}
                          className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition-colors cursor-pointer"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </td>
                    )}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Confirmation Dialog before Destructive Delete */}
      {leadToDelete && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-lead-dialog-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4"
        >
          <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl space-y-4">
            <h3 id="delete-lead-dialog-title" className="font-display text-lg font-bold text-slate-900">
              Delete Lead Record?
            </h3>
            <p className="text-sm text-slate-600">
              Are you sure you want to permanently remove the lead for{' '}
              <span className="font-semibold text-slate-900">
                {leadToDelete.name || leadToDelete.phone || leadToDelete.leadId}
              </span>{' '}
              ({leadToDelete.companyName || 'Unlisted Company'})? This action cannot be undone.
            </p>
            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setLeadToDelete(null)}
                className="rounded-xl border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold px-4 py-2.5 transition-colors cursor-pointer shadow-sm"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  onDeleteLead(leadToDelete);
                  setLeadToDelete(null);
                }}
                className="rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold px-4 py-2.5 transition-colors cursor-pointer shadow-sm"
              >
                Confirm Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
};
