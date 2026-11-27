// No protocol = no chemical plan (owner pick D18, protocols page 2026-11-25): a service with no card shows "inspection only, no
// product" and prefills nothing. Before, a name no rule claimed got the general pest card (and its products), "Wildlife Trapping"
// got the pest program's old rodent bait card, and a bare "Barrier Treatment" its old mosquito card. The Waves Assessment has its
// own card (owner pick D13): a walk of the property with no product. Protocols audit 2026-11-26, item 13.
// Real handlers and the real protocols.json; synthetic visit rows.
jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: jest.fn(), requireAdmin: jest.fn(), requireTechOrAdmin: jest.fn(),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const protocols = require('../config/protocols.json');
const { MATCH_RULES, matchServiceProtocol, followupVisitMatch } = require('../services/protocol-matcher');
const { parseProtocolLines } = require('../services/waveguard-plan-engine');
const { resolveCompletionDefaultProductNames } = require('../services/completion-product-defaults');
const jobCard = require('../services/job-card');
const adminProtocolsRouter = require('../routes/admin-protocols');

const { _internals: { buildCompletionActions } } = adminProtocolsRouter;
const routeHandler = (path) => adminProtocolsRouter.stack.find((layer) => layer.route?.path === path && layer.route.methods.get).route.stack[0].handle;
const match = (name, serviceKey = null) => {
  const result = matchServiceProtocol(protocols, name, { serviceKey });
  return [result.programKey, result.matchedVisit?.visit ?? null, result.reason, result.matched];
};
const NO_CARD = [null, null, 'no_protocol', false];
const NOTE = 'Inspection only, no product: this service has no protocol card.';

function readQuery(rows) {
  const query = {};
  for (const method of ['where', 'orWhereNull', 'whereIn', 'whereNotIn', 'join', 'leftJoin', 'select', 'orderByRaw', 'orderBy']) query[method] = jest.fn(() => query);
  query.first = jest.fn(async () => rows[0] || null);
  query.then = (onFulfilled, onRejected) => Promise.resolve(rows).then(onFulfilled, onRejected);
  query.catch = (onRejected) => Promise.resolve(rows).catch(onRejected);
  return query;
}
async function call(path, query) {
  const res = { json: jest.fn(), status: jest.fn() };
  res.status.mockReturnValue(res);
  const next = jest.fn();
  await routeHandler(path)({ query }, res, next);
  expect(next).not.toHaveBeenCalled();
  return { status: res.status.mock.calls[0]?.[0] || 200, body: JSON.parse(JSON.stringify(res.json.mock.calls[0][0])) };
}

