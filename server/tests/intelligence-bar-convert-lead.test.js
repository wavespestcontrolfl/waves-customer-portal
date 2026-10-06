/**
 * convert_lead (owner IB history 10-06: the bar could not convert a lead to a
 * customer so an estimate could be sent). The Leads page "Convert to Customer"
 * action as a card: the tool and POST /api/admin/leads/:id/convert both run
 * leadAttribution.convertLeadToCustomer, which links the lead to an EXISTING
 * customer and marks it won. The unconfirmed call previews and writes nothing;
 * the confirmed call passes the card's pinned status and version as the lead
 * it "saw", so the win's UPDATE refuses a lead that moved after the card.
 */

jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  fn.transaction = jest.fn(async (cb) => cb(fn));
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/lead-funnel-bridge', () => ({
  bridgeLeadFunnelStage: jest.fn().mockResolvedValue({ reason: 'advanced' }),
  bridgeLeadsFunnelStage: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../services/lead-estimate-link', () => ({
  settleRepeatFunnelRow: jest.fn().mockResolvedValue(undefined),
  linkLeadEstimatesToCustomer: jest.fn().mockResolvedValue(1),
}));
jest.mock('../services/lead-attribution', () => ({
  ...jest.requireActual('../services/lead-attribution'),
  convertLeadToCustomer: jest.fn(),
}));

const db = require('../models/db');
const leadAttribution = require('../services/lead-attribution');
const { executeLeadsTool, LEADS_TOOLS } = require('../services/intelligence-bar/leads-tools');
const { buildContract } = require('../services/intelligence-bar/authorization-contract');
const { WRITE_TWO_STEP_TOOL_NAMES, LEGACY_BARE_WRITE_TOOL_NAMES } = require('../services/intelligence-bar/write-gates');
const OwnerDirect = require('../services/intelligence-bar/owner-direct');

const LEAD_ID = '11111111-1111-4111-8111-111111111111';
const CUSTOMER_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_CUSTOMER_ID = '33333333-3333-4333-8333-333333333333';
const LEAD_UPDATED = new Date('2026-10-06T14:00:00.123Z');
const LEAD = {
  id: LEAD_ID, first_name: 'Testa', last_name: 'Lead', status: 'estimate_sent', customer_id: null,
  phone: '+19415550101', email: 'testa@example.test', address: '1 Example St', city: 'Sarasota', zip: '34201',
  monthly_value: null, initial_service_value: null, converted_at: null,
  updated_at: LEAD_UPDATED,
};
const CUSTOMER = {
  id: CUSTOMER_ID, first_name: 'Testa', last_name: 'Lead', phone: '+19415550101', email: 'testa@example.test',
  address_line1: '1 Example St', city: 'Sarasota', state: 'FL', zip: '34201', deleted_at: null,
  updated_at: new Date('2026-10-06T15:00:00Z'),
};

function chain(resultByMethod = {}) {
  const c = {};
  for (const m of ['where', 'whereIn', 'whereNot', 'whereNull', 'whereRaw', 'whereILike', 'orWhereILike', 'orWhereRaw', 'orWhere', 'whereNotExists', 'whereExists', 'select', 'orderBy']) {
    c[m] = jest.fn(function (arg) {
      if (typeof arg === 'function') arg.call(c, c);
      return c;
    });
  }
  for (const m of ['first', 'limit', 'update', 'insert']) {
    c[m] = jest.fn(async () => (typeof resultByMethod[m] === 'function' ? resultByMethod[m]() : resultByMethod[m]));
  }
  return c;
}

function install({ lead = LEAD, customer = CUSTOMER } = {}) {
  const tables = { leads: chain({ first: lead }), customers: chain({ first: customer }) };
  db.mockImplementation((table) => tables[table] || chain());
  return tables;
}

beforeEach(() => jest.clearAllMocks());

