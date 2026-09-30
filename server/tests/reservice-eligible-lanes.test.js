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
    'crickets all over the yard',
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
    for (const noun of ['ants', 'roaches', 'spiders', 'wasps', 'silverfish', 'scorpions', 'earwigs', 'centipedes', 'millipedes', 'bugs', 'pests']) {
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
    const { TURF_INSECT_NOUN_SOURCES } = require('../services/covered-pests');
    expect(RESERVICE_LAWN_SERVICE_WORDS).toBe(`lawn|turf|weeds?|fert|fertili[sz]er|fertili[sz]ation|mow(?:ing)?|sod|${TURF_INSECT_NOUN_SOURCES.join('|')}`);
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
    ['crickets are everywhere in the yard', true, 'pest', false],
    ['fleas are everywhere in the yard', true, null, true], // fleas are a "Separate services" pest (round-31)
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
    // round-26 P2: bed bugs are an excluded specialty; persistence grammar covers "keep getting/finding/having"
    ['bed bugs are back', true, null, true],
    ['the bedbugs came back', true, null, true],
    ["it's not bed bugs, the ants are back", true, 'pest', false],
    ['We keep getting ants', true, 'pest', false],
    ['we keep finding roaches in the kitchen', true, 'pest', false],
    ['we keep having spiders', true, 'pest', false],
    // round-27 P2: plain possession, epistemic negation, later pronoun resolution
    ['I have ants', true, 'pest', false],
    ["we've got roaches", true, 'pest', false],
    ['we have ants under contract', false, 'pest', false],
    ['we have ants covered in our plan', false, 'pest', false],
    ['we have ants on our plan', false, 'pest', false],
    ["I can't believe the ants are back", true, 'pest', false],
    ["I don't know why ants are back", true, 'pest', false],
    ["I'm not sure why the roaches are back", true, 'pest', false],
    ['I saw ants yesterday, but they are gone now', false, null, false],
    ['found roaches this morning but they disappeared', false, null, false],
    ['ants are gone but roaches are back', true, 'pest', false],
    ['I saw ants yesterday, but the spiders are gone now', true, 'pest', false],
    ['I saw ants yesterday and they are back today', true, 'pest', false],
    // round-28 P2: coordinated nouns, narrowed epistemic exemption, questions/hypotheticals, "left"
    ['termites and ants are back', true, null, true],
    ['ants and spiders are back', true, 'pest', false],
    ["I don't think ants are back", false, null, false],
    ["I don't believe ants are back", false, null, false],
    ["I'm not sure ants are back", false, null, false],
    ["I'm not sure why the ants are back", true, 'pest', false],
    ['Are the ants back?', false, 'pest', false],
    ['Can you tell me if ants are back?', false, 'pest', false],
    ['If ants are back, what should I do?', false, 'pest', false],
    ['Why are the ants back?', true, 'pest', false],
    ['I still have ants left', true, 'pest', false],
    ['There are still roaches left', true, 'pest', false],
    ['The roaches left droppings again', true, 'pest', false],
    ['the ants all left the house', false, null, false],
    ['they left', false, null, false],
    ['ants left for good', false, null, false],
    ["the ants haven't left", true, 'pest', false],
    // round-29 P2: comma-coordinated lists share the predicate; if/whether scoped to the pest activity
    ['termites, ants, and roaches are back', true, null, true],
    ['ants, roaches and spiders are back', true, 'pest', false],
    ['ants, spiders, and termites came back', true, null, true],
    ['ants are back, roaches are back', true, 'pest', false],
    ['Ants are back if you can believe it', true, 'pest', false],
    ['ants are back, whether you believe it or not', true, 'pest', false],
    ['Tell me whether the roaches are back', false, 'pest', false],
    // round-30 P2: an opener is an auxiliary + SUBJECT, never a contraction / subjectless shorthand
    ["Can't believe the ants are back", true, 'pest', false],
    ['Can confirm the ants are back', true, 'pest', false],
    ['Could not believe the ants are back', true, 'pest', false],
    ['Can someone check, the ants are back', true, 'pest', false],
    ['Can you tell me if ants are back?', false, 'pest', false],
    ['Is it the ants again?', false, 'pest', false],
    ['Do you spray for ants?', false, 'pest', false],
    ['Are ants back?', false, 'pest', false],
    // round-31 P2: the covered-pest list (services/covered-pests.js) — crickets, pillbugs & synonyms, stink / boxelder bugs
    ['crickets are back', true, 'pest', false],
    ['the pillbugs are back', true, 'pest', false],
    ['roly-polies everywhere again', true, 'pest', false],
    ['sowbugs came back', true, 'pest', false],
    ['stink bugs are back', true, 'pest', false],
    ['boxelder bugs are back', true, 'pest', false],
    ['bed bugs are back', true, null, true],
    // round-32 P2: object-position noun pairs, subjectless coordinated predicates, historical possession
    ['I do not have termites and ants are back', true, 'pest', false],
    ['we saw no termites and ants are back', true, 'pest', false],
    ['termites and ants are back', true, null, true],
    ['The ants went away and came back', true, 'pest', false],
    ['The ants are gone and are coming back', true, 'pest', false],
    ['The ants went away', false, null, false],
    ['Last year I had ants. What did you use?', false, 'pest', false],
    ['we used to have ants', false, 'pest', false],
    ['I had ants last year', false, 'pest', false],
    ['I had ants yesterday', true, 'pest', false],
    ['I have ants', true, 'pest', false],
    // round-33 P2: shared-verb coordinated objects keep both nouns (specialty detected); TURF insects are LAWN
    ['I have ants and termites', true, null, true],
    ['I saw ants and termites', true, null, true],
    ['I found ants and bed bugs', true, null, true],
    ['I saw ants and termites in the attic', true, null, true],
    ['I do not have termites and ants are back', true, 'pest', false],
    ['chinch bugs are back', true, 'lawn', false],
    ['mole crickets are back', true, 'lawn', false],
    ['the white grubs are back', true, 'lawn', false],
    ['sod webworms came back', true, 'lawn', false],
    ['armyworms are everywhere', true, 'lawn', false],
    ['crickets are back', true, 'pest', false],
    ['the bugs are back', true, 'pest', false],
    ['chinch bugs and ants are back', true, null, false],
    // round-35 P2: mosquito plurals; the past-time guard applies to every activity pattern
    ['mosquitos are back', true, null, true],
    ['the mosquitoes came back', true, null, true],
    ['a mosquito problem again', true, null, true],
    ['Last year the ants came back. What did you use?', false, 'pest', false],
    ['Last year the ants were everywhere', false, 'pest', false],
    ['Last year I saw roaches in the kitchen', false, 'pest', false],
    ['ants came back last year and are still here', true, 'pest', false],
    ['the ants came back last week', true, 'pest', false],
    ['the ants are back again this week', true, 'pest', false],
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
  test.each(['still seeing', 'still have', 'still having', 'still getting', 'still got', 'still finding', 'keep seeing', 'keep coming', 'keep getting', 'keep finding', 'keep having'])('"%s"', (phrase) => {
    expect(new RegExp(`\\b(?:${PEST_PERSISTENCE_PHRASES_SOURCE})\\b`, 'i').test(phrase)).toBe(true);
    expect(SAVE_SALE_TEXT_RE.test(`I ${phrase} ants`)).toBe(true);
    expect(isActivePestReport(`I ${phrase} ants`)).toBe(true);
  });

  test('mentionsAffirmed: a negated hand-off term does not count, an affirmed one does', () => {
    const re = /\b(?:cancel\w*|refund\w*)\b/i;
    for (const t of ["I don't need a refund, the ants are back", "I don't want to cancel; ants are back", 'do not cancel my plan', 'no need to cancel', "A refund isn't needed—the ants are back", "cancellation isn't what I want", "a refund is not necessary", "refund won't be needed"]) expect(mentionsAffirmed(t, re)).toBe(false);
    for (const t of ['I want a refund', 'the ants are back, cancel my service', 'I am going to cancel', 'I want a refund not a credit', 'a refund is needed']) expect(mentionsAffirmed(t, re)).toBe(true);
  });
});


