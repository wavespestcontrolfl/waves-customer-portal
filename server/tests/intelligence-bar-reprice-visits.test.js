/**
 * reprice_future_visits (owner ruling 2026-10-07, Q8): one customer's
 * upcoming visits for one service get a new per-visit price on ONE card that
 * lists each visit old -> new; never a completed, in-progress, invoiced, paid
 * or prepaid visit; a monthly-membership customer is refused. The confirmed run
 * saves each visit through the Schedule screen's own visit edit
 * (updateVisitDetails, mocked here — its handler has its own suites).
 * Synthetic names only.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../routes/admin-schedule', () => ({
  findBillingCoveredVisits: jest.fn(),
  updateVisitDetails: jest.fn(),
}));
jest.mock('../utils/datetime-et', () => ({
  ...jest.requireActual('../utils/datetime-et'),
  etDateString: jest.fn(() => '2099-03-01'),
}));

const db = require('../models/db');
const Schedule = require('../routes/admin-schedule');
const { executeRepriceVisitsTool, cardLines, MAX_VISITS } = require('../services/intelligence-bar/reprice-visits-tools');
const { buildContract, previewFingerprint } = require('../services/intelligence-bar/authorization-contract');
const { WRITE_TWO_STEP_TOOL_NAMES } = require('../services/intelligence-bar/write-gates');

const CUSTOMER_ID = '00000000-0000-0000-0000-0000000000c1';
let tables;

// A small in-memory knex: equality where / whereIn / >= <= on dates, first, select.
function builder(table) {
  const filters = [];
  let single = false;
  const api = {
    where(a, op, b) {
      if (a && typeof a === 'object') filters.push((r) => Object.entries(a).every(([k, v]) => String(r[k]) === String(v)));
      else if (op === '>=') filters.push((r) => String(r[a]) >= String(b));
      else if (op === '<=') filters.push((r) => String(r[a]) <= String(b));
      else filters.push((r) => String(r[a]) === String(op));
      return api;
    },
    whereIn(col, values) { filters.push((r) => values.map(String).includes(String(r[col]))); return api; },
    whereNull(col) { filters.push((r) => r[col] == null); return api; },
    select() { return api; },
    orderBy() { return api; },
    first() { single = true; return api; },
    then(resolve, reject) {
      const rows = (tables[table] || []).filter((r) => filters.every((f) => f(r))).map((r) => ({ ...r }));
      return Promise.resolve(single ? rows[0] : rows).then(resolve, reject);
    },
  };
  return api;
}

function visit(id, date, extra = {}) {
  return {
    id, customer_id: CUSTOMER_ID, scheduled_date: date, status: 'confirmed', service_type: 'Quarterly Pest Control',
    estimated_price: '55.00', primary_line_price: '55.00', row_version: `${id}:v1`, ...extra,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GATE_IB_REPRICE_VISITS = 'true';
  db.mockImplementation(builder);
  db.raw = jest.fn(() => 'raw');
  tables = {
    customers: [{ id: CUSTOMER_ID, first_name: 'Robin', last_name: 'Sample', billing_mode: 'per_visit', waveguard_tier: 'Gold', monthly_rate: null, deleted_at: null }],
    scheduled_services: [
      visit('v-1', '2099-03-10'),
      visit('v-2', '2099-06-10', { discount_type: 'percentage' }),
      visit('v-done', '2099-03-02', { status: 'completed' }),
      visit('v-road', '2099-03-01', { status: 'en_route' }),
      visit('v-track', '2099-03-03', { track_state: 'on_property' }),
      visit('v-inv', '2099-04-10'),
      visit('v-pre', '2099-05-10', { prepaid_amount: '55.00', prepaid_at: '2099-02-01' }),
      visit('v-term', '2099-07-10', { annual_prepay_term_id: 'term-1' }),
      visit('v-gone', '2099-08-10', { status: 'cancelled' }),
      visit('v-lawn', '2099-03-12', { service_type: 'Lawn Care' }),
      visit('v-same', '2099-09-10', { estimated_price: '49.00' }),
    ],
    invoices: [{ scheduled_service_id: 'v-inv', invoice_number: 'WPC-2099-0001', status: 'sent' }],
    scheduled_service_addons: [],
  };
  Schedule.findBillingCoveredVisits.mockResolvedValue(new Map());
  Schedule.updateVisitDetails.mockResolvedValue({ status: 200, json: { success: true } });
});

afterAll(() => { delete process.env.GATE_IB_REPRICE_VISITS; });

const ask = (extra = {}) => ({ customer_id: CUSTOMER_ID, service: 'pest', new_price: 49, ...extra });
const preview = (extra) => executeRepriceVisitsTool('reprice_future_visits', ask(extra), { isAdmin: true });
const confirm = (input, version) => executeRepriceVisitsTool('reprice_future_visits',
  { ...input, confirmed: true, _verified_reprice_version: version }, { isAdmin: true, technicianId: 'staff-1' });

describe('the card', () => {
  test('lists only the eligible visits, old -> new, and names every visit it leaves alone', async () => {
    const card = await preview();
    expect(card.preview).toBe(true);
    expect(card.visits.map((v) => [v.date, v.old_price, v.new_price])).toEqual([
      ['2099-03-10', '$55.00', '$49.00'],
      ['2099-06-10', '$55.00', '$49.00'],
    ]);
    expect(card.visits[1].discount_note).toMatch(/discount stamp is replaced/);
    const reasons = Object.fromEntries(card.left_alone.map((v) => [v.id, v.reason]));
    expect(reasons).toEqual({
      'v-done': 'completed',
      'v-road': expect.stringMatching(/in progress/),
      'v-track': 'the visit tracker shows on property',
      'v-inv': expect.stringMatching(/^invoiced \(WPC-2099-0001/),
      'v-pre': 'prepaid',
      'v-term': 'covered by an annual prepay term',
    });
    expect(card.already_at_price.map((v) => v.id)).toEqual(['v-same']);
    // Cancelled visits and other services are not on the card at all.
    const listed = [...card.visits, ...card.left_alone, ...card.already_at_price].map((v) => v.id);
    expect(listed).not.toContain('v-gone');
    expect(listed).not.toContain('v-lawn');
    expect(card.customer_message).toBe('No customer message is sent.');
    expect(Schedule.updateVisitDetails).not.toHaveBeenCalled();
  });

  test("a series' first (template) visit is left alone: its price would carry into visits the plan adds later", async () => {
    tables.scheduled_services.push(visit('v-tpl', '2099-03-05', { is_recurring: true, recurring_parent_id: null }));
    tables.scheduled_services[0].is_recurring = true;
    tables.scheduled_services[0].recurring_parent_id = 'v-tpl';
    const card = await preview();
    expect(card.visits.map((v) => v.id)).toEqual(['v-1', 'v-2']);
    expect(card.left_alone).toContainEqual(expect.objectContaining({ id: 'v-tpl', reason: expect.stringMatching(/plan's first visit/) }));
  });

  test("a visit the Schedule re-price block reports as holding money is left alone with that reason", async () => {
    Schedule.findBillingCoveredVisits.mockResolvedValue(new Map([['v-2', 'holding a card for a late-cancel fee']]));
    const card = await preview();
    expect(card.visits.map((v) => v.id)).toEqual(['v-1']);
    expect(card.left_alone).toContainEqual(expect.objectContaining({ id: 'v-2', reason: 'holding a card for a late-cancel fee' }));
    // Judged with the new price, as the save judges it.
    expect(Schedule.findBillingCoveredVisits.mock.calls[0][1].every((r) => r._proposedPrice === 49)).toBe(true);
    expect(Schedule.findBillingCoveredVisits.mock.calls[0][2]).toEqual({ liveInvoice: true });
  });

  test('the contract card carries one line per visit and says no customer message is sent', async () => {
    const card = await preview();
    const contract = buildContract({ toolName: 'reprice_future_visits', params: ask(), displayParams: {}, preview: card });
    const labels = contract.effects.map((e) => e.label);
    expect(labels).toContain('Visit 2099-03-10 (Tue) · Quarterly Pest Control: $55.00 → $49.00');
    expect(labels).toContainEqual(expect.stringMatching(/^Left alone: 2099-03-02 \(Mon\) · Quarterly Pest Control — completed$/));
    expect(labels).toContain('No customer message is sent.');
    expect(contract.notifies_customer).toBe(false);
    expect(contract.action_label).toBe('Change the price of upcoming visits');
    expect(contract.effects.filter((e) => e.label.startsWith('Visit ')).every((e) => e.kind === 'billing')).toBe(true);
    expect(cardLines(card).length).toBe(labels.length);
  });

  test('a monthly-membership customer is refused whole: their price is the monthly rate', async () => {
    tables.customers[0] = { ...tables.customers[0], billing_mode: 'monthly_membership', monthly_rate: '89.00' };
    const res = await preview();
    expect(res).toMatchObject({ code: 'membership_lane' });
    expect(res.error).toMatch(/monthly membership \(\$89\.00 a month\).*update_customer or rate_service/);
    expect(res.preview).toBeUndefined();
  });

  test('more than the cap is refused, never truncated', async () => {
    tables.scheduled_services = Array.from({ length: MAX_VISITS + 1 }, (_, i) => visit(`c-${i}`, `2099-04-${String(i + 1).padStart(2, '0')}`));
    const res = await preview();
    expect(res).toMatchObject({ code: 'too_many_visits' });
    expect(res.error).toMatch(/at most 24/);
  });

  test('a zero or fractional-cent price is refused; words matching two services or none are refused', async () => {
    expect((await preview({ new_price: 0 })).error).toMatch(/above \$0/);
    expect((await preview({ new_price: 49.005 })).error).toMatch(/whole cents/);
    tables.scheduled_services.push(visit('v-rod', '2099-03-20', { service_type: 'Rodent Control' }));
    expect((await preview({ service: 'Control' })).error).toMatch(/matches more than one service.*Name one/);
    expect((await preview({ service: 'termite' })).error).toMatch(/no upcoming "termite" visits/);
    expect(Schedule.updateVisitDetails).not.toHaveBeenCalled();
  });

  test('words naming an unrecognized service take only the visits with that name, not every other unrecognized one', async () => {
    tables.scheduled_services.push(
      visit('v-rod', '2099-03-20', { service_type: 'Rodent Control' }),
      visit('v-odd', '2099-03-22', { service_type: 'Gutter Cleaning' }),
    );
    const card = await preview({ service: 'rodent' });
    expect(card.service_label).toBe('Rodent Control');
    expect(card.visits.map((v) => v.id)).toEqual(['v-rod']);
  });

  test('gate off: refuses the preview and the commit, changing nothing', async () => {
    delete process.env.GATE_IB_REPRICE_VISITS;
    expect(await preview()).toMatchObject({ code: 'gate_off' });
    expect(await confirm(ask(), 'anything')).toMatchObject({ code: 'gate_off' });
    expect(Schedule.updateVisitDetails).not.toHaveBeenCalled();
  });
});

describe('the confirmed run', () => {
  test('saves each listed visit through the Schedule visit edit with the body its price edit sends', async () => {
    const card = await preview();
    const res = await confirm(ask(), card._version);
    expect(res).toMatchObject({ success: true, messages_sent: false });
    expect(res.changed.map((v) => v.id)).toEqual(['v-1', 'v-2']);
    expect(Schedule.updateVisitDetails.mock.calls.map((c) => c[0])).toEqual([
      { id: 'v-1', body: { estimatedPrice: 49, expectedTotal: 49 }, actor: { technicianId: 'staff-1' }, approvedVisitVersion: 'v-1:v1' },
      { id: 'v-2', body: { estimatedPrice: 49, expectedTotal: 49 }, actor: { technicianId: 'staff-1' }, approvedVisitVersion: 'v-2:v1' },
    ]);
  });

  test('a price that moved after the card refuses with preview_changed before any save', async () => {
    const card = await preview();
    tables.scheduled_services[0].estimated_price = '60.00';
    const res = await confirm(ask(), card._version);
    expect(res.preview_changed).toBe(true);
    expect(Schedule.updateVisitDetails).not.toHaveBeenCalled();
  });

  test('between saves the version the save must still find is the one just checked', async () => {
    const card = await preview();
    // visit 1's own save moves visit 2's row version (a post-commit effect) but not what the card showed
    Schedule.updateVisitDetails.mockImplementationOnce(async () => {
      tables.scheduled_services[1].row_version = 'v-2:v2';
      return { status: 200, json: { success: true } };
    });
    const res = await confirm(ask(), card._version);
    expect(res.success).toBe(true);
    expect(Schedule.updateVisitDetails.mock.calls[1][0].approvedVisitVersion).toBe('v-2:v2');
  });

  test.each([
    ['moved to another customer', { customer_id: '00000000-0000-0000-0000-0000000000c2' }],
    ['changed service', { service_type: 'Lawn Care' }],
    ['prepaid', { prepaid_amount: '49.00' }],
    ['started on the tracker', { track_state: 'en_route' }],
  ])('a later visit %s during the earlier saves is not saved, even with its date, status and price unchanged', async (_label, change) => {
    const card = await preview();
    Schedule.updateVisitDetails.mockImplementationOnce(async () => {
      Object.assign(tables.scheduled_services[1], change, { row_version: 'v-2:v2' });
      return { status: 200, json: { success: true } };
    });
    const res = await confirm(ask(), card._version);
    expect(res.partial).toBe(true);
    expect(res.failed_visit).toMatchObject({ id: 'v-2', code: 'preview_changed' });
    expect(Schedule.updateVisitDetails).toHaveBeenCalledTimes(1);
  });

  test('a later visit invoiced during the earlier saves is not saved', async () => {
    const card = await preview();
    Schedule.updateVisitDetails.mockImplementationOnce(async () => {
      tables.invoices.push({ scheduled_service_id: 'v-2', invoice_number: 'WPC-2099-0003', status: 'draft' });
      return { status: 200, json: { success: true } };
    });
    const res = await confirm(ask(), card._version);
    expect(res.failed_visit).toMatchObject({ id: 'v-2', code: 'preview_changed' });
    expect(Schedule.updateVisitDetails).toHaveBeenCalledTimes(1);
  });

  test('a row version that moved (any write to a listed visit) refuses with preview_changed', async () => {
    const card = await preview();
    tables.scheduled_services[1].row_version = 'v-2:v2';
    expect((await confirm(ask(), card._version)).preview_changed).toBe(true);
    expect(Schedule.updateVisitDetails).not.toHaveBeenCalled();
  });

  test('a visit invoiced after the card changes the card: refused, nothing saved', async () => {
    const card = await preview();
    tables.invoices.push({ scheduled_service_id: 'v-2', invoice_number: 'WPC-2099-0002', status: 'draft' });
    expect((await confirm(ask(), card._version)).preview_changed).toBe(true);
    expect(Schedule.updateVisitDetails).not.toHaveBeenCalled();
  });

  test('no card version: refused', async () => {
    expect((await confirm(ask(), undefined)).error).toMatch(/confirmation card/);
  });

  test("the edit's refusal mid-batch stops there and the receipt is partial, naming what changed", async () => {
    Schedule.updateVisitDetails
      .mockResolvedValueOnce({ status: 200, json: { success: true } })
      .mockResolvedValueOnce({ status: 409, json: { error: "Can't change this visit's price: it's already prepaid.", code: 'REPRICE_BLOCKED_COMMITTED_MONEY' } });
    const card = await preview();
    const res = await confirm(ask(), card._version);
    expect(res.partial).toBe(true);
    expect(res.changed.map((v) => v.id)).toEqual(['v-1']);
    expect(res.failed_visit).toMatchObject({ id: 'v-2', code: 'REPRICE_BLOCKED_COMMITTED_MONEY' });
    expect(res.note).toMatch(/Changed 1 visit\. Stopped at 2099-06-10/);
  });

  test('a thrown save is reported as unknown for that visit, never retried', async () => {
    Schedule.updateVisitDetails.mockRejectedValueOnce(new Error('connection reset'));
    const card = await preview();
    const res = await confirm(ask(), card._version);
    expect(res).toMatchObject({ outcome_unknown: true, unknown_visit: { id: 'v-1' } });
    expect(Schedule.updateVisitDetails).toHaveBeenCalledTimes(1);
  });

  test('a technician token is refused', async () => {
    const res = await executeRepriceVisitsTool('reprice_future_visits', ask(), { isAdmin: false });
    expect(res.code).toBe('permission_denied');
  });
});

describe('registration', () => {
  test('is a two-step write with a version pin the route binds', () => {
    expect(WRITE_TWO_STEP_TOOL_NAMES.has('reprice_future_visits')).toBe(true);
    const policy = require('../services/intelligence-bar/action-policy.json').reprice_future_visits;
    expect(policy).toMatchObject({ module: 'reprice-visits-tools.js', role: 'admin', approval: 'ui_confirm', scope: 'record' });
    // Money on many visits: always a card, never an owner-direct commit.
    expect(require('../services/intelligence-bar/owner-direct').OWNER_DIRECT_TOOL_NAMES.has('reprice_future_visits')).toBe(false);
  });

  test('the preview fingerprint binds the hidden version', async () => {
    const card = await preview();
    expect(previewFingerprint(card)).not.toBe(previewFingerprint({ ...card, _version: 'other' }));
  });
});