describe('registration', () => {
  test('two-step write with a required customer id, uuid selectors and no model-facing confirmed flag', () => {
    const tool = LEADS_TOOLS.find(t => t.name === 'convert_lead');
    expect(tool.input_schema.required).toEqual(['customer_id']);
    expect(tool.input_schema.properties.customer_id.format).toBe('uuid');
    expect(tool.input_schema.properties.lead_id.format).toBe('uuid');
    expect(Object.keys(tool.input_schema.properties)).not.toContain('confirmed');
    expect(WRITE_TWO_STEP_TOOL_NAMES.has('convert_lead')).toBe(true);
    expect(LEGACY_BARE_WRITE_TOOL_NAMES.has('convert_lead')).toBe(false);
    const policy = require('../services/intelligence-bar/action-policy.json').convert_lead;
    expect(policy).toMatchObject({ module: 'leads-tools.js', kind: 'internal_write', role: 'admin', approval: 'ui_confirm', scope: 'record' });
  });

  test('never runs without its card, even for the owner (one-way: it feeds the ad conversion upload)', () => {
    expect(OwnerDirect.OWNER_DIRECT_TOOL_NAMES.has('convert_lead')).toBe(false);
    expect(OwnerDirect.executesWithoutCard('convert_lead', { lead_id: LEAD_ID, customer_id: CUSTOMER_ID })).toBe(false);
  });
});

describe('preview (unconfirmed)', () => {
  test('names the lead and the existing customer, shows both contacts, writes nothing', async () => {
    const tables = install();
    const res = await executeLeadsTool('convert_lead', { lead_id: LEAD_ID, customer_id: CUSTOMER_ID });
    expect(res).toMatchObject({
      preview: true,
      lead_id: LEAD_ID, lead_name: 'Testa Lead', lead_status: 'estimate_sent',
      lead_contact: { phone: '+19415550101', email: 'testa@example.test', address: '1 Example St, Sarasota, 34201' },
      customer_id: CUSTOMER_ID, customer_name: 'Testa Lead',
      customer_record: { phone: '+19415550101', email: 'testa@example.test', address: '1 Example St, Sarasota, FL 34201' },
      _lead_updated_at: LEAD_UPDATED.toISOString(),
    });
    expect(res._version).toBe(`${LEAD_UPDATED.toISOString()}|${CUSTOMER.updated_at.toISOString()}`);
    expect(res.note).toMatch(/customer record is not changed and no message is sent/);
    expect(leadAttribution.convertLeadToCustomer).not.toHaveBeenCalled();
    expect(tables.leads.update).not.toHaveBeenCalled();
    expect(tables.customers.update).not.toHaveBeenCalled();
    expect(tables.customers.whereNull).toHaveBeenCalledWith('deleted_at');
  });

  test.each([
    ['no customer id', { lead_id: LEAD_ID }, {}, /customer_id is required.*create_customer/],
    ['customer missing or deleted', { lead_id: LEAD_ID, customer_id: CUSTOMER_ID }, { customer: null }, /Customer not found/],
    ['lead missing', { lead_id: LEAD_ID, customer_id: CUSTOMER_ID }, { lead: null }, /Lead not found/],
    ['lead already converted (linked and stamped)', { lead_id: LEAD_ID, customer_id: CUSTOMER_ID }, { lead: { ...LEAD, status: 'won', customer_id: CUSTOMER_ID, converted_at: LEAD_UPDATED } }, /already converted/],
    ['lead won for a different customer', { lead_id: LEAD_ID, customer_id: CUSTOMER_ID }, { lead: { ...LEAD, status: 'won', customer_id: OTHER_CUSTOMER_ID, converted_at: LEAD_UPDATED } }, /different customer/],
    ['lead linked to a different customer', { lead_id: LEAD_ID, customer_id: CUSTOMER_ID }, { lead: { ...LEAD, customer_id: OTHER_CUSTOMER_ID } }, /different customer/],
  ])('refuses: %s (no card, no write)', async (_label, input, fixture, message) => {
    install(fixture);
    const res = await executeLeadsTool('convert_lead', input);
    expect(res.error).toMatch(message);
    expect(res.preview).toBeUndefined();
    expect(leadAttribution.convertLeadToCustomer).not.toHaveBeenCalled();
  });

  test('a lead marked won by hand with no customer link gets a card (codex #6099 r2)', async () => {
    install({ lead: { ...LEAD, status: 'won', converted_at: LEAD_UPDATED } });
    const res = await executeLeadsTool('convert_lead', { lead_id: LEAD_ID, customer_id: CUSTOMER_ID });
    expect(res).toMatchObject({ preview: true, lead_status: 'won' });
  });

  test('the card shows the customer\'s unit (address_line2)', async () => {
    install({ customer: { ...CUSTOMER, address_line2: 'Unit 4B' } });
    const res = await executeLeadsTool('convert_lead', { lead_id: LEAD_ID, customer_id: CUSTOMER_ID });
    expect(res.customer_record.address).toBe('1 Example St, Unit 4B, Sarasota, FL 34201');
    expect(res._customer_updated_at).toBe(CUSTOMER.updated_at.toISOString());
  });

  test('a lead already linked to THIS customer (not yet won) converts', async () => {
    install({ lead: { ...LEAD, customer_id: CUSTOMER_ID.toUpperCase() } });
    const res = await executeLeadsTool('convert_lead', { lead_id: LEAD_ID, customer_id: CUSTOMER_ID });
    expect(res.preview).toBe(true);
  });
});