// Codex round-31 P2: the pest nouns have ONE source (services/covered-pests.js), tied to the estimate copy's covered list.
describe('covered-pest noun source', () => {
  const { COVERED_PEST_NOUN_SOURCES } = require('../services/covered-pests');
  const { RESERVICE_PEST_NOUNS_SOURCE, reportedReserviceLane, reportedReserviceExcludedSpecialty } = require('../services/reservice-scheduler');
  const { SERVICE_DETAILS_COPY } = require('../services/estimate-service-details');

  const coveredRow = () => {
    const found = [];
    const walk = (o) => {
      if (Array.isArray(o)) { if (o[0] === 'Covered pests' && typeof o[1] === 'string') found.push(o[1]); o.forEach(walk); } else if (o && typeof o === 'object') Object.values(o).forEach(walk);
    };
    walk(SERVICE_DETAILS_COPY);
    return found[0];
  };

  test('the scheduler noun source is built from the shared list', () => {
    expect(RESERVICE_PEST_NOUNS_SOURCE).toBe(COVERED_PEST_NOUN_SOURCES.join('|'));
  });

  // The pests under the copy's "Separate services" row are derived from it (services/covered-pests.js) — never a free
  // general-pest re-service. ticks / bees / hornets are in NEITHER row of the copy and keep their prior pest-noun handling.
  test('every pest under "Separate services" is an excluded specialty (lane null), derived from the copy', () => {
    const { SEPARATE_SERVICE_ITEMS, SEPARATE_SERVICE_PEST_NOUN_SOURCES } = require('../services/covered-pests');
    expect(SEPARATE_SERVICE_ITEMS).toEqual(['german-roach cleanouts', 'fleas', 'bed bugs', 'rodents', 'wildlife', 'turf insect programs']);
    expect(SEPARATE_SERVICE_PEST_NOUN_SOURCES.length).toBe(5); // "turf insect programs" is a program, not a pest noun
    for (const text of ['the fleas are back', 'German roaches are back', 'the german cockroaches came back', 'bed bugs are back', 'rats are back', 'the rodents are back', 'wildlife is back in the attic', 'we keep seeing fleas']) {
      expect(reportedReserviceLane(text)).toBeNull();
      expect(reportedReserviceExcludedSpecialty(text)).toBe(true);
    }
    // a plain roach report (no "German") and the covered pests stay pest
    expect(reportedReserviceLane('the roaches are back')).toBe('pest');
    // a negated separate service is not the specialty
    expect(reportedReserviceExcludedSpecialty("it's not fleas, the ants are back")).toBe(false);
    // the covered noun list no longer contains fleas
    expect(RESERVICE_PEST_NOUNS_SOURCE).not.toMatch(/flea/);
  });

  // Codex round-34 P2: the classifier that requires the covered re-service reads ONLY the covered row (plus synonyms).
  // Catalog-sold separate pests (ticks: tick_control / flea_tick; bees: bee_wasp_removal) are excluded specialties.
  test('ticks and bees are catalog-sold separate services → excluded specialties (lane null), not a covered re-service report', () => {
    const { CATALOG_SEPARATE_PEST_ITEM_SOURCES, CATALOG_SEPARATE_PEST_NOUN_SOURCES } = require('../services/covered-pests');
    expect(Object.keys(CATALOG_SEPARATE_PEST_ITEM_SOURCES).sort()).toEqual(['bee_wasp_removal', 'flea_tick', 'tick_control']);
    expect(CATALOG_SEPARATE_PEST_NOUN_SOURCES).toHaveLength(2);
    // each key really is a service the catalog sells (migrations)
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(__dirname, '../models/migrations');
    const all = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
    for (const key of Object.keys(CATALOG_SEPARATE_PEST_ITEM_SOURCES)) expect(all).toContain(`'${key}'`);
    for (const text of ['the ticks are back', 'ticks are everywhere again', 'the bees are back', 'honeybees are back', 'we keep seeing bees', 'we found ticks']) {
      expect(reportedReserviceLane(text)).toBeNull();
      expect(reportedReserviceExcludedSpecialty(text)).toBe(true);
    }
    // the covered nouns no longer include them; wasps (covered) and hornets (a wasp synonym) stay pest
    expect(RESERVICE_PEST_NOUNS_SOURCE).not.toMatch(/ticks|bees/);
    for (const noun of ['wasps', 'hornets']) expect(reportedReserviceLane(`the ${noun} are back`)).toBe('pest');
  });

  test('every pest the estimate copy lists as covered resolves to the pest lane (and specialties do not)', () => {
    const row = coveredRow();
    expect(row).toMatch(/pillbugs/);
    const nouns = { ants: 'ants', roaches: 'roaches', 'palmetto bugs': 'palmetto bugs', spiders: 'spiders', crickets: 'crickets', earwigs: 'earwigs', silverfish: 'silverfish', millipedes: 'millipedes', centipedes: 'centipedes', pillbugs: 'pillbugs', scorpions: 'scorpions', wasps: 'wasps', 'stink & boxelder bugs': null };
    for (const [key, noun] of Object.entries(nouns)) {
      expect(row.toLowerCase()).toContain(key.toLowerCase().split(' ')[0]);
      if (noun) expect(reportedReserviceLane(`the ${noun} are back`)).toBe('pest');
    }
    for (const noun of ['stink bugs', 'boxelder bugs', 'sowbugs', 'roly-polies', 'cockroaches']) expect(reportedReserviceLane(`the ${noun} are back`)).toBe('pest');
    // the separate services in that copy stay out of the pest lane
    for (const noun of ['termites', 'rodents', 'bed bugs', 'mosquitoes', 'fleas', 'German roaches', 'wildlife']) {
      expect(reportedReserviceLane(`the ${noun} are back`)).toBeNull();
      expect(reportedReserviceExcludedSpecialty(`the ${noun} are back`)).toBe(true);
    }
  });
});


