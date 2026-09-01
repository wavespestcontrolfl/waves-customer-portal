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

const { buildExistingCustomerPublicQuoteUpdates, findExistingCustomerByContact } = _internals;

describe('findExistingCustomerByContact (codex #3591 r14 P1 — shared by the pre-pricing setup-waiver lookup and the customer link)', () => {
  const fakeDb = (phoneRows, emailRows) => () => {
    const calls = [];
    const chain = {
      whereRaw: (sql) => { calls.push(sql); return chain; },
      whereNull: () => chain,
      limit: () => chain,
      select: async () => (calls.some((sql) => sql.includes('regexp_replace')) && !calls.some((sql) => sql.includes('LOWER(email)')) ? phoneRows : emailRows),
    };
    return chain;
  };
  test('phone (last 10 digits) wins; email is the fallback; nothing → null', async () => {
    expect(await findExistingCustomerByContact(fakeDb([{ id: 'p' }], [{ id: 'e' }]), { contactPhone: '+1 (941) 555-0199', contactEmail: 'x@y.z' })).toEqual({ id: 'p' });
    expect(await findExistingCustomerByContact(fakeDb([], [{ id: 'e' }]), { contactPhone: '555', contactEmail: 'X@Y.Z' })).toEqual({ id: 'e' });
    expect(await findExistingCustomerByContact(fakeDb([], []), { contactPhone: '', contactEmail: '' })).toBeNull();
  });

  test('an AMBIGUOUS contact (two active rows) never links an arbitrary customer (codex #3591 r88 P1)', async () => {
    // Two rows share the phone — decline outright, even with a unique email
    // (the same shared household would just resolve by the other key).
    expect(await findExistingCustomerByContact(
      fakeDb([{ id: 'p1' }, { id: 'p2' }], [{ id: 'e' }]),
      { contactPhone: '+1 (941) 555-0199', contactEmail: 'x@y.z' },
    )).toBeNull();
    // Two rows share the email — decline.
    expect(await findExistingCustomerByContact(
      fakeDb([], [{ id: 'e1' }, { id: 'e2' }]),
      { contactPhone: '', contactEmail: 'x@y.z' },
    )).toBeNull();
    // No phone match at all still falls through to a UNIQUE email.
    expect(await findExistingCustomerByContact(
      fakeDb([], [{ id: 'e' }]),
      { contactPhone: '+1 (941) 555-0199', contactEmail: 'x@y.z' },
    )).toEqual({ id: 'e' });
  });
});

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
