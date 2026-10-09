// GATE_COMBO_FAST_COMPLETE (PR 1): the lawn Fast Complete routes refuse a grouped member
// (`grouped_visit`) unless the server confirms a combined stop: the gate is live AND either the
// preflight runs inside the stop's own visit-closeout packet, or (the sheet's reads before a packet
// exists) the stop is open with exactly two open members, this service one of them AND the request
// asked for it. Gate off, or no tie: refused exactly as today. Synthetic data; a table-keyed fake knex.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/service-completion-profiles', () => ({ resolveCompletionProfileForScheduledService: jest.fn() }));
jest.mock('../services/waveguard-plan-engine', () => ({ buildPlanForService: jest.fn(), v13VisitLimits: jest.fn(), v13ProtocolRows: jest.fn(() => new Map()), v13GateNotes: jest.fn(() => []) }));

const { resolveCompletionProfileForScheduledService } = require('../services/service-completion-profiles');
const { buildPlanForService } = require('../services/waveguard-plan-engine');
const {
  resolveLawnFastEligibility, buildLawnFastContext, preflightLawnFastCompletion,
} = require('../services/lawn-fast-complete');
const lawnFast = require('../services/lawn-fast-complete');
const { groupedStopAllowed, comboStopRequested, comboRowFlag } = require('../services/combo-fast-complete');

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const VISIT = uuid(1);
const ASSESSMENT = uuid(2);
const STOP = uuid(3);
const OTHER = uuid(4);
const PACKET = uuid(5);
const PK = { id: PACKET, payload: { items: [{ serviceId: VISIT }, { serviceId: OTHER }] } };
const PROFILE = { category: 'lawn_care', serviceKey: 'lawn_care_monthly', billingType: 'recurring', findingsType: null, projectBacked: false, requiresProject: false, companions: [] };
const svcRow = (extra = {}) => ({
  id: VISIT, customer_id: 'cust-1', property_id: 'prop-1', service_type: 'Lawn Care', service_id: 'cat-1',
  scheduled_date: '2026-10-05', status: 'confirmed', visit_id: STOP,
  cust_address_line1: '100 Example Court', cust_city: 'Bradenton', cust_state: 'FL', cust_zip: '34201', ...extra,
});

// scheduled_services answers .first() with the service and, once whereNotIn ran (visit-groups.openMembers),
// its awaited list with `members`.
function fakeKnex({ visit = { id: STOP, status: 'open' }, members = [{ id: VISIT }, { id: OTHER }], packet = null, svc = svcRow(), projectError = false, invoice = null, invoiceError = false, records = [], recordsError = false } = {}) {
  const queried = [];
  const knex = jest.fn((table) => {
    queried.push(table);
    let list = false;
    const chain = {};
    for (const m of ['where', 'whereIn', 'whereNot', 'whereNotNull', 'whereRaw', 'leftJoin', 'join', 'orderBy', 'orderByRaw', 'select']) chain[m] = () => chain;
    chain.whereNotIn = () => { list = true; return chain; };
    const tables = {
      scheduled_services: svc,
      service_visits: visit,
      visit_completion_packets: packet,
      customers: { billing_mode: null },
      lawn_assessments: { id: ASSESSMENT, confirmed_by_tech: true },
    };
    chain.first = async () => {
      if (table === 'projects' && projectError) throw new Error('projects read failed');
      if (table === 'invoices') {
        if (invoiceError) throw new Error('invoices read failed');
        return invoice || undefined;
      }
      return tables[table];
    };
    chain.then = (resolve, reject) => {
      if (table === 'service_records') return (recordsError ? Promise.reject(new Error('records read failed')) : Promise.resolve(records)).then(resolve, reject);
      return Promise.resolve(list && table === 'scheduled_services' ? members : []).then(resolve, reject);
    };
    chain.catch = () => Promise.resolve([]);
    return chain;
  });
  knex.queried = queried;
  return knex;
}

