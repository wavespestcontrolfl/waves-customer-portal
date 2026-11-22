/**
 * The home price run (services/mail/home-price.js): the due rows, the permit type check, the calls into the facts reader
 * and the quote, the save, the budget, the row cap, the error stop, the summary, the log line and the throw at the end.
 * The facts reader and the quote are mocked at their entry points (their own tests are mail-home-facts.test.js and
 * mail-home-quote.test.js); the last two cases run the real ones end to end with their outside calls mocked. No network,
 * no database. Made-up rows.
 */
jest.mock('../models/db', () => jest.fn());
const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('../services/logger', () => mockLogger);
jest.mock('../services/mail/home-facts', () => ({
  createFactsContext: jest.fn(), readHomeFacts: jest.fn(), factsSummary: jest.fn(), factsProblems: jest.fn(),
}));
jest.mock('../services/mail/home-quote', () => ({ priceHome: jest.fn() }));

const homeFacts = require('../services/mail/home-facts');
const { priceHome } = require('../services/mail/home-quote');
const { runHomePrices, BUDGET_MS, ROW_CAP, READ_CAP } = require('../services/mail/home-price');

const actualFacts = jest.requireActual('../services/mail/home-facts');
const actualQuote = jest.requireActual('../services/mail/home-quote');

const NOW = Date.parse('2026-11-22T15:00:00Z');
const FACTS = { homeSqft: 1800, homeSqftSource: 'parcel_map', stories: 1, lotSqft: 8000 };
const PRICED = { status: 'priced', ...FACTS, priceAnnual: 512.34, priceSetupFee: 37.5, priceDigest: 'a'.repeat(64) };
const CTX = { facts: 'context' };
const SUMMARY = {
  mapQueries: 0, mapFailuresInARow: 0, mapStopped: false, mapDisabled: false,
  permitPages: 0, permitFailuresInARow: 0, permitNoFieldsInARow: 0, permitStopped: false, permitStop: null, permitPageOff: false,
};

let seq = 0;
const makeRow = (extra = {}) => {
  seq += 1;
  return {
    id: `row-${seq}`, parcel_pin: `PIN${String(seq).padStart(7, '0')}`, permit_no: `PMT-${seq}`, address_line1: `${100 + seq} EXAMPLE TRL`,
    city: 'SAMPLETON', state: 'FL', zip: '34212', recorded_date: '2026-11-17', price_status: null, price_version: 0, ...extra,
  };
};
const permitOf = (extra = {}) => ({
  type_of_work: 'New Single Family', detail_status: 'ok', detail_stale: false, canceled: false, conditioned_sqft: 2100, stories: 2, ...extra,
});

// The store calls are mocks. `permits` maps a permit number to its stored row (null: no row).
function setup({ rows = [], permits = {}, ...over } = {}) {
  const deps = {
    dueForPrice: jest.fn(async () => rows),
    permitFacts: jest.fn(async (no) => (no in permits ? permits[no] : permitOf())),
    savePriceResult: jest.fn(async () => ({ written: true, price_status: 'x' })),
    ...over,
  };
  return { deps, run: (options = {}) => runHomePrices({ now: () => NOW, deps, ...options }) };
}
const saved = (deps) => deps.savePriceResult.mock.calls;
const resultOf = (deps, row) => saved(deps).find(([r]) => r === row)[1];

beforeEach(() => {
  jest.resetAllMocks();
  homeFacts.createFactsContext.mockReturnValue(CTX);
  homeFacts.readHomeFacts.mockResolvedValue({ facts: FACTS, missing: null });
  homeFacts.factsSummary.mockReturnValue(SUMMARY);
  homeFacts.factsProblems.mockReturnValue([]);
  priceHome.mockResolvedValue(PRICED);
});

