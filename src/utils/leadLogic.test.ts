// Unit tests for lead sanitization, IST timestamps, and WhatsApp formatting
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildWhatsAppConfirmationMessage,
  buildWhatsAppDirectUrl,
  computeLeadMetrics,
  formatLeadForSheetRow,
  formatReadableTimestamp,
  hasAnyLeadContent,
  leadsToCsv,
  normalizePhoneForWhatsApp,
  sanitizeLeadInput,
  validateLeadForSubmit,
  type LeadRecord,
} from './leadLogic.ts';

test('sanitizeLeadInput trims strings and filters unknown product interests', () => {
  const res = sanitizeLeadInput({
    name: '  Rajesh Sharma  ',
    designation: 'Director',
    phone: '+91 9876543210',
    companyName: 'Royal Bakery',
    city: 'Mumbai',
    emailAddress: 'rajesh@royalbakery.in',
    outletsCount: '5',
    productInterest: ['Display Cabinet', 'Unknown Product', 'Electronic Shelf Label'],
  });
  assert.equal(res.name, 'Rajesh Sharma');
  assert.deepEqual(res.productInterest, ['Display Cabinet', 'Electronic Shelf Label']);
});

test('hasAnyLeadContent detects partial keystroke drafts', () => {
  assert.equal(
    hasAnyLeadContent({
      name: '',
      designation: '',
      phone: '+91 ',
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
      phone: '+91 ',
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
  const result = validateLeadForSubmit({
    name: '',
    designation: '',
    phone: '',
    companyName: '',
    city: '',
    emailAddress: '',
    outletsCount: '',
    productInterest: [],
  });
  assert.equal(result.valid, true);
});

test('normalizePhoneForWhatsApp handles 10-digit Indian and international numbers', () => {
  assert.equal(normalizePhoneForWhatsApp('98765 43210'), '919876543210');
  assert.equal(normalizePhoneForWhatsApp('09876543210'), '919876543210');
  assert.equal(normalizePhoneForWhatsApp('+91 9876543210'), '919876543210');
});

test('buildWhatsAppConfirmationMessage and direct URL format cleanly', () => {
  const msg = buildWhatsAppConfirmationMessage({
    name: 'Ananya',
    designation: 'Founder',
    phone: '9876543210',
    companyName: 'Artisan Crust',
    city: 'Pune',
    emailAddress: 'ananya@artisancrust.in',
    outletsCount: '4',
    productInterest: ['Display Cabinet'],
  });
  assert.ok(msg.includes('Team Prestair'));
  const url = buildWhatsAppDirectUrl('9876543210', msg);
  assert.ok(url.startsWith('https://wa.me/919876543210?text='));
});

test('formatLeadForSheetRow, IST timestamps, leadsToCsv, and computeLeadMetrics work accurately', () => {
  const formattedIst = formatReadableTimestamp('2026-11-24T18:07:34.000Z');
  assert.ok(formattedIst.includes('24 Nov 2026'));
  assert.ok(formattedIst.toLowerCase().includes('11:37:34'));
  assert.ok(formattedIst.endsWith('IST'));

  const sample: LeadRecord = {
    leadId: 'lead_test_1',
    name: 'Abhishek Chauhan',
    designation: 'Owner',
    phone: '+91 7318531953',
    companyName: 'Cake Urban',
    city: 'Maharajganj',
    emailAddress: 'abhi@example.com',
    outletsCount: '7',
    productInterest: ['Display Cabinet'],
    status: 'confirmed',
    whatsappSent: true,
    sheetSynced: true,
    createdAt: '2026-11-24T18:07:34.000Z',
    updatedAt: '2026-11-24T18:07:34.000Z',
  };
  const row = formatLeadForSheetRow(sample);
  assert.equal(row[0], 'lead_test_1');
  assert.equal(row[1], 'CONFIRMED');
  assert.ok(row[11].endsWith('IST'));

  const csv = leadsToCsv([sample]);
  assert.ok(csv.includes('Cake Urban'));

  const metrics = computeLeadMetrics([sample]);
  assert.equal(metrics.total, 1);
  assert.equal(metrics.confirmed, 1);
  assert.equal(metrics.whatsappSent, 1);
});