const IDENTITY = {
  propertyId: 'prop-1', customerId: 'cust-1', catalogServiceId: 'cat-1', serviceType: 'Lawn Care', scheduledDate: '2026-10-05', isCallback: false,
  address: { line1: '100 Example Court', line2: null, city: 'Bradenton', state: 'FL', zip: '34201' }, technicianId: null,
};
const preflight = (knex, { packetId, ...args } = {}) => preflightLawnFastCompletion({
  knex, svc: { id: VISIT, customer_id: 'cust-1', property_id: 'prop-1' }, lawnAssessmentId: ASSESSMENT, expectedVisit: IDENTITY, lawnFast: { visitType: 'recurring' }, ...(packetId ? { packetContext: { packetId } } : {}), ...args,
});

// The canonical verdicts the pair check reads for each member (resolveLawnFastEligibility without a grouped ask).
const LAWN_V = { ok: true, svc: { service_type: 'Lawn Care' }, profile: { category: 'lawn_care', serviceKey: 'lawn_care_monthly', findingsType: null, companions: [] }, reason: 'grouped_visit' };
const PEST_V = { ok: true, svc: { service_type: 'Quarterly Pest Control Service' }, profile: { category: 'pest_control', serviceKey: 'pest_general_quarterly', findingsType: null, companions: [] }, reason: 'not_lawn' };
let memberVerdicts;
const GATES = ['GATE_COMBO_FAST_COMPLETE', 'GATE_FAST_COMPLETE_REPORT', 'GATE_LAWN_FAST_COMPLETE', 'GATE_LAWN_COMPLETION_DEFAULTS', 'GATE_LAWN_PROPERTY_HISTORY'];
const saved = {};
beforeEach(() => {
  for (const name of GATES) { saved[name] = process.env[name]; delete process.env[name]; }
  process.env.GATE_LAWN_FAST_COMPLETE = 'true';
  process.env.GATE_FAST_COMPLETE_REPORT = 'true';
  resolveCompletionProfileForScheduledService.mockReset().mockResolvedValue(PROFILE);
  buildPlanForService.mockReset();
  memberVerdicts = { [VISIT]: LAWN_V, [OTHER]: PEST_V };
  const real = lawnFast.resolveLawnFastEligibility;
  jest.spyOn(lawnFast, 'resolveLawnFastEligibility').mockImplementation((id, knex, opts = {}) => (
    !opts.allowGrouped && memberVerdicts[id] ? Promise.resolve(memberVerdicts[id]) : real(id, knex, opts)));
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => {
  for (const name of GATES) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; }
});
const comboLive = () => { process.env.GATE_COMBO_FAST_COMPLETE = 'true'; };