describe('one row', () => {
  test('a home with every fact is priced and saved: the permit row, the facts and the quote are asked in turn', async () => {
    const row = makeRow();
    const permit = permitOf();
    const t = setup({ rows: [row], permits: { [row.permit_no]: permit } });
    const summary = await t.run();
    expect(t.deps.permitFacts).toHaveBeenCalledWith(row.permit_no);
    expect(homeFacts.readHomeFacts).toHaveBeenCalledWith(row, permit, CTX);
    expect(priceHome).toHaveBeenCalledWith(row, FACTS, t.deps);
    expect(saved(t.deps)).toEqual([[row, PRICED]]);
    expect(summary).toMatchObject({ due: 1, priced: 1, byStatus: { priced: 1 }, left: 0, kept: 0, errors: {} });
  });

  test('the save is given the due row itself (its id and its version), never a bare id', async () => {
    const row = makeRow({ price_version: 3 });
    const t = setup({ rows: [row] });
    await t.run();
    expect(saved(t.deps)[0][0]).toBe(row);
    expect(saved(t.deps)[0]).toHaveLength(2);
  });

  test('the facts reader gets the run\'s deps and clock in its context, and the quote gets the deps', async () => {
    const t = setup({ rows: [makeRow()], sleep: jest.fn(), buildEngineInput: jest.fn() });
    await t.run();
    const [options] = homeFacts.createFactsContext.mock.calls[0];
    expect(options.deps).toBe(t.deps);
    expect(options.clock()).toBe(NOW);
    expect(options.deadline).toBe(NOW + BUDGET_MS); // the end of the run's budget, for the permit throttle
    expect(priceHome.mock.calls[0][2]).toBe(t.deps);
  });

  test.each([
    ['a townhouse', { type_of_work: 'New Townhouse' }],
    ['a duplex', { type_of_work: 'New Duplex' }],
    ['a single family permit with other words around it', { type_of_work: 'New Single Family Addition' }],
    ['a permit with a blank type of work', { type_of_work: '  ' }],
    ['a permit with no type of work', { type_of_work: null }],
  ])('%s is settled as not_clean / not_single_family, with no facts read and no price', async (_name, extra) => {
    const row = makeRow();
    const t = setup({ rows: [row], permits: { [row.permit_no]: permitOf(extra) } });
    const summary = await t.run();
    expect(saved(t.deps)).toEqual([[row, { status: 'not_clean', reason: 'not_single_family' }]]);
    expect(homeFacts.readHomeFacts).not.toHaveBeenCalled();
    expect(priceHome).not.toHaveBeenCalled();
    expect(summary.byReason).toEqual({ 'not_clean/not_single_family': 1 });
  });

  test('a permit canceled or withdrawn since the list took it is settled as not_clean / permit_canceled, before anything is read', async () => {
    const row = makeRow();
    const t = setup({ rows: [row], permits: { [row.permit_no]: permitOf({ canceled: true }) } });
    const summary = await t.run();
    expect(saved(t.deps)).toEqual([[row, { status: 'not_clean', reason: 'permit_canceled' }]]);
    expect(homeFacts.readHomeFacts).not.toHaveBeenCalled();
    expect(priceHome).not.toHaveBeenCalled();
    expect(summary.byReason).toEqual({ 'not_clean/permit_canceled': 1 });
  });

  test('the type of work is read with its spaces and case ignored', async () => {
    const row = makeRow();
    const t = setup({ rows: [row], permits: { [row.permit_no]: permitOf({ type_of_work: '  NEW  single family ' }) } });
    await t.run();
    expect(resultOf(t.deps, row).status).toBe('priced');
  });

  test('a permit row that is missing is NOT settled: failed / permit_row, tried again on a later run', async () => {
    const row = makeRow();
    const t = setup({ rows: [row], permits: { [row.permit_no]: null } });
    const summary = await t.run();
    expect(saved(t.deps)).toEqual([[row, { status: 'failed', reason: 'permit_row' }]]);
    expect(homeFacts.readHomeFacts).not.toHaveBeenCalled();
    expect(summary.byReason).toEqual({ 'failed/permit_row': 1 });
  });

  test('a missing fact is saved as missing_fact with the facts known, and no price is asked', async () => {
    const row = makeRow();
    const known = { homeSqft: 1800, homeSqftSource: 'parcel_map', stories: 1, lotSqft: null };
    homeFacts.readHomeFacts.mockResolvedValue({ facts: known, missing: 'no_lot_size' });
    const t = setup({ rows: [row] });
    await t.run();
    expect(saved(t.deps)).toEqual([[row, { status: 'missing_fact', reason: 'no_lot_size', ...known }]]);
    expect(priceHome).not.toHaveBeenCalled();
  });

  test('a failed read is saved as failed with the reason and the facts it had', async () => {
    const row = makeRow();
    const known = { homeSqft: null, homeSqftSource: null, stories: 1, lotSqft: 8000 };
    homeFacts.readHomeFacts.mockResolvedValue({ failed: 'permit_page', facts: known });
    const t = setup({ rows: [row] });
    await t.run();
    expect(saved(t.deps)).toEqual([[row, { status: 'failed', reason: 'permit_page', ...known }]]);
    expect(priceHome).not.toHaveBeenCalled();
  });

  test('the quote\'s answer is saved as it is: not_clean and failed results too', async () => {
    const [a, b] = [makeRow(), makeRow()];
    priceHome
      .mockResolvedValueOnce({ status: 'not_clean', reason: 'engine_review', ...FACTS })
      .mockResolvedValueOnce({ status: 'failed', reason: 'engine', ...FACTS });
    const t = setup({ rows: [a, b] });
    const summary = await t.run();
    expect(resultOf(t.deps, a)).toMatchObject({ status: 'not_clean', reason: 'engine_review' });
    expect(resultOf(t.deps, b)).toMatchObject({ status: 'failed', reason: 'engine' });
    expect(summary.byReason).toEqual({ 'not_clean/engine_review': 1, 'failed/engine': 1 });
    // One engine failure among answers is a row's result, not a failed run.
    expect(summary).toMatchObject({ quotes: 2, engineFailures: 1, engineStop: false });
  });

  test('a row whose source is stopped is left as it is: not saved, counted as left, and the run is still good', async () => {
    homeFacts.readHomeFacts.mockResolvedValue({ left: true });
    const t = setup({ rows: [makeRow(), makeRow()] });
    expect(await t.run()).toMatchObject({ due: 2, left: 2, priced: 0 });
    expect(t.deps.savePriceResult).not.toHaveBeenCalled();
  });

  test.each([
    ['settled', { written: false, why: 'settled', price_status: 'priced' }],
    ['changed by another run', { written: false, why: 'changed', price_status: 'failed' }],
    ['no longer eligible', { written: false, why: 'not_eligible', price_status: null }],
    ['not found', { written: false, why: 'not_found', price_status: null }],
  ])('a row the store did not write (%s) is counted as kept, not as a result, and the run is good', async (_name, answer) => {
    const t = setup({ rows: [makeRow()], savePriceResult: jest.fn(async () => answer) });
    expect(await t.run()).toMatchObject({ kept: 1, priced: 0, byStatus: {}, byReason: {} });
  });
});