// Codex round-32 P2: open callbacks are loaded independently of current eligibility.
describe('reserviceLaneAvailability — open callbacks survive a coverage change', () => {
  const { reserviceLaneAvailability } = require('../services/reservice-scheduler');
  const fakeDb = (callbackRows) => {
    let mode = 'coverage';
    const chain = {};
    for (const m of ['leftJoin', 'where', 'whereIn', 'whereNotIn', 'modify', 'select', 'limit', 'forUpdate', 'orWhere', 'orWhereIn']) chain[m] = () => chain;
    chain.orderBy = () => { mode = 'callbacks'; return chain; };
    chain.then = (resolve) => Promise.resolve(mode === 'callbacks' ? callbackRows : []).then(resolve);
    return () => chain;
  };
  const rows = [{ id: 'r1', scheduled_date: '2099-01-05', window_start: '09:00', window_end: '11:00', service_type: 'Pest Control Re-Service', reschedule_token: 't1', service_key: 'pest_re_service' }];

  test('a customer with NO current coverage still reports the open pest callback (bookable stays empty)', async () => {
    const out = await reserviceLaneAvailability({ id: 'cust-1', active: true, waveguard_tier: null, monthly_rate: 0 }, fakeDb(rows));
    expect(out.eligible).toEqual([]);
    expect(Object.keys(out.open)).toEqual(['pest']);
    expect(out.open.pest.date).toBe('2099-01-05');
    expect(out.bookable).toEqual([]);
  });

  test('an inactive customer keeps the open callback too; nothing is newly bookable', async () => {
    const out = await reserviceLaneAvailability({ id: 'cust-1', active: false }, fakeDb(rows));
    expect(out.eligible).toEqual([]);
    expect(Object.keys(out.open)).toEqual(['pest']);
    expect(out.bookable).toEqual([]);
  });

  test('the SMS fact state renders the lane as ALREADY BOOKED even though it is no longer eligible', async () => {
    jest.resetModules();
    process.env.GATE_SMS_REAL_ANSWERS = 'true';
    const actual = jest.requireActual('../services/reservice-scheduler');
    jest.doMock('../services/reservice-scheduler', () => ({ ...actual, reserviceSelfServeEnabled: () => true, loadReserviceLaneAvailability: async () => ({ eligible: [], open: { pest: { date: '2026-10-08', windowStart: '09:00' } }, bookable: [], verified: true }) }));
    const drafter = require('../services/sms-shadow-drafter');
    const state = await drafter.fetchReserviceFactState({ customerId: 'cust-1' });
    delete process.env.GATE_SMS_REAL_ANSWERS;
    jest.dontMock('../services/reservice-scheduler');
    jest.resetModules();
    expect(state.booked).toEqual({ pest: { date: '2026-10-08', windowStart: '09:00' } });
    expect(state.lanes).toEqual([]);
  });
});


