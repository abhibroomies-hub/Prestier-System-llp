// Shared lead validation, formatting, IST timestamp, and Apps Script helpers
export type LeadStatus = 'partial' | 'confirmed';

export interface LeadFormInput {
  name: string;
  designation: string;
  phone: string;
  companyName: string;
  city: string;
  emailAddress: string;
  outletsCount: string;
  productInterest: string[];
}

export interface LeadRecord extends LeadFormInput {
  leadId: string;
  sessionToken?: string;
  status: LeadStatus;
  whatsappSent: boolean;
  sheetSynced: boolean;
  sheetRowNumber?: number | null;
  createdAt: string;
  updatedAt: string;
}

export const DEFAULT_PRESTAIR_WHATSAPP_REPLY = [
  'Thank you for your inquiry! 😊',
  'We appreciate your interest in our bakery solutions.',
  '',
  'Please let us know your exact requirements so that our team can understand your needs and get back to you with the most suitable solutions.',
  '',
  'Meanwhile, follow us on Instagram to explore our latest products, innovative designs, and updates.',
  '',
  '📲 instagram.com/prestairsystem',
  '',
  'Looking forward to connecting with you!',
  '',
  'Team Prestair',
].join('\n');

export const PRESTAIR_REPLY_IMAGES = [
  '/assets/aistudio/image_667a0296.png',
] as const;

export const PRODUCT_OPTIONS: ReadonlyArray<{
  value: string;
  label: string;
  shortLabel: string;
  description: string;
  accentKey: 'sky' | 'emerald' | 'amber';
}> = [
  {
    value: 'Display Cabinet',
    label: 'Display Cabinet',
    shortLabel: 'Display Cabinet',
    description: 'Precision stainless steel refrigerated & dry bakery display showcases',
    accentKey: 'sky',
  },
  {
    value: 'Electronic Shelf Label',
    label: 'Electronic Shelf Label',
    shortLabel: 'Electronic Shelf Label',
    description: 'Smart digital ESL pricing tags with instant wireless retail sync',
    accentKey: 'emerald',
  },
  {
    value: 'Degree-In Equipment',
    label: 'Degree-In Equipment',
    shortLabel: 'Degree-In Equipment',
    description: 'Temperature-controlled stainless steel processing & bakery equipment',
    accentKey: 'amber',
  },
];

export const VALID_PRODUCT_INTERESTS = new Set<string>([
  'Display Cabinet',
  'Electronic Shelf Label',
  'Degree-In Equipment',
]);

export const LEAD_FIELD_LIMITS = {
  leadId: 128,
  sessionToken: 128,
  name: 120,
  designation: 100,
  phone: 32,
  companyName: 150,
  city: 100,
  emailAddress: 150,
  outletsCount: 24,
  productInterest: 200,
} as const;

export function sanitizeField(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\r\n/g, ' ').replace(/\n/g, ' ').trim().slice(0, maxLength);
}

export function normalizeProductInterests(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    const unique = new Set<string>();
    for (const item of raw) {
      if (typeof item === 'string') {
        const trimmed = item.trim();
        if (VALID_PRODUCT_INTERESTS.has(trimmed)) {
          unique.add(trimmed);
        }
      }
    }
    return Array.from(unique);
  }
  if (typeof raw === 'string' && raw.trim()) {
    const unique = new Set<string>();
    for (const part of raw.split(',')) {
      const trimmed = part.trim();
      if (VALID_PRODUCT_INTERESTS.has(trimmed)) {
        unique.add(trimmed);
      }
    }
    return Array.from(unique);
  }
  return [];
}

export function sanitizeLeadInput(
  raw: Partial<Record<keyof LeadFormInput, unknown>>
): LeadFormInput {
  return {
    name: sanitizeField(raw.name, LEAD_FIELD_LIMITS.name),
    designation: sanitizeField(raw.designation, LEAD_FIELD_LIMITS.designation),
    phone: sanitizeField(raw.phone, LEAD_FIELD_LIMITS.phone),
    companyName: sanitizeField(raw.companyName, LEAD_FIELD_LIMITS.companyName),
    city: sanitizeField(raw.city, LEAD_FIELD_LIMITS.city),
    emailAddress: sanitizeField(raw.emailAddress, LEAD_FIELD_LIMITS.emailAddress),
    outletsCount: sanitizeField(raw.outletsCount, LEAD_FIELD_LIMITS.outletsCount),
    productInterest: normalizeProductInterests(raw.productInterest),
  };
}