describe('the end of the run', () => {
  test('what the facts reader reports as a problem fails the run, after the log line, with the summary on the error', async () => {
    homeFacts.factsSummary.mockReturnValue({ ...SUMMARY, mapStopped: true, mapFailuresInARow: 5 });
    homeFacts.factsProblems.mockReturnValue(['the parcel map did not answer (5 failures in a row)']);
    const t = setup({ rows: [makeRow()] });
    const failure = await t.run().catch((err) => err);
    expect(failure.message).toBe('Mail home prices: the parcel map did not answer (5 failures in a row)');
    expect(failure.summary).toMatchObject({ mapStopped: true, priced: 1 });
    expect(mockLogger.info).toHaveBeenCalledTimes(1);
  });

  test('the permit page switch off: the summary says so and the run throws with a message that names GATE_PERMIT_DETAIL_SYNC', async () => {
    homeFacts.factsSummary.mockReturnValue({ ...SUMMARY, permitStopped: true, permitPageOff: true });
    homeFacts.factsProblems.mockReturnValue(['the permit page is turned off (GATE_PERMIT_DETAIL_SYNC)']);
    homeFacts.readHomeFacts.mockResolvedValueOnce({ left: true });
    const t = setup({ rows: [makeRow(), makeRow()] });
    const failure = await t.run().catch((err) => err);
    expect(failure.message).toMatch(/GATE_PERMIT_DETAIL_SYNC/);
    expect(failure.summary).toMatchObject({ permitPageOff: true, left: 1, priced: 1 });
    expect(JSON.parse(mockLogger.info.mock.calls[0][0].replace('Mail home prices: ', ''))).toMatchObject({ permitPageOff: true });
  });

  test('the summary carries the facts reader\'s counts', async () => {
    homeFacts.factsSummary.mockReturnValue({ ...SUMMARY, mapQueries: 3, permitPages: 2 });
    const t = setup({ rows: [makeRow()] });
    expect(await t.run()).toMatchObject({ mapQueries: 3, permitPages: 2, permitPageOff: false });
  });
});