describe('confirmed', () => {
  const pins = { _expected_status: 'estimate_sent', _expected_updated_at: LEAD_UPDATED.toISOString(), _expected_customer_updated_at: CUSTOMER.updated_at.toISOString() };

  test('runs the shared convert with the card\'s status and version as the seen lead', async () => {
    install();
    leadAttribution.convertLeadToCustomer.mockResolvedValue({ lead: { ...LEAD, status: 'won', customer_id: CUSTOMER_ID } });
    const res = await executeLeadsTool('convert_lead', { lead_id: LEAD_ID, customer_id: CUSTOMER_ID, confirmed: true, ...pins });
    expect(leadAttribution.convertLeadToCustomer).toHaveBeenCalledWith(LEAD_ID, {
      customerId: CUSTOMER_ID,
      seenStatus: 'estimate_sent',
      seenUpdatedAt: LEAD_UPDATED.toISOString(),
      expectedStatus: 'estimate_sent',
      expectedCustomerUpdatedAt: CUSTOMER.updated_at.toISOString(),
      // The lead's own (empty) amounts ride through, never undefined → "$0".
      monthlyValue: null,
      initialServiceValue: null,
    });
    expect(res).toEqual({
      success: true, lead_id: LEAD_ID, lead_name: 'Testa Lead', old_status: 'estimate_sent', new_status: 'won',
      customer_id: CUSTOMER_ID, customer_name: 'Testa Lead',
    });
  });

  test('the lead\'s stored amounts ride through to the history entry', async () => {
    install({ lead: { ...LEAD, monthly_value: '89.00', initial_service_value: '149.00' } });
    leadAttribution.convertLeadToCustomer.mockResolvedValue({ lead: {}, estimates: { linked: 2 } });
    const res = await executeLeadsTool('convert_lead', { lead_id: LEAD_ID, customer_id: CUSTOMER_ID, confirmed: true, ...pins });
    expect(leadAttribution.convertLeadToCustomer.mock.calls[0][1]).toMatchObject({ monthlyValue: '89.00', initialServiceValue: '149.00' });
    expect(res.estimates_attached).toBe(2);
    expect(res.warning).toBeUndefined();
  });

  test('a failed estimate attach is a warning, not a clean Done', async () => {
    install();
    leadAttribution.convertLeadToCustomer.mockResolvedValue({ lead: {}, estimates: { failed: true } });
    const res = await executeLeadsTool('convert_lead', { lead_id: LEAD_ID, customer_id: CUSTOMER_ID, confirmed: true, ...pins });
    expect(res.warning).toBe("Converted, but the lead's estimates were not attached — attach them from the estimate page.");
    expect(require('../services/intelligence-bar/outcomes').executionOutcome(res)).toBe('partially_completed');
  });

  test('without the customer version pin it is not an approved card', async () => {
    install();
    const { _expected_customer_updated_at: _drop, ...leadPins } = pins;
    const res = await executeLeadsTool('convert_lead', { lead_id: LEAD_ID, customer_id: CUSTOMER_ID, confirmed: true, ...leadPins });
    expect(res).toMatchObject({ preview_changed: true });
    expect(leadAttribution.convertLeadToCustomer).not.toHaveBeenCalled();
  });

  test('without the route\'s pins it is not an approved card: refused, nothing written', async () => {
    install();
    const res = await executeLeadsTool('convert_lead', { lead_id: LEAD_ID, customer_id: CUSTOMER_ID, confirmed: true });
    expect(res).toMatchObject({ preview_changed: true, error: expect.stringMatching(/no approved card/) });
    expect(leadAttribution.convertLeadToCustomer).not.toHaveBeenCalled();
  });

  test('a lead that moved after the card (the win matched no row) asks for a fresh card', async () => {
    install();
    leadAttribution.convertLeadToCustomer.mockResolvedValue({ status: 409, error: 'The lead changed since the card was shown — nothing was converted.' });
    const res = await executeLeadsTool('convert_lead', { lead_id: LEAD_ID, customer_id: CUSTOMER_ID, confirmed: true, ...pins });
    expect(res).toMatchObject({ preview_changed: true, error: 'The lead changed since the card was shown — nothing was converted.' });
    expect(res.success).toBeUndefined();
  });

  test('a lead that became won after the card is refused before the shared convert runs', async () => {
    install({ lead: { ...LEAD, status: 'won', customer_id: CUSTOMER_ID, converted_at: LEAD_UPDATED } });
    const res = await executeLeadsTool('convert_lead', { lead_id: LEAD_ID, customer_id: CUSTOMER_ID, confirmed: true, ...pins });
    expect(res.error).toMatch(/already converted/);
    expect(leadAttribution.convertLeadToCustomer).not.toHaveBeenCalled();
  });
});

