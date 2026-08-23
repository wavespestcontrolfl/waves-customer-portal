/**
 * Public quote wizard — existing customer matched WITHOUT proven identity.
 *
 * POST /api/public/quote/calculate is unauthenticated and resolves an
 * existing customers row by phone digits (or email). Backfilling contact
 * and location fields onto that row from the form let anyone who knew a
 * customer's phone set the customer's email (and address / geo) to their
 * own — and receive that customer's invoices, pay links and reports.
 *
 * Rule under test: the existing-customer update carries ONLY attribution,
 * service interest, property size and last-contact fields. Email, address
 * lines, city/state/zip and lat/lng are never written here; the submitted
 * contact details stay on the leads row / estimate mirror for staff.
 */

const { _internals } = require('../routes/public-quote');

const { buildExistingCustomerPublicQuoteUpdates } = _internals;

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
  lead_source_channel: null,
  lead_source_area: null,
  property_sqft: null,
  lot_sqft: null,
  landing_page_url: null,
  utm_data: null,
});

const args = (existingCust) => ({
  existingCust,
  serviceInterestForCustomer: 'Pest Control',
  leadSourceDetail: 'quote_wizard',
  entryChannel: 'organic',
  quoteCity: 'Sarasota',
  sqft: 2000,
  lot: 9000,
  landingForCustomer: 'https://example.test/quote',
  utm: { utm_source: 'x' },
});

describe('buildExistingCustomerPublicQuoteUpdates', () => {
  test('never backfills contact or location fields, even when blank on the row', () => {
    const updates = buildExistingCustomerPublicQuoteUpdates(args(blankCustomer()));
    for (const f of CONTACT_FIELDS) expect(updates).not.toHaveProperty(f);
  });

  test('still fills attribution, interest, size and last-contact fields', () => {
    const updates = buildExistingCustomerPublicQuoteUpdates(args(blankCustomer()));
    expect(updates).toMatchObject({
      last_contact_type: 'website_quote',
      lead_service_interest: 'Pest Control',
      lead_source: 'website_quote',
      lead_source_detail: 'quote_wizard',
      lead_source_channel: 'organic',
      lead_source_area: 'Sarasota',
      property_sqft: 2000,
      lot_sqft: 9000,
      landing_page_url: 'https://example.test/quote',
      utm_data: { utm_source: 'x' },
    });
    expect(updates.last_contact_date).toBeInstanceOf(Date);
  });

  test('does not overwrite attribution / size already on the row', () => {
    const updates = buildExistingCustomerPublicQuoteUpdates(args({
      ...blankCustomer(),
      lead_source: 'google_ads',
      lead_source_detail: 'd',
      lead_source_channel: 'paid',
      lead_source_area: 'Venice',
      property_sqft: 1500,
      lot_sqft: 7000,
      landing_page_url: 'https://example.test/old',
      utm_data: { utm_source: 'old' },
    }));
    expect(Object.keys(updates).sort()).toEqual(
      ['last_contact_date', 'last_contact_type', 'lead_service_interest']
    );
  });
});

describe('route wiring', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../routes/public-quote.js'), 'utf8');

  test('the existing-customer branch writes via the helper and not the email-claim guard', () => {
    expect(src).toMatch(/const updates = buildExistingCustomerPublicQuoteUpdates\(\{/);
    expect(src).not.toMatch(/applyCustomerUpdatesWithEmailClaimGuard/);
  });
});
