/**
 * reservice-scheduler.js — loadEligibleReserviceLanes and
 * reportedReserviceLane (Codex round-4 structural fix on PR #5336).
 *
 * loadEligibleReserviceLanes is the ONE "can we mint/promise a re-service
 * link for this customer" predicate: a live (deleted_at IS NULL), active
 * customer row that carries a reservice_token AND has at least one live
 * lane — exactly what the admin composer's /reservice-link route checked
 * per candidate row before this fix, now shared with the SMS FREE
 * RE-SERVICE fact (liveReserviceLaneState/fetchReserviceFactState) and the
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
    expect(reportedReserviceLane('the ants are hurting my lawn treatment')).toBeNull();
    expect(reportedReserviceLane('ants in the yard and weeds in the lawn')).toBeNull();
  });

  // Codex round-22 P2: lawn / grass / yard are LOCATIONS after a location preposition ("on the lawn"), not the lawn service.
  test.each([
    'the ants are in the grass again',
    'ants are back on the lawn',
    'roaches are in the grass again',
    'fleas all over the yard',
    'ants around the front lawn',
  ])('%s → pest (a lawn/grass/yard location, dual-lane account)', (text) => {
    expect(reportedReserviceLane(text)).toBe('pest');
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

// Codex round-6 P1: the tree & shrub half of EXCLUDED_RESERVICE_SPECIALTY_RE
// used to fire on any bare "tree"/"shrub" word, so "the ants are back in the
// shrubs" — an ordinary pest report naming an incidental location — was
// wrongly rejected as an excluded specialty. Specialty now requires genuine
// service-issue phrasing (a tree & shrub service/treatment/care call, the
// trees/shrubs themselves reported sick/dying/diseased, or disease/fungus/
// scale on them); an incidental location (in/on/near/around/under the
// shrubs/trees/bushes) no longer counts, and a pest noun alongside one
// resolves to the pest lane. termite/rodent/mosquito words are unaffected —
// they stay an excluded specialty with no locational exception.
describe('tree & shrub: SERVICE-ISSUE phrasing vs an incidental location (Codex round-6 P1)', () => {
  test.each([
    'the ants are back in the shrubs',
    'bugs near the trees again',
    'ants under the bushes',
    'still finding roaches around the trees',
  ])('%s → resolves to pest (incidental location, not a specialty)', (text) => {
    expect(reportedReserviceExcludedSpecialty(text)).toBe(false);
    expect(reportedReserviceLane(text)).toBe('pest');
  });

  test.each([
    'we need tree and shrub service this month',
    'can you quote a shrub care program',
    'my trees are dying',
    'the trees are diseased',
    'shrub disease is spreading',
    'there is a fungus on the trees',
  ])('%s → true (genuine tree & shrub service-issue phrasing stays a specialty)', (text) => {
    expect(reportedReserviceExcludedSpecialty(text)).toBe(true);
    expect(reportedReserviceLane(text)).toBeNull();
  });

  // Regression: the existing "the shrubs look sick"/"the trees look sick"
  // fixtures above must keep resolving as a genuine specialty, not an
  // incidental location, since this narrowing must not swing the other way.
  // Codex round-9 (PR #5336): the service word may sit on EITHER side of the
  // tree/shrub noun.
  test.each([
    "the treatment for my shrubs didn't work—can I get a lawn re-service?",
    'spray on the trees never took',
    'care of my shrubs was skipped',
    'the shrub spray did nothing',
  ])('tree/shrub service wording on either side is the excluded specialty: %s', (text) => {
    expect(reportedReserviceExcludedSpecialty(text)).toBe(true);
    expect(reportedReserviceLane(text)).toBeNull();
  });

  test('an incidental tree/shrub location with a service word nowhere near still resolves pest', () => {
    expect(reportedReserviceExcludedSpecialty('the ants are back in the shrubs, treatment did not hold')).toBe(false);
  });

  test('a bare tree/shrub health complaint (no pest noun) still resolves as a specialty', () => {
    expect(reportedReserviceExcludedSpecialty('the shrubs look sick')).toBe(true);
    expect(reportedReserviceExcludedSpecialty('the trees look sick')).toBe(true);
  });
});

// Codex round-6 P1: namedReserviceLanesInText (sms-shadow-drafter.js) and
// reportedReserviceLane above must classify a lane word IDENTICALLY —
// RESERVICE_LANE_WORD_PATTERNS is the one exported vocabulary both read.
describe('RESERVICE_LANE_WORD_PATTERNS — the one shared lane vocabulary (Codex round-6 P1)', () => {
  const { RESERVICE_LANE_WORD_PATTERNS } = require('../services/reservice-scheduler');

  test('resolves a broader lawn vocabulary (weed-treatment) the same way reportedReserviceLane does', () => {
    expect(reportedReserviceLane('free weed-treatment re-service link')).toBe('lawn');
    const named = RESERVICE_LANE_WORD_PATTERNS.filter(([, rx]) => rx.test('free weed-treatment re-service link')).map(([lane]) => lane);
    expect(named).toEqual(['lawn']);
  });

  // Codex round-15 P2 (PR #5336): the drafter's pest-report prescreen and the lane vocabulary share one noun list.
  test.each(['earwigs are back', 'centipedes still in the house', 'millipedes everywhere', 'a palmetto bug came back'])('%s → pest lane', (text) => {
    expect(reportedReserviceLane(text)).toBe('pest');
  });

  test('every noun the pest-report prescreen accepts (bar the excluded specialties) resolves to the pest lane', () => {
    const { PEST_REPORT_TEXT_RE } = require('../services/sms-shadow-drafter');
    for (const noun of ['ants', 'roaches', 'spiders', 'fleas', 'ticks', 'wasps', 'bees', 'silverfish', 'scorpions', 'earwigs', 'centipedes', 'millipedes', 'bugs', 'pests']) {
      const text = `${noun} are back`;
      expect(PEST_REPORT_TEXT_RE.test(text)).toBe(true);
      expect(reportedReserviceLane(text)).toBe('pest');
    }
  });

  test('pest is checked before lawn, matching this module\'s own [\'pest\', \'lawn\'] ordering convention', () => {
    expect(RESERVICE_LANE_WORD_PATTERNS.map(([lane]) => lane)).toEqual(['pest', 'lawn']);
  });
});


// Codex round-21 P2 (PR #5336)
describe('reportedReserviceLane — "yard" is a location unless service-qualified', () => {
  const { reportedReserviceLane, RESERVICE_LAWN_SERVICE_WORDS } = require('../services/reservice-scheduler');
  test.each([
    ['ants are back in the yard', 'pest'],
    ['there are roaches in my yard again', 'pest'],
    ['yard treatment did not work', 'lawn'],
    ['service for my yard was missed', 'lawn'],
    ['weeds all over the yard', 'lawn'],
    ['ants in the yard and weeds in the lawn', null],
  ])('%s → %s', (text, lane) => {
    expect(reportedReserviceLane(text)).toBe(lane);
  });

  test('the lawn SERVICE words are the same list the outgoing promise classifier reads', () => {
    jest.resetModules();
    const drafter = require('../services/sms-shadow-drafter');
    // an outgoing promise naming "yard" alone names no lane; each scheduler service word names lawn on both sides
    expect(drafter.namedReserviceLanesInText('We will send your free re-service for the ants in your yard.')).toEqual(['pest']);
    for (const word of ['lawn', 'turf', 'weeds', 'fertilizer', 'fertilization', 'mowing', 'sod']) {
      expect(reportedReserviceLane(`my ${word} looks bad`)).toBe('lawn');
      expect(drafter.namedReserviceLanesInText(`We will send your free ${word} re-service link.`)).toEqual(['lawn']);
    }
    expect(RESERVICE_LAWN_SERVICE_WORDS).toBe('lawn|turf|weeds?|fert|fertili[sz]er|fertili[sz]ation|mow(?:ing)?|sod');
  });

  test('loadEligibleReserviceLanesStrict throws on a lookup error but returns [] for a genuinely ineligible row', async () => {
    const { loadEligibleReserviceLanesStrict } = require('../services/reservice-scheduler');
    const failingDb = () => { throw new Error('db down'); };
    await expect(loadEligibleReserviceLanesStrict('c1', failingDb)).rejects.toThrow('db down');
    const noRow = () => ({ where: () => ({ whereNull: () => ({ first: async () => undefined }) }) });
    await expect(loadEligibleReserviceLanesStrict('c1', noRow)).resolves.toEqual([]);
  });
});


// Codex round-22 (PR #5336): ONE clause-level classifier — [text, active pest report?, lane, excluded specialty?].
// PEST_REPORT_TEXT_RE, needsOpenTimes and reportedPestLane all read it (sms-shadow-drafter), so this table is
// the contract. A negated / resolved clause contributes nothing; other clauses still count.
describe('clause-level pest-report classifier (isActivePestReport / reportedReserviceLane / reportedReserviceExcludedSpecialty)', () => {
  const { isActivePestReport } = require('../services/reservice-scheduler');
  const ROWS = [
    // resolved clause + active clause
    ['ants are gone and spiders are back', true, 'pest', false],
    ['the ants are gone but I still see roaches', true, 'pest', false],
    ['no ants in the kitchen anymore but the wasps are back', true, 'pest', false],
    // negated specialty + active pest
    ["It's not termites—the ants are back", true, 'pest', false],
    ["it isn't rodents, it's the roaches coming back", true, 'pest', false],
    // lawn / grass / yard are locations
    ['ants are back on the lawn', true, 'pest', false],
    ['roaches are in the grass again', true, 'pest', false],
    ['fleas are everywhere in the yard', true, 'pest', false],
    // informational, not a report
    ['Can someone call me back about my ant service?', false, 'pest', false],
    ['Tell me more about ants', false, 'pest', false],
    ['Are ants still included in my plan?', false, 'pest', false],
    ['we have ants under contract', false, 'pest', false],
    ['I have a pest control plan', false, 'pest', false],
    // negated / resolved
    ["I don't see ants anymore", false, null, false],
    ['the ants are gone, thank you', false, null, false],
    ['thanks, no bugs since!', false, null, false],
    ['no more spiders in the house', false, null, false],
    ["haven't noticed a single wasp lately", false, null, false],
    // persisting / affirmative
    ["still see ants, they didn't go away", true, 'pest', false],
    ['I still see ants in the kitchen', true, 'pest', false],
    ['saw ants again this morning', true, 'pest', false],
    ['found more ants again', true, 'pest', false],
    ['the roaches have returned', true, 'pest', false],
    ['more ants showed up after the treatment', true, 'pest', false],
    ['the ants came back', true, 'pest', false],
    // negated resolution = PERSISTENCE (Codex round-23 P2); an un-negated one is still resolved
    ['the ants never went away', true, 'pest', false],
    ["the ants didn't go away", true, 'pest', false],
    ["the ants haven't stopped", true, 'pest', false],
    ["the ants won't go away", true, 'pest', false],
    ['the ants are gone', false, null, false],
    ['the ants stopped', false, null, false],
    ['Why are the ants back?', true, 'pest', false],
    // round-24 P2: the lane comes from the ACTIVE clause; possession / persistence constructions are sightings
    ['My lawn service is Tuesday, and the ants are back', true, 'pest', false],
    ["my lawn treatment was skipped but I don't see ants anymore", false, 'lawn', false],
    ['I still have ants', true, 'pest', false],
    ["I'm still getting ants", true, 'pest', false],
    ['we have so many ants in here', true, 'pest', false],
    ['I keep seeing roaches', true, 'pest', false],
    ['weeds are taking over the lawn and the roaches are back', true, 'pest', false],
    // round-25 P2: specialties are judged in the active-report clause(s) only
    ['My termite inspection is Tuesday, and the ants are back', true, 'pest', false],
    ['my rodent trapping follow-up is booked but the roaches are back', true, 'pest', false],
    ['the termites are back, and my lawn service is Tuesday', true, null, true],
    // excluded specialties, affirmed
    ['the termites are back', true, null, true],
    ['rats in the attic again', true, null, true],
    ['the shrubs look sick', false, null, true],
    // lawn service
    ['weeds all over my lawn', false, 'lawn', false],
    ['the grass is looking bad again', false, 'lawn', false],
    ['my yard treatment did not work', false, 'lawn', false],
    // genuinely ambiguous
    ['ants in the yard and weeds in the lawn', false, null, false],
  ];
  test.each(ROWS)('%s → active=%s lane=%s specialty=%s', (text, active, lane, specialty) => {
    expect(isActivePestReport(text)).toBe(active);
    expect(reportedReserviceLane(text)).toBe(lane);
    expect(reportedReserviceExcludedSpecialty(text)).toBe(specialty);
  });

  test('the drafter\'s PEST_REPORT_TEXT_RE is that same classifier', () => {
    const { PEST_REPORT_TEXT_RE } = require('../services/sms-shadow-drafter');
    for (const [text, active] of ROWS) expect(PEST_REPORT_TEXT_RE.test(text)).toBe(active);
  });
});


// Codex round-24 P2: the persistence constructions have ONE source (services/pest-persistence-phrases), read by both
// SAVE_SALE_TEXT_RE (routing + OPEN TIMES) and this classifier.
describe('persistence constructions share one source', () => {
  const { PEST_PERSISTENCE_PHRASES_SOURCE } = require('../services/pest-persistence-phrases');
  const { SAVE_SALE_TEXT_RE } = require('../services/sms-shadow-drafter');
  const { isActivePestReport, mentionsAffirmed } = require('../services/reservice-scheduler');
  test.each(['still seeing', 'still have', 'still having', 'still getting', 'still got', 'still finding', 'keep seeing', 'keep coming'])('"%s"', (phrase) => {
    expect(new RegExp(`\\b(?:${PEST_PERSISTENCE_PHRASES_SOURCE})\\b`, 'i').test(phrase)).toBe(true);
    expect(SAVE_SALE_TEXT_RE.test(`I ${phrase} ants`)).toBe(true);
    expect(isActivePestReport(`I ${phrase} ants`)).toBe(true);
  });

  test('mentionsAffirmed: a negated hand-off term does not count, an affirmed one does', () => {
    const re = /\b(?:cancel\w*|refund\w*)\b/i;
    for (const t of ["I don't need a refund, the ants are back", "I don't want to cancel; ants are back", 'do not cancel my plan', 'no need to cancel']) expect(mentionsAffirmed(t, re)).toBe(false);
    for (const t of ['I want a refund', 'the ants are back, cancel my service', 'I am going to cancel']) expect(mentionsAffirmed(t, re)).toBe(true);
  });
});
