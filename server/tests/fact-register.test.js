/**
 * Email division fact register: listFacts provenance + tag filtering, the
 * sync planner (pure), the on-demand ensure, and the findUnverifiedClaims
 * deterministic rule list newsletter-validator.js wires in as a hard block.
 * The sync against real PostgreSQL is fact-register-sync-postgres.test.js.
 */

function chain(rows) {
  const q = {};
  ['where', 'orderBy'].forEach((m) => { q[m] = jest.fn(() => q); });
  // await-able: resolves to `rows` when the query itself is awaited.
  q.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
  return q;
}

jest.mock('../models/db', () => jest.fn());

const db = require('../models/db');
const {
  listFacts, findUnverifiedClaims, factsPromptBlock, ensureFactRegister, SOURCE, _internals,
} = require('../services/email-division/fact-register');
const { FACTS, VERIFIED_ON } = require('../services/email-division/fact-register-data');
const { planFactSync, planStraySync, factFingerprint, rowFingerprint, hasProvenance, resetEnsureStamp } = _internals;

const NOW = new Date('2026-09-28T12:00:00Z');

function meta(extra = {}) {
  return {
    source_url: 'https://ask.ifas.ufl.edu/publication/IN369',
    source_urls: ['https://ask.ifas.ufl.edu/publication/IN369'],
    quote: '"flights start in early January and end in April"',
    register_hash: 'abc',
    ...extra,
  };
}

function row(overrides = {}) {
  return {
    id: 'f1',
    slug: 'fact-native-subterranean-termite-flight-season',
    title: 'Native subterranean termite swarm season',
    summary: '"flights start in early January and end in April"',
    content: 'UF gives one flight season.',
    tags: ['termites', 'swarm-season'],
    active: true,
    status: 'active',
    source: SOURCE,
    verified_by: SOURCE,
    metadata: meta(),
    ...overrides,
  };
}

const ROWS = [
  row(),
  row({ id: 'f2', slug: 'fact-southern-chinch-bug', title: 'Southern chinch bug', tags: ['chinch-bugs', 'lawn'] }),
  row({ id: 'f3', slug: 'fact-fire-ant-mating-flights', title: 'Fire ant mating flights', tags: ['fire-ants', 'swarm-season'] }),
];

beforeEach(() => {
  jest.clearAllMocks();
  resetEnsureStamp();
  db.mockImplementation(() => chain(ROWS));
});

describe('listFacts', () => {
  test('returns every usable fact when no tags are given', async () => {
    const facts = await listFacts({ now: NOW });
    expect(facts).toHaveLength(3);
    expect(db).toHaveBeenCalledWith('knowledge_base');
  });

  test("reads only the register's own rows that are active AND in status active — a flagged, archived or foreign row never reaches a writer", async () => {
    await listFacts({ now: NOW });
    const q = db.mock.results[db.mock.results.length - 1].value;
    expect(q.where).toHaveBeenCalledWith({ category: 'facts', source: SOURCE, active: true, status: 'active' });
  });

  test('filters to facts carrying ANY of the given tags', async () => {
    const facts = await listFacts({ tags: ['swarm-season'], now: NOW });
    expect(facts.map((f) => f.id).sort()).toEqual(['f1', 'f3']);
  });

  test('accepts a single tag string as well as an array, and tags stored as a JSON string', async () => {
    db.mockImplementation(() => chain([ROWS[0], { ...ROWS[1], tags: JSON.stringify(['chinch-bugs', 'lawn']) }]));
    const facts = await listFacts({ tags: 'lawn', now: NOW });
    expect(facts.map((f) => f.id)).toEqual(['f2']);
  });

  test('respects limit after filtering', async () => {
    const facts = await listFacts({ tags: ['swarm-season'], limit: 1, now: NOW });
    expect(facts).toHaveLength(1);
  });

  describe('provenance — a row is fed to a writer only when it is this register\'s fact with its source intact', () => {
    test.each([
      ['a slug that is not in the register', row({ slug: 'fact-somebody-added-this' })],
      ['a row the sync never stamped (no register_hash)', row({ metadata: meta({ register_hash: undefined }) })],
      ['a row from another source', row({ source: 'manual' })],
      ['no https source URL', row({ metadata: meta({ source_url: 'see file' }) })],
      ['a missing source URL', row({ metadata: meta({ source_url: undefined }) })],
      ['no quoted source text', row({ summary: '   ' })],
      ['an expired row (metadata.expires_on reached)', row({ metadata: meta({ expires_on: '2026-09-28' }) })],
    ])('drops %s', async (_label, bad) => {
      db.mockImplementation(() => chain([bad, ROWS[1]]));
      const facts = await listFacts({ now: NOW });
      expect(facts.map((f) => f.id)).toEqual(['f2']);
    });

    test('accepts metadata stored as a JSON string', () => {
      expect(hasProvenance(row({ metadata: JSON.stringify(meta()) }), '2026-09-28')).toBe(true);
    });

    test('a fact the weekly knowledge-base audit or a person VERIFIED stays usable (verified_by is not provenance)', () => {
      expect(hasProvenance(row({ verified_by: 'ai-cron', last_verified_at: new Date('2026-10-05T03:00:00Z') }), '2026-10-05')).toBe(true);
      expect(hasProvenance(row({ verified_by: 'waves', confidence: 'medium' }), '2026-10-05')).toBe(true);
    });

    test("the register's own expiry applies even when the stored row predates it", () => {
      const swfwmd = FACTS.find((f) => f.slug === 'fact-swfwmd-modified-phase-iii-water-shortage');
      expect(swfwmd.expiresOn).toBe('2026-10-02');
      const r = row({ slug: swfwmd.slug, metadata: meta({ expires_on: undefined }) });
      expect(hasProvenance(r, '2026-10-01')).toBe(true);
      expect(hasProvenance(r, '2026-10-02')).toBe(false);
    });
  });
});

