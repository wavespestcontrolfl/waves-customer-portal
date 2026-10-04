// A website lead form that posts with no Turnstile token while the gate is
// enforcing is held for the office, not dropped (owner 2026-10-04). The hold
// writes one customer-less lead + one activity + one bell and nothing else.

const mockState = { prior: null, inserts: [], raws: [], wheres: [] };

jest.mock('../models/db', () => {
  const makeTrx = () => {
    const trx = jest.fn((table) => {
      const qb = {
        where: jest.fn((...args) => { mockState.wheres.push([table, ...args]); return qb; }),
        whereNull: jest.fn(() => qb),
        whereRaw: jest.fn((...args) => { mockState.wheres.push([table, ...args]); return qb; }),
        first: jest.fn(async () => mockState.prior),
        insert: jest.fn((row) => {
          mockState.inserts.push({ table, row });
          const done = Promise.resolve([{ id: 'lead-1', ...row }]);
          done.returning = jest.fn(async () => [{ id: 'lead-1', ...row }]);
          return done;
        }),
      };
      return qb;
    });
    trx.raw = jest.fn(async (...args) => { mockState.raws.push(args); });
    return trx;
  };
  const db = jest.fn();
  db.transaction = jest.fn(async (fn) => fn(makeTrx()));
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockRaise = jest.fn(async () => ({ id: 'n-1' }));
jest.mock('../services/admin-alert-compose', () => ({
  ...jest.requireActual('../services/admin-alert-compose'),
  raiseAdminAlert: (...args) => mockRaise(...args),
}));

const { composeAdminAlert } = jest.requireActual('../services/admin-alert-compose');
const { holdUnverifiedLead, HOLD_STAGE } = require('../services/lead-unverified-hold');
const { _test } = require('../routes/lead-webhook');
const { CUSTOMER_ORIGINATED_LEAD_CHANNELS } = require('../services/collections/consent-provenance');
const { urgencyForTimeline } = require('../services/lead-timeline');

const intakeFor = (body) => _test.buildLeadWebhookIntake(body);
const BODY = {
  first_name: 'Dana',
  last_name: 'Sample',
  email: 'dana.sample@example.com',
  phone: '9415550142',
  address: '100 Test Palm Way, Parrish, FL 34219',
  service_interest: 'Pest Control',
  source: 'astro-quote',
};

beforeEach(() => {
  mockState.prior = null;
  mockState.inserts = [];
  mockState.raws = [];
  mockState.wheres = [];
  mockRaise.mockClear();
});

describe('holdUnverifiedLead', () => {
  test('saves one customer-less lead and one activity, and rings one bell', async () => {
    const out = await holdUnverifiedLead({ intake: intakeFor(BODY), leadSourceId: 'src-1' });

    expect(out).toEqual({ held: true, leadId: 'lead-1', deduped: false });
    expect(mockState.inserts.map((i) => i.table)).toEqual(['leads', 'lead_activities']);
    const lead = mockState.inserts[0].row;
    expect(lead).toMatchObject({
      first_name: 'Dana',
      last_name: 'Sample',
      lead_source_id: 'src-1',
      lead_type: 'form_submission',
      status: 'new',
    });
    // The contact is not proven to be the submitter's. It stays out of the
    // identity columns every trust reader keys on (ad audiences, the spam
    // blocker's known-lead bypass, the consent probes) and rides as a note.
    expect(lead.phone).toBeNull();
    expect(lead.email).toBeNull();
    expect(lead.first_contact_channel).toBe('form_unverified');
    expect(CUSTOMER_ORIGINATED_LEAD_CHANNELS).not.toContain(lead.first_contact_channel);
    expect(JSON.parse(lead.extracted_data).unverified_contact)
      .toEqual({ phone: '+19415550142', email: 'dana.sample@example.com' });
    expect(mockState.inserts[1].row.description)
      .toContain('Submitted contact, not verified: phone +19415550142; email dana.sample@example.com.');
    // No proven identity: the hold never links a customer profile.
    expect(lead).not.toHaveProperty('customer_id');
    expect(JSON.parse(lead.extracted_data)).toMatchObject({
      stage: HOLD_STAGE,
      verification: { turnstile: 'missing_token' },
    });
    expect(mockRaise).toHaveBeenCalledTimes(1);
  });

  test('the bell passes the admin notification rule and names the person', async () => {
    await holdUnverifiedLead({ intake: intakeFor(BODY) });
    const [category, spec, opts] = mockRaise.mock.calls[0];
    expect(category).toBe('lead');
    const composed = composeAdminAlert(spec);
    expect(composed.headline).toBe('Leads — call Dana Sample about a web quote request');
    expect(composed.link).toBe('/admin/leads?lead=lead-1');
    expect(opts).toMatchObject({ bell: true, dedupeKey: 'lead-unverified-hold:lead-1' });
  });

  test('a repeat from the same phone inside 24 hours adds no row and no bell', async () => {
    mockState.prior = { id: 'lead-0' };
    const out = await holdUnverifiedLead({ intake: intakeFor(BODY) });
    expect(out).toEqual({ held: true, leadId: 'lead-0', deduped: true });
    expect(mockState.inserts).toEqual([]);
    expect(mockRaise).not.toHaveBeenCalled();
    // The lookup is keyed on the phone and on the hold stage only.
    expect(mockState.wheres).toContainEqual(['leads', "extracted_data->'unverified_contact'->>'phone' = ?", ['+19415550142']]);
    expect(mockState.wheres).toContainEqual(['leads', "extracted_data->>'stage' = ?", [HOLD_STAGE]]);
    expect(mockState.raws[0][1]).toEqual(['lead-unverified-hold:+19415550142']);
  });

  test('no usable phone is not held (the caller keeps its 403)', async () => {
    expect(await holdUnverifiedLead({ intake: intakeFor({ ...BODY, phone: '555' }) }))
      .toEqual({ held: false, reason: 'not_reachable' });
    expect(mockState.inserts).toEqual([]);
    expect(mockRaise).not.toHaveBeenCalled();
  });

  test('the visitor message is kept for the office', async () => {
    await holdUnverifiedLead({ intake: intakeFor({ ...BODY, message: 'Ants in the  kitchen.\nCall after 3.' }) });
    expect(JSON.parse(mockState.inserts[0].row.extracted_data).message).toBe('Ants in the kitchen. Call after 3.');
    expect(mockState.inserts[1].row.description).toContain('Visitor wrote: "Ants in the kitchen. Call after 3."');
  });

  test('timeline, sign host, extra properties and the commercial verdict reach the row and the note', async () => {
    await holdUnverifiedLead({
      intake: intakeFor({ ...BODY, timeline: 'now', sign_host: '12 Sample Sign Ct' }),
      commercialFields: { is_commercial: true, is_residential: false },
    });
    const lead = mockState.inserts[0].row;
    expect(lead.urgency).toBe(urgencyForTimeline('now'));
    expect(lead).toMatchObject({ is_commercial: true, is_residential: false });
    expect(mockState.inserts[1].row.description).toContain('Saw our yard sign at: 12 Sample Sign Ct');
  });

  test('a long message is cut by code point, never mid-emoji', async () => {
    await holdUnverifiedLead({ intake: intakeFor({ ...BODY, message: `${'a'.repeat(999)}\u{1F41C}\u{1F41C}` }) });
    const kept = JSON.parse(mockState.inserts[0].row.extracted_data).message;
    expect(Array.from(kept)).toHaveLength(1000);
    expect(kept.endsWith('\u{1F41C}')).toBe(true);
    expect(kept.isWellFormed()).toBe(true);
  });

  test('a bell failure does not undo the saved lead', async () => {
    mockRaise.mockRejectedValueOnce(new Error('notify down'));
    const out = await holdUnverifiedLead({ intake: intakeFor(BODY) });
    expect(out).toMatchObject({ held: true, leadId: 'lead-1' });
  });
});