// Codex round-33 P2: TURF insects come from the lawn copy's "Covered turf insects" row (single source, like covered-pests).
describe('turf insects are LAWN-lane, derived from the lawn copy', () => {
  const { TURF_INSECT_ITEMS, TURF_INSECT_NOUN_SOURCES } = require('../services/covered-pests');
  const { reportedReserviceLane, isActivePestReport } = require('../services/reservice-scheduler');
  test('the derived items equal the copy row and every one resolves to lawn before the generic bug / cricket nouns', () => {
    expect(TURF_INSECT_ITEMS).toEqual(['chinch bugs', 'sod webworms', 'armyworms', 'white grubs', 'mole crickets']);
    expect(TURF_INSECT_NOUN_SOURCES).toHaveLength(5);
    for (const noun of ['chinch bugs', 'sod webworms', 'webworms', 'armyworms', 'army worms', 'white grubs', 'grubs', 'mole crickets']) {
      expect(reportedReserviceLane(`the ${noun} are back`)).toBe('lawn');
      expect(isActivePestReport(`the ${noun} are back`)).toBe(true);
    }
    // the outgoing promise classifier reads the same words
    const drafter = require('../services/sms-shadow-drafter');
    expect(drafter.namedReserviceLanesInText('We will send your free chinch bug re-service link.')).toEqual(['lawn']);
    expect(drafter.namedReserviceLanesInText('We will send your free mole cricket re-service link.')).toEqual(['lawn']);
    expect(drafter.namedReserviceLanesInText('We will send your free cricket re-service link.')).toEqual(['pest']);
  });
});