describe('groupedStopAllowed', () => {
  test('gate off: never, and no read at all', async () => {
    const knex = fakeKnex();
    expect(await groupedStopAllowed(knex, svcRow(), { stop: true })).toBe(false);
    expect(await groupedStopAllowed(knex, svcRow(), { packetContext: { packetId: PACKET } })).toBe(false);
    expect(knex).not.toHaveBeenCalled();
  });

  test('gate live: an open stop with exactly two open members, this service one of them', async () => {
    comboLive();
    expect(await groupedStopAllowed(fakeKnex(), svcRow(), { stop: true })).toBe(true);
  });

  test.each([
    ['an ungrouped service', fakeKnex(), svcRow({ visit_id: null })],
    ['a missing stop', fakeKnex({ visit: null }), svcRow()],
    ['a stop that is closing (no packet named)', fakeKnex({ visit: { id: STOP, status: 'closing' } }), svcRow()],
    ['a closed stop', fakeKnex({ visit: { id: STOP, status: 'closed' } }), svcRow()],
    ['a dissolved stop', fakeKnex({ visit: { id: STOP, status: 'dissolved' } }), svcRow()],
    ['one open member', fakeKnex({ members: [{ id: VISIT }] }), svcRow()],
    ['three open members', fakeKnex({ members: [{ id: VISIT }, { id: OTHER }, { id: uuid(6) }] }), svcRow()],
    ['two open members that are not this service', fakeKnex({ members: [{ id: OTHER }, { id: uuid(6) }] }), svcRow()],
  ])('gate live: %s is refused', async (_label, knex, svc) => {
    comboLive();
    expect(await groupedStopAllowed(knex, svc, { stop: true })).toBe(false);
  });

  test('gate live: no ask is no tie, and a packet ask that names no packet is never allowed', async () => {
    comboLive();
    expect(await groupedStopAllowed(fakeKnex(), svcRow())).toBe(false);
    expect(await groupedStopAllowed(fakeKnex({ visit: { id: STOP, status: 'closing' }, packet: PK }), svcRow(), { packetContext: { packetId: undefined } })).toBe(false);
    expect(await groupedStopAllowed(fakeKnex({ visit: { id: STOP, status: 'closing' }, packet: PK }), svcRow(), { packetContext: null })).toBe(false);
  });

  test('gate live, with a packet: only a closing stop that owns that packet', async () => {
    comboLive();
    const closing = { id: STOP, status: 'closing' };
    expect(await groupedStopAllowed(fakeKnex({ visit: closing, packet: PK }), svcRow(), { packetContext: { packetId: PACKET } })).toBe(true);
    expect(await groupedStopAllowed(fakeKnex({ visit: closing, packet: null }), svcRow(), { packetContext: { packetId: PACKET } })).toBe(false);
    expect(await groupedStopAllowed(fakeKnex({ visit: { id: STOP, status: 'open' }, packet: PK }), svcRow(), { packetContext: { packetId: PACKET } })).toBe(false);
  });
});

describe('comboStopRequested', () => {
  test('is the header X-Combo-Stop: 1 and nothing else', () => {
    const req = (value) => ({ get: (name) => (name.toLowerCase() === 'x-combo-stop' ? value : undefined) });
    expect(comboStopRequested(req('1'))).toBe(true);
    for (const value of ['0', 'true', '', undefined]) expect(comboStopRequested(req(value))).toBe(false);
    expect(comboStopRequested({ headers: { 'x-combo-stop': '1' } })).toBe(true);
    expect(comboStopRequested({})).toBe(false);
  });
});

describe('the lawn context for a grouped member (the sheet\'s reads)', () => {
  const ctx = (knex, ask) => buildLawnFastContext(VISIT, { knex, ...(ask ? { allowGrouped: { stop: true } } : {}) });

  test('refused as today: gate off; gate on without the request; gate on and requested but not a combined stop', async () => {
    expect(await ctx(fakeKnex(), true)).toMatchObject({ ok: true, eligible: false, reason: 'grouped_visit' });
    comboLive();
    expect(await ctx(fakeKnex(), false)).toMatchObject({ eligible: false, reason: 'grouped_visit' });
    expect(await ctx(fakeKnex({ members: [{ id: VISIT }] }), true)).toMatchObject({ eligible: false, reason: 'grouped_visit' });
    expect(await ctx(fakeKnex({ visit: { id: STOP, status: 'closing' } }), true)).toMatchObject({ eligible: false, reason: 'grouped_visit' });
  });

  test('accepted: gate on, requested, and the server reads an open two-member stop', async () => {
    comboLive();
    const verdict = await resolveLawnFastEligibility(VISIT, fakeKnex(), { allowGrouped: { stop: true }, withVisitType: false });
    expect(verdict).toMatchObject({ ok: true, reason: null });
    const built = await ctx(fakeKnex(), true);
    expect(built).toMatchObject({ ok: true, eligible: true, reason: null });
  });

  test('gate off with the request: never accepted', async () => {
    const knex = fakeKnex();
    expect(await resolveLawnFastEligibility(VISIT, knex, { allowGrouped: { stop: true }, withVisitType: false })).toMatchObject({ reason: 'grouped_visit' });
  });
});