describe('limits that do not fail the run', () => {
  test('the due read asks for 200 rows at the run\'s time; a run handles 40 homes, the rest waits, and it does not throw', async () => {
    const rows = Array.from({ length: ROW_CAP + 5 }, () => makeRow());
    const t = setup({ rows });
    const summary = await t.run();
    expect([ROW_CAP, READ_CAP]).toEqual([40, 200]);
    expect(t.deps.dueForPrice).toHaveBeenCalledWith({ limit: 200, now: new Date(NOW) });
    expect(summary).toMatchObject({ due: 45, capReached: true, priced: 40, budgetSpent: false });
    expect(saved(t.deps).map(([row]) => row)).toEqual(rows.slice(0, 40));
    // Exactly 40 due homes: every one is handled and nothing waits.
    expect(await setup({ rows: rows.slice(0, 40) }).run()).toMatchObject({ due: 40, capReached: false, priced: 40 });
  });

  test('a home left for a stopped source is not one of the 40: the run goes on to the homes behind it', async () => {
    const rows = Array.from({ length: 100 }, () => makeRow());
    const waiting = new Set(rows.slice(0, 45).map((row) => row.id)); // they need the permit page, and it is stopped
    homeFacts.readHomeFacts.mockImplementation(async (row) => (waiting.has(row.id) ? actualFacts.LEFT : { facts: FACTS, missing: null }));
    const t = setup({ rows });
    const summary = await t.run();
    expect(summary).toMatchObject({ due: 100, left: 45, priced: 40, capReached: true });
    expect(saved(t.deps).map(([row]) => row)).toEqual(rows.slice(45, 85));
  });

  test('a row that could not be read or saved is one of the 40', async () => {
    const rows = Array.from({ length: 45 }, () => makeRow());
    const t = setup({ rows, savePriceResult: jest.fn(async () => { throw new TypeError('x'); }) });
    const failure = await t.run().catch((err) => err);
    expect(t.deps.savePriceResult).toHaveBeenCalledTimes(40);
    expect(failure.summary).toMatchObject({ capReached: true, errors: { TypeError: 40 } });
  });

  test('a read of 200 rows that the run walked to its end sets capReached: more may wait behind it', async () => {
    const rows = Array.from({ length: READ_CAP }, () => makeRow());
    homeFacts.readHomeFacts.mockResolvedValue(actualFacts.LEFT);
    expect(await setup({ rows }).run()).toMatchObject({ due: 200, left: 200, priced: 0, capReached: true });
    // A shorter read walked to its end leaves nothing behind.
    expect(await setup({ rows: rows.slice(0, 60) }).run()).toMatchObject({ due: 60, left: 60, capReached: false });
  });

  test('a spent 20 minute budget leaves the rest for the next run and does not throw', async () => {
    const rows = Array.from({ length: 6 }, () => makeRow());
    let clockNow = NOW;
    const t = setup({ rows, savePriceResult: jest.fn(async () => { clockNow += BUDGET_MS / 3; return { written: true }; }) });
    const summary = await runHomePrices({ now: () => clockNow, deps: t.deps });
    expect(BUDGET_MS).toBe(20 * 60 * 1000);
    expect(saved(t.deps)).toHaveLength(3);
    expect(summary).toMatchObject({ due: 6, budgetSpent: true, left: 0, capReached: false });
  });

  test('a time in ms is the run\'s start: the clock still advances, so the budget and the elapsed time are real', async () => {
    const realNow = jest.spyOn(Date, 'now');
    try {
      let real = 5000000;
      realNow.mockImplementation(() => real);
      const rows = Array.from({ length: 6 }, () => makeRow());
      const t = setup({ rows, savePriceResult: jest.fn(async () => { real += BUDGET_MS / 3; return { written: true }; }) });
      const summary = await runHomePrices({ now: NOW, deps: t.deps });
      expect(t.deps.dueForPrice).toHaveBeenCalledWith({ limit: 200, now: new Date(NOW) });
      expect(saved(t.deps)).toHaveLength(3);
      expect(summary).toMatchObject({ due: 6, budgetSpent: true, ms: BUDGET_MS });
      // The facts reader's clock is the same advancing one.
      const [options] = homeFacts.createFactsContext.mock.calls[0];
      expect(options.clock()).toBe(NOW + BUDGET_MS);
    } finally {
      realNow.mockRestore();
    }
  });

  test('no due row is an empty run', async () => {
    expect(await setup({ rows: [] }).run()).toMatchObject({ due: 0, priced: 0 });
  });

  test('rows are handled one at a time', async () => {
    let inFlight = 0;
    let max = 0;
    const track = (fn) => async (...args) => { inFlight += 1; max = Math.max(max, inFlight); try { return await fn(...args); } finally { inFlight -= 1; } };
    homeFacts.readHomeFacts.mockImplementation(track(async () => ({ facts: FACTS, missing: null })));
    priceHome.mockImplementation(track(async () => PRICED));
    const t = setup({
      rows: Array.from({ length: 4 }, () => makeRow()),
      permitFacts: jest.fn(track(async () => permitOf())),
      savePriceResult: jest.fn(track(async () => ({ written: true }))),
    });
    await t.run();
    expect(max).toBe(1);
  });
});