// Codex round-33 P2: "no supported lane" is not "no plan" — a termite / mosquito / tree-and-shrub recurring customer is a plan customer.
describe('reserviceLaneAvailability — hasRecurringPlan (the affirmative prospect evidence)', () => {
  const { reserviceLaneAvailability } = require('../services/reservice-scheduler');
  const fakeDb = ({ recurringRow = null, throwOnRecurring = false } = {}) => {
    let kind = 'coverage';
    const chain = {};
    for (const m of ['leftJoin', 'where', 'whereIn', 'whereNotIn', 'modify', 'select', 'limit', 'forUpdate', 'orWhere', 'orWhereIn', 'whereNull']) chain[m] = () => chain;
    chain.orderBy = () => { kind = 'callbacks'; return chain; };
    chain.first = async () => { if (throwOnRecurring) throw new Error('db down'); return recurringRow; };
    chain.then = (resolve) => Promise.resolve([]).then(resolve);
    return () => chain;
  };
  const customer = { id: 'cust-1', active: true, waveguard_tier: null, monthly_rate: 0 };

  test('no coverage, no membership, no recurring row of ANY kind → false (a prospect)', async () => {
    expect((await reserviceLaneAvailability(customer, fakeDb())).hasRecurringPlan).toBe(false);
  });
  test('a recurring row of another kind (termite / mosquito / tree & shrub) → true with no supported lane', async () => {
    const out = await reserviceLaneAvailability(customer, fakeDb({ recurringRow: { id: 'row-1' } }));
    expect(out.eligible).toEqual([]);
    expect(out.hasRecurringPlan).toBe(true);
  });
  test('a membership row (tier / monthly rate) → true', async () => {
    expect((await reserviceLaneAvailability({ ...customer, waveguard_tier: 'Gold' }, fakeDb())).hasRecurringPlan).toBe(true);
    expect((await reserviceLaneAvailability({ ...customer, monthly_rate: 45 }, fakeDb())).hasRecurringPlan).toBe(true);
  });
  test('a lookup error: strict rethrows; non-strict reports null (unknown)', async () => {
    await expect(reserviceLaneAvailability(customer, fakeDb({ throwOnRecurring: true }), { strict: true })).rejects.toThrow('db down');
    expect((await reserviceLaneAvailability(customer, fakeDb({ throwOnRecurring: true }))).hasRecurringPlan).toBeNull();
  });
});


