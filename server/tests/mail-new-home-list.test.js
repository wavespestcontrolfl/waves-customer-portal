/**
 * The new-home mail list job (services/mail/new-home-list.js) with every dependency faked: which deeds count, how
 * a deed becomes a row, the day and map-query limits, and what the log and the error may say. All names, lots and
 * parcel numbers are made up.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const logger = require('../services/logger');
const {
  LIST_KEY, SOURCE, MIN_PRICE, DAY_PAUSE_MS, PARCEL_PAUSE_MS, MAX_PARCEL_QUERIES, MAX_LOOKUP_FAILURES_IN_A_ROW,
  MAX_ERRORS_IN_A_ROW, RETRY_AFTER_MS, HOLD_BACK_ONE_IN, isCompanyName, isTrustName, buyerKind, candidateFromRow, holdBack,
  evaluate,
  daysToRead, runNewHomeList,
} = require('../services/mail/new-home-list');

const deed = (extra = {}) => ({
  instrument: '202699000001', from: ['SAMPLE HOMES LLC'], to: ['TESTER ALEX J'], type: 'DEED', consideration: 425000,
  description: 'LOT 12 SAMPLE GROVE', date: '2026-11-17', ...extra,
});
const candidate = (extra = {}) => candidateFromRow(deed(extra)).candidate;
// What the store answers for a row it wrote as asked.
const stored = (row) => ({ status: row.status, reason: row.reason ?? null, written: true });

describe('company, trust and buyer kind', () => {
  test.each([
    ['SAMPLE HOMES LLC', true], ['M/I HOMES OF SAMPLETON', true], ['EXAMPLE L L C', true], ['EXAMPLE L.L.C.', true],
    ['TESTER ALEX J', false], ['HOMER TESTER', false], ['TESTER CITYMAN', false], ['SAMPLE BANK NA', true],
    ['COUNTY OF SAMPLE', true],
  ])('isCompanyName(%s) = %s', (name, expected) => expect(isCompanyName(name)).toBe(expected));

  test.each([
    ['TESTER FAMILY TRUST', true], ['TESTER ALEX J TR', true], ['TESTER ESTATE', true], ['TESTER ALEX J', false], ['TRUSTWELL TESTER', false],
  ])('isTrustName(%s) = %s', (name, expected) => expect(isTrustName(name)).toBe(expected));

  test('buyerKind: company beats trust beats person', () => {
    expect(buyerKind(['TESTER ALEX J', 'TESTER JORDAN M'])).toBe('person');
    expect(buyerKind(['TESTER ALEX J', 'TESTER FAMILY TRUST'])).toBe('trust');
    expect(buyerKind(['TESTER FAMILY TRUST', 'SAMPLE HOLDINGS LLC'])).toBe('company');
  });
});

describe('company endings written with dots or with spaces', () => {
  test.each([
    'EXAMPLE L.P.', 'EXAMPLE L.L.P.', 'EXAMPLE L.L.C.', 'EXAMPLE N.A.', 'EXAMPLE L.P', 'EXAMPLE, L.L.C', 'EXAMPLE P.A.',
    'EXAMPLE L P', 'EXAMPLE L L P', 'EXAMPLE L L L P', 'EXAMPLE P A', 'EXAMPLE N A', 'EXAMPLE L. L. C.',
  ])('%s is a company', (name) => {
    expect(isCompanyName(name)).toBe(true);
  });
  test('single letters in a row are one word, and they stay apart from the word next to them', () => {
    expect(isCompanyName('A.B.CONSTRUCTION')).toBe(true);
    expect(isCompanyName('TESTER A. J.')).toBe(false);
    expect(isCompanyName('TESTER A J')).toBe(false);
    expect(isCompanyName('TESTER ALEX J')).toBe(false);
    expect(isCompanyName('TESTER L PAT')).toBe(false); // "L" then a word that starts with P is not "LP"
    expect(isTrustName('TESTER ALEX J TR')).toBe(true);
    expect(isTrustName('TESTER ALEX J')).toBe(false);
  });
  test('both roles: such a buyer is a company, and such a seller is a builder', () => {
    expect(buyerKind(['EXAMPLE L.P.'])).toBe('company');
    expect(buyerKind(['EXAMPLE L P'])).toBe('company');
    expect(candidateFromRow(deed({ to: ['EXAMPLE L.L.P.'] })).candidate.buyerKind).toBe('company');
    expect(candidateFromRow(deed({ to: ['EXAMPLE L L P'] })).candidate.buyerKind).toBe('company');
    expect(candidateFromRow(deed({ from: ['SAMPLE L.P.'] })).candidate).toMatchObject({ sellerNames: ['SAMPLE L.P.'], buyerKind: 'person' });
    expect(candidateFromRow(deed({ from: ['SAMPLE L P'] })).candidate).toMatchObject({ sellerNames: ['SAMPLE L P'], buyerKind: 'person' });
    expect(candidateFromRow(deed({ from: ['SAMPLE L.P.', 'TESTER ROBIN K'] }))).toEqual({ skip: 'person_seller' });
  });
});

describe('candidateFromRow', () => {
  test('a builder-to-person deed is a candidate with its buyer kind', () => {
    expect(candidateFromRow(deed())).toEqual({
      candidate: {
        instrument: '202699000001', date: '2026-11-17', sellerNames: ['SAMPLE HOMES LLC'], recipientNames: ['TESTER ALEX J'],
        consideration: 425000, description: 'LOT 12 SAMPLE GROVE', buyerKind: 'person',
      },
    });
  });
  test.each([
    ['other_type', { type: 'MORTGAGE' }],
    ['not_filled', { from: [] }],
    ['not_filled', { to: [] }],
    ['not_filled', { description: '' }],
    ['low_price', { consideration: null }],
    ['low_price', { consideration: MIN_PRICE - 1 }],
    ['person_seller', { from: ['SAMPLE HOMES LLC', 'TESTER ROBIN K'] }],
  ])('skip %s', (why, extra) => expect(candidateFromRow(deed(extra))).toEqual({ skip: why }));
  test('exactly the minimum price stays', () => {
    expect(candidateFromRow(deed({ consideration: MIN_PRICE })).candidate).toBeDefined();
  });
});

describe('holdBack', () => {
  test('stable for a home, and holds back about one in five', () => {
    expect(holdBack(LIST_KEY, '513309059')).toBe(holdBack(LIST_KEY, '513309059'));
    let held = 0;
    for (let i = 0; i < 2000; i += 1) if (holdBack(LIST_KEY, String(500000000 + i * 7))) held += 1;
    expect(held / 2000).toBeGreaterThan(0.17);
    expect(held / 2000).toBeLessThan(0.23);
    expect(HOLD_BACK_ONE_IN).toBe(5);
  });
});

describe('daysToRead', () => {
  // 9:31 PM Eastern on Monday 2026-11-16 is already Tuesday in UTC: the ET date must win.
  test('a Monday night reads Monday and the three weekdays before it, never the weekend', () => {
    expect(daysToRead('night', Date.UTC(2026, 10, 17, 2, 31))).toEqual(['2026-11-16', '2026-11-13', '2026-11-12', '2026-11-11']);
  });
  test('across the November daylight-time change', () => {
    // Wed 2026-11-04 12:31 ET (EST); the change was Sunday 2026-11-01.
    expect(daysToRead('night', Date.UTC(2026, 10, 4, 17, 31))).toEqual(['2026-11-04', '2026-11-03', '2026-11-02', '2026-10-30']);
    // Sun 2026-11-01 11:00 PM EST is Monday in UTC; still the weekend, so Friday is the newest day.
    expect(daysToRead('night', Date.UTC(2026, 10, 2, 4, 0))[0]).toBe('2026-10-30');
  });
  test('noon mode is today and yesterday', () => {
    expect(daysToRead('noon', Date.UTC(2026, 10, 17, 17, 31))).toEqual(['2026-11-17', '2026-11-16']);
    expect(daysToRead('noon', Date.UTC(2026, 10, 16, 17, 31))).toEqual(['2026-11-16']); // Sunday and Saturday drop out
  });
});

describe('evaluate', () => {
  const parcel = (extra = {}) => ({
    parid: '513309059', addressLine1: '101 EXAMPLE TRL', city: 'SAMPLETON', zip: '34212', subdivision: 'SAMPLE GROVE PH 1',
    lot: '12', block: null, ownerName: 'SAMPLE HOMES LLC', livingSqft: 2100, stories: 2, yearBuilt: null, platKnown: true,
    ...extra,
  });
  const deps = (over = {}) => ({
    queryParcels: jest.fn(async () => [parcel()]),
    newHomePermitsForParcels: jest.fn(async () => ({ 513309059: { permit_no: 'BLD9900-0001', co_date: '2026-10-30', issued_date: '2026-01-05' } })),
    addressKnownToWaves: jest.fn(async () => false),
    ...over,
  });
  // A parcel number that holdBack() lets through, and one it holds back (found, not assumed).
  const pinWhere = (held) => { for (let i = 0; ; i += 1) { const pin = String(520000000 + i); if (holdBack(LIST_KEY, pin) === held) return pin; } };

  test('company and trust buyers are never looked up', async () => {
    const d = deps();
    expect(await evaluate(candidate({ to: ['SAMPLE HOLDINGS LLC'] }), d)).toMatchObject({ status: 'not_eligible', reason: 'company_buyer' });
    expect(await evaluate(candidate({ to: ['TESTER FAMILY TRUST'] }), d)).toMatchObject({ status: 'not_eligible', reason: 'trust_buyer' });
    expect(d.queryParcels).not.toHaveBeenCalled();
  });
  test('a description that is not one lot', async () => {
    const d = deps();
    expect(await evaluate(candidate({ description: 'SAMPLE COVE UNIT 104' }), d)).toMatchObject({ status: 'not_eligible', reason: 'no_lot' });
    expect(d.queryParcels).not.toHaveBeenCalled();
  });
  test('a map failure is unmatched / lookup_failed', async () => {
    const d = deps({ queryParcels: jest.fn(async () => { throw new Error('busy'); }) });
    expect(await evaluate(candidate(), d)).toMatchObject({ status: 'unmatched', reason: 'lookup_failed' });
  });
  test.each([
    ['no_parcel', { queryParcels: jest.fn(async () => []) }],
    ['no_permit', { newHomePermitsForParcels: jest.fn(async () => ({})) }],
    ['unknown_plat', { queryParcels: jest.fn(async () => [parcel({ platKnown: false })]) }],
    ['ambiguous', {
      queryParcels: jest.fn(async () => [parcel({ ownerName: 'A PERSON' }), parcel({ parid: '513309060', ownerName: 'B PERSON' })]),
      newHomePermitsForParcels: jest.fn(async () => ({ 513309059: { permit_no: 'A' }, 513309060: { permit_no: 'B' } })),
    }],
  ])('%s is unmatched with that reason', async (reason, over) => {
    expect(await evaluate(candidate(), deps(over))).toMatchObject({ status: 'unmatched', reason });
  });
  test.each([
    ['no house number', { addressLine1: 'EXAMPLE TRL' }],
    ['no zip', { zip: null }],
  ])('a matched parcel with %s is unmatched / no_address', async (_l, extra) => {
    const d = deps({ queryParcels: jest.fn(async () => [parcel(extra)]) });
    expect(await evaluate(candidate(), d)).toMatchObject({ status: 'unmatched', reason: 'no_address' });
    expect(d.addressKnownToWaves).not.toHaveBeenCalled();
  });
  test('an address Waves already knows is not eligible', async () => {
    const d = deps({ addressKnownToWaves: jest.fn(async () => true) });
    expect(await evaluate(candidate(), d)).toMatchObject({ status: 'not_eligible', reason: 'known_address' });
    expect(d.addressKnownToWaves).toHaveBeenCalledWith('101 EXAMPLE TRL', '34212');
  });
  test('a new home is eligible with its parcel, permit, address and size filled in', async () => {
    const pin = pinWhere(false);
    const d = deps({
      queryParcels: jest.fn(async () => [parcel({ parid: pin })]),
      newHomePermitsForParcels: jest.fn(async () => ({ [pin]: { permit_no: 'BLD9900-0001', co_date: '2026-10-30' } })),
    });
    expect(await evaluate(candidate(), d)).toEqual({
      list_key: LIST_KEY, source: SOURCE, source_ref: '202699000001', recorded_date: '2026-11-17',
      seller_names: ['SAMPLE HOMES LLC'], recipient_names: ['TESTER ALEX J'], buyer_kind: 'person', consideration: 425000,
      legal_description: 'LOT 12 SAMPLE GROVE', status: 'eligible', reason: null, match_basis: 'owner_permit', parcel_pin: pin,
      permit_no: 'BLD9900-0001', co_date: '2026-10-30', address_line1: '101 EXAMPLE TRL', city: 'SAMPLETON', state: 'FL', zip: '34212',
      subdivision: 'SAMPLE GROVE PH 1', living_sqft: 2100, stories: 2, year_built: null,
    });
  });
  test('a size no house has is stored as unknown, so it can never make the save fail', async () => {
    const pin = pinWhere(false);
    const d = deps({
      queryParcels: jest.fn(async () => [parcel({ parid: pin, livingSqft: 3e9, stories: 1200, yearBuilt: 20260 })]),
      newHomePermitsForParcels: jest.fn(async () => ({ [pin]: { permit_no: 'BLD9900-0001', co_date: null } })),
    });
    expect(await evaluate(candidate(), d)).toMatchObject({ status: 'eligible', living_sqft: null, stories: null, year_built: null });
  });
  test('the whole legal description is kept', async () => {
    const description = `LOT 12 SAMPLE GROVE ${'AND MORE WORDS '.repeat(40)}`.trim();
    const row = await evaluate(candidate({ description }), deps());
    expect(row.legal_description).toBe(description);
    expect(description.length).toBeGreaterThan(300);
  });
  test('the store gets the map\'s parcels as they are (it needs the address and the city)', async () => {
    const d = deps();
    await evaluate(candidate(), d);
    expect(d.newHomePermitsForParcels).toHaveBeenCalledWith([parcel()]);
  });
  test('the fixed one-in-five home is held back', async () => {
    const pin = pinWhere(true);
    const d = deps({
      queryParcels: jest.fn(async () => [parcel({ parid: pin })]),
      newHomePermitsForParcels: jest.fn(async () => ({ [pin]: { permit_no: 'BLD9900-0002', co_date: null } })),
    });
    expect(await evaluate(candidate(), d)).toMatchObject({ status: 'held_back', reason: null, co_date: null });
  });
});

describe('runNewHomeList', () => {
  // Tuesday 2026-11-17, 9:31 PM ET. Night mode reads 17, 16, 13 and 12 November.
  const NOW = Date.UTC(2026, 10, 18, 2, 31);
  const DAYS = ['2026-11-17', '2026-11-16', '2026-11-13', '2026-11-12'];
  const NAMES = ['SAMPLE HOMES LLC', 'TESTER ALEX J', 'EXAMPLE TRL'];

  function makeDeps({ rowsByDay = {}, existing = [], failDays = {}, parcels = [], permits = {} } = {}) {
    return {
      fetchDayList: jest.fn(async (day) => {
        if (failDays[day]) throw Object.assign(new Error(failDays[day]), { reason: failDays[day] });
        return { rows: rowsByDay[day] || [] };
      }),
      queryParcels: jest.fn(async () => parcels),
      findBySourceRefs: jest.fn(async () => existing),
      newHomePermitsForParcels: jest.fn(async () => permits),
      addressKnownToWaves: jest.fn(async () => false),
      saveProspect: jest.fn(async (row) => stored(row)),
      sleep: jest.fn(async () => {}),
    };
  }
  const run = (deps, mode = 'night') => runNewHomeList({ mode, now: () => NOW, deps });
  const person = (n, extra = {}) => deed({ instrument: String(202699100000 + n), description: `LOT ${n} SAMPLE GROVE`, ...extra });
  // The map's parcel and the store's permit for person(12) ("LOT 12 SAMPLE GROVE"): with these the run saves a live home.
  const HOME = {
    parcels: [{
      parid: '513309059', addressLine1: '101 EXAMPLE TRL', city: 'SAMPLETON', zip: '34212', subdivision: 'SAMPLE GROVE PH 1',
      lot: '12', block: null, ownerName: 'SAMPLE HOMES LLC', livingSqft: 2100, stories: 2, yearBuilt: null, platKnown: true,
    }],
    permits: { 513309059: { permit_no: 'BLD9900-0001', co_date: '2026-10-30', issued_date: '2026-01-05' } },
  };
  const LIVE = ['eligible', 'held_back'];
  // The summary of a run that threw, read from its one log line.
  const loggedSummary = () => JSON.parse(logger.info.mock.calls[0][0].replace(/^[^{]*/, ''));

  beforeEach(() => jest.clearAllMocks());

  test('reads each day in order with a pause between days', async () => {
    const deps = makeDeps();
    await run(deps);
    expect(deps.fetchDayList.mock.calls.map((c) => c[0])).toEqual(DAYS);
    expect(deps.sleep.mock.calls.filter(([ms]) => ms === DAY_PAUSE_MS)).toHaveLength(DAYS.length - 1);
  });

  test('counts the skips and saves a company buyer without a map query', async () => {
    const deps = makeDeps({
      rowsByDay: {
        '2026-11-17': [
          person(1, { to: ['SAMPLE HOLDINGS LLC'] }), person(2, { type: 'MORTGAGE' }), person(3, { consideration: 10 }),
          person(4, { from: ['TESTER ROBIN K'] }), person(5, { to: [] }),
        ],
      },
    });
    const summary = await run(deps);
    expect(summary.skipped).toEqual({ other_type: 1, low_price: 1, person_seller: 1, not_filled: 1 });
    expect(summary.saved).toEqual({ not_eligible: 1 });
    expect(summary.savedByReason).toEqual({ 'not_eligible/company_buyer': 1 });
    expect(summary.mapQueries).toBe(0);
    expect(deps.queryParcels).not.toHaveBeenCalled();
  });

  test('settled rows cost no map query and are never saved again', async () => {
    const deps = makeDeps({
      rowsByDay: { '2026-11-17': [person(1), person(2), person(3)] },
      existing: ['202699100001', '202699100002', '202699100003'].map((ref, i) => ({
        source_ref: ref, status: ['eligible', 'held_back', 'not_eligible'][i], last_checked_at: new Date(NOW - 1000),
      })),
    });
    const summary = await run(deps);
    expect(summary.skipped.settled).toBe(3);
    expect(deps.queryParcels).not.toHaveBeenCalled();
    expect(deps.saveProspect).not.toHaveBeenCalled();
  });

  test('one store call loads the existing rows for all instrument numbers', async () => {
    const deps = makeDeps({ rowsByDay: { '2026-11-17': [person(1), person(2)], '2026-11-16': [person(3)] } });
    await run(deps);
    expect(deps.findBySourceRefs).toHaveBeenCalledTimes(1);
    expect(deps.findBySourceRefs.mock.calls[0][2]).toHaveLength(3);
  });

  test('an unmatched row is tried again only after 20 hours', async () => {
    const unmatched = (n, hoursAgo) => ({ source_ref: String(202699100000 + n), status: 'unmatched', last_checked_at: new Date(NOW - hoursAgo * 3600 * 1000) });
    const deps = makeDeps({
      rowsByDay: { '2026-11-17': [person(1), person(2)] },
      existing: [unmatched(1, 19), unmatched(2, 21)],
    });
    const summary = await run(deps);
    expect(summary.skipped.retry_wait).toBe(1);
    expect(deps.saveProspect).toHaveBeenCalledTimes(1);
    expect(deps.saveProspect.mock.calls[0][0].source_ref).toBe('202699100002');
    expect(RETRY_AFTER_MS).toBe(20 * 3600 * 1000);
  });

  test('map queries stop at the cap; the rest are not saved, and later deeds that need no query still are', async () => {
    const many = Array.from({ length: MAX_PARCEL_QUERIES + 10 }, (_, i) => person(i + 1));
    const deps = makeDeps({ rowsByDay: { '2026-11-17': [...many, person(900, { to: ['SAMPLE HOLDINGS LLC'] })] } });
    const summary = await run(deps);
    expect(deps.queryParcels).toHaveBeenCalledTimes(MAX_PARCEL_QUERIES);
    expect(summary.mapQueries).toBe(MAX_PARCEL_QUERIES);
    expect(summary.skipped.waits_for_next_run).toBe(10);
    expect(summary.saved.unmatched).toBe(MAX_PARCEL_QUERIES);
    expect(summary.saved.not_eligible).toBe(1);
    expect(deps.sleep.mock.calls.filter(([ms]) => ms === PARCEL_PAUSE_MS)).toHaveLength(MAX_PARCEL_QUERIES - 1);
  });

  test('the map-query budget goes first to deeds never judged, the oldest day first; a retry waits', async () => {
    const newest = Array.from({ length: MAX_PARCEL_QUERIES }, (_, i) => person(i + 1)); // recorded 2026-11-17
    const oldest = [person(501, { date: '2026-11-12' }), person(502, { date: '2026-11-12' })];
    const retry = person(700); // recorded 2026-11-17, stored as unmatched 21 hours ago: due again
    const deps = makeDeps({
      rowsByDay: { '2026-11-17': [retry, ...newest], '2026-11-12': oldest },
      existing: [{ source_ref: '202699100700', status: 'unmatched', last_checked_at: new Date(NOW - 21 * 3600 * 1000) }],
    });
    const summary = await run(deps);
    const order = deps.saveProspect.mock.calls.map(([row]) => row.source_ref);
    expect(order.slice(0, 3)).toEqual(['202699100501', '202699100502', '202699100001']);
    expect(order).toHaveLength(MAX_PARCEL_QUERIES);
    expect(order).not.toContain('202699100700');
    // 120 queries: the 2 of the oldest day and 118 of the newest. Left for the next run: 2 new deeds and the retry.
    expect(summary.skipped.waits_for_next_run).toBe(3);
  });

  test('five map failures in a row stop the queries, leave the rest unsaved, and the run throws at its end', async () => {
    const rows = [...Array.from({ length: 8 }, (_, i) => person(i + 1)), person(900, { to: ['SAMPLE HOLDINGS LLC'] })];
    const deps = makeDeps({ rowsByDay: { '2026-11-17': rows } });
    deps.queryParcels.mockRejectedValue(new Error('map is down: TESTER ALEX J'));
    let thrown;
    await run(deps).catch((err) => { thrown = err; });
    expect(thrown.message).toBe(`Mail new-home list: the parcel map did not answer (${MAX_LOOKUP_FAILURES_IN_A_ROW} failures in a row)`);
    expect(deps.queryParcels).toHaveBeenCalledTimes(MAX_LOOKUP_FAILURES_IN_A_ROW);
    const summary = loggedSummary();
    expect(summary.savedByReason).toEqual({ 'unmatched/lookup_failed': MAX_LOOKUP_FAILURES_IN_A_ROW, 'not_eligible/company_buyer': 1 });
    expect(summary.skipped.waits_for_next_run).toBe(3);
    // The five are stored as unmatched and tried again; the company buyer needs no map and is still saved.
    expect(deps.saveProspect).toHaveBeenCalledTimes(MAX_LOOKUP_FAILURES_IN_A_ROW + 1);
    expect(summary.mapFailuresInARow).toBe(MAX_LOOKUP_FAILURES_IN_A_ROW);
  });

  test('a small run where no map query was answered throws too', async () => {
    const deps = makeDeps({ rowsByDay: { '2026-11-17': [person(1), person(2)] } });
    deps.queryParcels.mockRejectedValue(new Error('map is down'));
    await expect(run(deps)).rejects.toThrow('Mail new-home list: the parcel map did not answer (2 failures in a row)');
    expect(deps.saveProspect.mock.calls.map(([row]) => `${row.status}/${row.reason}`)).toEqual(['unmatched/lookup_failed', 'unmatched/lookup_failed']);
  });

  test('a map failure between answers is not an outage: the count starts again and the run does not throw', async () => {
    const deps = makeDeps({ rowsByDay: { '2026-11-17': Array.from({ length: 12 }, (_, i) => person(i + 1)) } });
    let n = 0;
    deps.queryParcels.mockImplementation(async () => { n += 1; if (n % 3 !== 0) throw new Error('flaky'); return []; });
    const summary = await run(deps);
    expect(deps.queryParcels).toHaveBeenCalledTimes(12);
    expect(summary.savedByReason).toEqual({ 'unmatched/lookup_failed': 8, 'unmatched/no_parcel': 4 });
    expect(summary.mapFailuresInARow).toBe(0);
  });

  test('a duplicate fallback (the home or its permit is live under another deed) is counted under its own reason', async () => {
    // Only a live home can be refused as a duplicate, so the deed matches a parcel and a permit.
    const deps = makeDeps({ rowsByDay: { '2026-11-17': [person(12)] }, ...HOME });
    deps.saveProspect.mockResolvedValue({ status: 'not_eligible', reason: 'duplicate_parcel', written: true });
    const summary = await run(deps);
    expect(LIVE).toContain(deps.saveProspect.mock.calls[0][0].status);
    expect(summary.saved).toEqual({ not_eligible: 1 });
    expect(summary.savedByReason).toEqual({ 'not_eligible/duplicate_parcel': 1 });
    expect(summary.keptAnswers).toBe(0);
  });

  test('a deed that cannot be saved does not stop the deeds after it; the run throws at its end with codes only', async () => {
    const deps = makeDeps({ rowsByDay: { '2026-11-17': [person(1), person(2), person(3)] } });
    deps.saveProspect.mockImplementation(async (row) => {
      if (row.source_ref === '202699100002') throw Object.assign(new Error('value too long: TESTER ALEX J, 101 EXAMPLE TRL'), { code: '22003' });
      return stored(row);
    });
    let thrown;
    await run(deps).catch((err) => { thrown = err; });
    expect(thrown.message).toBe('Mail new-home list: 1 deeds could not be judged or saved (22003: 1)');
    expect(deps.saveProspect.mock.calls.map(([row]) => row.source_ref)).toEqual(['202699100001', '202699100002', '202699100003']);
    const line = logger.info.mock.calls[0][0];
    expect(line).toContain('"errors":{"22003":1}');
    expect(line).toContain('"saved":{"unmatched":2}');
    for (const text of NAMES) expect(`${line} ${thrown.message}`).not.toContain(text);
  });

  test('an error while a deed is judged is counted by its class name, and a message is never a code', async () => {
    const deps = makeDeps({ rowsByDay: { '2026-11-17': [person(1), person(2)] } });
    deps.newHomePermitsForParcels
      .mockRejectedValueOnce(new TypeError('TESTER ALEX J'))
      .mockRejectedValueOnce(Object.assign(new Error('x'), { name: 'a name with TESTER ALEX J in it', code: 42 }));
    deps.queryParcels.mockResolvedValue([{ parid: '513309059' }]);
    await expect(run(deps)).rejects.toThrow('2 deeds could not be judged or saved (TypeError: 1; error: 1)');
    expect(deps.saveProspect).not.toHaveBeenCalled();
  });

  test('several errors in a row stop the run: every deed left waits for the next run', async () => {
    const rows = [...Array.from({ length: 6 }, (_, i) => person(i + 1)), person(900, { to: ['SAMPLE HOLDINGS LLC'] })];
    const deps = makeDeps({ rowsByDay: { '2026-11-17': rows } });
    deps.saveProspect.mockRejectedValue(Object.assign(new Error('the database is away'), { code: 'ECONNREFUSED' }));
    let thrown;
    await run(deps).catch((err) => { thrown = err; });
    expect(thrown.message).toContain(`${MAX_ERRORS_IN_A_ROW} deeds could not be judged or saved (ECONNREFUSED: ${MAX_ERRORS_IN_A_ROW})`);
    expect(deps.saveProspect).toHaveBeenCalledTimes(MAX_ERRORS_IN_A_ROW);
    expect(deps.queryParcels).toHaveBeenCalledTimes(MAX_ERRORS_IN_A_ROW);
    // The company buyer needs no map query, and it waits too.
    expect(JSON.parse(logger.info.mock.calls[0][0].replace(/^[^{]*/, '')).skipped.waits_for_next_run).toBe(rows.length - MAX_ERRORS_IN_A_ROW);
  });

  test('a save that works resets the error count', async () => {
    const deps = makeDeps({ rowsByDay: { '2026-11-17': Array.from({ length: 9 }, (_, i) => person(i + 1)) } });
    let n = 0;
    deps.saveProspect.mockImplementation(async (row) => { n += 1; if (n % 3 !== 0) throw new Error('x'); return stored(row); });
    await expect(run(deps)).rejects.toThrow('6 deeds could not be judged or saved (Error: 6)');
    expect(deps.saveProspect).toHaveBeenCalledTimes(9);
  });

  test('a failed day is named by its code, never by a message', async () => {
    const deps = makeDeps();
    deps.fetchDayList.mockImplementation(async (day) => {
      if (day === '2026-11-16') throw new Error('page text with TESTER ALEX J');
      if (day === '2026-11-13') throw Object.assign(new Error('TESTER ALEX J'), { reason: 'party_cell' });
      return { rows: [] };
    });
    await expect(run(deps)).rejects.toThrow('Mail new-home list: 2 of 4 days failed (2026-11-16: Error; 2026-11-13: party_cell)');
  });

  test('an answer that another run saved first is counted as the table holds it, not as this run judged it', async () => {
    // Deed 12 is a live home in this run; deed 1 has no parcel in this run. Another run answered both first.
    const deps = makeDeps({ rowsByDay: { '2026-11-17': [person(12), person(1)] }, ...HOME });
    deps.queryParcels.mockImplementation(async (legal) => (legal.lot === '12' ? HOME.parcels : []));
    deps.saveProspect.mockImplementation(async (row) => (row.source_ref === '202699100012'
      ? { status: 'not_eligible', reason: 'known_address', written: false }
      : { status: 'eligible', reason: null, written: false }));
    const summary = await run(deps);
    const asked = Object.fromEntries(deps.saveProspect.mock.calls.map(([row]) => [row.source_ref, row.status]));
    expect(LIVE).toContain(asked['202699100012']);
    expect(asked['202699100001']).toBe('unmatched');
    expect(summary.saved).toEqual({ not_eligible: 1, eligible: 1 });
    expect(summary.savedByReason).toEqual({ 'not_eligible/known_address': 1 });
    expect(summary.keptAnswers).toBe(2);
  });

  test('a refused row shows that the database answered: the errors-in-a-row count starts again', async () => {
    const deps = makeDeps({ rowsByDay: { '2026-11-17': Array.from({ length: 7 }, (_, i) => person(i + 1)) } });
    const away = () => Object.assign(new Error('away'), { code: 'ECONNRESET' });
    const refused = () => Object.assign(new Error('refused'), { code: '23514' });
    const outcomes = [away, refused, away, away, refused, away]; // the seventh save works
    deps.saveProspect.mockImplementation(async (row) => { const next = outcomes.shift(); if (next) throw next(); return stored(row); });
    let thrown;
    await run(deps).catch((err) => { thrown = err; });
    expect(thrown.message).toBe('Mail new-home list: 6 deeds could not be judged or saved (23514: 2; ECONNRESET: 4)');
    expect(deps.saveProspect).toHaveBeenCalledTimes(7); // never three in a row with no answer between them
    expect(loggedSummary().saved).toEqual({ unmatched: 1 });
  });

  test('an error of the code on one deed leaves the errors-in-a-row count as it is', async () => {
    const deps = makeDeps({ rowsByDay: { '2026-11-17': Array.from({ length: 5 }, (_, i) => person(i + 1)) } });
    deps.saveProspect.mockRejectedValue(Object.assign(new Error('away'), { code: 'ECONNRESET' }));
    let judged = 0;
    deps.newHomePermitsForParcels.mockImplementation(async () => { judged += 1; if (judged === 2) throw new TypeError('x'); return {}; });
    let thrown;
    await run(deps).catch((err) => { thrown = err; });
    // Deed 1: away. Deed 2: TypeError. Deeds 3 and 4: away, the third in a row. Deed 5 waits.
    expect(thrown.message).toBe('Mail new-home list: 4 deeds could not be judged or saved (ECONNRESET: 3; TypeError: 1)');
    expect(deps.saveProspect).toHaveBeenCalledTimes(3);
    expect(loggedSummary().skipped.waits_for_next_run).toBe(1);
  });

  test('errors that belong to one deed never stop the run: the deeds after three refused rows are still saved', async () => {
    const deps = makeDeps({ rowsByDay: { '2026-11-17': Array.from({ length: 8 }, (_, i) => person(i + 1)) } });
    deps.saveProspect.mockImplementation(async (row) => {
      const n = Number(row.source_ref) - 202699100000;
      if (n <= 3) throw Object.assign(new Error('refused: TESTER ALEX J'), { code: n === 1 ? '22003' : '23514' });
      return stored(row);
    });
    deps.newHomePermitsForParcels.mockImplementation(async (parcels) => { if (parcels.length) throw new TypeError('TESTER ALEX J'); return {}; });
    deps.queryParcels.mockImplementation(async (legal) => (Number(legal.lot) >= 6 ? [{ parid: '513309059' }] : []));
    let thrown;
    await run(deps).catch((err) => { thrown = err; });
    // Deeds 1 to 3: the row is refused. 4 and 5: saved. 6 to 8: a TypeError while the deed is judged.
    expect(thrown.message).toBe('Mail new-home list: 6 deeds could not be judged or saved (22003: 1; 23514: 2; TypeError: 3)');
    expect(deps.queryParcels).toHaveBeenCalledTimes(8);
    expect(loggedSummary().saved).toEqual({ unmatched: 2 });
    expect(loggedSummary().skipped.waits_for_next_run).toBeUndefined();
  });

  test('a failed day throws after the other days were saved, naming the day and the reason', async () => {
    const deps = makeDeps({ rowsByDay: { '2026-11-17': [person(1, { to: ['SAMPLE HOLDINGS LLC'] })] }, failDays: { '2026-11-16': 'http_status' } });
    await expect(run(deps)).rejects.toThrow(/1 of 4 days failed \(2026-11-16: http_status\)/);
    expect(deps.saveProspect).toHaveBeenCalledTimes(1);
    expect(deps.fetchDayList).toHaveBeenCalledTimes(DAYS.length);
    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  test('the log line is one line of counts: no name, no address', async () => {
    const deps = makeDeps({ rowsByDay: { '2026-11-17': [person(12)] }, ...HOME });
    await run(deps);
    // The saved row is a live home with its address and names; the line has none of them.
    expect(deps.saveProspect.mock.calls[0][0]).toMatchObject({ address_line1: '101 EXAMPLE TRL', recipient_names: ['TESTER ALEX J'] });
    expect(LIVE).toContain(deps.saveProspect.mock.calls[0][0].status);
    expect(logger.info).toHaveBeenCalledTimes(1);
    const line = logger.info.mock.calls[0][0];
    for (const text of NAMES) expect(line).not.toContain(text);
    expect(line).toContain('"mapQueries":1');
  });

  test('the noon mode reads two days', async () => {
    const deps = makeDeps();
    await run(deps, 'noon');
    expect(deps.fetchDayList.mock.calls.map((c) => c[0])).toEqual(['2026-11-17', '2026-11-16']);
  });
});
