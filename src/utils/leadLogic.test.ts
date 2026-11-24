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

test('sanitizeLeadInput trims strings and rejects unknown product interest', () => {
  const sanitized = sanitizeLeadInput({
    name: '  Aarav Sharma \n',
    phone: '  +91 98765 43210 ',
    companyName: '  Apex Mart  ',
    outletsCount: ' 14 ',
    productInterest: 'Invalid Product' as any,
  });
  assert.equal(sanitized.name, 'Aarav Sharma');
  assert.equal(sanitized.phone, '+91 98765 43210');
  assert.equal(sanitized.companyName, 'Apex Mart');
  assert.equal(sanitized.outletsCount, '14');
  assert.equal(sanitized.productInterest, '');
});

test('hasAnyLeadContent detects partial keystroke drafts', () => {
  assert.equal(
    hasAnyLeadContent({
      name: '',
      phone: '',
      companyName: '',
      outletsCount: '',
      productInterest: '',
    }),
    false
  );
  assert.equal(
    hasAnyLeadContent({
      name: 'R',
      phone: '',
      companyName: '',
      outletsCount: '',
      productInterest: '',
    }),
    true
  );
});

test('validateLeadForSubmit enforces required fields and product choice', () => {
  const invalid = validateLeadForSubmit({
    name: 'A',
    phone: '12345',
    companyName: '',
    outletsCount: '0',
    productInterest: '',
  });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.name);
  assert.ok(invalid.errors.phone);
  assert.ok(invalid.errors.companyName);
  assert.ok(invalid.errors.outletsCount);
  assert.ok(invalid.errors.productInterest);

  const valid = validateLeadForSubmit({
    name: 'Rohan Patel',
    phone: '9876543210',
    companyName: 'Patel Supermart',
    outletsCount: '6',
    productInterest: 'Electronic Shelf Label',
  });
  assert.equal(valid.valid, true);
  assert.deepEqual(valid.errors, {});
});

test('normalizePhoneForWhatsApp handles 10-digit Indian and international numbers', () => {
  assert.equal(normalizePhoneForWhatsApp('98765-43210'), '919876543210');
  assert.equal(normalizePhoneForWhatsApp('09876543210'), '919876543210');
  assert.equal(normalizePhoneForWhatsApp('+1 (415) 555-2671'), '14155552671');
});

test('buildWhatsAppConfirmationMessage and direct URL format cleanly', () => {
  const msg = buildWhatsAppConfirmationMessage({
    name: 'Meera Joshi',
    phone: '9820112233',
    companyName: 'Joshi Bakers',
    outletsCount: '4',
    productInterest: 'Degree-In Equipment',
  });
  assert.match(msg, /Meera Joshi/);
  assert.match(msg, /Prestier System LLP/);
  assert.match(msg, /Degree-In Equipment/);

  const url = buildWhatsAppDirectUrl('9820112233', msg);
  assert.ok(url.startsWith('https://wa.me/919820112233?text='));
});

test('formatLeadForSheetRow, leadsToCsv, and computeLeadMetrics work accurately', () => {
  const sampleLeads: LeadRecord[] = [
    {
      leadId: 'lead_1',
      name: 'Nikhil Verma',
      phone: '9811122233',
      companyName: 'Verma Retail, Pvt Ltd',
      outletsCount: '8',
      productInterest: 'Display Cabinet',
      status: 'confirmed',
      whatsappSent: true,
      sheetSynced: true,
      createdAt: '2026-11-20T10:00:00.000Z',
      updatedAt: '2026-11-20T10:05:00.000Z',
    },
    {
      leadId: 'lead_2',
      name: 'Karan',
      phone: '9899001122',
      companyName: '',
      outletsCount: '',
      productInterest: '',
      status: 'partial',
      whatsappSent: false,
      sheetSynced: false,
      createdAt: '2026-11-20T11:00:00.000Z',
      updatedAt: '2026-11-20T11:00:00.000Z',
    },
  ];

  const row = formatLeadForSheetRow(sampleLeads[1]);
  assert.equal(row[1], 'PARTIAL (LIVE DRAFT)');
  assert.equal(row[6], 'Pending Selection');

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