describe('the /complete preflight for a grouped member', () => {
  const closing = { visit: { id: STOP, status: 'closing' }, packet: PK };

  test('gate off: lawn_fast_disabled (as today, whatever the packet)', async () => {
    delete process.env.GATE_LAWN_FAST_COMPLETE;
    expect(await preflight(fakeKnex(closing), { packetContext: { packetId: PACKET } })).toMatchObject({ status: 409, payload: { code: 'lawn_fast_disabled' } });
  });

  test('combo gate off: a grouped member is refused 409 lawn_fast_not_eligible / grouped_visit, packet or not', async () => {
    expect(await preflight(fakeKnex(closing))).toMatchObject({ status: 409, payload: { code: 'lawn_fast_not_eligible', reason: 'grouped_visit' } });
    expect(await preflight(fakeKnex(closing), { packetContext: { packetId: PACKET } })).toMatchObject({ status: 409, payload: { code: 'lawn_fast_not_eligible', reason: 'grouped_visit' } });
  });

  test('combo gate on but no packet (a bare /complete for a grouped member): refused as today', async () => {
    comboLive();
    expect(await preflight(fakeKnex({ visit: { id: STOP, status: 'open' } }))).toMatchObject({ status: 409, payload: { reason: 'grouped_visit' } });
  });

  test('combo gate on, packet named but not this stop\'s (no packet row) or the stop not closing: refused', async () => {
    comboLive();
    expect(await preflight(fakeKnex({ visit: { id: STOP, status: 'closing' }, packet: null }), { packetContext: { packetId: PACKET } })).toMatchObject({ status: 409, payload: { reason: 'grouped_visit' } });
    expect(await preflight(fakeKnex({ visit: { id: STOP, status: 'open' }, packet: PK }), { packetContext: { packetId: PACKET } })).toMatchObject({ status: 409, payload: { reason: 'grouped_visit' } });
  });

  test('combo gate on, inside the stop\'s own packet: accepted (the rest of the preflight still runs)', async () => {
    comboLive();
    expect(await preflight(fakeKnex(closing), { packetContext: { packetId: PACKET } })).toBeNull();
    // ...including the confirmed-assessment check.
    const noAssessment = fakeKnex(closing);
    expect(await preflight(noAssessment, { packetId: PACKET, lawnAssessmentId: null })).toMatchObject({ status: 400, payload: { code: 'lawn_fast_assessment_required' } });
  });
});

describe('comboRowFlag', () => {
  test('gate live and a row on a stop; never otherwise', () => {
    expect(comboRowFlag({ visit_id: STOP })).toBe(false);
    comboLive();
    expect(comboRowFlag({ visit_id: STOP })).toBe(true);
    expect(comboRowFlag({ visit_id: null })).toBe(false);
    expect(comboRowFlag({})).toBe(false);
    expect(comboRowFlag(undefined)).toBe(false);
  });
});

