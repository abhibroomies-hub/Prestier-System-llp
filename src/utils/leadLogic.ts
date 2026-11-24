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

export interface LeadRecord extends Omit<LeadFormInput, 'productInterest'> {
  leadId: string;
  sessionToken?: string;
  productInterest: string[];
  status: LeadStatus;
  whatsappSent: boolean;
  sheetSynced: boolean;
  sheetRowNumber?: number | null;
  createdAt: string;
  updatedAt: string;
}

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
    description: 'Precision stainless steel refrigerated & dry retail display showcases',
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

export function sanitizeLeadInput(raw: Partial<LeadFormInput>): LeadFormInput {
  let rawInterests: string[] = [];
  if (Array.isArray(raw.productInterest)) {
    rawInterests = raw.productInterest.filter((item): item is string => typeof item === 'string' && VALID_PRODUCT_INTERESTS.has(item));
  } else if (typeof raw.productInterest === 'string' && raw.productInterest.trim()) {
    rawInterests = raw.productInterest.split(',').map((s) => s.trim()).filter((s) => VALID_PRODUCT_INTERESTS.has(s));
  }

  return {
    name: sanitizeField(raw.name, LEAD_FIELD_LIMITS.name),
    designation: sanitizeField(raw.designation, LEAD_FIELD_LIMITS.designation),
    phone: sanitizeField(raw.phone, LEAD_FIELD_LIMITS.phone),
    companyName: sanitizeField(raw.companyName, LEAD_FIELD_LIMITS.companyName),
    city: sanitizeField(raw.city, LEAD_FIELD_LIMITS.city),
    emailAddress: sanitizeField(raw.emailAddress, LEAD_FIELD_LIMITS.emailAddress),
    outletsCount: sanitizeField(raw.outletsCount, LEAD_FIELD_LIMITS.outletsCount),
    productInterest: rawInterests,
  };
}

export function hasAnyLeadContent(input: LeadFormInput): boolean {
  return Boolean(
    input.name.trim() ||
      input.designation.trim() ||
      input.phone.trim() ||
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

export function validateLeadForSubmit(input: LeadFormInput): ValidationResult {
  const errors: Partial<Record<keyof LeadFormInput, string>> = {};

  if (!input.name.trim() || input.name.trim().length < 2) {
    errors.name = 'Please enter your full name.';
  }

  if (!input.designation.trim()) {
    errors.designation = 'Please enter your designation (e.g. Director, Store Manager).';
  }

  const digits = input.phone.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) {
    errors.phone = 'Enter a valid 10–15 digit phone / WhatsApp number.';
  }

  if (!input.companyName.trim()) {
    errors.companyName = 'Please enter your company or store name.';
  }

  if (!input.city.trim()) {
    errors.city = 'Please enter your city.';
  }

  if (!input.emailAddress.trim() || !input.emailAddress.includes('@')) {
    errors.emailAddress = 'Enter a valid email address.';
  }

  const outletsNum = Number(input.outletsCount.trim());
  if (!input.outletsCount.trim() || !Number.isFinite(outletsNum) || outletsNum < 1 || outletsNum > 100000) {
    errors.outletsCount = 'Enter the number of outlets (at least 1).';
  }

  if (!Array.isArray(input.productInterest) || input.productInterest.length === 0) {
    errors.productInterest = 'Select at least one equipment category.';
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors,
  };
}

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
  const interestsStr = Array.isArray(lead.productInterest) && lead.productInterest.length > 0
    ? lead.productInterest.join(', ')
    : 'Food service equipment';

  const template =
    customTemplate && customTemplate.trim().length > 0
      ? customTemplate
      : [
          'Thank you for your inquiry! 😊 We appreciate your interest in our bakery solutions. Please let us know your exact requirements so that our team can understand your needs and get back to you with the most suitable solutions. Meanwhile, follow us on Instagram to explore our latest products, innovative designs, and updates. 📲 instagram.com/prestairsystem Looking forward to connecting with you! Team Prestair',
        ].join('\n');

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
  const interestsStr = Array.isArray(lead.productInterest) ? lead.productInterest.join(', ') : (lead.productInterest || '—');
  return [
    lead.leadId,
    lead.status === 'confirmed' ? 'CONFIRMED' : 'PARTIAL (LIVE DRAFT)',
    lead.name || '—',
    lead.designation || '—',
    lead.phone || '—',
    lead.companyName || '—',
    lead.city || '—',
    lead.emailAddress || '—',
    lead.outletsCount || '—',
    interestsStr,
    lead.whatsappSent ? 'Yes' : 'Pending',
    formatReadableTimestamp(lead.createdAt),
    formatReadableTimestamp(lead.updatedAt),
  ];
}

export function formatReadableTimestamp(iso: string): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
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