// Codex round-35 (CI): covered-pests' load-time copy derivation must NEVER throw. Main's reworked lawn copy renamed the
// "Covered turf insects" row to "Covered insects"; the old load-time throw took down every request path that loaded the
// scheduler (request-app-receipts-postgres: 500s). Drift now falls back to the known static set and is reported on DERIVATION.
describe('covered-pests load-time derivation never throws (and drift is reported, not fatal)', () => {
  const load = (copy) => {
    jest.resetModules();
    jest.doMock('../services/estimate-service-details', () => ({ SERVICE_DETAILS_COPY: copy }));
    const mod = require('../services/covered-pests');
    const scheduler = require('../services/reservice-scheduler');
    jest.dontMock('../services/estimate-service-details');
    jest.resetModules();
    return { mod, scheduler };
  };
  const lawnRow = (label) => ({ lawn_care: { systemBox: { rows: [[label, 'Chinch bugs, sod webworms, armyworms, white grubs, mole crickets \u2014 checked every visit, treated on evidence']] } } });

  test('the LIVE copy derives cleanly (no fallback, nothing unmapped)', () => {
    const { DERIVATION } = require('../services/covered-pests');
    expect(DERIVATION).toEqual({ separateServices: 'copy', turfInsects: 'copy', unmapped: [] });
  });

  test('an empty / reshaped copy: the module and the scheduler still load, falling back to the static sets', () => {
    for (const copy of [{}, { lawn_care: {} }, null, { pest: { systemBox: { rows: [] } } }]) {
      const { mod, scheduler } = load(copy);
      expect(mod.DERIVATION.separateServices).toBe('fallback');
      expect(mod.DERIVATION.turfInsects).toBe('fallback');
      expect(mod.TURF_INSECT_ITEMS).toHaveLength(5);
      expect(mod.SEPARATE_SERVICE_ITEMS).toContain('fleas');
      expect(scheduler.reportedReserviceLane('chinch bugs are back')).toBe('lawn');
      expect(scheduler.reportedReserviceLane('the fleas are back')).toBeNull();
    }
  });

  test('both lawn row labels derive ("Covered turf insects" and the reworked "Covered insects"); an unmapped new item is reported, not thrown', () => {
    for (const label of ['Covered turf insects', 'Covered insects']) {
      expect(load(lawnRow(label)).mod.DERIVATION.turfInsects).toBe('copy');
    }
    const copy = { lawn_care: { rows: [['Covered insects', 'Chinch bugs, billbugs \u2014 monitored']] } };
    const { mod } = load(copy);
    expect(mod.DERIVATION.unmapped).toContain('turf:billbugs');
    expect(mod.TURF_INSECT_NOUN_SOURCES).toHaveLength(1);
  });
});