// The shared body the Leads page route and the card both run.
describe('convertLeadToCustomer (POST /api/admin/leads/:id/convert body)', () => {
  const { convertLeadToCustomer } = jest.requireActual('../services/lead-attribution');

  function installConvert({ lead = LEAD, customer = CUSTOMER, claimed = 1 } = {}) {
    // The pre-read sees the lead as it was; every later read (the estimate
    // link's, the returned lead) sees it won.
    let reads = 0;
    const leads = chain({ first: () => (reads++ === 0 || !lead ? lead : { ...lead, status: 'won', customer_id: CUSTOMER_ID }), update: claimed });
    const customers = chain({ first: customer });
    const activities = chain({ insert: undefined });
    db.mockImplementation((table) => ({ leads, customers, lead_activities: activities }[table] || chain()));
    return { leads, customers, activities };
  }

  test('route refusals are unchanged: 400 without a customer, 404 for a missing lead or customer', async () => {
    installConvert();
    expect(await convertLeadToCustomer(LEAD_ID, { customerId: '  ' })).toEqual({ status: 400, error: 'customer_id is required to convert a lead' });
    installConvert({ lead: null });
    expect(await convertLeadToCustomer(LEAD_ID, { customerId: CUSTOMER_ID })).toEqual({ status: 404, error: 'Lead not found' });
    installConvert({ customer: null });
    expect(await convertLeadToCustomer(LEAD_ID, { customerId: CUSTOMER_ID })).toEqual({ status: 404, error: 'Customer not found' });
  });

  test('a lead the customer\'s booking closed after the page loaded is refused (409) before any write', async () => {
    const { leads } = installConvert({ lead: { ...LEAD, status: 'handled' } });
    const res = await convertLeadToCustomer(LEAD_ID, { customerId: CUSTOMER_ID, seenStatus: 'estimate_sent' });
    expect(res.status).toBe(409);
    expect(leads.update).not.toHaveBeenCalled();
  });

  test('marks the lead won for the customer, links its estimates, logs the conversion and returns the lead', async () => {
    const { leads, activities } = installConvert();
    const res = await convertLeadToCustomer(LEAD_ID, { customerId: ` ${CUSTOMER_ID} `, seenStatus: 'estimate_sent' });
    expect(res.lead).toMatchObject({ status: 'won', customer_id: CUSTOMER_ID });
    const written = leads.update.mock.calls[0][0];
    expect(written).toMatchObject({ status: 'won', is_qualified: true, customer_id: CUSTOMER_ID });
    expect(written.converted_at).toEqual(expect.any(Date));
    expect(require('../services/lead-funnel-bridge').bridgeLeadFunnelStage).toHaveBeenCalledWith(LEAD_ID, 'won');
    expect(require('../services/lead-estimate-link').linkLeadEstimatesToCustomer).toHaveBeenCalledWith(expect.objectContaining({ customerId: CUSTOMER_ID }));
    expect(activities.insert).toHaveBeenCalledWith(expect.objectContaining({ lead_id: LEAD_ID, activity_type: 'converted' }));
    // Route path: the history line is unchanged (amounts the route did not get read $0, as before).
    expect(activities.insert.mock.calls[0][0].description).toBe(`Converted to customer (${CUSTOMER_ID}). Monthly: $0, Initial: $0`);
    // The estimate attach outcome is returned (the tool reports a failure).
    expect(res.estimates).toEqual({ linked: 1 });
    // The route passes no expected status: no status filter on the claim.
    expect(leads.whereIn).not.toHaveBeenCalledWith('status', expect.anything());
  });

  test('explicit empty amounts (the card path) leave them out of the history line; stored ones are shown', async () => {
    const { activities } = installConvert();
    await convertLeadToCustomer(LEAD_ID, { customerId: CUSTOMER_ID, seenStatus: 'estimate_sent', monthlyValue: null, initialServiceValue: null });
    expect(activities.insert.mock.calls[0][0].description).toBe(`Converted to customer (${CUSTOMER_ID}).`);
    const second = installConvert();
    await convertLeadToCustomer(LEAD_ID, { customerId: CUSTOMER_ID, seenStatus: 'estimate_sent', monthlyValue: '89.00', initialServiceValue: '149.00' });
    expect(second.activities.insert.mock.calls[0][0].description).toBe(`Converted to customer (${CUSTOMER_ID}). Monthly: $89.00, Initial: $149.00`);
  });

  test('a failed estimate attach is reported, the conversion still stands', async () => {
    installConvert();
    require('../services/lead-estimate-link').linkLeadEstimatesToCustomer.mockRejectedValueOnce(new Error('db down'));
    const res = await convertLeadToCustomer(LEAD_ID, { customerId: CUSTOMER_ID, seenStatus: 'estimate_sent' });
    expect(res.lead).toMatchObject({ status: 'won' });
    expect(res.estimates).toEqual({ failed: true });
    expect(require('../services/lead-estimate-link').linkLeadEstimatesToCustomer).toHaveBeenCalledWith(expect.objectContaining({ throwOnError: true }));
  });

  test('the card\'s expected status rides into the win\'s UPDATE; a claim that matches nothing is 409', async () => {
    const { leads } = installConvert({ claimed: 0 });
    const res = await convertLeadToCustomer(LEAD_ID, { customerId: CUSTOMER_ID, seenStatus: 'estimate_sent', seenUpdatedAt: LEAD_UPDATED.toISOString(), expectedStatus: 'estimate_sent', expectedCustomerUpdatedAt: CUSTOMER.updated_at.toISOString() });
    expect(leads.whereIn).toHaveBeenCalledWith('status', ['estimate_sent']);
    expect(res.status).toBe(409);
    expect(require('../services/lead-funnel-bridge').bridgeLeadFunnelStage).not.toHaveBeenCalled();
  });
});