export function normalizeLeadRecord(raw: unknown): LeadRecord {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const sanitized = sanitizeLeadInput(obj);
  const nowIso = new Date().toISOString();
  const rawLeadId = sanitizeField(obj.leadId, LEAD_FIELD_LIMITS.leadId);
  return {
    leadId: rawLeadId || generateLeadId(),
    ...(typeof obj.sessionToken === 'string' && obj.sessionToken
      ? { sessionToken: sanitizeField(obj.sessionToken, LEAD_FIELD_LIMITS.sessionToken) }
      : {}),
    name: sanitized.name,
    designation: sanitized.designation,
    phone: sanitized.phone,
    companyName: sanitized.companyName,
    city: sanitized.city,
    emailAddress: sanitized.emailAddress,
    outletsCount: sanitized.outletsCount,
    productInterest: sanitized.productInterest,
    status: obj.status === 'confirmed' ? 'confirmed' : 'partial',
    whatsappSent: Boolean(obj.whatsappSent),
    sheetSynced: Boolean(obj.sheetSynced),
    sheetRowNumber: typeof obj.sheetRowNumber === 'number' ? obj.sheetRowNumber : null,
    createdAt: typeof obj.createdAt === 'string' && obj.createdAt ? obj.createdAt : nowIso,
    updatedAt: typeof obj.updatedAt === 'string' && obj.updatedAt ? obj.updatedAt : nowIso,
  };
}

export function hasAnyLeadContent(input: LeadFormInput): boolean {
  const phoneDigits = input.phone.replace(/\D/g, '');
  const hasRealPhone = phoneDigits.length > 0 && phoneDigits !== '91';
  return Boolean(
    input.name.trim() ||
      input.designation.trim() ||
      hasRealPhone ||
      input.companyName.trim() ||
      input.city.trim() ||
      input.emailAddress.trim() ||
      input.outletsCount.trim() ||
      (Array.isArray(input.productInterest) && input.productInterest.length > 0)
  );
}

export function normalizePhoneForWhatsApp(phone: string, defaultCountryCode = '91'): string {
  const digits = phone.replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 10) {
    return `${defaultCountryCode}${digits}`;
  }
  if (digits.length === 11 && digits.startsWith('0')) {
    return `${defaultCountryCode}${digits.slice(1)}`;
  }
  return digits;
}

export interface ValidationResult {
  valid: boolean;
  errors: Partial<Record<keyof LeadFormInput, string>>;
}

export function validateLeadForSubmit(_input: LeadFormInput): ValidationResult {
  return {
    valid: true,
    errors: {},
  };
}

