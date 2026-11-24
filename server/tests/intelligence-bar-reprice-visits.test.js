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
// The refresh's own term selection; `mockRefreshableTerm` stands in for a term
// it would process (e.g. an 'active' term whose prepay invoice was voided).
let mockRefreshableTerm;
jest.mock('../services/annual-prepay-renewals', () => ({
  refreshableTermsForCustomer: jest.fn(async () => (mockRefreshableTerm ? [mockRefreshableTerm] : [])),
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
  const order = [];
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
    orderBy(col) { order.push(col); return api; },
    first() { single = true; return api; },
    then(resolve, reject) {
      const rows = (tables[table] || []).filter((r) => filters.every((f) => f(r))).map((r) => ({ ...r }));
      const key = (r) => order.map((c) => String(r[c] ?? ''));
      rows.sort((a, b) => {
        const [ka, kb] = [key(a), key(b)];
        const i = ka.findIndex((v, n) => v !== kb[n]);
        return i < 0 ? 0 : (ka[i] < kb[i] ? -1 : 1);
      });
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
  mockRefreshableTerm = null;
  // The Schedule re-price block's own coverage reader decides an annual-term link.
  Schedule.findBillingCoveredVisits.mockResolvedValue(new Map([['v-term', 'covered by an annual prepay term']]));
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

  test('when exclusions took every matching visit and one is a missing capability, the refusal is a coded gap (Codex #6371 r12)', async () => {
    tables.scheduled_services = [
      visit('v-tpl', '2099-03-05', { is_recurring: true, recurring_parent_id: null }),
      visit('v-zero', '2099-04-05', { estimated_price: '0.00' }),
      visit('v-pre', '2099-05-10', { prepaid_amount: '55.00', prepaid_at: '2099-02-01' }),
    ];
    const result = await preview();
    expect(result.code).toBe('reprice_excluded_unsupported');
    expect(result.error).toMatch(/^The bar can't change any upcoming .* visit for Robin Sample to \$49\.00 from here yet: /);
    expect(result.error).toMatch(/plan's first visit/);
    expect(result.error).toMatch(/a \$0 visit/);
    expect(result.error).not.toMatch(/prepaid/);
    expect(result.left_alone.map((v) => v.id).sort()).toEqual(['v-pre', 'v-tpl', 'v-zero']);
    expect(Schedule.updateVisitDetails).not.toHaveBeenCalled();
  });

  test('a partial plan with a capability exclusion carries the gap note; one with only waits does not (Codex #6371 r13)', async () => {
    tables.scheduled_services = [
      visit('v-1', '2099-03-10'),
      visit('v-zero', '2099-04-05', { estimated_price: '0.00' }),
    ];
    const card = await preview();
    expect(card.preview).toBe(true);
    expect(card.visits.map((v) => v.id)).toEqual(['v-1']);
    expect(card.capability_gaps).toEqual([{ code: 'reprice_excluded_unsupported' }]);
    tables.scheduled_services = [visit('v-1', '2099-03-10'), visit('v-pre', '2099-05-10', { prepaid_amount: '55.00', prepaid_at: '2099-02-01' })];
    expect(await preview()).not.toHaveProperty('capability_gaps');
  });

  test('a visit already at the price does not hide a capability exclusion behind nothing_to_reprice (Codex #6371 r14)', async () => {
    tables.scheduled_services = [
      visit('v-tpl', '2099-03-05', { is_recurring: true, recurring_parent_id: null }),
      visit('v-same', '2099-09-10', { estimated_price: '49.00' }),
    ];
    const result = await preview();
    expect(result.code).toBe('reprice_excluded_unsupported');
    expect(result.left_alone.map((v) => v.id)).toEqual(['v-tpl']);
    expect(result.already_at_price.map((v) => v.id)).toEqual(['v-same']);
    // Only waits plus an already-priced visit stays the plain answer.
    tables.scheduled_services = [visit('v-pre', '2099-05-10', { prepaid_amount: '55.00', prepaid_at: '2099-02-01' }), visit('v-same', '2099-09-10', { estimated_price: '49.00' })];
    expect((await preview()).code).toBe('nothing_to_reprice');
  });

  test('exclusions that are only waits (prepaid, completed) keep the plain nothing_to_reprice', async () => {
    tables.scheduled_services = [
      visit('v-pre', '2099-05-10', { prepaid_amount: '55.00', prepaid_at: '2099-02-01' }),
      visit('v-done', '2099-03-02', { status: 'completed' }),
    ];
    const result = await preview();
    expect(result.code).toBe('nothing_to_reprice');
    expect(result.left_alone).toHaveLength(2);
  });

  test('nothing matching at all keeps nothing_to_reprice', async () => {
    tables.scheduled_services = [];
    const result = await preview();
    expect(result.error).toBeTruthy();
    expect(result.code).not.toBe('reprice_excluded_unsupported');
  });

  test("a visit the Schedule re-price block reports as holding money is left alone with that reason", async () => {
    Schedule.findBillingCoveredVisits.mockResolvedValue(new Map([['v-2', 'holding a card for a late-cancel fee'], ['v-term', 'covered by an annual prepay term']]));
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

  test('a customer with a term the save would refresh (active, prepay invoice voided) is refused whole', async () => {
    mockRefreshableTerm = { id: 'term-1', status: 'active', prepay_invoice_id: 'inv-void' };
    const res = await preview();
    expect(res).toMatchObject({ code: 'annual_prepay_customer' });
    expect(res.error).toMatch(/annual prepay term, and the bar can't change visit prices for those from here yet/);
  });

  test("a visit still linked to a voided term is eligible: the canonical coverage reader decides, not the bare link", async () => {
    Schedule.findBillingCoveredVisits.mockResolvedValue(new Map());
    const card = await preview();
    expect(card.visits.map((v) => v.id)).toContain('v-term');
  });

  test('two visits on the same date and window keep one order, whatever order the rows come back in', async () => {
    tables.scheduled_services = [
      visit('b-2', '2099-04-01', { window_start: '09:00' }),
      visit('b-1', '2099-04-01', { window_start: '09:00' }),
    ];
    const first = await preview();
    tables.scheduled_services.reverse();
    const second = await preview();
    expect(first.visits.map((v) => v.id)).toEqual(['b-1', 'b-2']);
    expect(second.visits.map((v) => v.id)).toEqual(['b-1', 'b-2']);
    expect(second._version).toBe(first._version);
  });

  test.each([
    ['discount_id only', { discount_id: 'disc-1' }],
    ['line_discount_id only', { line_discount_id: 'disc-2' }],
    ['discount_name only', { discount_name: 'Gold loyalty' }],
    ['discount_dollars only', { discount_dollars: '5.00' }],
    ['line_discount_amount only', { line_discount_amount: '10' }],
  ])('a stored discount in any shape the price edit clears gets the replaced note: %s', async (_label, shape) => {
    Object.assign(tables.scheduled_services[0], shape);
    const card = await preview();
    expect(card.visits.find((v) => v.id === 'v-1').discount_note).toMatch(/discount stamp is replaced/);
  });

  test('zero-dollar discount amounts alone are not a stamp', async () => {
    Object.assign(tables.scheduled_services[0], { discount_dollars: '0.00', line_discount_dollars: 0 });
    const card = await preview();
    expect(card.visits.find((v) => v.id === 'v-1').discount_note).toBeUndefined();
  });

  test.each(['2027-02-29', '2026-13-01'])('an impossible through_date (%s) is refused with the documented error', async (date) => {
    const res = await preview({ through_date: date });
    expect(res.error).toBe('through_date must be a real calendar date (YYYY-MM-DD).');
    expect(res.preview).toBeUndefined();
  });

  test('through_date declares format date', () => {
    const tool = require('../services/intelligence-bar/reprice-visits-tools').REPRICE_VISITS_TOOLS[0];
    expect(tool.input_schema.properties.through_date.format).toBe('date');
  });

  test('a visit with several invoices shows the same one whatever order the rows come back in', async () => {
    tables.invoices = [
      { id: 'inv-b', scheduled_service_id: 'v-inv', invoice_number: 'WPC-2099-0002', status: 'sent' },
      { id: 'inv-c', scheduled_service_id: 'v-inv', invoice_number: 'WPC-2099-0003', status: 'void' },
      { id: 'inv-a', scheduled_service_id: 'v-inv', invoice_number: 'WPC-2099-0001', status: 'draft' },
    ];
    const reason = async () => (await preview()).left_alone.find((v) => v.id === 'v-inv').reason;
    const first = await reason();
    tables.invoices.reverse();
    expect(await reason()).toBe(first);
    // A live row before a void one, then by invoice id.
    expect(first).toBe('invoiced (WPC-2099-0001, draft)');
    tables.invoices = [{ id: 'inv-0', scheduled_service_id: 'v-inv', invoice_number: 'WPC-2099-0000', status: 'void' }, ...tables.invoices];
    expect(await reason()).toBe('invoiced (WPC-2099-0001, draft)');
  });

  test('more than the cap is refused, never truncated', async () => {
    tables.scheduled_services = Array.from({ length: MAX_VISITS + 1 }, (_, i) => visit(`c-${i}`, `2099-04-${String(i + 1).padStart(2, '0')}`));
    const res = await preview();
    expect(res).toMatchObject({ code: 'reprice_page_limit' });
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
      { id: 'v-1', body: { estimatedPrice: 49, expectedTotal: 49 }, actor: { technicianId: 'staff-1' }, approvedVisitVersion: 'v-1:v1', approvedRepriceState: { addonCount: 0, billingLane: 'per_visit', refreshablePrepayTerm: false } },
      { id: 'v-2', body: { estimatedPrice: 49, expectedTotal: 49 }, actor: { technicianId: 'staff-1' }, approvedVisitVersion: 'v-2:v1', approvedRepriceState: { addonCount: 0, billingLane: 'per_visit', refreshablePrepayTerm: false } },
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

  test('a customer switched to monthly membership during the earlier saves stops the batch', async () => {
    const card = await preview();
    Schedule.updateVisitDetails.mockImplementationOnce(async () => {
      Object.assign(tables.customers[0], { billing_mode: 'monthly_membership', monthly_rate: '89.00' });
      return { status: 200, json: { success: true } };
    });
    const res = await confirm(ask(), card._version);
    expect(res.failed_visit).toMatchObject({ id: 'v-2', code: 'preview_changed' });
    expect(Schedule.updateVisitDetails).toHaveBeenCalledTimes(1);
  });

  test('a live annual prepay term that appears during the earlier saves stops the batch', async () => {
    const card = await preview();
    Schedule.updateVisitDetails.mockImplementationOnce(async () => {
      mockRefreshableTerm = { id: 'term-1', status: 'active', prepay_invoice_id: 'inv-void' };
      return { status: 200, json: { success: true } };
    });
    const res = await confirm(ask(), card._version);
    expect(res.failed_visit).toMatchObject({ id: 'v-2', code: 'preview_changed' });
    expect(Schedule.updateVisitDetails).toHaveBeenCalledTimes(1);
  });

  test("the save's own under-lock drift refusal reads as preview_changed", async () => {
    Schedule.updateVisitDetails.mockRejectedValueOnce(Object.assign(new Error('This appointment changed while saving — reload and save again.'), {
      statusCode: 409, code: 'VISIT_CHANGED_RETRY', reason: 'REPRICE_APPROVAL_DRIFT',
    }));
    const card = await preview();
    const res = await confirm(ask(), card._version);
    expect(res).toMatchObject({ preview_changed: true, code: 'preview_changed', failed_visit: { id: 'v-1' } });
  });

  test('an ID-only discount stamp added to a later visit during the earlier saves stops the batch', async () => {
    const card = await preview();
    Schedule.updateVisitDetails.mockImplementationOnce(async () => {
      Object.assign(tables.scheduled_services.find((r) => r.id === 'v-2'), { discount_id: 'disc-late', row_version: 'v-2:v2' });
      return { status: 200, json: { success: true } };
    });
    const res = await confirm(ask(), card._version);
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

// Gaps #25 + #26 (2026-11-22): an account with two units of a duplex needed
// each unit's visits at its own price, and one visit changed on its own.
describe('one property, one visit', () => {
  const UNIT_A = '00000000-0000-0000-0000-0000000000a1';
  const UNIT_B = '00000000-0000-0000-0000-0000000000b1';

  beforeEach(() => {
    tables.customer_properties = [
      { id: UNIT_A, customer_id: CUSTOMER_ID, label: 'Unit A', address_line1: '101 Example Ave', city: 'Sampletown', zip: '34200' },
      { id: UNIT_B, customer_id: CUSTOMER_ID, label: 'Unit B', address_line1: '103 Example Ave', city: 'Sampletown', zip: '34200' },
    ];
    tables.scheduled_services = [
      visit('a-1', '2099-03-10', { property_id: UNIT_A, estimated_price: '95.04' }),
      visit('a-2', '2099-05-10', { property_id: UNIT_A, estimated_price: '95.04' }),
      visit('b-1', '2099-03-10', { property_id: UNIT_B, estimated_price: '76.56' }),
      visit('b-2', '2099-05-10', { property_id: UNIT_B, estimated_price: '76.56' }),
    ];
  });

  test("property_id changes only that property's visits and names the property on the card", async () => {
    const card = await preview({ property_id: UNIT_B, new_price: 68.9 });
    expect(card.preview).toBe(true);
    expect(card.visits.map((v) => [v.id, v.old_price, v.new_price])).toEqual([['b-1', '$76.56', '$68.90'], ['b-2', '$76.56', '$68.90']]);
    expect(card.property_label).toBe('Unit B · 103 Example Ave, Sampletown 34200');
    expect(cardLines(card)[0].text).toBe("Only visits booked for Unit B · 103 Example Ave, Sampletown 34200. The customer's other properties keep their prices.");
    const contract = buildContract({ toolName: 'reprice_future_visits', params: ask({ property_id: UNIT_B }), displayParams: {}, preview: card });
    expect(contract.effects.map((e) => e.label)).toContain("Only visits booked for Unit B · 103 Example Ave, Sampletown 34200. The customer's other properties keep their prices.");
  });

  test('the confirmed run saves only the listed property visits', async () => {
    const input = ask({ property_id: UNIT_A, new_price: 85.54 });
    const card = await preview({ property_id: UNIT_A, new_price: 85.54 });
    const res = await confirm(input, card._version);
    expect(res.success).toBe(true);
    expect(Schedule.updateVisitDetails.mock.calls.map((c) => c[0].id)).toEqual(['a-1', 'a-2']);
    expect(Schedule.updateVisitDetails.mock.calls[0][0].body).toEqual({ estimatedPrice: 85.54, expectedTotal: 85.54 });
  });

  test('from_date = through_date narrows to that day', async () => {
    const card = await preview({ property_id: UNIT_A, from_date: '2099-05-10', through_date: '2099-05-10', new_price: 85.54 });
    expect(card.visits.map((v) => v.id)).toEqual(['a-2']);
  });

  test('appointment_id changes that one visit, even with another unit on the same day, and the card names its place', async () => {
    const id = '00000000-0000-0000-0000-0000000000d1';
    Object.assign(tables.scheduled_services.find((r) => r.id === 'b-1'), { id, service_address_line1: '103 Example Ave' });
    const card = await preview({ appointment_id: id, new_price: 68.9 });
    expect(card.visits.map((v) => [v.id, v.at])).toEqual([[id, '103 Example Ave']]);
    expect(cardLines(card)[0].text).toBe(`Visit 2099-03-10 (Tue) · Quarterly Pest Control at 103 Example Ave (visit ${id}): $76.56 → $68.90`);
    // Uppercase input matches the lowercase stored id.
    expect((await preview({ appointment_id: id.toUpperCase(), new_price: 68.9 })).visits.map((v) => v.id)).toEqual([id]);
    expect((await preview({ appointment_id: '00000000-0000-0000-0000-0000000000d9' })).code).toBe('visit_not_found');
    expect((await preview({ appointment_id: 'b-1' })).code).toBe('invalid_input');
    // Another unit's visit under property_id is not found.
    expect((await preview({ appointment_id: id, property_id: UNIT_A })).code).toBe('visit_not_found');
  });

  test('a supplied blank selector is refused, never read as no narrowing', async () => {
    for (const field of ['appointment_id', 'property_id', 'from_date', 'through_date']) {
      for (const blank of ['', '   ', null]) {
        expect(await preview({ [field]: blank })).toMatchObject({ code: 'invalid_input', error: expect.stringMatching(new RegExp(`^${field} is empty`)) });
      }
    }
  });

  test('a card spanning two units names each visit place; a one-place card does not', async () => {
    tables.scheduled_services.forEach((r) => { r.service_address_line1 = r.property_id === UNIT_A ? '101 Example Ave' : '103 Example Ave'; });
    const card = await preview({ new_price: 70 });
    expect(card.visits.map((v) => v.at)).toEqual(['101 Example Ave', '103 Example Ave', '101 Example Ave', '103 Example Ave']);
    const one = await preview({ property_id: UNIT_A, new_price: 70 });
    expect(one.visits.every((v) => v.at === undefined)).toBe(true);
  });

  test("appointment_id and property_id are references the bar's task check binds to the named customer", async () => {
    const { validateRecordTarget } = require('../services/intelligence-bar/task-context');
    const OTHER = '00000000-0000-0000-0000-0000000000c2';
    const OTHER_VISIT = '00000000-0000-0000-0000-0000000000e1';
    const MINE = '00000000-0000-0000-0000-0000000000e2';
    tables.customers.push({ id: OTHER, first_name: 'Casey', last_name: 'Other', billing_mode: 'per_visit', deleted_at: null });
    tables.scheduled_services.push(
      visit(OTHER_VISIT, '2099-03-10', { customer_id: OTHER, property_id: null }),
      visit(MINE, '2099-03-10', { property_id: UNIT_A }),
    );
    const check = (params) => validateRecordTarget({ customer_id: CUSTOMER_ID, ...params }, {}, { toolName: 'reprice_future_visits' });
    expect(await check({ appointment_id: OTHER_VISIT })).toMatchObject({ code: 'target_relationship_mismatch' });
    // A visit at the other unit than the property named in the same call.
    expect(await check({ appointment_id: MINE, property_id: UNIT_B })).toMatchObject({ code: 'target_relationship_mismatch' });
    tables.customer_properties[1].customer_id = OTHER;
    expect(await check({ property_id: UNIT_B })).toMatchObject({ code: 'target_relationship_mismatch' });
  });

  test('two visits whose lines read the same both stay on the contract card, each with its id', async () => {
    tables.scheduled_services = [visit('s-1', '2099-03-10'), visit('s-2', '2099-03-10')];
    const card = await preview();
    const contract = buildContract({ toolName: 'reprice_future_visits', params: ask(), displayParams: {}, preview: card });
    const billing = contract.effects.filter((e) => e.kind === 'billing').map((e) => e.label);
    expect(billing).toEqual([
      'Visit 2099-03-10 (Tue) · Quarterly Pest Control: $55.00 → $49.00 (visit s-1)',
      'Visit 2099-03-10 (Tue) · Quarterly Pest Control: $55.00 → $49.00 (visit s-2)',
    ]);
  });

  test('two saved properties that render the same street still name each visit place, with the city', async () => {
    tables.scheduled_services.forEach((r) => Object.assign(r, { service_address_line1: '101 Example Ave', service_address_city: r.property_id === UNIT_A ? 'Sampletown' : 'Otherville' }));
    const card = await preview({ new_price: 70 });
    expect(card.visits.map((v) => v.at)).toEqual(['101 Example Ave, Sampletown', '101 Example Ave, Otherville', '101 Example Ave, Sampletown', '101 Example Ave, Otherville']);
  });

  test('two units on one street show their unit line', async () => {
    tables.scheduled_services.forEach((r) => Object.assign(r, { service_address_line1: '101 Example Ave', service_address_line2: r.property_id === UNIT_A ? 'Unit A' : 'Unit B' }));
    const card = await preview({ new_price: 70 });
    expect(card.visits.map((v) => v.at)).toEqual(['101 Example Ave Unit A', '101 Example Ave Unit B', '101 Example Ave Unit A', '101 Example Ave Unit B']);
  });

  test('an address change on a later visit between saves stops the batch', async () => {
    const card = await preview({ new_price: 70 });
    Schedule.updateVisitDetails.mockImplementationOnce(async () => {
      Object.assign(tables.scheduled_services.find((r) => r.id === 'b-1'), { service_address_line1: '999 Example Ave', row_version: 'b-1:v2' });
      return { status: 200, json: { success: true } };
    });
    const res = await confirm(ask({ new_price: 70 }), card._version);
    expect(Schedule.updateVisitDetails.mock.calls.map((c) => c[0].id)).toEqual(['a-1']);
    expect(res).toMatchObject({ partial: true, failed_visit: { id: 'b-1', code: 'preview_changed' } });
  });

  test('a visit moved to another unit between saves is not saved at the old unit price', async () => {
    const input = ask({ property_id: UNIT_A, new_price: 85.54 });
    const card = await preview({ property_id: UNIT_A, new_price: 85.54 });
    Schedule.updateVisitDetails.mockImplementationOnce(async () => {
      Object.assign(tables.scheduled_services.find((r) => r.id === 'a-2'), { property_id: UNIT_B, row_version: 'a-2:v2' });
      return { status: 200, json: { success: true } };
    });
    const res = await confirm(input, card._version);
    expect(Schedule.updateVisitDetails.mock.calls.map((c) => c[0].id)).toEqual(['a-1']);
    expect(res).toMatchObject({ partial: true, failed_visit: { id: 'a-2', code: 'preview_changed' } });
  });

  test('a visit with no saved property is left alone, never guessed onto the property', async () => {
    tables.scheduled_services.push(visit('n-1', '2099-04-10', { property_id: null }));
    const card = await preview({ property_id: UNIT_A, new_price: 85.54 });
    expect(card.visits.map((v) => v.id)).toEqual(['a-1', 'a-2']);
    expect(card.left_alone).toEqual([expect.objectContaining({ id: 'n-1', reason: expect.stringMatching(/no saved property/) })]);
  });

  test('another customer\'s property, a bad id, a past from_date or a reversed range is refused', async () => {
    tables.customer_properties[1].customer_id = '00000000-0000-0000-0000-0000000000c2';
    expect(await preview({ property_id: UNIT_B })).toMatchObject({ code: 'invalid_input', error: expect.stringMatching(/not one of Robin Sample's saved properties/) });
    expect((await preview({ property_id: 'unit-b' })).code).toBe('invalid_input');
    expect((await preview({ from_date: '2099-02-01' })).error).toMatch(/from_date is in the past/);
    expect((await preview({ from_date: '2099-05-10', through_date: '2099-03-10' })).error).toMatch(/from_date is after through_date/);
    expect(Schedule.updateVisitDetails).not.toHaveBeenCalled();
  });

  test('a property with no visits of that service in range says so, and lists visits with no saved property', async () => {
    const res = await preview({ property_id: UNIT_A, from_date: '2099-06-01' });
    expect(res.error).toBeTruthy();
    tables.scheduled_services = tables.scheduled_services.filter((r) => r.property_id !== UNIT_A).concat(visit('n-1', '2099-04-10', { property_id: null }));
    const unstamped = await preview({ property_id: UNIT_A });
    expect(unstamped.code).toBe('nothing_to_reprice');
    expect(unstamped.left_alone).toEqual([expect.objectContaining({ id: 'n-1', reason: expect.stringMatching(/no saved property/) })]);
  });

  test('the version binds the property and range', async () => {
    const a = await preview({ property_id: UNIT_A, from_date: '2099-03-10', through_date: '2099-03-10' });
    const b = await preview({ property_id: UNIT_A, from_date: '2099-03-10', through_date: '2099-03-11' });
    expect(a.visits.map((v) => v.id)).toEqual(b.visits.map((v) => v.id));
    expect(a._version).not.toBe(b._version);
  });
});
