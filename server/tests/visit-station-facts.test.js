/**
 * Station exceptions read from a technician's note (GATE_STATION_FAST_COMPLETE,
 * owner 2026-10-08, services/visit-station-facts.js) and the typed-facts route
 * that carries them to the Fast Complete sheet.
 *
 *  - A station exception stands only when its number is an ACTIVE station of the
 *    visit's program, its status is activity / serviced / inaccessible, and its
 *    quote is in the note word for word and states that number.
 *  - Anything else is dropped (the tech can still tap); a failure reads as no
 *    exceptions, never an error; access codes never reach the provider.
 *  - The route loads the registry itself, reads stations only with the gate on,
 *    for a bait station visit with no companion form, and answers exactly as
 *    before otherwise.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

let mockDbCurrent = null;
jest.mock('../models/db', () => {
  const defaultChain = () => {
    const chain = {};
    const methods = [
      'where', 'whereIn', 'whereNot', 'whereNull', 'whereNotNull', 'whereRaw', 'andWhere',
      'orWhere', 'join', 'leftJoin', 'select', 'orderBy', 'groupBy', 'limit',
      'offset', 'update', 'insert', 'del', 'onConflict', 'merge', 'ignore',
    ];
    for (const m of methods) chain[m] = () => chain;
    chain.first = async () => null;
    chain.returning = async () => [];
    chain.count = async () => [{ count: 0 }];
    chain.columnInfo = async () => ({});
    chain.then = (resolve) => Promise.resolve([]).then(resolve);
    chain.catch = () => chain;
    return chain;
  };
  const proxy = (...args) => (mockDbCurrent ? mockDbCurrent(...args) : defaultChain());
  proxy.transaction = () => Promise.resolve();
  proxy.raw = (sql) => ({ toString: () => sql });
  proxy.fn = { now: () => new Date() };
  proxy.schema = { hasTable: async () => true, hasColumn: async () => true };
  return proxy;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/job-costing', () => ({
  calculateJobCost: jest.fn(async () => ({})),
  resolveServiceRecord: jest.requireActual('../services/job-costing').resolveServiceRecord,
}));
jest.mock('../services/time-tracking', () => ({ adminEditEntry: jest.fn(async () => ({})) }));
jest.mock('../services/llm/call', () => ({
  ...jest.requireActual('../services/llm/call'),
  dispatchWithFallback: jest.fn(),
}));
let mockProfile = null;
jest.mock('../services/service-completion-profiles', () => ({
  ...jest.requireActual('../services/service-completion-profiles'),
  resolveCompletionProfileForScheduledService: async () => mockProfile,
}));
const { dispatchWithFallback } = require('../services/llm/call');
const {
  readStationExceptions, verifyStationExceptions, stationChecksWriterLines, stationReadVerdict, namableStations, stationFactsSchema, STATION_SHEET_PROGRAMS, EXCEPTION_STATUSES,
} = require('../services/visit-station-facts');
const router = require('../routes/admin-dispatch');

const answer = (json) => ({ ok: true, json });
// A termite_stations row as the registry holds it.
const row = (number, extra = {}) => ({ id: `st-${number}`, station_number: number, program: 'termite', is_active: true, ...extra });
const ROSTER = [row(1), row(2), row(3), row(4), row(7)];
const NOTE = 'Station 4 had activity, I replaced the bait in 7. Everything else looked fine.';
const item = (number, status, quote) => ({ number, status, quote });

beforeEach(() => {
  dispatchWithFallback.mockReset();
  mockDbCurrent = null;
  mockProfile = null;
});

describe('which forms the sheet reads stations for', () => {
  test('termite and rodent bait stations only: a trap check keeps the full form', () => {
    expect(STATION_SHEET_PROGRAMS).toEqual({ termite_bait_station: 'termite', rodent_bait_station: 'rodent' });
    expect(STATION_SHEET_PROGRAMS).not.toHaveProperty('rodent_trapping');
    expect(EXCEPTION_STATUSES).toEqual(['activity', 'serviced', 'inaccessible']);
  });

  test('the model schema carries no numeric bounds (Anthropic structured output rejects them)', () => {
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      expect(node).not.toHaveProperty('minimum');
      expect(node).not.toHaveProperty('maximum');
      expect(node).not.toHaveProperty('minItems');
      expect(node).not.toHaveProperty('maxItems');
      Object.values(node).forEach(walk);
    };
    walk(stationFactsSchema());
  });
});

describe('verifyStationExceptions: the code verifies what the model heard, and fails closed', () => {
  const run = (exceptions, note = NOTE, stations = ROSTER, opts = { program: 'termite' }) => verifyStationExceptions({ exceptions }, note, stations, opts);
  // The exceptions that stood; and the count of those that did not.
  const kept = (...args) => run(...args).exceptions;
  const dropped = (...args) => run(...args).unresolved;
  // Nothing stood and something was dropped: the read is not clean.
  const unresolvedOnly = (...args) => {
    const result = run(...args);
    expect(result.exceptions).toEqual([]);
    expect(result.unresolved).toBeGreaterThan(0);
  };

  test('keeps an exception whose station is active in the program, whose status is one of the three and whose words are in the note and state the number', () => {
    const result = run([
      item(4, 'activity', 'station 4 had activity'),
      item(7, 'serviced', 'I replaced the bait in 7'),
    ]);
    expect(result.exceptions).toEqual([
      { id: 'st-4', number: 4, status: 'activity', quote: 'station 4 had activity' },
      { id: 'st-7', number: 7, status: 'serviced', quote: 'i replaced the bait in 7' },
    ]);
    expect(result.unresolved).toBe(0);
  });

  test('an answer with no exceptions is clean: nothing was named, nothing is unresolved', () => {
    expect(run([])).toEqual({ exceptions: [], unresolved: 0 });
  });

  test('a station number the property does not have is unresolved (a wrong number)', () => {
    unresolvedOnly([item(5, 'activity', 'station 5 had activity')], 'Station 5 had activity.');
    unresolvedOnly([item(40, 'activity', 'station 4 had activity')]);
  });

  test('a retired station is unresolved; the verified one beside it still stands', () => {
    const stations = [row(1), row(4, { is_active: false }), row(7)];
    const result = run([item(4, 'activity', 'station 4 had activity'), item(7, 'serviced', 'I replaced the bait in 7')], NOTE, stations);
    expect(result.exceptions.map((e) => e.number)).toEqual([7]);
    expect(result.unresolved).toBe(1);
  });

  test('another program\'s station is unresolved, and a registry of mixed programs names nothing without a program', () => {
    const stations = [row(1), row(4, { program: 'rodent' }), row(7)];
    unresolvedOnly([item(4, 'activity', 'station 4 had activity')], NOTE, stations);
    expect(dropped([item(4, 'activity', 'station 4 had activity')], NOTE, stations, { program: 'rodent' })).toBe(0);
    unresolvedOnly([item(7, 'serviced', 'I replaced the bait in 7')], NOTE, stations, {});
  });

  test('a quote that is not in the note is unresolved, whatever the model made of it', () => {
    unresolvedOnly([item(4, 'activity', 'station 4 was chewed through')]);
    unresolvedOnly([item(4, 'activity', 'the termites are all over station 4')]);
  });

  test('a quote that does not state the number is unresolved: a number the note does not state is never guessed', () => {
    unresolvedOnly([item(7, 'activity', 'station 4 had activity')]);
    unresolvedOnly([item(4, 'activity', 'had activity')], 'Station 4 had activity.');
    unresolvedOnly([item(4, 'activity', '4')], 'Station 4 had activity.');
  });

  test('a number said in words stands, and a decimal or ordinal states no station', () => {
    expect(kept([item(7, 'serviced', 'replaced the bait in station seven')], 'Replaced the bait in station seven.')).toHaveLength(1);
    unresolvedOnly([item(4, 'activity', 'the 4th one had activity')], 'The 4th one had activity.');
    unresolvedOnly([item(4, 'activity', 'about 4.5 ounces')], 'Used about 4.5 ounces.');
  });

  // The class of bug behind "Stations 2,3 were inaccessible": a quote that names
  // several stations states each of them.
  test.each([
    ['comma-separated digits', 'Stations 2,3 were inaccessible'],
    ['a list with a space', 'Stations 2, 3 were inaccessible'],
    ['a list with and', 'Stations 2 and 3 were inaccessible'],
    ['a slash', 'Stations 2/3 were inaccessible'],
    ['an ampersand', 'Stations 2 & 3 were inaccessible'],
    ['a range', 'Stations 2-3 were inaccessible'],
    ['a range in words', 'Stations 2 through 3 were inaccessible'],
    ['spoken numbers in a list', 'Stations two, three were inaccessible'],
    ['spoken numbers joined by and', 'Stations two and three were inaccessible'],
  ])('a quote that lists stations states each of them: %s', (_label, quote) => {
    const result = run([item(2, 'inaccessible', quote), item(3, 'inaccessible', quote)], quote);
    expect(result.unresolved).toBe(0);
    expect(result.exceptions.map((e) => [e.number, e.status])).toEqual([[2, 'inaccessible'], [3, 'inaccessible']]);
  });

  test('a list names the stations it lists and no others; a range names the ones between', () => {
    unresolvedOnly([item(4, 'inaccessible', 'Stations 2,3 were inaccessible')], 'Stations 2,3 were inaccessible');
    expect(kept([item(3, 'inaccessible', 'stations 2-4 were inaccessible')], 'Stations 2-4 were inaccessible')).toHaveLength(1);
    expect(dropped([item(7, 'inaccessible', 'stations 2-4 were inaccessible')], 'Stations 2-4 were inaccessible')).toBe(1);
  });

  test('a status that is not one of the three is unresolved: ok is the default and never an exception', () => {
    unresolvedOnly([item(4, 'ok', 'station 4 had activity')]);
    unresolvedOnly([item(4, 'broken', 'station 4 had activity')]);
    unresolvedOnly([item(4, undefined, 'station 4 had activity')]);
  });

  test('a station given two different statuses is unresolved, with every entry for it counted; two of the same is one', () => {
    const note = 'Station 4 had activity and I could not get to station 4.';
    const result = run([item(4, 'activity', 'station 4 had activity'), item(4, 'inaccessible', 'get to station 4'), item(7, 'serviced', 'I replaced the bait in 7')], `${note} I replaced the bait in 7.`);
    expect(result.exceptions.map((e) => e.number)).toEqual([7]);
    expect(result.unresolved).toBe(2);
    expect(run([item(4, 'activity', 'station 4 had activity'), item(4, 'activity', 'station 4 had activity')], note)).toMatchObject({ unresolved: 0 });
    expect(kept([item(4, 'activity', 'station 4 had activity'), item(4, 'activity', 'station 4 had activity')], note)).toHaveLength(1);
  });

  test('a number held by two active stations names none, and says so', () => {
    unresolvedOnly([item(4, 'activity', 'station 4 had activity')], NOTE, [row(4), { ...row(4), id: 'dup' }]);
    expect(namableStations([row(4), { ...row(4), id: 'dup' }, row(5)], 'termite').map((s) => s.number)).toEqual([5]);
  });

  test('junk in the answer is unresolved, never an error and never clean', () => {
    for (const json of [null, {}, { exceptions: 'x' }]) {
      expect(verifyStationExceptions(json, NOTE, ROSTER, { program: 'termite' })).toEqual({ exceptions: [], unresolved: 1 });
    }
    expect(verifyStationExceptions({ exceptions: [null, 4, {}] }, NOTE, ROSTER, { program: 'termite' })).toEqual({ exceptions: [], unresolved: 3 });
    unresolvedOnly([item('4', 'activity', 'station 4 had activity')]);
    unresolvedOnly([item(4.5, 'activity', 'station 4 had activity')]);
  });
});

describe('readStationExceptions', () => {
  test('a clean read: every exception the model returned verified', async () => {
    dispatchWithFallback.mockResolvedValue(answer({ exceptions: [
      item(4, 'activity', 'Station 4 had activity'),
      item(7, 'serviced', 'I replaced the bait in 7'),
    ] }));
    const result = await readStationExceptions({ note: NOTE, stations: ROSTER, program: 'termite' });
    expect(result).toMatchObject({ status: 'read', unresolved: 0 });
    expect(result.exceptions.map((e) => [e.number, e.status])).toEqual([[4, 'activity'], [7, 'serviced']]);
    const call = dispatchWithFallback.mock.calls[0][1];
    expect(call.laneId).toBe('visit_typed_facts');
    expect(call.system).toContain('1, 2, 3, 4, 7');
    expect(call.system).toContain('termite');
  });

  test('an exception that could not be grounded makes the read unresolved, with the verified ones beside it', async () => {
    dispatchWithFallback.mockResolvedValue(answer({ exceptions: [
      item(4, 'activity', 'Station 4 had activity'),
      item(9, 'activity', 'station 9 was chewed'),
    ] }));
    const result = await readStationExceptions({ note: NOTE, stations: ROSTER, program: 'termite' });
    expect(result).toMatchObject({ status: 'unresolved', unresolved: 1 });
    expect(result.exceptions.map((e) => e.number)).toEqual([4]);
  });

  test('"Stations 2,3 were inaccessible" is a clean read naming both', async () => {
    dispatchWithFallback.mockResolvedValue(answer({ exceptions: [
      item(2, 'inaccessible', 'Stations 2,3 were inaccessible'),
      item(3, 'inaccessible', 'Stations 2,3 were inaccessible'),
    ] }));
    const result = await readStationExceptions({ note: 'Stations 2,3 were inaccessible. The rest looked fine.', stations: ROSTER, program: 'termite' });
    expect(result).toMatchObject({ status: 'read', unresolved: 0 });
    expect(result.exceptions.map((e) => e.number)).toEqual([2, 3]);
  });

  test('a model that returned none is a clean read of none; a malformed answer is a failed read', async () => {
    dispatchWithFallback.mockResolvedValue(answer({ exceptions: [] }));
    expect(await readStationExceptions({ note: NOTE, stations: ROSTER, program: 'termite' })).toMatchObject({ status: 'read', exceptions: [], unresolved: 0 });
    dispatchWithFallback.mockResolvedValue(answer({ exceptions: 'station 4' }));
    expect(await readStationExceptions({ note: NOTE, stations: ROSTER, program: 'termite' })).toMatchObject({ status: 'failed', exceptions: [] });
    dispatchWithFallback.mockResolvedValue(answer(undefined));
    expect(await readStationExceptions({ note: NOTE, stations: ROSTER, program: 'termite' })).toMatchObject({ status: 'failed', exceptions: [] });
  });

  test('the rodent program reads consumption, not infestation', async () => {
    dispatchWithFallback.mockResolvedValue(answer({ exceptions: [] }));
    await readStationExceptions({ note: NOTE, stations: [row(4, { program: 'rodent' })], program: 'rodent' });
    expect(dispatchWithFallback.mock.calls[0][1].system).toContain('bait consumption');
  });

  test('a trap check is never read; no stations, no note or a long note makes no model call', async () => {
    expect(await readStationExceptions({ note: NOTE, stations: [row(4, { program: 'trapping' })], program: 'trapping' })).toMatchObject({ status: 'no_program', exceptions: [] });
    expect(await readStationExceptions({ note: NOTE, stations: [], program: 'termite' })).toMatchObject({ status: 'no_stations' });
    expect(await readStationExceptions({ note: NOTE, stations: [row(4, { is_active: false })], program: 'termite' })).toMatchObject({ status: 'no_stations' });
    expect(await readStationExceptions({ note: '   ', stations: ROSTER, program: 'termite' })).toMatchObject({ status: 'empty_note' });
    expect(await readStationExceptions({ note: 'x'.repeat(9000), stations: ROSTER, program: 'termite' })).toMatchObject({ status: 'too_long' });
    expect(dispatchWithFallback).not.toHaveBeenCalled();
  });

  test('access codes never reach the provider', async () => {
    dispatchWithFallback.mockResolvedValue(answer({ exceptions: [] }));
    await readStationExceptions({ note: 'Gate code is 4471. Station 4 had activity.', stations: ROSTER, program: 'termite' });
    const sent = dispatchWithFallback.mock.calls[0][1].text;
    expect(sent).not.toContain('4471');
    expect(sent).toContain('Station 4 had activity.');
  });

  test('a failed or throwing call is no exceptions, never an error', async () => {
    dispatchWithFallback.mockResolvedValue({ ok: false });
    expect(await readStationExceptions({ note: NOTE, stations: ROSTER, program: 'termite' })).toMatchObject({ status: 'failed', exceptions: [] });
    dispatchWithFallback.mockRejectedValue(new Error('provider down'));
    expect(await readStationExceptions({ note: NOTE, stations: ROSTER, program: 'termite' })).toMatchObject({ status: 'failed', exceptions: [] });
  });
});

function invoke(params, body, actor = { techRole: 'admin', technicianId: 'admin-1' }) {
  const layer = router.stack.find((l) => l.route && l.route.path === '/:serviceId/typed-facts' && l.route.methods.post);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return new Promise((resolve, reject) => {
    handler({ params, body, ...actor }, res, (err) => (err ? reject(err) : resolve(res)))
      .then(() => resolve(res))
      .catch(reject);
  });
}

const TODAY = new Date().toISOString().slice(0, 10);
const SERVICE = { id: 'svc-1', customer_id: 'cust-1', technician_id: 'tech-1', status: 'confirmed', scheduled_date: TODAY, service_type: 'Termite Monitoring' };
// A database that answers the visit and the customer's station rows.
function stationDb(service, stations, calls = []) {
  return (table) => {
    const chain = {};
    chain.where = (clause) => { calls.push({ table, clause }); return chain; };
    chain.select = async () => stations;
    chain.first = async () => (table === 'scheduled_services' ? service : null);
    return chain;
  };
}
const TYPED_FIELDS = { fields: { stations_checked: { said: false, value: 0, quote: '' }, termite_activity: { value: 'not_said', quote: '' }, bait_consumption: { value: 'not_said', quote: '' } } };
// The reader answers the typed fields call first and the station call second, or by lane prompt.
function modelAnswers(stationJson) {
  dispatchWithFallback.mockImplementation(async (_policy, request) => (
    String(request.system).includes('station number') ? answer(stationJson) : answer(TYPED_FIELDS)
  ));
}
const SHEET_STATIONS = ROSTER.map((s) => ({ id: s.id, number: s.station_number }));

describe('POST /:serviceId/typed-facts with the sheet\'s stations', () => {
  const saved = { typed: process.env.GATE_TYPED_VOICE_FILL, station: process.env.GATE_STATION_FAST_COMPLETE };
  const restore = (name, value) => { if (value === undefined) delete process.env[name]; else process.env[name] = value; };
  afterEach(() => { restore('GATE_TYPED_VOICE_FILL', saved.typed); restore('GATE_STATION_FAST_COMPLETE', saved.station); });
  beforeEach(() => {
    process.env.GATE_TYPED_VOICE_FILL = 'true';
    process.env.GATE_STATION_FAST_COMPLETE = 'true';
    mockProfile = { serviceKey: 'termite_monitoring', findingsType: 'termite_bait_station' };
  });

  test('answers the verified exceptions beside the fields, from the registry the server loads', async () => {
    const calls = [];
    mockDbCurrent = stationDb(SERVICE, ROSTER, calls);
    modelAnswers({ exceptions: [item(4, 'activity', 'station 4 had activity'), item(7, 'serviced', 'I replaced the bait in 7')] });
    const res = await invoke({ serviceId: 'svc-1' }, { note: NOTE, stations: SHEET_STATIONS });
    expect(res.body).toMatchObject({ available: true, status: 'read', stationRead: 'read' });
    expect(res.body.stationExceptions.map((e) => [e.id, e.status])).toEqual([['st-4', 'activity'], ['st-7', 'serviced']]);
    // The registry was read for THIS customer's active stations.
    expect(calls).toContainEqual({ table: 'termite_stations', clause: { customer_id: 'cust-1', is_active: true } });
  });

  test('something the model returned that did not verify is a failed read, "unresolved", with the verified exceptions beside it', async () => {
    mockDbCurrent = stationDb(SERVICE, ROSTER);
    modelAnswers({ exceptions: [item(4, 'activity', 'station 4 had activity'), item(9, 'activity', 'station 9')] });
    const res = await invoke({ serviceId: 'svc-1' }, { note: NOTE, stations: SHEET_STATIONS });
    expect(res.body).toMatchObject({ stationRead: 'failed', stationReadDetail: 'unresolved' });
    expect(res.body.stationExceptions.map((e) => e.number)).toEqual([4]);
  });

  // The roster the sheet shows must be the registry's active stations of the
  // visit's program; otherwise the sheet would assert and count stations that
  // are not the property's, and no read is answered (the sheet loads again).
  describe('a roster that went stale', () => {
    const says = async (stations = SHEET_STATIONS) => (await invoke({ serviceId: 'svc-1' }, { note: NOTE, stations })).body;
    const staleBody = (body) => {
      expect(body).toMatchObject({ available: true, stationRead: 'failed', stationReadDetail: 'roster_changed', stationExceptions: [] });
    };

    test('a station shown on the sheet was retired since (the registry no longer holds it)', async () => {
      mockDbCurrent = stationDb(SERVICE, ROSTER.filter((s) => s.id !== 'st-7'));
      modelAnswers({ exceptions: [item(4, 'activity', 'station 4 had activity')] });
      staleBody(await says());
    });

    test('a station was added since the sheet loaded (the registry holds one the sheet did not show)', async () => {
      mockDbCurrent = stationDb(SERVICE, [...ROSTER, row(9)]);
      modelAnswers({ exceptions: [item(4, 'activity', 'station 4 had activity')] });
      staleBody(await says());
    });

    test('a station the client names that is not the property\'s at all', async () => {
      mockDbCurrent = stationDb(SERVICE, ROSTER);
      modelAnswers({ exceptions: [] });
      staleBody(await says([...SHEET_STATIONS, { id: 'ghost', number: 8 }]));
    });

    test('another program\'s station in the registry is not part of the roster', async () => {
      mockDbCurrent = stationDb(SERVICE, [...ROSTER, row(9, { program: 'rodent' })]);
      modelAnswers({ exceptions: [item(4, 'activity', 'station 4 had activity')] });
      expect(await says()).toMatchObject({ stationRead: 'read' });
    });

    test('the same roster is read, and the model is not asked about a stale one', async () => {
      mockDbCurrent = stationDb(SERVICE, [...ROSTER, row(9)]);
      modelAnswers({ exceptions: [] });
      await says();
      expect(dispatchWithFallback.mock.calls.some(([, request]) => String(request.system).includes('station number'))).toBe(false);
    });
  });

  test('gate off, no stations carried, a combined visit or any other form: the answer is exactly as before', async () => {
    mockDbCurrent = stationDb(SERVICE, ROSTER);
    modelAnswers({ exceptions: [item(4, 'activity', 'station 4 had activity')] });
    process.env.GATE_STATION_FAST_COMPLETE = 'false';
    let res = await invoke({ serviceId: 'svc-1' }, { note: NOTE, stations: SHEET_STATIONS });
    expect(res.body).not.toHaveProperty('stationExceptions');
    expect(res.body).not.toHaveProperty('stationRead');
    process.env.GATE_STATION_FAST_COMPLETE = 'true';
    res = await invoke({ serviceId: 'svc-1' }, { note: NOTE });
    expect(res.body).not.toHaveProperty('stationExceptions');
    res = await invoke({ serviceId: 'svc-1' }, { note: NOTE, stations: [] });
    expect(res.body).not.toHaveProperty('stationExceptions');
    mockProfile = { serviceKey: 'termite_monitoring', findingsType: 'termite_bait_station', companions: [{ type: 'rodent_bait_station' }] };
    res = await invoke({ serviceId: 'svc-1' }, { note: NOTE, stations: SHEET_STATIONS });
    expect(res.body).not.toHaveProperty('stationExceptions');
    // A trap check keeps the full form: no station read.
    mockProfile = { serviceKey: 'rodent_trapping', findingsType: 'rodent_trapping' };
    res = await invoke({ serviceId: 'svc-1' }, { note: NOTE, stations: SHEET_STATIONS });
    expect(res.body).not.toHaveProperty('stationExceptions');
    expect(dispatchWithFallback.mock.calls.some(([, request]) => String(request.system).includes('station number'))).toBe(false);
  });

  test('a registry that cannot be read is a failed station read, not an error', async () => {
    mockDbCurrent = (table) => {
      const chain = {};
      chain.where = () => chain;
      chain.select = async () => { throw new Error('db down'); };
      chain.first = async () => (table === 'scheduled_services' ? SERVICE : null);
      return chain;
    };
    modelAnswers({ exceptions: [] });
    const res = await invoke({ serviceId: 'svc-1' }, { note: NOTE, stations: SHEET_STATIONS });
    expect(res.body).toMatchObject({ available: true, stationRead: 'failed', stationExceptions: [] });
  });

  // Never an empty list the sheet could take for "all stations OK": every way
  // the read does not succeed says so, explicitly.
  describe('a station read that did not succeed says so', () => {
    const says = async (note = NOTE) => (await invoke({ serviceId: 'svc-1' }, { note, stations: SHEET_STATIONS })).body;
    const failedBody = (body) => {
      expect(body).toMatchObject({ available: true, stationRead: 'failed', stationExceptions: [] });
    };

    test('the model call fails, times out or throws', async () => {
      mockDbCurrent = stationDb(SERVICE, ROSTER);
      dispatchWithFallback.mockImplementation(async (_policy, request) => (
        String(request.system).includes('station number') ? { ok: false } : answer(TYPED_FIELDS)
      ));
      failedBody(await says());
      dispatchWithFallback.mockImplementation(async (_policy, request) => {
        if (String(request.system).includes('station number')) throw new Error('timeout');
        return answer(TYPED_FIELDS);
      });
      failedBody(await says());
    });

    test('the registry query fails, or comes to no station the sheet showed', async () => {
      mockDbCurrent = (table) => {
        const chain = {};
        chain.where = () => chain;
        chain.select = async () => { throw new Error('db down'); };
        chain.first = async () => (table === 'scheduled_services' ? SERVICE : null);
        return chain;
      };
      modelAnswers({ exceptions: [item(4, 'activity', 'station 4 had activity')] });
      const body = await says();
      failedBody(body);
      expect(body.stationReadDetail).toBe('failed');
      mockDbCurrent = stationDb(SERVICE, []);
      failedBody(await says());
    });

    test('the reader itself throws, or the note is too long to read', async () => {
      mockDbCurrent = stationDb(SERVICE, ROSTER);
      modelAnswers({ exceptions: [] });
      const spy = jest.spyOn(require('../services/visit-station-facts'), 'readStationExceptions').mockRejectedValue(new Error('boom'));
      try {
        const body = await says();
        failedBody(body);
        expect(body.stationReadDetail).toBe('error');
      } finally { spy.mockRestore(); }
      failedBody(await says('x'.repeat(9000)));
    });

    test('a read that succeeded says read, with or without exceptions; an empty note has nothing to read', async () => {
      mockDbCurrent = stationDb(SERVICE, ROSTER);
      modelAnswers({ exceptions: [] });
      expect(await says()).toMatchObject({ stationRead: 'read', stationExceptions: [] });
      expect((await says('   ')).stationRead).toBe('read');
    });

    test('the verdict is read only for a read or an empty note', () => {
      expect(['read', 'empty_note'].map(stationReadVerdict)).toEqual(['read', 'read']);
      for (const status of ['failed', 'no_stations', 'no_program', 'too_long', 'error', undefined, null, '']) {
        expect(stationReadVerdict(status)).toBe('failed');
      }
    });
  });

  // The two reads run side by side and each answers with its own verdict: the
  // four combinations serialize distinctly (Codex P2 on #6205).
  describe('the typed read and the station read are independent in the answer', () => {
    const typedOk = { fields: { stations_checked: { said: true, value: 4, quote: 'checked 4 stations' }, termite_activity: { value: 'not_said', quote: '' }, bait_consumption: { value: 'not_said', quote: '' } } };
    const note = 'Checked 4 stations. Station 4 had activity.';
    const answerWith = (typed, stations) => dispatchWithFallback.mockImplementation(async (_policy, request) => {
      const isStation = String(request.system).includes('station number');
      const verdict = isStation ? stations : typed;
      if (verdict === 'throws') throw new Error('provider down');
      return verdict === 'fails' ? { ok: false } : answer(isStation ? { exceptions: [item(4, 'activity', 'station 4 had activity')] } : typedOk);
    });
    const call = async (typed, stations) => {
      mockDbCurrent = stationDb(SERVICE, ROSTER);
      answerWith(typed, stations);
      return (await invoke({ serviceId: 'svc-1' }, { note, stations: SHEET_STATIONS })).body;
    };

    test('typed ok + stations read', async () => {
      const body = await call('ok', 'ok');
      expect(body).toMatchObject({ status: 'read', stationRead: 'read' });
      expect(body.stationExceptions.map((e) => e.number)).toEqual([4]);
      expect(body.values).toMatchObject({ stations_checked: '4' });
    });

    test('typed failed + stations read: the stations keep their verdict and exceptions', async () => {
      for (const typed of ['fails', 'throws']) {
        const body = await call(typed, 'ok');
        expect(body).toMatchObject({ available: true, status: 'failed', stationRead: 'read' });
        expect(body.values).toEqual({});
        expect(body.stationExceptions.map((e) => e.number)).toEqual([4]);
      }
    });

    test('typed ok + stations failed: the form fields stand, the stations say failed with no exceptions', async () => {
      const body = await call('ok', 'fails');
      expect(body).toMatchObject({ status: 'read', stationRead: 'failed', stationExceptions: [] });
      expect(body.values).toMatchObject({ stations_checked: '4' });
    });

    test('both failed: both say so, nothing is filled or named', async () => {
      const body = await call('fails', 'fails');
      expect(body).toMatchObject({ available: true, status: 'failed', stationRead: 'failed', stationExceptions: [], values: {} });
    });

    test('stations unresolved: the verdict is failed with its own detail, whatever the form read said, and the verified ones ride along', async () => {
      const unresolved = { exceptions: [item(4, 'activity', 'station 4 had activity'), item(9, 'activity', 'station 9')] };
      for (const typed of ['ok', 'fails']) {
        mockDbCurrent = stationDb(SERVICE, ROSTER);
        dispatchWithFallback.mockImplementation(async (_policy, request) => {
          if (String(request.system).includes('station number')) return answer(unresolved);
          return typed === 'ok' ? answer(typedOk) : { ok: false };
        });
        const body = (await invoke({ serviceId: 'svc-1' }, { note, stations: SHEET_STATIONS })).body;
        expect(body).toMatchObject({ stationRead: 'failed', stationReadDetail: 'unresolved', status: typed === 'ok' ? 'read' : 'failed' });
        expect(body.stationExceptions.map((e) => e.number)).toEqual([4]);
      }
    });

    test('a typed reader that itself throws is a failed typed read, not a failed route', async () => {
      mockDbCurrent = stationDb(SERVICE, ROSTER);
      answerWith('ok', 'ok');
      const spy = jest.spyOn(require('../services/visit-typed-facts'), 'readTypedFacts').mockRejectedValue(new Error('boom'));
      try {
        const res = await invoke({ serviceId: 'svc-1' }, { note, stations: SHEET_STATIONS });
        expect(res.statusCode).toBe(200);
        expect(res.body).toMatchObject({ available: true, status: 'failed', stationRead: 'read' });
      } finally { spy.mockRestore(); }
    });

    test('the four answers are four different answers', async () => {
      const answers = [await call('ok', 'ok'), await call('fails', 'ok'), await call('ok', 'fails'), await call('fails', 'fails')];
      const keys = answers.map((body) => `${body.status}/${body.stationRead}/${body.stationExceptions.length}`);
      expect(new Set(keys).size).toBe(4);
    });
  });

  test('a technician reads only their own current visit, stations or not', async () => {
    mockDbCurrent = stationDb(SERVICE, ROSTER);
    const res = await invoke({ serviceId: 'svc-1' }, { note: NOTE, stations: SHEET_STATIONS }, { techRole: 'technician', technicianId: 'tech-2' });
    expect(res.statusCode).toBe(403);
    expect(dispatchWithFallback).not.toHaveBeenCalled();
  });
});

describe('stationChecksWriterLines: the tech\'s statuses for the report writer', () => {
  const saved = process.env.GATE_STATION_FAST_COMPLETE;
  beforeEach(() => { process.env.GATE_STATION_FAST_COMPLETE = 'true'; });
  afterEach(() => { if (saved === undefined) delete process.env.GATE_STATION_FAST_COMPLETE; else process.env.GATE_STATION_FAST_COMPLETE = saved; });
  const lines = (type, checks) => stationChecksWriterLines({ type }, checks);

  test('a serviced station is work done; activity and no access are observed; both carry the authority', () => {
    const { completed, observed } = lines('termite_bait_station', [{ number: 7, status: 'serviced' }, { number: 4, status: 'activity' }]);
    expect(completed).toMatch(/^\nTechnician station checks, work done \(authoritative: they override anything the note says about a station\): station 7: the technician serviced the station/);
    expect(completed).not.toContain('station 4');
    expect(observed).toMatch(/^\nTechnician station checks, observed \(authoritative: they override anything the note says about a station\): station 4: termite activity.*Every other station was checked and is OK\.$/);
    expect(observed).not.toContain('station 7');
    expect(lines('rodent_bait_station', [{ number: 2, status: 'activity' }]).observed).toContain('bait consumption');
    expect(lines('rodent_bait_station', [{ number: 2, status: 'inaccessible' }]).observed).toContain('could not be reached or checked');
  });

  test('the OK remainder is every station that is no exception of any kind, serviced included', () => {
    // Serviced only: station 3 is work done, and the rest are OK, never "every station".
    const serviced = lines('rodent_bait_station', [{ number: 3, status: 'serviced' }]);
    expect(serviced.completed).toContain('station 3: the technician serviced the station');
    expect(serviced.observed).toMatch(/: Every other station was checked and is OK\.$/);
    expect(serviced.observed).not.toMatch(/every station was checked/);
    // Serviced + activity: the remainder follows the observed exception, once.
    const both = lines('rodent_bait_station', [{ number: 3, status: 'serviced' }, { number: 2, status: 'activity' }]);
    expect(both.observed).toMatch(/station 2: bait consumption.*\. Every other station was checked and is OK\.$/);
    expect(both.observed).not.toContain('station 3');
    // None: every station.
    expect(lines('rodent_bait_station', []).observed).toMatch(/: every station was checked and is OK\.$/);
  });

  test('an empty list is an observation that every station is OK, with no work done', () => {
    const result = lines('rodent_bait_station', []);
    expect(result.completed).toBe('');
    expect(result.observed).toContain('every station was checked and is OK');
  });

  test('adds nothing with the gate off, for a trap check or another form, or for anything that is not a clean list', () => {
    const none = { completed: '', observed: '' };
    expect(lines('rodent_trapping', [{ number: 2, status: 'activity' }])).toEqual(none);
    expect(lines('cockroach', [])).toEqual(none);
    expect(stationChecksWriterLines(undefined, [])).toEqual(none);
    expect(lines('rodent_bait_station', undefined)).toEqual(none);
    expect(lines('rodent_bait_station', [{ number: 2, status: 'ok' }])).toEqual(none);
    expect(lines('rodent_bait_station', [{ number: '2', status: 'activity' }])).toEqual(none);
    expect(lines('rodent_bait_station', [{ number: 2, status: 'activity' }, { number: 2, status: 'activity' }])).toEqual(none);
    process.env.GATE_STATION_FAST_COMPLETE = 'false';
    expect(lines('rodent_bait_station', [])).toEqual(none);
  });
});

describe('stationSheetProgramFor and stationFastCompleteEnabled', () => {
  const GATES = ['GATE_STATION_FAST_COMPLETE', 'GATE_FAST_COMPLETE_REPORT', 'GATE_TYPED_VOICE_FILL'];
  const saved = Object.fromEntries(GATES.map((name) => [name, process.env[name]]));
  afterEach(() => { for (const name of GATES) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; } });
  const { stationSheetProgramFor, stationFastCompleteEnabled } = require('../services/visit-station-facts');

  test('the two bait station forms with no companion form; never a trap check, a combined visit or another form', () => {
    expect(stationSheetProgramFor({ findingsType: 'termite_bait_station' })).toBe('termite');
    expect(stationSheetProgramFor({ findingsType: 'rodent_bait_station', companions: [] })).toBe('rodent');
    expect(stationSheetProgramFor({ findingsType: 'rodent_trapping' })).toBeNull();
    expect(stationSheetProgramFor({ findingsType: 'termite_bait_station', companions: [{ type: 'rodent_bait_station' }] })).toBeNull();
    expect(stationSheetProgramFor({ findingsType: 'cockroach' })).toBeNull();
    expect(stationSheetProgramFor(null)).toBeNull();
  });

  test('the row flag needs all three gates exactly "true" and such a visit', () => {
    for (const name of GATES) process.env[name] = 'true';
    expect(stationFastCompleteEnabled({ findingsType: 'termite_bait_station' })).toBe(true);
    expect(stationFastCompleteEnabled({ findingsType: 'rodent_trapping' })).toBe(false);
    for (const name of GATES) {
      process.env[name] = 'false';
      expect(stationFastCompleteEnabled({ findingsType: 'termite_bait_station' })).toBe(false);
      process.env[name] = 'true';
    }
  });
});

describe('the roster rule, one copy', () => {
  const { stationRosterMatches, assertStationRosterUnderLock } = require('../services/visit-station-facts');

  test('the sheet\'s ids must be exactly the registry\'s active ids', () => {
    expect(stationRosterMatches(['a', 'b'], ['b', 'a'])).toBe(true);
    expect(stationRosterMatches(['a', 'b'], ['a'])).toBe(false);
    expect(stationRosterMatches(['a'], ['a', 'b'])).toBe(false);
    expect(stationRosterMatches(['a', 'b'], ['a', 'c'])).toBe(false);
    expect(stationRosterMatches([], undefined)).toBe(true);
    expect(stationRosterMatches([1, 2], ['1', '2'])).toBe(true);
  });

  const trxWith = (rows) => ({ transaction: async (fn) => fn(() => ({ where: () => ({ select: async () => rows }) })) });
  const profile = { findingsType: 'termite_bait_station' };
  const run = (rows, seen, p = profile) => assertStationRosterUnderLock(trxWith(rows), { customerId: 'c1', profile: p, stationRosterSeen: seen });

  test('the completion checks it under the lock, only for a completion that sent the marker', async () => {
    await expect(run([{ id: 'a', program: 'termite' }], undefined)).resolves.toBeUndefined();
    await expect(run([{ id: 'a', program: 'termite' }, { id: 'r', program: 'rodent' }], ['a'])).resolves.toBeUndefined();
    for (const [rows, seen] of [[[{ id: 'a', program: 'termite' }], ['a', 'b']], [[{ id: 'a', program: 'termite' }, { id: 'b', program: 'termite' }], ['a']]]) {
      await expect(run(rows, seen)).rejects.toMatchObject({ code: 'station_roster_changed' });
    }
  });

  test('a marker that cannot be judged fails closed: not a list, or not a station sheet visit', async () => {
    await expect(run([], 'a')).rejects.toMatchObject({ code: 'station_roster_changed' });
    await expect(run([{ id: 'a', program: 'termite' }], ['a'], { findingsType: 'rodent_trapping' })).rejects.toMatchObject({ code: 'station_roster_changed' });
  });
});