export const GOOGLE_APPS_SCRIPT_CODE = `/**
 * Prestier System LLP — 24x7 Live Google Sheets Sync (Apps Script)
 *
 * Setup Steps:
 * 1. Open your Google Sheet -> Extensions -> Apps Script
 * 2. Delete existing code, paste this entire script, and press Ctrl+S (Save)
 * 3. Click "Deploy" -> "New deployment"
 * 4. Select type: "Web app"
 *    - Description: Prestier Live Leads Sync
 *    - Execute as: "Me"
 *    - Who has access: "Anyone"
 * 5. Click "Deploy", authorize access, copy the Web App URL (ends with /exec),
 *    and paste it inside the Prestier Admin -> Google Sheet Sync tab.
 */

var SHEET_NAME = 'Prestier Leads';
var HEADERS = [
  'Lead ID',
  'Status',
  'Full Name',
  'Designation',
  'Phone Number',
  'Company Name',
  'City',
  'Email Address',
  'No. of Outlets',
  'Equipment Requirements',
  'WhatsApp Sent',
  'Captured At',
  'Last Updated'
];

function getOrCreateLeadSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
  }
  if (sheet.getLastRow() === 0) {
    var headerRange = sheet.getRange(1, 1, 1, HEADERS.length);
    headerRange.setValues([HEADERS]);
    headerRange.setFontWeight('bold');
    headerRange.setBackground('#0F172A');
    headerRange.setFontColor('#FFFFFF');
    sheet.setFrozenRows(1);
  }
  return { ss: ss, sheet: sheet };
}

function normalizeRowValues_(row) {
  var out = [];
  for (var i = 0; i < HEADERS.length; i++) {
    var val = row && i < row.length && row[i] !== null && row[i] !== undefined ? String(row[i]) : '—';
    out.push(val);
  }
  return out;
}

function upsertRows_(sheet, rows) {
  if (!rows || !rows.length) return 0;

  var lastRow = sheet.getLastRow();
  var idToRow = {};

  if (lastRow >= 2) {
    var existingIds = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (var r = 0; r < existingIds.length; r++) {
      var id = String(existingIds[r][0] || '').trim();
      if (id) {
        idToRow[id] = r + 2;
      }
    }
  }

  var rowsToAppend = [];
  var processed = 0;

  for (var i = 0; i < rows.length; i++) {
    var cleanRow = normalizeRowValues_(rows[i]);
    var leadId = String(cleanRow[0] || '').trim();
    if (!leadId) continue;

    var targetRow = idToRow[leadId];
    if (targetRow) {
      var updateRange = sheet.getRange(targetRow, 1, 1, HEADERS.length);
      updateRange.setNumberFormat('@');
      updateRange.setValues([cleanRow]);
    } else {
      rowsToAppend.push(cleanRow);
      idToRow[leadId] = lastRow + rowsToAppend.length;
    }
    processed++;
  }

  if (rowsToAppend.length > 0) {
    var startRow = sheet.getLastRow() + 1;
    var appendRange = sheet.getRange(startRow, 1, rowsToAppend.length, HEADERS.length);
    appendRange.setNumberFormat('@');
    appendRange.setValues(rowsToAppend);
  }

  return processed;
}

function syncExactRows_(sheet, rows) {
  var safeRows = Array.isArray(rows) ? rows : [];
  var validIds = {};
  for (var i = 0; i < safeRows.length; i++) {
    var rId = safeRows[i] && safeRows[i][0] ? String(safeRows[i][0]).trim() : '';
    if (rId) {
      validIds[rId] = true;
    }
  }

  var lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    var existingIds = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (var r = existingIds.length - 1; r >= 0; r--) {
      var id = String(existingIds[r][0] || '').trim();
      if (!id || !validIds[id]) {
        sheet.deleteRow(r + 2);
      }
    }
  }

  return upsertRows_(sheet, safeRows);
}

function deleteRowByLeadId_(sheet, targetLeadId) {
  var id = String(targetLeadId || '').trim();
  if (!id) return 0;
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return 0;
  var ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  var deleted = 0;
  for (var i = ids.length - 1; i >= 0; i--) {
    if (String(ids[i][0] || '').trim() === id) {
      sheet.deleteRow(i + 2);
      deleted++;
    }
  }
  return deleted;
}

function doGet() {
  var info = getOrCreateLeadSheet_();
  return ContentService.createTextOutput(
    JSON.stringify({
      ok: true,
      service: 'Prestier System LLP Live Sheet Sync',
      spreadsheetName: info.ss.getName(),
      sheetName: info.sheet.getName(),
      totalRows: Math.max(0, info.sheet.getLastRow() - 1)
    })
  ).setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var raw = e && e.postData && e.postData.contents ? e.postData.contents : '{}';
    var payload = JSON.parse(raw);
    var info = getOrCreateLeadSheet_();
    var sheet = info.sheet;
    var synced = 0;

    if (payload.action === 'bulk_sync' && Array.isArray(payload.rows)) {
      synced = syncExactRows_(sheet, payload.rows);
    } else if (payload.action === 'upsert' && Array.isArray(payload.row)) {
      synced = upsertRows_(sheet, [payload.row]);
    } else if (payload.action === 'delete' && payload.leadId) {
      synced = deleteRowByLeadId_(sheet, payload.leadId);
    } else if (payload.action === 'ping') {
      synced = 0;
    }

    return ContentService.createTextOutput(
      JSON.stringify({
        ok: true,
        synced: synced,
        spreadsheetName: info.ss.getName(),
        sheetName: sheet.getName(),
        spreadsheetUrl: info.ss.getUrl(),
        totalRows: Math.max(0, sheet.getLastRow() - 1)
      })
    ).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(
      JSON.stringify({
        ok: false,
        error: String(err && err.message ? err.message : err)
      })
    ).setMimeType(ContentService.MimeType.JSON);
  } finally {
    lock.releaseLock();
  }
}
`;