// Codex #6099 r1: the card path's UPDATE binds the lead's version and its
// customer link, not just its status. The claim's predicates are evaluated
// against the row as it is at the UPDATE, after the pre-read saw the card's lead.
describe('card path: a lead changed between the card and the UPDATE', () => {
  const { convertLeadToCustomer } = jest.requireActual('../services/lead-attribution');
  const msIso = (v) => new Date(v).toISOString();

  // A tiny knex where-evaluator: AND by default, orWhere* joins with OR.
  // Column names may be table-qualified ('customers.id').
  const col = (row, c) => row[String(c).split('.').pop()];
  function group(row) {
    const terms = [];
    const add = (op, fn) => { terms.push({ op, fn }); return g; };
    const g = {
      where: (a, b) => add('and', typeof a === 'function' ? (() => { const sub = group(row); a.call(sub, sub); return sub.test(); }) : () => (b === undefined ? true : col(row, a) === b)),
      orWhere: (a, b) => add('or', () => col(row, a) === b),
      whereNull: (c) => add('and', () => col(row, c) == null),
      whereNot: (c, v) => add('and', () => col(row, c) !== v),
      whereIn: (c, arr) => add('and', () => arr.includes(col(row, c))),
      whereRaw: (_sql, [iso]) => add('and', () => msIso(row.updated_at) === iso),
      orWhereRaw: (_sql, [iso]) => add('or', () => msIso(row.updated_at) === iso),
      whereExists: (sub) => add('and', () => sub.test()),
      whereNotExists: () => g,
      select: () => g,
      test: () => terms.reduce((acc, t, i) => (i === 0 ? t.fn() : t.op === 'or' ? acc || t.fn() : acc && t.fn()), true),
    };
    return g;
  }

  // `current` / `currentCustomer`: the rows as they are at the UPDATE. The
  // pre-reads saw the card's LEAD and CUSTOMER.
  function installRace(current, currentCustomer = CUSTOMER) {
    let reads = 0;
    let customerReads = 0;
    const leads = {};
    let claim = null;
    for (const m of ['where', 'whereNull', 'whereIn', 'whereNot', 'whereRaw', 'orWhereRaw', 'whereNotExists', 'whereExists', 'orWhere']) {
      leads[m] = jest.fn((...args) => { (claim ||= group(current))[m](...args); return leads; });
    }
    leads.first = jest.fn(async () => { claim = null; return reads++ === 0 ? LEAD : { ...current, status: 'won' }; });
    leads.update = jest.fn(async () => { const hit = claim.test(); claim = null; return hit ? 1 : 0; });
    const customers = () => {
      const q = group(currentCustomer || {});
      q.first = async () => (customerReads++ === 0 ? CUSTOMER : currentCustomer);
      return q;
    };
    db.mockImplementation((table) => (table === 'customers' ? customers() : { leads, lead_activities: chain({ insert: undefined }) }[table] || chain()));
    return leads;
  }
  const card = { customerId: CUSTOMER_ID, seenStatus: 'estimate_sent', seenUpdatedAt: LEAD_UPDATED.toISOString(), expectedStatus: 'estimate_sent', expectedCustomerUpdatedAt: CUSTOMER.updated_at.toISOString() };
  const refused = { status: 409, error: 'The lead changed since the card was shown — nothing was converted.' };
  const customerRefused = { status: 409, error: 'The customer changed since the card was shown — nothing was converted.' };

  test('customer edited after the card: refused, nothing converted (codex #6099 r2)', async () => {
    const leads = installRace({ ...LEAD }, { ...CUSTOMER, updated_at: new Date(CUSTOMER.updated_at.getTime() + 1) });
    expect(await convertLeadToCustomer(LEAD_ID, card)).toEqual(customerRefused);
    expect(leads.update).toHaveBeenCalledTimes(1);
    expect(require('../services/lead-funnel-bridge').bridgeLeadFunnelStage).not.toHaveBeenCalled();
  });

  test('customer deleted after the card: refused', async () => {
    installRace({ ...LEAD }, { ...CUSTOMER, deleted_at: new Date() });
    expect(await convertLeadToCustomer(LEAD_ID, card)).toEqual(customerRefused);
  });

  test('card path without the customer version fails closed', async () => {
    installRace({ ...LEAD });
    expect(await convertLeadToCustomer(LEAD_ID, { ...card, expectedCustomerUpdatedAt: undefined })).toEqual(customerRefused);
  });

  test('a lead marked won by hand (no customer link) converts on the card path', async () => {
    const wonByHand = { ...LEAD, status: 'won', converted_at: LEAD_UPDATED };
    installRace(wonByHand);
    // The pre-read returns LEAD; the handled refusal only cares about 'handled'.
    expect((await convertLeadToCustomer(LEAD_ID, { ...card, seenStatus: 'won', expectedStatus: 'won' })).lead).toMatchObject({ status: 'won' });
  });

  test('unchanged since the card: converts', async () => {
    const leads = installRace({ ...LEAD });
    const res = await convertLeadToCustomer(LEAD_ID, card);
    expect(res.lead).toMatchObject({ status: 'won' });
    expect(leads.update).toHaveBeenCalledTimes(1);
  });

  test('already linked to this same customer: converts', async () => {
    installRace({ ...LEAD, customer_id: CUSTOMER_ID });
    expect((await convertLeadToCustomer(LEAD_ID, card)).lead).toMatchObject({ status: 'won' });
  });

  test('edited by another admin after the card (same status, newer version): refused, nothing converted', async () => {
    installRace({ ...LEAD, phone: '+19415550199', updated_at: new Date(LEAD_UPDATED.getTime() + 1) });
    expect(await convertLeadToCustomer(LEAD_ID, card)).toEqual(refused);
    expect(require('../services/lead-funnel-bridge').bridgeLeadFunnelStage).not.toHaveBeenCalled();
  });

  test('re-linked to another customer after the card (version unchanged): refused', async () => {
    installRace({ ...LEAD, customer_id: OTHER_CUSTOMER_ID });
    expect(await convertLeadToCustomer(LEAD_ID, card)).toEqual(refused);
  });

  test('the card path without its version fails closed; the plain route path keeps its rule', async () => {
    installRace({ ...LEAD, updated_at: new Date(LEAD_UPDATED.getTime() + 1) });
    expect(await convertLeadToCustomer(LEAD_ID, { ...card, seenUpdatedAt: undefined })).toEqual(refused);
    // Route: no expected status, so a newer version of a non-handled lead still converts, as before.
    installRace({ ...LEAD, updated_at: new Date(LEAD_UPDATED.getTime() + 1) });
    expect((await convertLeadToCustomer(LEAD_ID, { customerId: CUSTOMER_ID, seenStatus: 'estimate_sent' })).lead).toMatchObject({ status: 'won' });
  });
});