describe('the pair is validated before the grouped refusal lifts (header path and packet path)', () => {
  const OTHER_LAWN = { ...LAWN_V, reason: 'grouped_visit' };
  const withProfile = (base, profile, svc = {}) => ({ ...base, profile: { ...base.profile, ...profile }, svc: { ...base.svc, ...svc } });
  const cases = [
    ['the valid pair', { [VISIT]: LAWN_V, [OTHER]: PEST_V }, true],
    ['two lawn members', { [VISIT]: LAWN_V, [OTHER]: OTHER_LAWN }, false],
    ['lawn + typed pest', { [VISIT]: LAWN_V, [OTHER]: withProfile(PEST_V, { findingsType: 'cockroach' }) }, false],
    ['lawn + lane pest (bed bug)', { [VISIT]: LAWN_V, [OTHER]: withProfile(PEST_V, { serviceKey: 'bed_bug_treatment' }, { service_type: 'Bed Bug Treatment' }) }, false],
    ['lawn + project-backed pest', { [VISIT]: LAWN_V, [OTHER]: withProfile(PEST_V, { projectBacked: true }) }, false],
    ['lawn + pest needing a project', { [VISIT]: LAWN_V, [OTHER]: withProfile(PEST_V, { requiresProject: true }) }, false],
    ['lawn + pest with companions', { [VISIT]: LAWN_V, [OTHER]: withProfile(PEST_V, { companions: [{ type: 'rodent_bait_station' }] }) }, false],
    ['lawn + pest re-service (profile key)', { [VISIT]: LAWN_V, [OTHER]: withProfile(PEST_V, { serviceKey: 'pest_re_service' }) }, false],
    ['lawn + pest callback', { [VISIT]: LAWN_V, [OTHER]: withProfile(PEST_V, {}, { is_callback: true }) }, false],
    ['lawn re-service + pest', { [VISIT]: { ...withProfile(LAWN_V, { serviceKey: 'lawn_re_service' }), reason: 'lawn_re_service' }, [OTHER]: PEST_V }, false],
    ['lawn callback + pest (a lawn visit the lawn rule admits)', { [VISIT]: withProfile(LAWN_V, {}, { is_callback: true }), [OTHER]: PEST_V }, true],
    ['lawn + a profile that failed to read', { [VISIT]: LAWN_V, [OTHER]: { ok: false, reason: 'not_found' } }, false],
    ['lawn with companions + pest', { [VISIT]: withProfile(LAWN_V, { companions: ['tree_shrub'] }, {}), [OTHER]: PEST_V }, true],
  ];
  // (A lawn member that is itself refused for another reason keeps that reason at the lawn read; the pair check
  // only sets aside the grouped one, so give those a non-grouped reason.)
  cases[cases.length - 1] = ['lawn refused for companions + pest', { [VISIT]: { ...withProfile(LAWN_V, { companions: ['tree_shrub'] }), reason: 'has_companions' }, [OTHER]: PEST_V }, false];

  test.each(cases)('header path: %s', async (_label, verdicts, expected) => {
    comboLive();
    memberVerdicts = verdicts;
    expect(await groupedStopAllowed(fakeKnex(), svcRow(), { stop: true })).toBe(expected);
  });

  test.each(cases)('packet path: %s', async (_label, verdicts, expected) => {
    comboLive();
    memberVerdicts = verdicts;
    const knex = fakeKnex({ visit: { id: STOP, status: 'closing' }, packet: PK });
    expect(await groupedStopAllowed(knex, svcRow(), { packetContext: { packetId: PACKET } })).toBe(expected);
  });

  test('three members: refused on both paths', async () => {
    comboLive();
    expect(await groupedStopAllowed(fakeKnex({ members: [{ id: VISIT }, { id: OTHER }, { id: uuid(6) }] }), svcRow(), { stop: true })).toBe(false);
    const three = { ...PK, payload: { items: [{ serviceId: VISIT }, { serviceId: OTHER }, { serviceId: uuid(6) }] } };
    expect(await groupedStopAllowed(fakeKnex({ visit: { id: STOP, status: 'closing' }, packet: three }), svcRow(), { packetContext: { packetId: PACKET } })).toBe(false);
  });

  test('a packet whose frozen items do not include this service is refused', async () => {
    comboLive();
    const other = { ...PK, payload: { items: [{ serviceId: OTHER }, { serviceId: uuid(6) }] } };
    expect(await groupedStopAllowed(fakeKnex({ visit: { id: STOP, status: 'closing' }, packet: other }), svcRow(), { packetContext: { packetId: PACKET } })).toBe(false);
  });

  test('the packet path reads the earlier, already completed item as a member (allowStatuses completed)', async () => {
    comboLive();
    await groupedStopAllowed(fakeKnex({ visit: { id: STOP, status: 'closing' }, packet: PK }), svcRow(), { packetContext: { packetId: PACKET } });
    expect(lawnFast.resolveLawnFastEligibility).toHaveBeenCalledTimes(2);
    expect(lawnFast.resolveLawnFastEligibility.mock.calls.every(([, , opts]) => opts.allowStatuses?.includes('completed'))).toBe(true);
  });

  test('the context for two lawn members stays refused as grouped_visit', async () => {
    comboLive();
    memberVerdicts = { [VISIT]: LAWN_V, [OTHER]: OTHER_LAWN };
    expect(await buildLawnFastContext(VISIT, { knex: fakeKnex(), allowGrouped: { stop: true } })).toMatchObject({ eligible: false, reason: 'grouped_visit' });
  });
});

