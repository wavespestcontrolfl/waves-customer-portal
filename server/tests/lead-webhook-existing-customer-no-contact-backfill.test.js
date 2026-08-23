/**
 * Public lead webhook — existing customer matched WITHOUT proven identity.
 *
 * POST /api/leads (and /api/webhooks/lead) is unauthenticated and resolves
 * an existing customers row by the submitted phone alone. Backfilling
 * contact and location fields onto that row from the form let anyone who
 * knew a customer's phone set the customer's email (and address) to their
 * own — and receive that customer's invoices, pay links and reports.
 *
 * Rule under test (sibling of the /public/quote/calculate fix): the
 * existing-customer update carries ONLY attribution, last-contact and
 * intake-status fields. Email, address lines, city/state/zip and lat/lng are
 * never written here; the submitted contact details ride on the existing-
 * customer interaction note's metadata for staff reconciliation (existing
 * customers return before the leads insert).
 */

jest.mock('../models/db', () => { const db = jest.fn(); db.raw = jest.fn(); return db; });
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { _test } = require('../routes/lead-webhook');

const { buildExistingCustomerLeadUpdates } = _test;

const CONTACT_FIELDS = [
  'email', 'address_line1', 'address_line2', 'city', 'state', 'zip', 'latitude', 'longitude',
];

const blankCustomer = () => ({
  id: 'c-1',
  email: null,
  address_line1: null,
  address_line2: null,
  city: null,
  state: null,
  zip: null,
  latitude: null,
  longitude: null,
  lead_source: null,
  lead_source_detail: null,
  lead_intake_status: null,
});

const leadSource = { source: 'website', detail: 'main_site_form', channel: 'organic', area: 'Sarasota' };

describe('buildExistingCustomerLeadUpdates', () => {
  test('never backfills contact or location fields, even when blank on the row', () => {
    const updates = buildExistingCustomerLeadUpdates({ existing: blankCustomer(), leadSource });
    for (const f of CONTACT_FIELDS) expect(updates).not.toHaveProperty(f);
  });

  test('still fills attribution and last-contact fields', () => {
    const updates = buildExistingCustomerLeadUpdates({ existing: blankCustomer(), leadSource });
    expect(updates).toMatchObject({
      last_contact_type: 'form_submission',
      lead_source: 'website',
      lead_source_detail: 'main_site_form',
    });
    expect(updates.last_contact_date).toBeInstanceOf(Date);
    expect(updates).not.toHaveProperty('lead_intake_status');
  });

  test('clears a pending intake status and does not overwrite attribution already on the row', () => {
    const updates = buildExistingCustomerLeadUpdates({
      existing: { ...blankCustomer(), lead_source: 'google_ads', lead_source_detail: 'd', lead_intake_status: 'pending' },
      leadSource,
    });
    expect(Object.keys(updates).sort()).toEqual(
      ['last_contact_date', 'last_contact_type', 'lead_intake_status']
    );
    expect(updates.lead_intake_status).toBeNull();
  });
});

describe('route wiring', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../routes/lead-webhook.js'), 'utf8');

  test('the existing-customer branch writes via the helper and not the email-claim guard', () => {
    expect(src).toMatch(/const updates = buildExistingCustomerLeadUpdates\(\{ existing, leadSource \}\);/);
    expect(src).not.toMatch(/applyCustomerUpdatesWithEmailClaimGuard/);
  });

  test('the existing-customer interaction note carries the submitted contact details for staff', () => {
    const note = src.slice(src.indexOf("subject: 'Form submission (existing customer)'"));
    const metadata = note.slice(0, note.indexOf('logger.info('));
    // Contact line leads the body (Customer 360 previews body[0..200]).
    expect(metadata).toMatch(/body: `Submitted contact \(not applied to profile\): email \$\{email \|\| '—'\}; address \$\{fullAddress \|\| '—'\}`/);
    expect(metadata).toMatch(/submittedContact: \{/);
    expect(metadata).toMatch(/email: email \|\| null,/);
    expect(metadata).toMatch(/address: fullAddress \|\| null,/);
    expect(metadata).toMatch(/zip: normalizedAddress\.zip \|\| null,/);
  });
});