describe('errors that are not a source being away', () => {
  test('a read that throws leaves the row untouched, counts its code, and fails the run at the end', async () => {
    const [a, b] = [makeRow(), makeRow()];
    const t = setup({
      rows: [a, b],
      permitFacts: jest.fn(async (no) => { if (no === a.permit_no) throw Object.assign(new Error(`select ... ${a.permit_no}`), { code: 'ECONNRESET' }); return permitOf(); }),
    });
    await expect(t.run()).rejects.toThrow('Mail home prices: 1 rows could not be read or saved (ECONNRESET: 1)');
    expect(saved(t.deps).map(([row]) => row)).toEqual([b]);
  });

  test('a facts reader that throws is the same kind of error', async () => {
    homeFacts.readHomeFacts.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'EPIPE' }));
    const t = setup({ rows: [makeRow(), makeRow()] });
    await expect(t.run()).rejects.toThrow(/EPIPE: 1/);
    expect(t.deps.savePriceResult).toHaveBeenCalledTimes(1);
  });

  test('three errors in a row that are not a row\'s own stop the run; a row the table refused does not count', async () => {
    const rows = Array.from({ length: 6 }, () => makeRow());
    const away = jest.fn(async () => { throw Object.assign(new Error('x'), { code: 'ECONNREFUSED' }); });
    const t = setup({ rows, permitFacts: away });
    await expect(t.run()).rejects.toThrow(/stopped after errors in a row/);
    expect(away).toHaveBeenCalledTimes(3);
    const refused = setup({ rows, savePriceResult: jest.fn(async () => { throw Object.assign(new Error('x'), { code: '23514' }); }) });
    await expect(refused.run()).rejects.toThrow(/23514: 6/);
    expect(refused.deps.permitFacts).toHaveBeenCalledTimes(6);
  });

  test('a row the table refused is an answer from the database: it starts the count of errors in a row again', async () => {
    const rows = Array.from({ length: 8 }, () => makeRow());
    const away = () => { throw Object.assign(new Error('x'), { code: 'ECONNRESET' }); };
    const refused = () => { throw Object.assign(new Error('x'), { code: '23514' }); };
    const answers = [away, away, refused, away, away, refused, away, away];
    const t = setup({ rows, savePriceResult: jest.fn(async () => answers.shift()()) });
    const failure = await t.run().catch((err) => err);
    expect(t.deps.savePriceResult).toHaveBeenCalledTimes(8);
    expect(failure.summary).toMatchObject({ errorStop: false, errors: { ECONNRESET: 6, 23514: 2 } });
    // A TypeError between two connection errors says nothing about the database: the count goes on.
    const mixed = [away, away, () => { throw new TypeError('x'); }, away, away];
    const stopped = setup({ rows, savePriceResult: jest.fn(async () => mixed.shift()()) });
    const stop = await stopped.run().catch((err) => err);
    expect(stopped.deps.savePriceResult).toHaveBeenCalledTimes(4);
    expect(stop.summary.errorStop).toBe(true);
  });

  test('a TypeError from the save (a bare id, a bad result) is the row\'s own error and does not stop the run', async () => {
    const t = setup({ rows: Array.from({ length: 5 }, () => makeRow()), savePriceResult: jest.fn(async () => { throw new TypeError('x'); }) });
    await expect(t.run()).rejects.toThrow(/TypeError: 5/);
    expect(t.deps.savePriceResult).toHaveBeenCalledTimes(5);
  });

  test('the due rows that cannot be read fail the run with a code only', async () => {
    const t = setup({ dueForPrice: jest.fn(async () => { throw Object.assign(new Error('select * from mail_prospects where x = 101 EXAMPLE TRL'), { code: '57P01' }); }) });
    const failure = await t.run().catch((err) => err);
    expect(failure.message).toBe('Mail home prices: the due rows could not be read (57P01)');
  });
});

