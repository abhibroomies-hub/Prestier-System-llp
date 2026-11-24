import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWhatsAppConfirmationMessage,
  buildWhatsAppDirectUrl,
  computeLeadMetrics,
  formatLeadForSheetRow,
  hasAnyLeadContent,
  leadsToCsv,
  normalizePhoneForWhatsApp,
  sanitizeLeadInput,
  validateLeadForSubmit,
  type LeadRecord,
} from './leadLogic';

test('sanitizeLeadInput trims strings and filters unknown product interests', () => {
  const sanitized = sanitizeLeadInput({
    name: '  Aarav Sharma \n',
    designation: ' Director ',
    phone: '  +91 98765 43210 ',
    companyName: '  Apex Mart  ',
    city: ' Mumbai ',
    emailAddress: ' aarav@apex.com ',
    outletsCount: ' 14 ',
    productInterest: ['Display Cabinet', 'Invalid Product'] as any,
  });
  assert.equal(sanitized.name, 'Aarav Sharma');
  assert.equal(sanitized.designation, 'Director');
  assert.equal(sanitized.phone, '+91 98765 43210');
  assert.equal(sanitized.companyName, 'Apex Mart');
  assert.equal(sanitized.city, 'Mumbai');
  assert.equal(sanitized.emailAddress, 'aarav@apex.com');
  assert.equal(sanitized.outletsCount, '14');
  assert.deepEqual(sanitized.productInterest, ['Display Cabinet']);
});

test('hasAnyLeadContent detects partial keystroke drafts', () => {
  assert.equal(
    hasAnyLeadContent({
      name: '',
      designation: '',
      phone: '',
      companyName: '',
      city: '',
      emailAddress: '',
      outletsCount: '',
      productInterest: [],
    }),
    false
  );
  assert.equal(
    hasAnyLeadContent({
      name: 'R',
      designation: '',
      phone: '',
      companyName: '',
      city: '',
      emailAddress: '',
      outletsCount: '',
      productInterest: [],
    }),
    true
  );
});

test('validateLeadForSubmit allows optional fields with nothing compulsory', () => {
  const emptySubmit = validateLeadForSubmit({
    name: '',
    designation: '',
    phone: '+91 ',
    companyName: '',
    city: '',
    emailAddress: '',
    outletsCount: '',
    productInterest: [],
  });
  assert.equal(emptySubmit.valid, true);
  assert.deepEqual(emptySubmit.errors, {});

  const partialSubmit = validateLeadForSubmit({
    name: 'Rohan',
    designation: '',
    phone: '',
    companyName: '',
    city: '',
    emailAddress: '',
    outletsCount: '',
    productInterest: [],
  });
  assert.equal(partialSubmit.valid, true);
  assert.deepEqual(partialSubmit.errors, {});
});

test('normalizePhoneForWhatsApp handles 10-digit Indian and international numbers', () => {
  assert.equal(normalizePhoneForWhatsApp('98765-43210'), '919876543210');
  assert.equal(normalizePhoneForWhatsApp('09876543210'), '919876543210');
  assert.equal(normalizePhoneForWhatsApp('+1 (415) 555-2671'), '14155552671');
});

test('buildWhatsAppConfirmationMessage and direct URL format cleanly', () => {
  const msg = buildWhatsAppConfirmationMessage({
    name: 'Meera Joshi',
    designation: 'Manager',
    phone: '9820112233',
    companyName: 'Joshi Bakers',
    city: 'Nagpur',
    emailAddress: 'meera@joshibakers.com',
    outletsCount: '4',
    productInterest: ['Degree-In Equipment'],
  });
  assert.match(msg, /Thank you for your inquiry/);
  assert.match(msg, /instagram.com\/prestairsystem/);

  const url = buildWhatsAppDirectUrl('9820112233', msg);
  assert.ok(url.startsWith('https://wa.me/919820112233?text='));
});

test('formatLeadForSheetRow, leadsToCsv, and computeLeadMetrics work accurately', () => {
  const sampleLeads: LeadRecord[] = [
    {
      leadId: 'lead_1',
      name: 'Nikhil Verma',
      designation: 'Director',
      phone: '9811122233',
      companyName: 'Verma Retail, Pvt Ltd',
      city: 'Delhi',
      emailAddress: 'nikhil@verma.com',
      outletsCount: '8',
      productInterest: ['Display Cabinet'],
      status: 'confirmed',
      whatsappSent: true,
      sheetSynced: true,
      createdAt: '2026-11-20T10:00:00.000Z',
      updatedAt: '2026-11-20T10:05:00.000Z',
    },
    {
      leadId: 'lead_2',
      name: 'Karan',
      designation: '',
      phone: '9899001122',
      companyName: '',
      city: '',
      emailAddress: '',
      outletsCount: '',
      productInterest: [],
      status: 'partial',
      whatsappSent: false,
      sheetSynced: false,
      createdAt: '2026-11-20T11:00:00.000Z',
      updatedAt: '2026-11-20T11:00:00.000Z',
    },
  ];

  const row = formatLeadForSheetRow(sampleLeads[1]);
  assert.equal(row[1], 'PARTIAL (LIVE DRAFT)');

  const csv = leadsToCsv(sampleLeads);
  assert.match(csv, /"Verma Retail, Pvt Ltd"/);
  assert.match(csv, /CONFIRMED/);

  const metrics = computeLeadMetrics(sampleLeads);
  assert.deepEqual(metrics, {
    total: 2,
    confirmed: 1,
    partial: 1,
    sheetSynced: 1,
    whatsappSent: 1,
  });
});