describe('project linkage is rechecked for both members (header path and packet path)', () => {
  const pestRecap = require('../services/pest-recap');
  const paths = [
    ['header path', () => fakeKnex(), { stop: true }],
    ['packet path', () => fakeKnex({ visit: { id: STOP, status: 'closing' }, packet: PK }), { packetContext: { packetId: PACKET } }],
  ];

  test.each(paths)('%s: the valid pair with no project is allowed (reads both members)', async (_label, knexFor, ask) => {
    comboLive();
    const linked = jest.spyOn(pestRecap, 'serviceHasLinkedProject').mockResolvedValue(false);
    expect(await groupedStopAllowed(knexFor(), svcRow(), ask)).toBe(true);
    expect(linked.mock.calls.map(([id]) => id).sort()).toEqual([OTHER, VISIT].sort());
  });

  test.each(paths)('%s: a project linked to either member after the schedule loaded refuses', async (_label, knexFor, ask) => {
    comboLive();
    for (const member of [VISIT, OTHER]) {
      jest.spyOn(pestRecap, 'serviceHasLinkedProject').mockImplementation(async (id) => id === member);
      expect(await groupedStopAllowed(knexFor(), svcRow(), ask)).toBe(false);
    }
  });

  test.each(paths)('%s: a lookup that fails refuses (the lookup answers linked on error)', async (_label, knexFor, ask) => {
    comboLive();
    const failing = fakeKnex({ visit: ask.stop ? { id: STOP, status: 'open' } : { id: STOP, status: 'closing' }, packet: ask.stop ? null : PK, projectError: true });
    expect(await groupedStopAllowed(failing, svcRow(), ask)).toBe(false);
  });
});

describe('serviceHasLinkedProject (the lookup behind the sheet record and the combo check)', () => {
  const { serviceHasLinkedProject } = require('../services/pest-recap');
  const recording = (answer) => {
    const wheres = [];
    const chain = {};
    for (const m of ['leftJoin']) chain[m] = () => chain;
    chain.where = (arg) => { if (typeof arg === 'function') { const inner = { where: (c) => { wheres.push(c); return inner; }, orWhere: (c) => { wheres.push(c); return inner; } }; arg(inner); } return chain; };
    chain.first = () => (answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer));
    const knex = jest.fn(() => chain);
    knex.wheres = wheres;
    return knex;
  };

  test('looks at the direct link and the legacy link through the service record', async () => {
    const knex = recording(undefined);
    expect(await serviceHasLinkedProject('svc-1', knex)).toBe(false);
    expect(knex.wheres).toEqual(['projects.scheduled_service_id', 'service_records.scheduled_service_id']);
  });
  test('a found project is linked; a failed read counts as linked', async () => {
    expect(await serviceHasLinkedProject('svc-1', recording({ id: 'p' }))).toBe(true);
    expect(await serviceHasLinkedProject('svc-1', recording(new Error('boom')))).toBe(true);
  });
});