export function generateLeadId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `lead_${ts}_${rand}`;
}

export function generateSessionToken(): string {
  const part1 = Math.random().toString(36).slice(2, 10);
  const part2 = Math.random().toString(36).slice(2, 10);
  const part3 = Date.now().toString(36);
  return `tok_${part1}${part2}_${part3}`;
}

export function buildWhatsAppConfirmationMessage(
  lead: LeadFormInput,
  customTemplate?: string
): string {
  const interestsStr =
    Array.isArray(lead.productInterest) && lead.productInterest.length > 0
      ? lead.productInterest.join(', ')
      : 'Food service equipment';

  const template =
    customTemplate && customTemplate.trim().length > 0
      ? customTemplate
      : DEFAULT_PRESTAIR_WHATSAPP_REPLY;

  return template
    .replace(/\{\{name\}\}/g, lead.name || 'Valued Partner')
    .replace(/\{\{designation\}\}/g, lead.designation || '-')
    .replace(/\{\{phone\}\}/g, lead.phone || '-')
    .replace(/\{\{companyName\}\}/g, lead.companyName || '-')
    .replace(/\{\{city\}\}/g, lead.city || '-')
    .replace(/\{\{emailAddress\}\}/g, lead.emailAddress || '-')
    .replace(/\{\{outletsCount\}\}/g, lead.outletsCount || '-')
    .replace(/\{\{productInterest\}\}/g, interestsStr);
}

export function buildWhatsAppDirectUrl(phone: string, message: string): string {
  const normalized = normalizePhoneForWhatsApp(phone);
  const encoded = encodeURIComponent(message);
  if (!normalized) {
    return `https://wa.me/?text=${encoded}`;
  }
  return `https://wa.me/${normalized}?text=${encoded}`;
}

export const SHEET_HEADERS = [
  'Lead ID',
  'Status',
  'Full Name',
  'Designation',
  'Phone Number',
  'Company Name',
  'City',
  'Email Address',
  'No. of Outlets',
  'Product Interest',
  'WhatsApp Sent',
  'Captured At',
  'Last Updated',
] as const;

export function formatLeadForSheetRow(lead: LeadRecord): string[] {
  const normalized = normalizeLeadRecord(lead);
  const interestsStr =
    normalized.productInterest.length > 0
      ? normalized.productInterest.join(', ')
      : 'Pending Selection';
  return [
    normalized.leadId,
    normalized.status === 'confirmed' ? 'CONFIRMED' : 'PARTIAL (LIVE DRAFT)',
    normalized.name || '—',
    normalized.designation || '—',
    normalized.phone || '—',
    normalized.companyName || '—',
    normalized.city || '—',
    normalized.emailAddress || '—',
    normalized.outletsCount || '—',
    interestsStr,
    normalized.whatsappSent ? 'Yes' : 'Pending',
    formatReadableTimestamp(normalized.createdAt),
    formatReadableTimestamp(normalized.updatedAt),
  ];
}

export function formatReadableTimestamp(iso: string): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  })} IST`;
}

export function escapeCsvCell(value: string): string {
  const safe = String(value ?? '');
  if (safe.includes(',') || safe.includes('"') || safe.includes('\n')) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

export function leadsToCsv(leads: LeadRecord[]): string {
  const headerLine = SHEET_HEADERS.map(escapeCsvCell).join(',');
  const rows = leads.map((lead) => formatLeadForSheetRow(lead).map(escapeCsvCell).join(','));
  return [headerLine, ...rows].join('\n');
}

export function computeLeadMetrics(leads: LeadRecord[]) {
  let confirmed = 0;
  let partial = 0;
  let sheetSynced = 0;
  let whatsappSent = 0;
  for (const l of leads) {
    if (l.status === 'confirmed') confirmed += 1;
    else partial += 1;
    if (l.sheetSynced) sheetSynced += 1;
    if (l.whatsappSent) whatsappSent += 1;
  }
  return {
    total: leads.length,
    confirmed,
    partial,
    sheetSynced,
    whatsappSent,
  };
}