describe('a price engine that is away', () => {
  const ENGINE_FAILED = { status: 'failed', reason: 'engine', ...FACTS };

  test('three price engine failures in a row stop the run: the three rows are saved as failed, the rest waits, and the run throws', async () => {
    const rows = Array.from({ length: 6 }, () => makeRow());
    priceHome.mockResolvedValue(ENGINE_FAILED);
    const t = setup({ rows });
    const failure = await t.run().catch((err) => err);
    expect(failure.message).toBe('Mail home prices: stopped after 3 price engine failures in a row');
    expect(priceHome).toHaveBeenCalledTimes(3);
    expect(saved(t.deps).map(([row]) => row)).toEqual(rows.slice(0, 3));
    expect(failure.summary).toMatchObject({ engineStop: true, quotes: 3, engineFailures: 3, priced: 0, byReason: { 'failed/engine': 3 } });
  });

  test('the third failure in a row on the LAST row of a batch still fails the run: a price, then three failures', async () => {
    const rows = Array.from({ length: 4 }, () => makeRow());
    priceHome.mockResolvedValueOnce(PRICED).mockResolvedValue(ENGINE_FAILED);
    const t = setup({ rows });
    const failure = await t.run().catch((err) => err);
    expect(failure.message).toBe('Mail home prices: stopped after 3 price engine failures in a row');
    expect(saved(t.deps)).toHaveLength(4);
    expect(failure.summary).toMatchObject({ engineStop: true, quotes: 4, engineFailures: 3, priced: 1 });
  });

  test('a budget that is spent on the third failure in a row does not hide it', async () => {
    const rows = Array.from({ length: 6 }, () => makeRow());
    priceHome.mockResolvedValueOnce(PRICED).mockResolvedValue(ENGINE_FAILED);
    let clockNow = NOW;
    let saves = 0;
    const t = setup({ rows, savePriceResult: jest.fn(async () => { saves += 1; if (saves === 4) clockNow += BUDGET_MS; return { written: true }; }) });
    const failure = await runHomePrices({ now: () => clockNow, deps: t.deps }).catch((err) => err);
    expect(failure.message).toBe('Mail home prices: stopped after 3 price engine failures in a row');
    expect(failure.summary).toMatchObject({ engineStop: true, budgetSpent: false, quotes: 4 });
  });

  test('three errors in a row on the last rows of a batch set the stop too', async () => {
    const rows = Array.from({ length: 3 }, () => makeRow());
    const t = setup({ rows, permitFacts: jest.fn(async () => { throw Object.assign(new Error('x'), { code: 'ECONNREFUSED' }); }) });
    const failure = await t.run().catch((err) => err);
    expect(failure.message).toBe('Mail home prices: stopped after errors in a row; 3 rows could not be read or saved (ECONNREFUSED: 3)');
    expect(failure.summary.errorStop).toBe(true);
  });

  test('an answer from the engine starts the count again: two failures, a price, two failures do not stop the run or fail it', async () => {
    const rows = Array.from({ length: 5 }, () => makeRow());
    priceHome
      .mockResolvedValueOnce(ENGINE_FAILED).mockResolvedValueOnce(ENGINE_FAILED)
      .mockResolvedValueOnce(PRICED)
      .mockResolvedValueOnce(ENGINE_FAILED).mockResolvedValueOnce(ENGINE_FAILED);
    const summary = await setup({ rows }).run();
    expect(summary).toMatchObject({ engineStop: false, quotes: 5, engineFailures: 4, priced: 1 });
  });

  test('a short run where the engine failed for every home it was asked is a failed run', async () => {
    const [a, b] = [makeRow(), makeRow()];
    priceHome.mockResolvedValue(ENGINE_FAILED);
    const t = setup({ rows: [a, b] });
    const failure = await t.run().catch((err) => err);
    expect(failure.message).toBe('Mail home prices: the price engine failed for every home it was asked (2)');
    expect(saved(t.deps)).toHaveLength(2);
    // A not-clean answer is an answer: a run of only not-clean homes is a good run.
    priceHome.mockResolvedValue({ status: 'not_clean', reason: 'engine_review', ...FACTS });
    expect(await setup({ rows: [makeRow()] }).run()).toMatchObject({ quotes: 1, engineFailures: 0 });
    // A run that asked for no price (a townhouse) is a good run.
    const town = makeRow();
    expect(await setup({ rows: [town], permits: { [town.permit_no]: permitOf({ type_of_work: 'New Townhouse' }) } }).run())
      .toMatchObject({ quotes: 0, engineFailures: 0 });
  });
});