describe('authorization contract', () => {
  const preview = {
    preview: true, lead_id: LEAD_ID, lead_name: 'Testa Lead', lead_status: 'estimate_sent',
    lead_contact: { phone: '+19415550101', email: null, address: '1 Example St' },
    customer_id: CUSTOMER_ID, customer_name: 'Testa Lead',
    customer_record: { phone: '+19415550101', email: null, address: '1 Example St, Sarasota, FL 34201' },
    _version: 'v1',
  };
  const contract = () => buildContract({
    toolName: 'convert_lead',
    params: { lead_id: LEAD_ID, customer_id: CUSTOMER_ID },
    displayParams: { lead: 'Testa Lead (estimate_sent) — +19415550101 · 1 Example St', customer: 'Testa Lead — +19415550101 · 1 Example St, Sarasota, FL 34201' },
    preview,
  });

  test('discloses every effect of the conversion; one-way; no customer message', () => {
    const c = contract();
    expect(c).toMatchObject({ tier: 'yellow', action_label: 'Convert a lead to a customer', irreversible: true, notifies_customer: false });
    const labels = c.effects.map(e => e.label);
    expect(c.effects).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'customer', label: 'Lead Testa Lead: status estimate_sent → won, linked to customer Testa Lead', before: 'estimate_sent', after: 'won' }),
    ]));
    for (const re of [/customer record for Testa Lead is not changed/, /converted now and marked qualified/, /funnel stage advances toward 'booked'/,
      /Tries to attach this lead's estimates.*if that step fails, the result says so/, /converted entry is appended/, /Google Ads and Meta as a qualified-lead conversion/,
      /No message is sent to the customer/, /^lead: Testa Lead \(estimate_sent\)/, /^customer: Testa Lead — /]) {
      expect(labels).toEqual(expect.arrayContaining([expect.stringMatching(re)]));
    }
    // Curated: the raw preview keys are not dumped as extra lines.
    expect(labels.some(l => /^lead id:|^customer id:/.test(l))).toBe(false);
  });

  test('the preview fingerprint binds the lead and customer versions', () => {
    const a = contract().preview_fingerprint;
    const b = buildContract({ toolName: 'convert_lead', params: {}, displayParams: {}, preview: { ...preview, _version: 'v2' } }).preview_fingerprint;
    expect(a).toEqual(expect.any(String));
    expect(a).not.toBe(b);
  });
});