const VISIT = '3f2c1d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
// The booked visit the routes read: its catalog key.
function bookedAs(serviceKey) {
  db.mockImplementation((table) => {
    if (table === 'products_catalog') return readQuery([{ id: 'tau', name: 'Taurus SC', aliases: [] }]);
    if (table === 'scheduled_services') return readQuery([{ id: VISIT, service_key: serviceKey, followup_source_service_id: null }]);
    if (table === 'product_aliases') return readQuery([]);
    throw new Error(`Unexpected table: ${table}`);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  db.raw = jest.fn((sql) => sql);
  db.mockImplementation((table) => {
    if (table === 'products_catalog') return readQuery([{ id: 'tau', name: 'Taurus SC', aliases: [] }]);
    if (table === 'product_aliases' || table === 'scheduled_services') return readQuery([]);
    throw new Error(`Unexpected table: ${table}`);
  });
});

describe('the matcher: a service no rule claims has no card', () => {
  // Each active catalog service that fell to the general pest card on 2026-11-26 (production read), with its key.
  test.each([
    ['Bee / Wasp Nest Removal Service', 'bee_wasp_removal'],
    ['Mud Dauber Nest Removal Service', 'mud_dauber_removal'],
    ['Roof-Entry Cover / Bird Box Service', 'rodent_bird_box'],
    ['WaveGuard Initial Setup Service', 'waveguard_initial_setup'],
    ['WaveGuard Membership', 'waveguard_membership'],
    ['Web Sweep', 'area_addon_web_sweep'],
    ['Stinging Insect Removal', null],
    ['One-Time Service', null],
  ])('%s gets no card', (name, key) => {
    expect(match(name, key)).toEqual(NO_CARD);
    expect(matchServiceProtocol(protocols, name, { serviceKey: key }).program).toBeNull();
  });

  test('wildlife trapping no longer gets rodent bait, and a bare "Barrier Treatment" no mosquito card', () => {
    expect(match('Wildlife Trapping Service', 'wildlife_trapping')).toEqual(NO_CARD);
    expect(match('Wildlife Trapping')).toEqual(NO_CARD);
    expect(match('Barrier Treatment')).toEqual(NO_CARD);
    // A named mosquito barrier and a named rodent job keep their own programs.
    expect(match('Mosquito Barrier Treatment')).toEqual(['mosquito', 1, 'mosquito_barrier', true]);
    expect(match('Rodent Trapping Service', 'rodent_trapping').slice(0, 1)).toEqual(['rodent']);
  });

  test('the pest program holds no copy of another program\'s card, and every rule points at a card that exists', () => {
    expect(protocols.pest.visits.map((visit) => visit.visit)).toEqual([1, 3, 4]);
    expect(MATCH_RULES.filter((rule) => rule.programKey === 'pest').map((rule) => rule.reason)).toEqual(['ant_service', 'tick_service', 'general_pest']);
    for (const rule of MATCH_RULES) {
      expect([rule.reason, (protocols[rule.programKey]?.visits || []).some((visit) => Number(visit.visit) === Number(rule.visit))]).toEqual([rule.reason, true]);
    }
  });

  test('a service a pest rule claims keeps its card, by key or by name', () => {
    expect(match('Quarterly Pest Control Service', 'pest_general_quarterly')).toEqual(['pest', 1, 'general_pest', true]);
    expect(match('Anything At All', 'pest_general_quarterly')).toEqual(['pest', 1, 'general_pest', true]);
    expect(match('Pest Control Re-Service')).toEqual(['pest', 1, 'general_pest', true]);
    expect(match('Ant Treatment')).toEqual(['pest', 3, 'ant_service', true]);
    expect(match('Tick Control Service')).toEqual(['pest', 4, 'tick_service', true]);
  });

  // The close-out reads these keys as regular pest work (the house mix): the card must not go when the name says nothing.
  test.each(['pest_general_quarterly', 'pest_general_monthly', 'pest_general_bimonthly', 'pest_general_semiannual', 'one_time_pest_control', 'pest_re_service', 'pest_initial_cleanout'])(
    'a booking named "Re-Service" with the general pest key %s keeps the general pest card', (key) => {
      expect(match('Re-Service', key)).toEqual(['pest', 1, 'general_pest', true]);
    },
  );

  // The close-out seeds the house mix on these names (client lib/pest-default-mix.js): the matcher must call them general pest too.
  test.each(['Re-Service', 'Reservice', 'Callback', 'Semi-Annual Service', 'Semiannual Service', 'Recurring Service'])('a bare "%s" is a general pest visit', (name) => {
    expect(match(name)).toEqual(['pest', 1, 'general_pest', true]);
  });

  test('another line\'s re-service keeps its own program, and a name that says nothing under an unclaimed key has no card', () => {
    expect(match('Lawn Care Re-Service', 'lawn_re_service').slice(0, 1)).toEqual(['lawn']);
    expect(match('Termite Re-Service').slice(0, 1)).toEqual(['termite']);
    expect(match('Mosquito Callback').slice(0, 1)).toEqual(['mosquito']);
    expect(match('Service Visit', 'bee_wasp_removal')).toEqual(NO_CARD);
    expect(match('Service Visit')).toEqual(NO_CARD);
  });

  test('another program\'s own default card is unchanged: only the pest catch-all had no meaning', () => {
    // A lawn name with no rule still reads as the lawn program (its plan engine owns the visit).
    expect(match('Lawn Assessment').slice(0, 1)).toEqual(['lawn']);
    expect(match('Termite Something').slice(0, 1)).toEqual(['termite']);
  });

  test('a follow-up of a service with no card has no card either', () => {
    expect(followupVisitMatch(matchServiceProtocol(protocols, 'Bee / Wasp Nest Removal Service', { serviceKey: 'bee_wasp_removal' }), true)).toMatchObject({ program: null, matchedVisit: null, reason: 'no_protocol' });
  });
});

describe('the Waves Assessment card', () => {
  const visit = protocols.assessment.visits[0];

  test('the catalog key (lawn_inspection since the rename) reaches it, whatever the visit is named', () => {
    expect(match('Waves Assessment', 'lawn_inspection')).toEqual(['assessment', 1, 'waves_assessment', true]);
    expect(match('Lawn Inspection', 'lawn_inspection')).toEqual(['assessment', 1, 'waves_assessment', true]);
    // Every booked assessment carries the key (production read 2026-11-26). A row with no key has no card: inspection only.
    expect(match('Waves Assessment')).toEqual(NO_CARD);
  });

  test('no line of the card is a product or records a treatment', () => {
    const lines = [...parseProtocolLines(visit.primary, 'base'), ...parseProtocolLines(visit.secondary, 'conditional')];
    const actions = buildCompletionActions({ lines, products: [{ id: 'tau', name: 'Taurus SC', active: true }], programKey: 'assessment', visit });
    expect(actions.length).toBeGreaterThan(8);
    expect(actions.filter((action) => action.treatmentApplied || action.product)).toEqual([]);
    expect(visit.completionDefaultProducts).toBeUndefined();
    // Every line declares it, the title too.
    const declared = Object.keys(visit.lineMeta);
    expect([...visit.primary.split('\n'), ...visit.secondary.split('\n')].filter((line) => !declared.includes(line))).toEqual([]);
    expect(Object.values(visit.lineMeta).every((meta) => meta.treatmentApplied === false)).toBe(true);
  });

  test('the card states the owner\'s rules: the price is the estimate\'s, and a sale is treated on the sold service\'s own visit', () => {
    const text = `${visit.primary}\n${visit.secondary}\n${protocols.assessment.notes.join('\n')}`;
    expect(text).toMatch(/Never write or say a price that is not on the estimate/);
    expect(text).toMatch(/book the sold service on this visit, then treat from that service's card/);
    expect(text).toMatch(/No product is applied or logged on an assessment/);
    // No amount in mL anywhere (owner rule 2026-09-27), and no fixed re-entry claim.
    expect(text).not.toMatch(/\bmL\b|re-?entry/i);
  });

  test('the close-out seeds no product for it', () => {
    const resolved = resolveCompletionDefaultProductNames({ protocols, serviceType: 'Waves Assessment', serviceKey: 'lawn_inspection' });
    expect(resolved).toMatchObject({ programKey: 'assessment', source: 'none', entries: [] });
  });

  test('the job card shows its steps with no product line', async () => {
    const out = await jobCard.resolveVisitLines({
      facts: { isLawn: false, serviceType: 'Waves Assessment', serviceCategory: 'inspection', serviceKey: 'lawn_inspection', scheduledDate: '2026-11-27', addons: [] },
      protocols, catalog: [{ id: 'tau', name: 'Taurus SC' }], dbh: () => ({}),
    });
    expect(out.lines).toEqual([]);
    expect(out.note).toBe('Assessment: steps only, no products on this card');
    expect(out.visit.visit).toBe(1);
    expect(out.procedure.name).toBe('Waves Assessment Protocol');
    expect(out.procedure.steps[0]).toMatch(/^Waves Assessment/);
    // Any other inspection keeps its no-protocol note.
    const other = await jobCard.resolveVisitLines({
      facts: { isLawn: false, serviceType: 'Pest Inspection Service', serviceCategory: 'inspection', serviceKey: 'pest_inspection', scheduledDate: '2026-11-27', addons: [] },
      protocols, catalog: [], dbh: () => ({}),
    });
    expect([other.lines, other.note, other.procedure]).toEqual([[], 'No treatment protocol for this service (inspection)', undefined]);
  });
});

describe('a pest control row no rule claims has no card on the job card either', () => {
  const lines = (serviceType, serviceCategory, serviceKey = null) => jobCard.resolveVisitLines({
    facts: { isLawn: false, serviceType, serviceCategory, serviceKey, scheduledDate: '2026-11-27', addons: [] }, protocols, catalog: [{ id: 'tau', name: 'Taurus SC' }], dbh: () => ({}),
  });

  test('the category does not hand it the general pest card', async () => {
    const out = await lines('Barrier Treatment', 'pest_control');
    expect([out.visit, out.lines, out.note]).toEqual([null, [], 'No treatment protocol for this service (pest_control)']);
  });

  test('a pest control row a rule claims keeps its card, and another category keeps its own default', async () => {
    expect((await lines('Quarterly Pest Control Service', 'pest_control', 'pest_general_quarterly')).visit?.visit).toBe(1);
    expect((await lines('Re-Service', 'pest_control', 'one_time_pest_control')).visit?.visit).toBe(1);
    // A rodent row whose name says nothing keeps the rodent program (its category), as before.
    expect((await lines('Station Service', 'rodent', 'rodent_bait_quarterly')).note).not.toBe('No treatment protocol for this service (rodent)');
  });
});

describe('a service with no card on the schedule panel and the close-out', () => {
  test('/match answers with no program and the note, not a failed read', async () => {
    const { status, body } = await call('/match', { serviceType: 'Bee / Wasp Nest Removal Service' });
    expect(status).toBe(200);
    expect(body).toEqual({ serviceType: 'Bee / Wasp Nest Removal Service', programKey: null, program: null, matchedVisit: null, matched: false, reason: 'no_protocol', note: NOTE });
  });

  test('/completion-actions answers with no action and the note', async () => {
    const { status, body } = await call('/completion-actions', { serviceType: 'Wildlife Trapping Service' });
    expect(status).toBe(200);
    expect(body).toEqual({ serviceType: 'Wildlife Trapping Service', programKey: null, programName: null, visit: null, actions: [], noProtocol: true, note: NOTE });
  });

  test('the Waves Assessment gets its card\'s steps as actions, none a treatment', async () => {
    bookedAs('lawn_inspection');
    const { status, body } = await call('/completion-actions', { serviceType: 'Waves Assessment', visitId: VISIT });
    expect(status).toBe(200);
    expect(body).toMatchObject({ programKey: 'assessment', programName: 'Waves Assessment Protocol', visit: { visit: 1 } });
    expect(body.noProtocol).toBeUndefined();
    expect(body.actions.length).toBeGreaterThan(8);
    expect(body.actions.some((action) => action.treatmentApplied || action.product)).toBe(false);
  });

  test('the close-out seeds no product for a service with no card', () => {
    expect(resolveCompletionDefaultProductNames({ protocols, serviceType: 'Bee / Wasp Nest Removal Service', serviceKey: 'bee_wasp_removal' }))
      .toMatchObject({ programKey: null, source: 'none', entries: [] });
  });
});

describe('a card line that forbids work is not a treatment', () => {
  const actionOf = (programKey, visit, raw) => buildCompletionActions({
    lines: [...parseProtocolLines(visit.primary, 'base'), ...parseProtocolLines(visit.secondary, 'conditional')], products: [], programKey, visit,
  }).find((action) => action.raw === raw);
  const visitOf = (programKey, number) => protocols[programKey].visits.find((visit) => visit.visit === number);

  test.each([
    ['flea', 2, 'Do not apply the growth regulator again at this visit'],
    ['pest', 3, 'Avoid repellent spray on active trails'],
    ['tree_shrub', 12, 'Do not treat blooming plants with bee-toxic systemic/contact products while bees forage'],
    ['tree_shrub', 8, 'No alfalfa meal or other N/P bed products during Sarasota/Manatee blackout'],
  ])('%s visit %s: "%s"', (programKey, number, raw) => {
    const action = actionOf(programKey, visitOf(programKey, number), raw);
    expect(action).toBeDefined();
    expect(action.treatmentApplied).toBe(false);
  });

  test('no card holds a forbidding line that records a treatment', () => {
    const wrong = [];
    for (const [programKey, program] of Object.entries(protocols)) {
      for (const visit of program.visits || []) {
        const lines = [...parseProtocolLines(visit.primary, 'base'), ...parseProtocolLines(visit.secondary, 'conditional')];
        for (const action of buildCompletionActions({ lines, products: [], programKey, visit })) {
          if (action.treatmentApplied && /^(do not|don't|never|no|not|avoid)\b/i.test(String(action.raw || '').trim())) wrong.push([programKey, visit.visit, action.raw]);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  test('a line that applies a product still records a treatment', () => {
    const visit = visitOf('pest', 3);
    const treated = buildCompletionActions({ lines: parseProtocolLines(visit.primary, 'base'), products: [], programKey: 'pest', visit }).filter((action) => action.treatmentApplied);
    expect(treated.length).toBeGreaterThan(0);
  });
});