describe('the register data', () => {
  test('every fact has a slug, title, tags, https source URLs, a quote in double quotes and content', () => {
    const slugs = new Set();
    for (const fact of FACTS) {
      expect(fact.slug).toMatch(/^fact-[a-z0-9-]+$/);
      expect(slugs.has(fact.slug)).toBe(false);
      slugs.add(fact.slug);
      expect(fact.title.length).toBeGreaterThan(10);
      expect(Array.isArray(fact.tags) && fact.tags.length > 0).toBe(true);
      expect(fact.sourceUrls.length).toBeGreaterThan(0);
      fact.sourceUrls.forEach((u) => expect(u).toMatch(/^https:\/\//));
      expect(fact.quote).toMatch(/"[^"]{10,}"/);
      expect(fact.content.length).toBeGreaterThan(40);
      if (fact.expiresOn) expect(fact.expiresOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  test('no fact cites a retailer page', () => {
    for (const fact of FACTS) {
      fact.sourceUrls.forEach((u) => expect(u).not.toMatch(/domyown|solutionsstores|amazon\.|pestcontrolsupplies|doityourselfpestcontrol/i));
    }
  });

  test('every number of days, weeks or months in a fact\'s content also appears in its quote', () => {
    // "7 to 10 days", "7–10 days" and "7-10 days" are the same range.
    const numbers = (text) => (text.match(/\b\d+(?:\s*(?:–|-|to)\s*\d+)?\s*(?:days?|weeks?|months?)\b/gi) || [])
      .map((n) => n.toLowerCase().replace(/\s+/g, ' ').replace(/(\d)\s*(?:–|-|to)\s*(\d)/, '$1–$2'));
    // "one-day-per-week" in a quote and "one day per week" in content are the same.
    const wordNumbers = (text) => (text.replace(/-/g, ' ').match(/\b(?:one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:days?|weeks?|months?)\b/gi) || [])
      .map((n) => n.toLowerCase());
    const missing = [];
    for (const fact of FACTS) {
      const quoteNums = numbers(fact.quote).concat(wordNumbers(fact.quote));
      for (const n of numbers(fact.content).concat(wordNumbers(fact.content))) {
        if (!quoteNums.includes(n)) missing.push({ slug: fact.slug, number: n });
      }
    }
    expect(missing).toEqual([]);
  });
});

describe('planFactSync (pure)', () => {
  const fact = FACTS[0];
  const shipped = factFingerprint(fact);
  const TODAY = '2026-09-28';

  function syncedMeta(extra = {}) {
    return meta({
      source_url: fact.sourceUrls[0], source_urls: fact.sourceUrls, quote: fact.quote, register_hash: shipped,
      verified_on: VERIFIED_ON, derived: fact.derived === true, expires_on: fact.expiresOn || null, ...extra,
    });
  }

  function syncedRow(overrides = {}) {
    // Exactly what the sync writes for `fact`, with the hash stamped.
    return row({
      slug: fact.slug, title: fact.title, summary: fact.quote, content: fact.content, tags: fact.tags,
      metadata: syncedMeta(),
      ...overrides,
    });
  }

  test('no row → insert; an expired fact with no row is never seeded', () => {
    expect(planFactSync(fact, undefined, { today: TODAY })).toEqual({ action: 'insert' });
    expect(planFactSync({ ...fact, expiresOn: '2026-09-01' }, undefined, { today: TODAY })).toEqual({ action: 'skip', reason: 'expired_never_seeded' });
  });

  test("a row under the slug that is not the register's is held, whatever it says", () => {
    expect(planFactSync(fact, syncedRow({ source: 'manual' }), { today: TODAY })).toEqual({ action: 'hold', reason: 'foreign_row' });
  });

  test('an untouched row already carrying the shipped content is unchanged', () => {
    expect(planFactSync(fact, syncedRow(), { today: TODAY })).toEqual({ action: 'unchanged' });
  });

  test('a row a person edited is held with both fingerprints, even when the register has new content for it', () => {
    const edited = syncedRow({ content: 'A person corrected this sentence.' });
    const plan = planFactSync({ ...fact, content: `${fact.content} New sentence.` }, edited, { today: TODAY });
    expect(plan.action).toBe('hold');
    expect(plan.reason).toBe('edited_by_person');
    expect(plan.rowHash).toBe(rowFingerprint(edited));
    expect(plan.shippedHash).toBe(factFingerprint({ ...fact, content: `${fact.content} New sentence.` }));
  });

  test('an edit to the title, tags or quote also counts as a person\'s edit', () => {
    expect(planFactSync(fact, syncedRow({ title: 'Renamed' }), { today: TODAY }).action).toBe('hold');
    expect(planFactSync(fact, syncedRow({ tags: [...fact.tags, 'extra'] }), { today: TODAY }).action).toBe('hold');
    expect(planFactSync(fact, syncedRow({ summary: '"a different quote"' }), { today: TODAY }).action).toBe('hold');
  });

  test('an untouched row whose shipped content changed is updated', () => {
    const plan = planFactSync({ ...fact, content: `${fact.content} New sentence.` }, syncedRow(), { today: TODAY });
    expect(plan).toEqual({ action: 'update', legacy: false, reactivate: false, metadataOnly: false });
  });

  test('a register row from before fingerprinting (no register_hash) is brought under management as a legacy update', () => {
    const legacy = syncedRow({ content: 'retailer-sourced content from the first seed', metadata: meta({ register_hash: undefined }) });
    expect(planFactSync(fact, legacy, { today: TODAY })).toEqual({ action: 'update', legacy: true, reactivate: false, metadataOnly: false });
  });

  test.each([
    ['an expiry added', { expiresOn: '2027-01-01' }, syncedMeta()],
    ['an expiry extended', { expiresOn: '2027-01-01' }, syncedMeta({ expires_on: '2026-10-02' })],
    ['an expiry removed', {}, syncedMeta({ expires_on: '2026-12-01' })],
    ['the derived flag changed', { derived: true }, syncedMeta()],
    ['the verification date moved', {}, syncedMeta({ verified_on: '2026-09-01' })],
    ['the primary source URL changed (same wording)', {}, syncedMeta({ source_url: 'https://ask.ifas.ufl.edu/publication/OLD' })],
  ])('managed metadata that changed with no change of wording still updates the row: %s', (_label, factChange, metadata) => {
    const plan = planFactSync({ ...fact, ...factChange }, syncedRow({ metadata }), { today: TODAY });
    expect(plan).toEqual({ action: 'update', legacy: false, reactivate: false, metadataOnly: true });
  });

  test('a fact retired at its old expiry comes back, restamped, when the register extends the expiry', () => {
    const retired = syncedRow({ active: false, metadata: syncedMeta({ expires_on: '2026-09-20', retired_on: '2026-09-20', retired_reason: 'expired' }) });
    expect(planFactSync({ ...fact, expiresOn: '2026-12-01' }, retired, { today: TODAY }))
      .toEqual({ action: 'update', legacy: false, reactivate: true, metadataOnly: true });
  });

  test('metadata stored as a JSON string is read the same way', () => {
    const r = syncedRow(); r.metadata = JSON.stringify(r.metadata);
    expect(planFactSync(fact, r, { today: TODAY })).toEqual({ action: 'unchanged' });
  });

  test('an expired fact retires its untouched active row, once', () => {
    const expired = { ...fact, expiresOn: '2026-09-28' };
    expect(planFactSync(expired, syncedRow(), { today: TODAY })).toEqual({ action: 'retire', reason: 'expired' });
    expect(planFactSync(expired, syncedRow({ active: false }), { today: TODAY })).toEqual({ action: 'unchanged' });
    // the day before expiry it is still a live fact (its row already carries that expiry)
    expect(planFactSync(expired, syncedRow({ metadata: syncedMeta({ expires_on: '2026-09-28' }) }), { today: '2026-09-27' })).toEqual({ action: 'unchanged' });
  });

  test('an expired fact never overwrites a person\'s edit, even to retire it', () => {
    const expired = { ...fact, expiresOn: '2026-09-01' };
    expect(planFactSync(expired, syncedRow({ content: 'edited' }), { today: TODAY }).action).toBe('hold');
  });

  test('a retired-then-restored fact reactivates its untouched row', () => {
    expect(planFactSync(fact, syncedRow({ active: false }), { today: TODAY })).toEqual({ action: 'update', legacy: false, reactivate: true, metadataOnly: true });
  });
});

describe('planStraySync (pure) — a register row whose slug left the register', () => {
  test('ignores rows that are not the register\'s, leaves inactive rows alone', () => {
    expect(planStraySync(row({ source: 'manual' }))).toEqual({ action: 'ignore' });
    expect(planStraySync(row({ active: false }))).toEqual({ action: 'unchanged' });
  });

  test('retires an untouched or legacy row, holds an edited one', () => {
    const untouched = row({ metadata: meta({ register_hash: rowFingerprint(row()) }) });
    expect(planStraySync(untouched)).toEqual({ action: 'retire', reason: 'withdrawn_from_register' });
    expect(planStraySync(row({ metadata: meta({ register_hash: undefined }) }))).toEqual({ action: 'retire', reason: 'withdrawn_from_register' });
    const edited = row({ metadata: meta({ register_hash: 'stamped-before-the-edit' }) });
    expect(planStraySync(edited)).toMatchObject({ action: 'hold', reason: 'edited_by_person' });
  });
});

describe('ensureFactRegister', () => {
  test('syncs once, then not again within the interval, then again when forced', async () => {
    const sync = jest.fn(async () => ({ inserted: ['x'], updated: [], retired: [], held: [], unchanged: [], skipped: [], errors: [] }));
    const first = await ensureFactRegister({ now: NOW, sync });
    expect(first.inserted).toEqual(['x']);
    const second = await ensureFactRegister({ now: new Date(NOW.getTime() + 60 * 60e3), sync });
    expect(second).toEqual({ skipped: true, reason: 'recently synced' });
    await ensureFactRegister({ now: new Date(NOW.getTime() + 60 * 60e3), sync, force: true });
    expect(sync).toHaveBeenCalledTimes(2);
  });

  test('runs again after the interval has passed', async () => {
    const sync = jest.fn(async () => ({ errors: [] }));
    await ensureFactRegister({ now: NOW, sync });
    await ensureFactRegister({ now: new Date(NOW.getTime() + 60 * 60e3), sync });
    expect(sync).toHaveBeenCalledTimes(1);
    await ensureFactRegister({ now: new Date(NOW.getTime() + 7 * 60 * 60e3), sync });
    expect(sync).toHaveBeenCalledTimes(2);
  });

  test('a sync that RESOLVED with a per-fact error is not a success: the next call retries at once', async () => {
    const sync = jest.fn()
      .mockResolvedValueOnce({ inserted: ['a'], updated: [], retired: [], held: [], unchanged: [], skipped: [], errors: [{ slug: 'b', error: 'connection reset' }] })
      .mockResolvedValueOnce({ inserted: ['b'], updated: [], retired: [], held: [], unchanged: ['a'], skipped: [], errors: [] })
      .mockResolvedValueOnce({ errors: [] });
    const first = await ensureFactRegister({ now: NOW, sync });
    expect(first.errors).toHaveLength(1);
    const second = await ensureFactRegister({ now: new Date(NOW.getTime() + 1000), sync });
    expect(second.inserted).toEqual(['b']);
    // …and a clean run stamps, so the third call within the interval is skipped.
    const third = await ensureFactRegister({ now: new Date(NOW.getTime() + 2000), sync });
    expect(third).toEqual({ skipped: true, reason: 'recently synced' });
    expect(sync).toHaveBeenCalledTimes(2);
  });

  test('a failed sync leaves no stamp, so the next call retries', async () => {
    const sync = jest.fn()
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce({ ok: true });
    await expect(ensureFactRegister({ now: NOW, sync })).rejects.toThrow('db down');
    await expect(ensureFactRegister({ now: new Date(NOW.getTime() + 1000), sync })).resolves.toEqual({ ok: true });
  });
});

describe('findUnverifiedClaims', () => {
  test('flags a storm-triggered "second swarm" termite claim', () => {
    const claims = findUnverifiedClaims('Termites will throw a second swarm event after significant rain and storm activity.');
    expect(claims).toEqual([{ rule: 'termite_second_swarm', excerpt: expect.stringContaining('second') }]);
  });

  test('does NOT flag the correct, verified swarm-season fact', () => {
    const claims = findUnverifiedClaims('Native subterranean termites swarm January through May, on warm days after rain.');
    expect(claims).toEqual([]);
  });

  test('does NOT flag a correctly-negated denial of the false swarm claim', () => {
    const claims = findUnverifiedClaims('Termites do not have a second swarm after storms.');
    expect(claims.some((c) => c.rule === 'termite_second_swarm')).toBe(false);
  });

  test('does NOT flag a LEADING negation before the claim\'s subject', () => {
    const claims = findUnverifiedClaims('No native subterranean termites have a second swarm after storms.');
    expect(claims.some((c) => c.rule === 'termite_second_swarm')).toBe(false);
  });

  test('a trailing, unrelated "not" after a comma does NOT exempt the real false claim', () => {
    const claims = findUnverifiedClaims('Termites will have a second swarm after storms, not that anyone believes it.');
    expect(claims.some((c) => c.rule === 'termite_second_swarm')).toBe(true);
  });

  test('does NOT flag a correctly-scoped drywood swarm claim (a different species, a real wide window)', () => {
    const claims = findUnverifiedClaims('Western drywood termites can have another round of late-summer swarms.');
    expect(claims.some((c) => c.rule === 'termite_second_swarm')).toBe(false);
  });

  test('a contrastive drywood clause does NOT exempt a false claim about a DIFFERENT species in the same sentence', () => {
    const claims = findUnverifiedClaims('Unlike drywood termites, native subterranean termites have a second swarm after storms.');
    expect(claims.some((c) => c.rule === 'termite_second_swarm')).toBe(true);
  });

  test('a correct drywood sentence does NOT exempt a false claim about a DIFFERENT sentence/species', () => {
    const claims = findUnverifiedClaims('Drywood termites may fly in fall. Native subterranean termites have a second swarm after storms.');
    expect(claims.some((c) => c.rule === 'termite_second_swarm')).toBe(true);
  });

  test('flags the natural word order "swarm again after storms"', () => {
    const claims = findUnverifiedClaims('After a wet week, termites swarm again after storms roll through.');
    expect(claims.some((c) => c.rule === 'termite_second_swarm')).toBe(true);
  });

  test.each([
    'Termites will swarm for a second time after summer storms.',
    'Termites swarm a second time when the storms come.',
    'Termites make another flight after storms.',
    'Termites will have a second flight in late summer.',
    'A second termite flight follows hurricanes.',
    'Storms can trigger another subterranean termite flight.',
  ])('flags "(for) a second time" and the "flight" noun: %s', (sentence) => {
    expect(findUnverifiedClaims(sentence).some((c) => c.rule === 'termite_second_swarm')).toBe(true);
  });

  test('exempts an explicit denial in that word order', () => {
    expect(findUnverifiedClaims('Termites do not swarm again after storms.')).toEqual([]);
    expect(findUnverifiedClaims('Termites do not swarm for a second time after storms.')).toEqual([]);
    expect(findUnverifiedClaims('For termites, there is no second swarm after storms.')).toEqual([]);
    expect(findUnverifiedClaims('There is no such thing as a second termite swarm.')).toEqual([]);
  });

  test.each([
    ['no doubt', 'There is no doubt termites will swarm a second time after storms.'],
    ['not only', 'Not only do termites swarm in spring, termites swarm again after storms.'],
    ['never fail to', 'Termites never fail to swarm again after a storm.'],
    ['a negated aside inside the match', 'Termites, which are not picky, have a second swarm after storms.'],
    ['a negated different verb', 'Termites do not eat concrete, yet termites have a second swarm after storms.'],
    ['a denial of a different claim before a dash', 'Termites do not swarm only in spring — they swarm again after storms.'],
    ['a denial of a different claim before a hyphen', 'Termites do not swarm only in spring - they swarm again after storms.'],
    ['"no wonder"', 'No wonder termites have a second swarm after every storm.'],
    ['"no doubt these"', 'No doubt these termites have a second swarm after storms.'],
    ['"no question"', 'No question, termites have a second swarm after storms.'],
    ['"no myth" (an affirmation)', 'Termites swarm again after storms, and that is no myth.'],
  ])('a negation idiom or unrelated negation (%s) does NOT exempt the false claim', (_label, sentence) => {
    expect(findUnverifiedClaims(sentence).some((c) => c.rule === 'termite_second_swarm')).toBe(true);
  });

  describe('a pronoun subject is the claim only in termite context', () => {
    test.each([
      'Subterranean termites fly in spring. They swarm again after storms.',
      'Native termites swarm from January to May. They have a second swarm after every hurricane.',
      'Once termites establish, they fly again after late-summer storms.',
    ])('flags: %s', (sentence) => {
      expect(findUnverifiedClaims(sentence).some((c) => c.rule === 'termite_second_swarm')).toBe(true);
    });

    test.each([
      'Fire ants make six to eight mating flights a year. They fly again after rain.',
      'Drywood termites fly in most months. They swarm again in fall.',
      'Mosquitoes breed in containers. They swarm again after every rain.',
    ])('does NOT flag: %s', (sentence) => {
      expect(findUnverifiedClaims(sentence).some((c) => c.rule === 'termite_second_swarm')).toBe(false);
    });
  });

  test.each([
    'Summer large patch outbreaks are a myth.',
    'The idea of a second termite swarm after storms is a myth.',
    'A storm-triggered second termite swarm is just an old wives\' tale.',
    'Myth: termites swarm again after storms.',
    'Myth — large patch is a summer disease.',
    'Myth: that termites have a second swarm after late-summer storms.',
  ])('the matched claim itself named a myth is the correct fact, not the claim: %s', (sentence) => {
    expect(findUnverifiedClaims(sentence)).toEqual([]);
  });

  test.each([
    ['a myth phrase in another clause of the same sentence', 'Termites swarm again after storms, but winter swarms are a myth.', 'termite_second_swarm'],
    ['a myth phrase after a semicolon', 'Termites have a second swarm after storms; the rest is a myth.', 'termite_second_swarm'],
    ['a myth phrase after a dash', 'Termites swarm again after storms — the winter swarm is a myth.', 'termite_second_swarm'],
    ['a myth phrase about something else in the sentence', 'Large patch thrives in summer, and the idea that it is harmless is a myth.', 'large_patch_summer_disease'],
    ['"Myth:" labelling an EARLIER claim, then the false one', 'Myth: termites never swarm. Fact: termites swarm again after every storm.', 'termite_second_swarm'],
  ])('a myth phrase that is not about the matched claim clears nothing: %s', (_label, sentence, rule) => {
    expect(findUnverifiedClaims(sentence).some((c) => c.rule === rule)).toBe(true);
  });

  test('a correct denial earlier in the sentence does NOT exempt a later false claim in it', () => {
    const claims = findUnverifiedClaims('Large patch is not a summer disease up north, but here large patch thrives in summer heat.');
    expect(claims.some((c) => c.rule === 'large_patch_summer_disease')).toBe(true);
  });

  test('"no joke" is not a denial of the large-patch claim', () => {
    const claims = findUnverifiedClaims('Brown patch is no joke in summer heat.');
    expect(claims.some((c) => c.rule === 'large_patch_summer_disease')).toBe(true);
  });

  test.each([
    'Expect a second termite swarm after the next storm.',
    'Storms can trigger another termite swarm.',
    'A second subterranean termite swarm follows hurricanes.',
    'No doubt a second termite swarm is coming.',
  ])('flags the claim when the modifier comes before "termite swarm": %s', (sentence) => {
    expect(findUnverifiedClaims(sentence).some((c) => c.rule === 'termite_second_swarm')).toBe(true);
  });

  test.each([
    'There is no second termite swarm after storms.',
    'UF documents no second termite swarm.',
    'This is not a second termite swarm.',
    'A second drywood termite swarm is possible in fall.',
  ])('does NOT flag a denial or a drywood subject in that word order: %s', (sentence) => {
    expect(findUnverifiedClaims(sentence).some((c) => c.rule === 'termite_second_swarm')).toBe(false);
  });

  test('flags brown/large patch mis-described as a summer disease', () => {
    const claims = findUnverifiedClaims('Watch for large patch this summer as temperatures climb.');
    expect(claims.some((c) => c.rule === 'large_patch_summer_disease')).toBe(true);
  });

  test('UF\'s own wording about large patch passes: warm humid weather, and not observed in summer', () => {
    expect(findUnverifiedClaims('Large patch occurs in warm, humid weather and is encouraged by excessive nitrogen.')).toEqual([]);
    expect(findUnverifiedClaims('Large patch is normally not observed in the summer months.')).toEqual([]);
    expect(findUnverifiedClaims('Large patch is most likely from November through May when temperatures are below 80°F.')).toEqual([]);
  });

  test('flags large patch placed above 80 degrees', () => {
    const claims = findUnverifiedClaims('Large patch takes off once temperatures climb above 80 degrees.');
    expect(claims.some((c) => c.rule === 'large_patch_summer_disease')).toBe(true);
  });

  test('does NOT flag the correct, negated large-patch explanation', () => {
    const claims = findUnverifiedClaims('Large patch appears in spring and fall; it is not a summer disease.');
    expect(claims.some((c) => c.rule === 'large_patch_summer_disease')).toBe(false);
  });

  test.each([
    'In summer, brown spots are usually chinch bugs, not large patch.',
    'Rhizoctonia leaf and sheath spot occurs in summer above 80°F, and its controls are very different from large patch.',
    'A summer patch is often mistaken for large patch.',
    'Unlike large patch, gray leaf spot is a summer disease.',
  ])('the correct "not / different from / mistaken for large patch" contrast passes: %s', (sentence) => {
    expect(findUnverifiedClaims(sentence).some((c) => c.rule === 'large_patch_summer_disease')).toBe(false);
  });

  test('flags a generalized "do not vacuum" instruction — never correct, any context', () => {
    expect(findUnverifiedClaims('Avoid vacuuming for 14 days after your ant treatment.')
      .some((c) => c.rule === 'non_flea_vacuum_advice')).toBe(true);
    // Even in a flea context, telling customers to AVOID vacuuming is wrong
    // — the actual guidance says to vacuum, so this is flagged too.
    expect(findUnverifiedClaims('For fleas, avoid vacuuming for 14 days so pupae hatch into the residual.')
      .some((c) => c.rule === 'non_flea_vacuum_advice')).toBe(true);
  });

  test('flags the affirmative "vacuum for N days" instruction generalized outside fleas', () => {
    const claims = findUnverifiedClaims('Vacuum daily for 14 days after your ant treatment.');
    expect(claims.some((c) => c.rule === 'non_flea_vacuum_advice')).toBe(true);
  });

  test('does NOT flag the correct affirmative flea vacuuming guidance', () => {
    const claims = findUnverifiedClaims('For fleas, vacuum daily for about 14 days so pupae hatch into the residual.');
    expect(claims.some((c) => c.rule === 'non_flea_vacuum_advice')).toBe(false);
  });

  test('a later non-exempt occurrence still blocks after an earlier exempt one', () => {
    const claims = findUnverifiedClaims('For fleas, vacuum daily for 14 days. For fleas, avoid vacuuming for 14 days.');
    expect(claims.some((c) => c.rule === 'non_flea_vacuum_advice')).toBe(true);
  });

  test('correct flea guidance in one sentence does NOT exempt a false claim about a DIFFERENT pest in another', () => {
    const claims = findUnverifiedClaims('For fleas, vacuum daily for about 14 days so pupae hatch into the residual. Vacuum daily for 14 days after your ant treatment.');
    expect(claims.some((c) => c.rule === 'non_flea_vacuum_advice')).toBe(true);
  });

  test.each([
    'Our family-safe treatment keeps everyone comfortable.',
    'It is safe for the whole family.',
    'Kid-safe once it dries.',
    'Safe for children and pets.',
    'A child-safe barrier.',
    'Completely safe for your pets.',
    'Safe around kids and dogs once dry.',
    'A cat-safe, dog-safe formula.',
    'It is safe around our pets.',
  ])('flags family, kid, child, pet, dog and cat safety claims: %s', (sentence) => {
    expect(findUnverifiedClaims(sentence).some((c) => c.rule === 'absolute_safety_claim')).toBe(true);
  });

  test('the label\'s own re-entry wording is not a safety claim', () => {
    expect(findUnverifiedClaims('Do not allow people or pets on treated surfaces until spray has dried.')).toEqual([]);
    expect(findUnverifiedClaims('Keep pets off the lawn until it is dry, then it is safe to let them back out.')).toEqual([]);
  });

  test('flags absolute "bee-safe" / "pet-safe" claims', () => {
    expect(findUnverifiedClaims('Our spray is completely bee-safe.').some((c) => c.rule === 'absolute_safety_claim')).toBe(true);
    expect(findUnverifiedClaims('This treatment is pet-safe for the whole family.').some((c) => c.rule === 'absolute_safety_claim')).toBe(true);
  });

  test('a clean draft with no known-false claim shapes returns nothing', () => {
    expect(findUnverifiedClaims('Mosquito season is here. Call us for a quote.')).toEqual([]);
  });

  test('the register\'s own titles and content never trip its own rules (a writer may repeat them)', () => {
    const tripped = FACTS
      .map((fact) => ({ slug: fact.slug, claims: findUnverifiedClaims(`${fact.title}. ${fact.content}`) }))
      .filter((r) => r.claims.length);
    expect(tripped).toEqual([]);
  });

  test('empty/undefined input returns an empty array', () => {
    expect(findUnverifiedClaims('')).toEqual([]);
    expect(findUnverifiedClaims(undefined)).toEqual([]);
  });
});

describe('factsPromptBlock', () => {
  test('lists every fact with its source text, its limits and its source, then binds the writer to the list', async () => {
    db.mockImplementation(() => chain([
      row({
        slug: 'fact-container-mosquitoes',
        title: 'Aedes mosquitoes: containers and the 7–10 day life cycle',
        summary: '"A mosquito egg takes 7–10 days to develop into an adult mosquito."',
        content: 'Per CDC, an egg takes 7 to 10 days to develop into an adult.',
        metadata: JSON.stringify(meta({ source_url: 'https://www.cdc.gov/mosquitoes/about/life-cycle-of-aedes-mosquitoes.html' })),
        tags: ['mosquitoes'],
      }),
      row({
        slug: 'fact-taurus-sc-non-repellent',
        title: 'Taurus SC: non-repellent',
        summary: '"Taurus SC is a non-repellent insecticide"',
        content: 'The manufacturer states no time to control.',
        metadata: meta({ source_url: 'https://www.controlsolutionsinc.com/csi-pest/products/taurus-sc' }),
        tags: ['products'],
      }),
    ]));

    const block = await factsPromptBlock({ ensure: false, now: NOW });

    expect(block).toContain('VERIFIED FACTS');
    expect(block).toContain('A mosquito egg takes 7–10 days');
    expect(block).toContain('https://www.cdc.gov/mosquitoes/about/life-cycle-of-aedes-mosquitoes.html');
    expect(block).toContain('The manufacturer states no time to control.');
    expect(block).toContain('If the list does not cover a claim, leave the claim out');
    expect(block).toContain('Never write a number of days, weeks or months that does not appear in the list');
  });

  test('throws when the register is empty, so a draft is never written ungrounded', async () => {
    db.mockImplementation(() => chain([]));
    await expect(factsPromptBlock({ ensure: false, now: NOW })).rejects.toThrow(/fact register is empty/);
  });

  test('a row without provenance is not rendered even when it is the only row', async () => {
    db.mockImplementation(() => chain([row({ metadata: meta({ register_hash: undefined }) })]));
    await expect(factsPromptBlock({ ensure: false, now: NOW })).rejects.toThrow(/fact register is empty/);
  });

  test('when the on-demand sync fails, the block still renders from the stored facts', async () => {
    // The mocked db has no schema/transaction, so the sync throws; the
    // draft must still be grounded in what is stored.
    const block = await factsPromptBlock({ now: NOW });
    expect(block).toContain('VERIFIED FACTS');
    expect(block).toContain('Southern chinch bug');
  });
});