describe('invoice state and the pest report gate are rechecked (header path and packet path)', () => {
  const paths = [
    ['header path', (extra) => fakeKnex(extra), { stop: true }],
    ['packet path', (extra) => fakeKnex({ visit: { id: STOP, status: 'closing' }, packet: PK, ...extra }), { packetContext: { packetId: PACKET } }],
  ];

  test.each(paths)('%s: the pair with no invoice is allowed', async (_label, knexFor, ask) => {
    comboLive();
    expect(await groupedStopAllowed(knexFor({}), svcRow(), ask)).toBe(true);
  });

  test.each(paths)('%s: an invoice created for a member after the schedule loaded refuses', async (_label, knexFor, ask) => {
    comboLive();
    expect(await groupedStopAllowed(knexFor({ invoice: { id: 'inv-1' } }), svcRow(), ask)).toBe(false);
  });

  test.each(paths)('%s: an invoice read that fails refuses', async (_label, knexFor, ask) => {
    comboLive();
    expect(await groupedStopAllowed(knexFor({ invoiceError: true }), svcRow(), ask)).toBe(false);
  });

  test.each(paths)('%s: the pest report gate off refuses (the kill switch holds against a stale client)', async (_label, knexFor, ask) => {
    comboLive();
    process.env.GATE_FAST_COMPLETE_REPORT = 'false';
    expect(await groupedStopAllowed(knexFor({}), svcRow(), ask)).toBe(false);
    delete process.env.GATE_FAST_COMPLETE_REPORT;
    expect(await groupedStopAllowed(knexFor({}), svcRow(), ask)).toBe(false);
  });

  test('the invoice rule is the mint\'s own predicate (one exported function)', () => {
    const { linkedMemberInvoices } = require('../services/visit-completion-invoice');
    const wheres = [];
    const chain = { whereIn: (col) => { wheres.push(col); return chain; }, orWhereIn: (col) => { wheres.push(col); return chain; } };
    const trx = () => ({ where: (fn) => { fn.call(chain); return chain; } });
    linkedMemberInvoices(trx, [{ id: 'a', record_id: 'r' }]);
    expect(wheres).toEqual(['scheduled_service_id', 'service_record_id']);
  });
});

describe('an invoice that hangs on a member\'s service record refuses the combo (header path and packet path)', () => {
  const invoiceModule = require('../services/visit-completion-invoice');
  const paths = [
    ['header path', (extra) => fakeKnex(extra), { stop: true }],
    ['packet path', (extra) => fakeKnex({ visit: { id: STOP, status: 'closing' }, packet: PK, ...extra }), { packetContext: { packetId: PACKET } }],
  ];

  test.each(paths)('%s: the lookup is given each member\'s existing record ids, and an invoice found by them refuses', async (_label, knexFor, ask) => {
    comboLive();
    const lookup = jest.spyOn(invoiceModule, 'linkedMemberInvoices');
    const records = [{ id: 'rec-pest', scheduled_service_id: OTHER }, { id: 'rec-lawn-1', scheduled_service_id: VISIT }, { id: 'rec-lawn-2', scheduled_service_id: VISIT }];
    expect(await groupedStopAllowed(knexFor({ records }), svcRow(), ask)).toBe(true);
    const given = lookup.mock.calls.at(-1)[1];
    expect(given).toEqual(expect.arrayContaining([
      { id: OTHER, record_id: 'rec-pest' }, { id: VISIT, record_id: 'rec-lawn-1' }, { id: VISIT, record_id: 'rec-lawn-2' },
    ]));
    expect(await groupedStopAllowed(knexFor({ records, invoice: { id: 'inv-on-record' } }), svcRow(), ask)).toBe(false);
  });

  test.each(paths)('%s: members with no record yet are looked up by the visit alone', async (_label, knexFor, ask) => {
    comboLive();
    const lookup = jest.spyOn(invoiceModule, 'linkedMemberInvoices');
    await groupedStopAllowed(knexFor({}), svcRow(), ask);
    expect(lookup.mock.calls.at(-1)[1]).toEqual(expect.arrayContaining([{ id: VISIT, record_id: null }, { id: OTHER, record_id: null }]));
  });

  test.each(paths)('%s: a failed record read refuses (fail closed)', async (_label, knexFor, ask) => {
    comboLive();
    expect(await groupedStopAllowed(knexFor({ recordsError: true }), svcRow(), ask)).toBe(false);
  });
});

