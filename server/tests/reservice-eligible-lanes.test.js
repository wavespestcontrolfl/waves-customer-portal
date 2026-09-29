/**
 * reservice-scheduler.js — loadEligibleReserviceLanes and
 * reportedReserviceLane (Codex round-4 structural fix on PR #5336).
 *
 * loadEligibleReserviceLanes is the ONE "can we mint/promise a re-service
 * link for this customer" predicate: a live (deleted_at IS NULL), active
 * customer row that carries a reservice_token AND has at least one live
 * lane — exactly what the admin composer's /reservice-link route checked
 * per candidate row before this fix, now shared with the SMS FREE
 * RE-SERVICE fact (liveReserviceLanes/fetchReserviceLanes) and the
 * send-time promise recheck (reservicePromiseStillEligible) so none of
 * them can disagree about who staff can actually send a link to.
 *
 * reportedReserviceLane is the re-service mechanism's OWN free-text lane
 * classifier for a customer's reported issue — deliberately separate from
 * sms-service-intent.js's lead-intake regexClassify, which lumps
 * termite/rodent/mosquito words into a single 'pest' bucket that the
 * re-service lane split (laneForCoverageRow) categorically excludes.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

// A minimal chainable/thenable fake knex query: every builder method returns
// the same object, and awaiting it resolves to the rows it was constructed
// with. Good enough for loadEligibleReserviceLanes's needs — it never
// exercises the coverage-row filtering itself (that's
// reservice-scheduler-lane.test.js's job); here the 'scheduled_services as s'
// rows are exactly what the test wants laneForCoverageRow to classify.
function fakeQuery(rows) {
  const q = {
    leftJoin: () => q,
    where: () => q,
    whereNotIn: () => q,
    whereNull: () => q,
    modify: (fn) => { fn(q); return q; },
    select: () => q,
    limit: () => q,
    orderBy: () => q,
    forUpdate: () => q,
    first: async () => (Array.isArray(rows) ? rows[0] || null : rows),
    then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
  };
  return q;
}

function makeDb({ customerRow, scheduledRows = [] } = {}) {
  return jest.fn((table) => {
    if (table === 'customers') return fakeQuery(customerRow);
    if (table === 'scheduled_services as s') return fakeQuery(scheduledRows);
    if (table === 'scheduled_services as hist') return fakeQuery([]); // membership evidence path, unused here
    throw new Error(`fakeDb: unexpected table ${table}`);
  });
}

const { loadEligibleReserviceLanes, reportedReserviceLane, reportedReserviceExcludedSpecialty } = require('../services/reservice-scheduler');

const PEST_COVERAGE_ROW = { service_type: 'Quarterly Pest Control', is_callback: false, service_key: null, category: 'pest_control' };

describe('loadEligibleReserviceLanes', () => {
  test('no customerId → [] without querying', async () => {
    const dbh = makeDb({ customerRow: null });
    await expect(loadEligibleReserviceLanes(null, dbh)).resolves.toEqual([]);
    expect(dbh).not.toHaveBeenCalled();
  });

  test('active, token-bearing customer with a qualifying lane → eligible', async () => {
    const dbh = makeDb({
      customerRow: { id: 'cu-1', active: true, reservice_token: 'a'.repeat(40) },
      scheduledRows: [PEST_COVERAGE_ROW],
    });
    await expect(loadEligibleReserviceLanes('cu-1', dbh)).resolves.toEqual(['pest']);
  });

  test('missing customer row (never existed) → []', async () => {
    const dbh = makeDb({ customerRow: null, scheduledRows: [PEST_COVERAGE_ROW] });
    await expect(loadEligibleReserviceLanes('cu-1', dbh)).resolves.toEqual([]);
  });

  test('inactive customer → [] even with a qualifying lane', async () => {
    const dbh = makeDb({
      customerRow: { id: 'cu-1', active: false, reservice_token: 'a'.repeat(40) },
      scheduledRows: [PEST_COVERAGE_ROW],
    });
    await expect(loadEligibleReserviceLanes('cu-1', dbh)).resolves.toEqual([]);
  });

  test('tokenless customer (pre-backfill row) → [] even with a qualifying lane', async () => {
    const dbh = makeDb({
      customerRow: { id: 'cu-1', active: true, reservice_token: null },
      scheduledRows: [PEST_COVERAGE_ROW],
    });
    await expect(loadEligibleReserviceLanes('cu-1', dbh)).resolves.toEqual([]);
  });

  test('active, tokened customer with no qualifying lane (e.g. mosquito-only) → []', async () => {
    const dbh = makeDb({
      customerRow: { id: 'cu-1', active: true, reservice_token: 'a'.repeat(40) },
      scheduledRows: [{ service_type: 'Mosquito Control', is_callback: false, service_key: null, category: null }],
    });
    await expect(loadEligibleReserviceLanes('cu-1', dbh)).resolves.toEqual([]);
  });

  test('a lookup error fails CLOSED, not throws', async () => {
    const dbh = jest.fn(() => { throw new Error('boom'); });
    await expect(loadEligibleReserviceLanes('cu-1', dbh)).resolves.toEqual([]);
  });
});

describe('reportedReserviceLane', () => {
  test('resolves plain pest and lawn wording', () => {
    expect(reportedReserviceLane('the ants are back')).toBe('pest');
    expect(reportedReserviceLane('the grass is looking bad again')).toBe('lawn');
  });

  // Codex round-4 P2: termite/rodent/mosquito words must NEVER resolve to
  // the pest lane, even though they read as pest-adjacent language —
  // reservice-scheduler's own laneForCoverageRow excludes those specialties
  // from the self-bookable pest lane, and this classifier must agree.
  test.each([
    'the termites are back',
    'saw a mosquito problem again',
    'rats in the attic again',
    'there is a mouse in the garage',
    'the shrubs look sick',
  ])('%s → null (an excluded specialty, never the pest lane)', (text) => {
    expect(reportedReserviceLane(text)).toBeNull();
  });

  test('ambiguous (both pest and lawn words) → null', () => {
    expect(reportedReserviceLane('the ants are in the grass again')).toBeNull();
  });

  test('no resolvable wording → null', () => {
    expect(reportedReserviceLane('can you come back out?')).toBeNull();
    expect(reportedReserviceLane('')).toBeNull();
    expect(reportedReserviceLane(null)).toBeNull();
  });
});

// Codex round-5 P1: validateReserviceOffer needs to tell an excluded
// specialty apart from an ambiguous/unresolved report — reportedReserviceLane
// folds both into the same null, so this is its own exported check.
describe('reportedReserviceExcludedSpecialty', () => {
  test.each([
    'the termites are back',
    'saw a mosquito problem again',
    'rats in the attic again',
    'there is a mouse in the garage',
    'the shrubs look sick',
    'the trees look sick',
  ])('%s → true', (text) => {
    expect(reportedReserviceExcludedSpecialty(text)).toBe(true);
  });

  test.each([
    'the ants are back',
    'the grass is looking bad again',
    'can you come back out?',
    '',
    null,
    undefined,
  ])('%s → false', (text) => {
    expect(reportedReserviceExcludedSpecialty(text)).toBe(false);
  });
});