describe('what leaves the module', () => {
  test('the log line and the thrown message hold counts and codes, never a name, address, parcel number or permit number', async () => {
    const rows = [makeRow(), makeRow(), makeRow()];
    homeFacts.factsProblems.mockReturnValue(['the parcel map did not answer (5 failures in a row)']);
    const t = setup({
      rows,
      permitFacts: jest.fn(async (no) => { throw Object.assign(new Error(`failed for ${no} TESTER ALEX J 101 EXAMPLE TRL SAMPLETON 34212`), { code: 'ETIMEDOUT' }); }),
    });
    const failure = await t.run().catch((err) => err);
    const text = [mockLogger.info.mock.calls.map(([line]) => line).join('\n'), failure.message, JSON.stringify(failure.summary)].join('\n');
    expect(text).toContain('Mail home prices');
    expect(text).toContain('ETIMEDOUT');
    for (const row of rows) for (const secret of [row.address_line1, row.parcel_pin, row.permit_no, row.id]) expect(text).not.toContain(secret);
    for (const secret of ['EXAMPLE', 'TESTER', 'SAMPLETON', '34212', 'PIN0', 'PMT-']) expect(text).not.toContain(secret);
    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(mockLogger.error).not.toHaveBeenCalled();
  });
});

describe('the run with the real facts reader and the real quote (their outside calls mocked)', () => {
  // Every outside call of both modules is injected; only the three store calls and the logger are the run's own.
  const lowLevel = (parcels) => ({
    lookupParcel: jest.fn(async (pin) => parcels[pin]),
    fetchPermitPage: jest.fn(async () => ({ status: 'ok', facts: { conditioned_sqft: 2400, stories: 2 } })),
    createThrottle: jest.fn(() => (fn) => fn(Number.MAX_SAFE_INTEGER)),
    recordPermitResult: jest.fn(async () => undefined),
    countPageResult: jest.requireActual('../services/property-lookup/manatee-permit-detail')._private.countResult,
    permitGapMs: jest.fn(() => 2500),
    sleep: jest.fn(async () => undefined),
    buildEngineInput: jest.fn((input) => ({ built: input })),
    dryRunEstimate: jest.fn(async () => ({
      estimate: {
        pricing_authority: 'SERVER', annual_total: '512.34',
        estimate_data: JSON.stringify({ engineResult: { lineItems: [{ service: 'pest_control' }] }, result: { oneTime: { membershipFee: 0 } } }),
      },
    })),
  });
  const useReal = () => {
    homeFacts.createFactsContext.mockImplementation(actualFacts.createFactsContext);
    homeFacts.readHomeFacts.mockImplementation(actualFacts.readHomeFacts);
    homeFacts.factsSummary.mockImplementation(actualFacts.factsSummary);
    homeFacts.factsProblems.mockImplementation(actualFacts.factsProblems);
    priceHome.mockImplementation(actualQuote.priceHome);
  };

  test('a good run: a home the map sizes is priced, a townhouse settles, a home with no lot is missing_fact', async () => {
    useReal();
    const [good, town, noLot] = [makeRow(), makeRow(), makeRow()];
    const parcels = {
      [good.parcel_pin]: { lotSqft: 8000, livingAreaSqft: 1800, stories: 1 },
      [noLot.parcel_pin]: { lotSqft: null, livingAreaSqft: 1800, stories: 1 },
    };
    const t = setup({
      rows: [good, town, noLot],
      permits: { [town.permit_no]: permitOf({ type_of_work: 'New Townhouse' }) },
      ...lowLevel(parcels),
    });
    const summary = await t.run();
    expect(summary).toMatchObject({ due: 3, priced: 1, mapQueries: 2, permitPages: 0, byReason: { 'not_clean/not_single_family': 1, 'missing_fact/no_lot_size': 1 } });
    expect(resultOf(t.deps, good)).toMatchObject({ status: 'priced', priceAnnual: 512.34, priceSetupFee: 0 });
    expect(t.deps.dryRunEstimate).toHaveBeenCalledTimes(1);
  });

  test('the permit page switch off: homes that need the page are left, homes that do not are priced, and the run throws naming the switch', async () => {
    useReal();
    const [needs, fine] = [makeRow(), makeRow()];
    const parcels = {
      [needs.parcel_pin]: { lotSqft: 8000, livingAreaSqft: null, stories: 1 },
      [fine.parcel_pin]: { lotSqft: 8000, livingAreaSqft: 1800, stories: 1 },
    };
    const t = setup({
      rows: [needs, fine],
      permits: { [needs.permit_no]: permitOf({ detail_status: null, detail_fetched_at: null, conditioned_sqft: null, stories: null }) },
      permitPageOn: jest.fn(() => false),
      ...lowLevel(parcels),
    });
    const failure = await t.run().catch((err) => err);
    expect(failure.message).toBe('Mail home prices: the permit page is turned off (GATE_PERMIT_DETAIL_SYNC)');
    expect(failure.summary).toMatchObject({ permitPageOff: true, left: 1, priced: 1 });
    expect(t.deps.fetchPermitPage).not.toHaveBeenCalled();
    expect(saved(t.deps).map(([row]) => row)).toEqual([fine]);
  });

  test('the budget ends between two requests of one permit page read (the real throttle): the home is left untried, not failed, and the run is good', async () => {
    useReal();
    const [needs, later] = [makeRow(), makeRow()];
    const parcels = {
      [needs.parcel_pin]: { lotSqft: 8000, livingAreaSqft: null, stories: 1 },
      [later.parcel_pin]: { lotSqft: 8000, livingAreaSqft: 1800, stories: 1 },
    };
    let clockNow = NOW;
    const sent = [];
    const t = setup({
      rows: [needs, later],
      permits: { [needs.permit_no]: permitOf({ detail_status: null, detail_fetched_at: null, conditioned_sqft: null, stories: null }) },
      permitPageOn: jest.fn(() => true),
      ...lowLevel(parcels),
      createThrottle: jest.requireActual('../services/property-lookup/manatee-permit-detail')._private.createThrottle,
      // Two requests of one page read, as the permit reader sends them: each through the throttle.
      fetchPermitPage: jest.fn(async (_no, { polite }) => {
        await polite(async () => { sent.push('search'); clockNow = NOW + BUDGET_MS; });
        await polite(async () => { sent.push('record'); });
        return { status: 'ok', facts: { conditioned_sqft: 2400, stories: 2 } };
      }),
    });
    const summary = await runHomePrices({ now: () => clockNow, deps: t.deps });
    expect(sent).toEqual(['search']); // the second request is never sent
    expect(summary).toMatchObject({ due: 2, left: 1, priced: 0, budgetSpent: true, permitBudgetStop: true, permitFailuresInARow: 0, permitStopped: false });
    expect(t.deps.recordPermitResult).not.toHaveBeenCalled();
    expect(t.deps.savePriceResult).not.toHaveBeenCalled();
    // On the run's only row too: the summary says the budget was spent.
    clockNow = NOW;
    t.deps.dueForPrice.mockResolvedValue([needs]);
    expect(await runHomePrices({ now: () => clockNow, deps: t.deps })).toMatchObject({ due: 1, left: 1, budgetSpent: true, permitBudgetStop: true });
  });
});
