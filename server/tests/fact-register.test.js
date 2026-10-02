/**
 * Email division fact register: listFacts provenance + tag filtering, the
 * sync planner (pure), the on-demand ensure, the data invariants, and the
 * findUnverifiedClaims sentence-and-clause tripwire newsletter-validator.js
 * wires in as a hard block. The sync against real PostgreSQL is
 * fact-register-sync-postgres.test.js.
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
const {
  planFactSync, planStraySync, factFingerprint, rowFingerprint, hasProvenance, splitSentences, splitClauses, resetEnsureStamp,
} = _internals;

const NOW = new Date('2026-09-28T12:00:00Z');
const bySlug = (slug) => FACTS.find((f) => f.slug === slug);

// Exactly what the sync writes for a register fact (see rowValues), with the
// fingerprint stamped — the only shape hasProvenance admits.
function rowFor(fact, overrides = {}) {
  return {
    id: fact.slug,
    slug: fact.slug,
    title: fact.title,
    summary: fact.quote,
    content: fact.content,
    tags: fact.tags,
    active: true,
    status: 'active',
    source: SOURCE,
    verified_by: SOURCE,
    metadata: {
      source_url: fact.sourceUrls[0],
      source_urls: fact.sourceUrls,
      quote: fact.quote,
      verified_on: VERIFIED_ON,
      derived: fact.derived === true,
      expires_on: fact.expiresOn || null,
      register_hash: factFingerprint(fact),
    },
    ...overrides,
  };
}
const withMeta = (fact, extra) => rowFor(fact, { metadata: { ...rowFor(fact).metadata, ...extra } });

const TERMITE = bySlug('fact-native-subterranean-termite-flight-season');
const CHINCH = bySlug('fact-southern-chinch-bug');
const FIRE_ANT = bySlug('fact-fire-ant-mating-flights');
const ROWS = [rowFor(TERMITE), rowFor(CHINCH), rowFor(FIRE_ANT)];

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
    // by SOURCE, not category: a person may reclassify a register fact and it must still reach the writer (codex round 14 P2)
    expect(q.where).toHaveBeenCalledWith({ source: SOURCE, active: true, status: 'active' });
  });

  test('a knowledge-base-only fact (newsletter: false) never reaches the newsletter writer', async () => {
    const kbOnly = FACTS.find((f) => f.newsletter === false);
    expect(kbOnly).toBeDefined();
    db.mockImplementation(() => chain([...ROWS, rowFor(kbOnly)]));
    const facts = await listFacts({ now: NOW });
    expect(facts.map((r) => r.slug)).not.toContain(kbOnly.slug);
    expect(facts).toHaveLength(ROWS.length);
  });

  test('filters to facts carrying ANY of the given tags', async () => {
    const facts = await listFacts({ tags: ['swarm-season', 'fire-ants'], now: NOW });
    expect(facts.map((f) => f.slug).sort()).toEqual([FIRE_ANT.slug, TERMITE.slug].sort());
  });

  test('accepts a single tag string as well as an array, and tags stored as a JSON string', async () => {
    db.mockImplementation(() => chain([ROWS[0], { ...ROWS[1], tags: JSON.stringify(CHINCH.tags) }]));
    const facts = await listFacts({ tags: 'lawn', now: NOW });
    expect(facts.map((f) => f.slug)).toEqual([CHINCH.slug]);
  });

  test('respects limit after filtering', async () => {
    const facts = await listFacts({ tags: ['termites', 'lawn'], limit: 1, now: NOW });
    expect(facts).toHaveLength(1);
  });

  describe("provenance — a row is fed to a writer only when it is this register's fact, exactly as the register states it", () => {
    test.each([
      ['a slug that is not in the register', rowFor(TERMITE, { slug: 'fact-somebody-added-this' })],
      ['a row the sync never stamped (no register_hash)', withMeta(TERMITE, { register_hash: undefined })],
      ['a row from another source', rowFor(TERMITE, { source: 'manual' })],
      ['no https source URL', withMeta(TERMITE, { source_url: 'see file' })],
      ['a missing source URL', withMeta(TERMITE, { source_url: undefined })],
      ['no quoted source text', rowFor(TERMITE, { summary: '   ' })],
      ['an expired row (metadata.expires_on reached)', withMeta(TERMITE, { expires_on: '2026-09-28' })],
      ['a row a person edited (content differs from the register)', rowFor(TERMITE, { content: `${TERMITE.content} A person added this.` })],
      ['a row another writer appended to (the WikiQA file-back shape)', rowFor(TERMITE, { content: `${TERMITE.content}\n\n## Q&A\nAI-written answer.` })],
      ['a row whose title a person changed', rowFor(TERMITE, { title: 'Renamed' })],
    ])('drops %s', async (_label, bad) => {
      db.mockImplementation(() => chain([bad, ROWS[1]]));
      const facts = await listFacts({ now: NOW });
      expect(facts.map((f) => f.slug)).toEqual([CHINCH.slug]);
    });

    test('accepts metadata and tags stored as JSON strings', () => {
      const r = rowFor(TERMITE);
      expect(hasProvenance({ ...r, metadata: JSON.stringify(r.metadata), tags: JSON.stringify(r.tags) }, '2026-09-28')).toBe(true);
    });

    test('a fact the weekly knowledge-base audit or a person VERIFIED stays usable (verified_by is not provenance)', () => {
      expect(hasProvenance(rowFor(TERMITE, { verified_by: 'ai-cron', last_verified_at: new Date('2026-10-05T03:00:00Z'), confidence: 'medium' }), '2026-10-05')).toBe(true);
      expect(hasProvenance(rowFor(TERMITE, { verified_by: 'waves' }), '2026-10-05')).toBe(true);
    });

    test("the register's own expiry applies even when the stored row predates it", () => {
      const swfwmd = bySlug('fact-swfwmd-modified-phase-iii-water-shortage');
      expect(swfwmd.expiresOn).toBe('2026-10-02');
      const r = withMeta(swfwmd, { expires_on: undefined });
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
      if (fact.verifiedOn) expect(fact.verifiedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  test('no fact cites a retailer page or a news outlet — sources are UF/IFAS, labels, manufacturers, governments, CDC', () => {
    for (const fact of FACTS) {
      fact.sourceUrls.forEach((u) => {
        expect(u).not.toMatch(/domyown|solutionsstores|amazon\.|pestcontrolsupplies|doityourselfpestcontrol/i);
        expect(u).not.toMatch(/wusf\.org|heraldtribune|tampabay\.com|patch\.com|wfla\.com|baynews9|yoursun\.com/i);
      });
    }
  });

  test('every number of days, weeks or months in a fact\'s content also appears in its quote', () => {
    // "7 to 10 days", "7–10 days" and "7-10 days" are the same range;
    // "one-day-per-week" in a quote and "one day per week" in content too.
    const numbers = (text) => (text.match(/\b\d+(?:\s*(?:–|-|to)\s*\d+)?\s*(?:days?|weeks?|months?)\b/gi) || [])
      .map((n) => n.toLowerCase().replace(/\s+/g, ' ').replace(/(\d)\s*(?:–|-|to)\s*(\d)/, '$1–$2'));
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

  test('every percentage in a fact\'s title or content also appears in its quote', () => {
    const missing = [];
    for (const fact of FACTS) {
      for (const pct of (`${fact.title} ${fact.content}`).match(/\d+(?:\.\d+)?%/g) || []) {
        if (!fact.quote.includes(pct)) missing.push({ slug: fact.slug, pct });
      }
    }
    expect(missing).toEqual([]);
  });
});

describe('planFactSync (pure)', () => {
  const fact = FACTS[0];
  const TODAY = '2026-09-28';
  const syncedRow = (overrides = {}) => rowFor(fact, overrides);
  const syncedMeta = (extra = {}) => ({ ...rowFor(fact).metadata, ...extra });

  test('no row → insert; an expired fact with no row is never seeded', () => {
    expect(planFactSync(fact, undefined, { today: TODAY })).toEqual({ action: 'insert' });
    expect(planFactSync({ ...fact, expiresOn: '2026-09-01' }, undefined, { today: TODAY })).toEqual({ action: 'skip', reason: 'expired_never_seeded' });
  });

  test('no row but the register seeded this slug before → a person deleted it; it is not put back', () => {
    expect(planFactSync(fact, undefined, { today: TODAY, priorSeed: true })).toEqual({ action: 'hold', reason: 'deleted_by_person' });
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

  test('an edit that landed on exactly the register\'s current wording has converged: restamp, do not hold forever', () => {
    const converged = syncedRow({ metadata: syncedMeta({ register_hash: 'stamp-from-before-the-edit' }) });
    expect(planFactSync(fact, converged, { today: TODAY })).toEqual({ action: 'update', legacy: false, reactivate: false, metadataOnly: true, converged: true });
  });

  test('a fact checked on its own day (verifiedOn) is stamped with that day, not the register default', () => {
    const own = { ...fact, verifiedOn: '2026-10-01' };
    expect(planFactSync(own, syncedRow({ metadata: syncedMeta({ verified_on: '2026-10-01' }) }), { today: TODAY })).toEqual({ action: 'unchanged' });
    // A row stamped with the default date is brought to the fact's own date, wording untouched.
    expect(planFactSync(own, syncedRow(), { today: TODAY })).toEqual({ action: 'update', legacy: false, reactivate: false, metadataOnly: true, converged: false });
  });

  test('an untouched row whose shipped content changed is updated', () => {
    const plan = planFactSync({ ...fact, content: `${fact.content} New sentence.` }, syncedRow(), { today: TODAY });
    expect(plan).toEqual({ action: 'update', legacy: false, reactivate: false, metadataOnly: false, converged: false });
  });

  test('a register row from before fingerprinting (no register_hash) is brought under management as a legacy update', () => {
    const legacy = syncedRow({ content: 'retailer-sourced content from the first seed', metadata: syncedMeta({ register_hash: undefined }) });
    expect(planFactSync(fact, legacy, { today: TODAY })).toEqual({ action: 'update', legacy: true, reactivate: false, metadataOnly: false, converged: false });
  });

  test.each([
    ['an expiry added', { expiresOn: '2027-01-01' }, {}],
    ['an expiry extended', { expiresOn: '2027-01-01' }, { expires_on: '2026-10-02' }],
    ['an expiry removed', {}, { expires_on: '2026-12-01' }],
    ['the derived flag changed', { derived: true }, {}],
    ['the verification date moved', {}, { verified_on: '2026-09-01' }],
    ['the primary source URL changed (same wording)', {}, { source_url: 'https://ask.ifas.ufl.edu/publication/OLD' }],
  ])('managed metadata that changed with no change of wording still updates the row: %s', (_label, factChange, metaChange) => {
    const plan = planFactSync({ ...fact, ...factChange }, syncedRow({ metadata: syncedMeta(metaChange) }), { today: TODAY });
    expect(plan).toEqual({ action: 'update', legacy: false, reactivate: false, metadataOnly: true, converged: false });
  });

  test('metadata stored as a JSON string is read the same way', () => {
    const r = syncedRow(); r.metadata = JSON.stringify(r.metadata);
    expect(planFactSync(fact, r, { today: TODAY })).toEqual({ action: 'unchanged' });
  });

  test('an expired fact retires its untouched active row, once', () => {
    const expired = { ...fact, expiresOn: '2026-09-28' };
    expect(planFactSync(expired, syncedRow(), { today: TODAY })).toEqual({ action: 'retire', reason: 'expired', keepDeactivation: false });
    expect(planFactSync(expired, syncedRow({ active: false, status: 'archived', metadata: syncedMeta({ retired_reason: 'expired' }) }), { today: TODAY })).toEqual({ action: 'unchanged' });
    // the day before expiry it is still a live fact (its row already carries that expiry)
    expect(planFactSync(expired, syncedRow({ metadata: syncedMeta({ expires_on: '2026-09-28' }) }), { today: '2026-09-27' })).toEqual({ action: 'unchanged' });
  });

  test('an expired fact still archives a person-edited row — the edit is kept word for word, the expired guidance leaves the shared search', () => {
    const expired = { ...fact, expiresOn: '2026-09-01' };
    expect(planFactSync(expired, syncedRow({ content: 'edited' }), { today: TODAY })).toEqual({ action: 'retire', reason: 'expired', keepDeactivation: false });
    // …and once archived the edited row is left alone; if the fact comes back unexpired the edit is held, never overwritten.
    const archived = syncedRow({ content: 'edited', active: false, status: 'archived', metadata: syncedMeta({ retired_reason: 'expired', retired_on: '2026-09-28' }) });
    expect(planFactSync(expired, archived, { today: TODAY })).toEqual({ action: 'unchanged' });
    expect(planFactSync(fact, archived, { today: TODAY })).toMatchObject({ action: 'hold', reason: 'edited_by_person' });
  });

  test('a fact the REGISTER retired comes back, restamped, when the register extends the expiry', () => {
    const retired = syncedRow({ active: false, metadata: syncedMeta({ expires_on: '2026-09-20', retired_on: '2026-09-20', retired_reason: 'expired' }) });
    expect(planFactSync({ ...fact, expiresOn: '2026-12-01' }, retired, { today: TODAY }))
      .toEqual({ action: 'update', legacy: false, reactivate: true, metadataOnly: true, converged: false });
  });

  test('a row a PERSON deactivated (active=false, no retirement stamp) is held, never switched back on', () => {
    expect(planFactSync(fact, syncedRow({ active: false }), { today: TODAY })).toEqual({ action: 'hold', reason: 'deactivated_by_person' });
  });

  test('active IS NULL is not a deactivation — only active === false is a person\'s', () => {
    expect(planFactSync(fact, syncedRow({ active: null }), { today: TODAY })).toEqual(expect.objectContaining({ action: 'update' }));
    expect(planFactSync({ ...fact, expiresOn: '2026-09-01' }, syncedRow({ active: null }), { today: TODAY }))
      .toEqual({ action: 'retire', reason: 'expired', keepDeactivation: false });
  });

  test('an expired fact still archives a person-deactivated row (shared search reads status), remembering the deactivation', () => {
    const expired = { ...fact, expiresOn: '2026-09-01' };
    expect(planFactSync(expired, syncedRow({ active: false }), { today: TODAY })).toEqual({ action: 'retire', reason: 'expired', keepDeactivation: true });
    // …and when the fact comes back, the person's deactivation still holds.
    const archived = syncedRow({ active: false, status: 'archived', metadata: syncedMeta({ retired_reason: 'expired', retired_on: '2026-09-28', deactivated_by_person: true, expires_on: '2026-09-01' }) });
    expect(planFactSync(fact, archived, { today: TODAY })).toEqual({ action: 'hold', reason: 'deactivated_by_person' });
  });
});

describe('planStraySync (pure) — a register row whose slug left the register', () => {
  const fact = FACTS[0];
  test('ignores rows that are not the register\'s, leaves already-archived rows alone', () => {
    expect(planStraySync(rowFor(fact, { source: 'manual' }))).toEqual({ action: 'ignore' });
    expect(planStraySync(rowFor(fact, { active: false, status: 'archived' }))).toEqual({ action: 'unchanged' });
  });

  test('archives an untouched, legacy OR edited row — the wording is never touched, withdrawn guidance leaves the shared search', () => {
    expect(planStraySync(rowFor(fact))).toEqual({ action: 'retire', reason: 'withdrawn_from_register', keepDeactivation: false });
    expect(planStraySync(withMeta(fact, { register_hash: undefined }))).toEqual({ action: 'retire', reason: 'withdrawn_from_register', keepDeactivation: false });
    expect(planStraySync(rowFor(fact, { content: 'edited by a person' }))).toEqual({ action: 'retire', reason: 'withdrawn_from_register', keepDeactivation: false });
  });

  test('a withdrawn row with active NULL is not remembered as a person\'s deactivation', () => {
    expect(planStraySync(rowFor(fact, { active: null }))).toEqual({ action: 'retire', reason: 'withdrawn_from_register', keepDeactivation: false });
  });

  test('a withdrawn fact a person had deactivated still archives (shared search reads status), keeping the deactivation', () => {
    expect(planStraySync(rowFor(fact, { active: false }))).toEqual({ action: 'retire', reason: 'withdrawn_from_register', keepDeactivation: true });
  });
});

describe('ensureFactRegister', () => {
  const clean = () => ({ inserted: [], updated: [], retired: [], held: [], unchanged: [], skipped: [], errors: [] });

  test('syncs once, then not again within the interval, then again when forced', async () => {
    const sync = jest.fn(async () => ({ ...clean(), inserted: ['x'] }));
    const first = await ensureFactRegister({ now: NOW, sync });
    expect(first.inserted).toEqual(['x']);
    const second = await ensureFactRegister({ now: new Date(NOW.getTime() + 60 * 60e3), sync });
    expect(second).toEqual({ skipped: true, reason: 'recently synced' });
    await ensureFactRegister({ now: new Date(NOW.getTime() + 60 * 60e3), sync, force: true });
    expect(sync).toHaveBeenCalledTimes(2);
  });

  test('runs again after the interval has passed', async () => {
    const sync = jest.fn(async () => clean());
    await ensureFactRegister({ now: NOW, sync });
    await ensureFactRegister({ now: new Date(NOW.getTime() + 60 * 60e3), sync });
    expect(sync).toHaveBeenCalledTimes(1);
    await ensureFactRegister({ now: new Date(NOW.getTime() + 7 * 60 * 60e3), sync });
    expect(sync).toHaveBeenCalledTimes(2);
  });

  test('a failed sync leaves no stamp, so the next call retries', async () => {
    const sync = jest.fn()
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce(clean());
    await expect(ensureFactRegister({ now: NOW, sync })).rejects.toThrow('db down');
    await expect(ensureFactRegister({ now: new Date(NOW.getTime() + 1000), sync })).resolves.toEqual(clean());
  });

  test('a sync that RESOLVED with a per-fact error is not a success: the next call retries at once', async () => {
    const sync = jest.fn()
      .mockResolvedValueOnce({ ...clean(), inserted: ['a'], errors: [{ slug: 'b', error: 'connection reset' }] })
      .mockResolvedValueOnce({ ...clean(), inserted: ['b'], unchanged: ['a'] })
      .mockResolvedValueOnce(clean());
    const first = await ensureFactRegister({ now: NOW, sync });
    expect(first.errors).toHaveLength(1);
    const second = await ensureFactRegister({ now: new Date(NOW.getTime() + 1000), sync });
    expect(second.inserted).toEqual(['b']);
    // …and a clean run stamps, so the third call within the interval is skipped.
    const third = await ensureFactRegister({ now: new Date(NOW.getTime() + 2000), sync });
    expect(third).toEqual({ skipped: true, reason: 'recently synced' });
    expect(sync).toHaveBeenCalledTimes(2);
  });
});

describe('sentence and clause splitting', () => {
  test('a period after an abbreviation does not end the sentence', () => {
    expect(splitSentences('Large patch in St. Augustinegrass flares up in summer. Water at 6 a.m. or 8 p.m. only.'))
      .toEqual(['Large patch in St. Augustinegrass flares up in summer.', 'Water at 6 a.m. or 8 p.m. only.']);
  });

  test('clauses break at punctuation, brackets, a spaced hyphen and statement conjunctions — never inside a hyphenated word', () => {
    expect(splitClauses('Termites do not swarm only in spring - they swarm again after late-summer storms, but not in winter'))
      .toEqual(['Termites do not swarm only in spring', 'they swarm again after late-summer storms', 'not in winter']);
  });
});

describe('findUnverifiedClaims', () => {
  const rule = (sentence, name) => findUnverifiedClaims(sentence).some((c) => c.rule === name);

  describe('termite_second_swarm — the September 2026 claim in every phrasing', () => {
    test.each([
      'Termites will throw a second swarm event after significant rain and storm activity.',
      'After a wet week, termites swarm again after storms roll through.',
      'Termites will swarm for a second time after summer storms.',
      'Termites swarm a second time when the storms come.',
      'Termites make another flight after storms.',
      'Termites will have a second flight in late summer.',
      'A second termite flight follows hurricanes.',
      'Storms can trigger another subterranean termite flight.',
      'Expect a second termite swarm after the next storm.',
      'Storms can trigger another termite swarm.',
      'A second subterranean termite swarm follows hurricanes.',
      'Termites swarm once again after summer storms.',
      'Termites take flight again after storms.',
      'A second swarm of subterranean termites often follows summer storms.',
      'Summer storms can trigger subterranean termite swarms.',
      'Subterranean termites also swarm in late summer.',
      'Termites can have a second, smaller swarm after storms.',
      'Termites can have a second (and bigger) swarm after storms.',
      'Termite swarms after storms are common here.',
      'Hurricane season brings termite swarmers out again.',
      // a fall or late-year flight assigned to a non-drywood termite is the same false claim with no "second" in it (codex round 12 P1)
      'Native subterranean termites swarm in fall.',
      'Subterranean termites take flight in October.',
      'Termites swarm in September after the rains.',
      'Formosan termites also fly in November.',
      // the register's own scientific names, full and abbreviated (codex round 19 P1)
      'Reticulitermes flavipes swarms again after summer storms.',
      'R. flavipes swarms again after storms.',
      'Reticulitermes swarm again after hurricanes.',
      'Coptotermes formosanus takes flight again after storms.',
      'C. formosanus flies in October.',
      'R. flavipes swarms in spring. They swarm again after storms.',
    ])('flags: %s', (sentence) => {
      expect(rule(sentence, 'termite_second_swarm')).toBe(true);
    });

    test.each([
      'Native subterranean termites swarm January through May, on warm days after rain.',
      'Formosan subterranean termites begin swarming in late April.',
      'Termite swarmers appear on warm afternoons after rain in spring.',
      'After a storm, check the house for termite damage.',
      'Swarm season, January through May, is unrelated to hurricane season.',
      'Native subterranean termites swarm in spring. By October the swarmers are gone.',
      'Termite swarm season is over by June.',
      'Subterranean termites do not fly in the fall.',
      'Termite swarmers in October are almost always drywood termites.',
      // drywood genera and epithets are drywood; a bare initial is not a termite (codex round 19)
      'Cryptotermes brevis flies in the fall.',
      'Incisitermes minor swarms in the fall.',
      'C. brevis swarms again after storms.',
      'Reticulitermes flavipes does not swarm again after storms.',
      'R. zeae thrives in summer heat.',
    ])('does NOT flag the verified swarm-season facts: %s', (sentence) => {
      expect(rule(sentence, 'termite_second_swarm')).toBe(false);
    });

    test.each([
      'Termites do not have a second swarm after storms.',
      'Termites do not swarm again after storms.',
      'Termites do not swarm for a second time after storms.',
      'No native subterranean termites have a second swarm after storms.',
      'For termites, there is no second swarm after storms.',
      'There is no such thing as a second termite swarm.',
      'There is no second termite swarm after storms.',
      'UF documents no second termite swarm.',
      'This is not a second termite swarm.',
      'Termite swarms are not triggered by storms.',
      "Storms don't cause termite swarms.",
    ])('does NOT flag a denial with the negation attached inside the claim clause: %s', (sentence) => {
      expect(rule(sentence, 'termite_second_swarm')).toBe(false);
    });

    test.each([
      'Western drywood termites can have another round of late-summer swarms.',
      'A second drywood termite swarm is possible in fall.',
      'Drywood termites fly in most months. They swarm again in fall.',
      'Native subterranean termites fly in spring, but drywood termites fly most months. They swarm again in fall.',
    ])('does NOT flag a drywood subject (a real wide flight window): %s', (sentence) => {
      expect(rule(sentence, 'termite_second_swarm')).toBe(false);
    });

    test.each([
      'Unlike drywood termites, native subterranean termites have a second swarm after storms.',
      'Drywood termites may fly in fall. Native subterranean termites have a second swarm after storms.',
      'Drywood termites fly in almost any month, but subterranean termites are different. They swarm again after late-summer storms.',
      'Drywood termites may fly in fall, but native subterranean termites fly in spring. They swarm again after storms.',
      'Subterranean termites swarm again after storms, unlike drywood termites.',
      'Native subterranean termites fly in spring. They swarm again after storms, while drywood termites can fly in fall.',
    ])('a drywood mention elsewhere does NOT shield a subterranean claim (the nearest termite decides): %s', (sentence) => {
      expect(rule(sentence, 'termite_second_swarm')).toBe(true);
    });

    test.each([
      ['no doubt', 'There is no doubt termites will swarm a second time after storms.'],
      ['no doubt these', 'No doubt these termites have a second swarm after storms.'],
      ['no wonder', 'No wonder termites have a second swarm after every storm.'],
      ['no question', 'No question, termites have a second swarm after storms.'],
      ['no second-guessing', 'No second-guessing: termites swarm again after storms.'],
      ['not only', 'Not only do termites swarm in spring, termites swarm again after storms.'],
      ['never fail to', 'Termites never fail to swarm again after a storm.'],
      ['a negated aside inside the sentence', 'Termites, which are not picky, have a second swarm after storms.'],
      ['a negated different verb', 'Termites do not eat concrete, yet termites have a second swarm after storms.'],
      ['a denial of a different claim before a dash', 'Termites do not swarm only in spring — they swarm again after storms.'],
      ['a denial of a different claim before a hyphen', 'Termites do not swarm only in spring - they swarm again after storms.'],
      ['a denial of a different claim before "but"', "Termites don't swarm in winter but they swarm again after summer storms."],
      ['another subject denied in the same sentence', 'Fire ants do not swarm again after storms and termites swarm again after storms.'],
      ['a trailing unrelated "not"', 'Termites will have a second swarm after storms, not that anyone believes it.'],
      ['"no myth" (an affirmation)', 'Termites swarm again after storms, and that is no myth.'],
      ['a double negative that asserts the claim', 'It is a myth that termites do not swarm again after storms.'],
    ])('a negation idiom, or a negation in another clause, clears nothing: %s', (_label, sentence) => {
      expect(rule(sentence, 'termite_second_swarm')).toBe(true);
    });

    test.each([
      'Subterranean termites fly in spring. They swarm again after storms.',
      'Native termites swarm from January to May. They have a second swarm after every hurricane.',
      'Once termites establish, they fly again after late-summer storms.',
    ])('a pronoun subject is the claim when the nearest termite named is not drywood: %s', (sentence) => {
      expect(rule(sentence, 'termite_second_swarm')).toBe(true);
    });

    test.each([
      'Native subterranean termites fly in spring. Unlike fire ants, they swarm again after storms.',
      'Native termites swarm in spring. Compared with mosquitoes, they swarm again after every storm.',
    ])('a contrast lead-in names the other party, not the subject — the termite claim after it still flags: %s', (sentence) => {
      expect(rule(sentence, 'termite_second_swarm')).toBe(true);
    });

    test.each([
      'Termites fly in spring, and fire ants swarm again after storms.',
      'Native termites fly in spring; mosquitoes come out again after every storm.',
      'Subterranean termites swarm in spring, but lovebugs fly again in September.',
    ])('a clause naming ANOTHER pest never inherits the termite subject: %s', (sentence) => {
      expect(rule(sentence, 'termite_second_swarm')).toBe(false);
    });

    test.each([
      'Fire ants make six to eight mating flights a year. They fly again after rain.',
      'Mosquitoes breed in containers. They swarm again after every rain.',
      'Love bugs are back. They swarm again in September.',
    ])('a pronoun with no termite antecedent is not the claim: %s', (sentence) => {
      expect(rule(sentence, 'termite_second_swarm')).toBe(false);
    });
  });

  describe('"myth" clears a claim only when it names THAT claim', () => {
    test.each([
      'The idea of a second termite swarm after storms is a myth.',
      "A storm-triggered second termite swarm is just an old wives' tale.",
      'Myth: termites swarm again after storms.',
      'Myth — large patch is a summer disease.',
      'Myth: that termites have a second swarm after late-summer storms.',
      'Summer large patch outbreaks are a myth.',
    ])('the claim named a myth passes: %s', (sentence) => {
      expect(findUnverifiedClaims(sentence)).toEqual([]);
    });

    test.each([
      ['a myth phrase in another clause of the same sentence', 'Termites swarm again after storms, but winter swarms are a myth.', 'termite_second_swarm'],
      ['a myth phrase after a semicolon', 'Termites have a second swarm after storms; the rest is a myth.', 'termite_second_swarm'],
      ['a myth phrase after a dash', 'Termites swarm again after storms — the winter swarm is a myth.', 'termite_second_swarm'],
      ['a myth phrase joined by "and"', 'Termites swarm again after storms and the winter swarm is a myth.', 'termite_second_swarm'],
      ['a myth about something else', 'Termites have a second swarm after storms, but the idea that every winged insect is a termite is a myth.', 'termite_second_swarm'],
      ['a myth about something else, large patch', 'Large patch thrives in summer, and the idea that it is harmless is a myth.', 'large_patch_summer_disease'],
      ['"Myth:" labelling an EARLIER claim, then the false one', 'Myth: termites never swarm. Fact: termites swarm again after every storm.', 'termite_second_swarm'],
      ['a quiz label that poses the claim', 'Fact or myth: termites swarm again after summer storms? Fact.', 'termite_second_swarm'],
      ['a label that affirms the claim', 'Not a myth: termites swarm again after big summer storms.', 'termite_second_swarm'],
    ])('a myth phrase that is not about the matched claim clears nothing: %s', (_label, sentence, name) => {
      expect(rule(sentence, name)).toBe(true);
    });
  });

  describe('large_patch_summer_disease', () => {
    test.each([
      // the register's own scientific name, full and abbreviated (codex round 20 P1)
      'Rhizoctonia solani thrives in summer heat.',
      'R. solani thrives in summer heat.',
      'Watch for large patch this summer as temperatures climb.',
      'Large patch takes off once temperatures climb above 80 degrees.',
      'Large patch is not a summer disease up north, but here large patch thrives in summer heat.',
      'Brown patch is no joke in summer heat.',
      'Large patch in St. Augustinegrass flares up in summer.',
      'Large patch peaks in July and August.',
      'Brown patch loves the rainy season.',
      'Large patch thrives in summer unlike gray leaf spot.',
      'Large patch, rather than chinch damage, is what you see in summer.',
      'Large patch normally appears in spring. It thrives in summer.',
      'Brown patch shows up after cold snaps. This disease peaks in July.',
    ])('flags: %s', (sentence) => {
      expect(rule(sentence, 'large_patch_summer_disease')).toBe(true);
    });

    test.each([
      'Gray leaf spot is a summer disease. It thrives in the rainy season.',
      'Large patch appears in spring and fall. It is not a summer disease.',
      'Chinch bugs peak in July. They love summer heat.',
    ])('a pronoun whose lawn antecedent is not large patch, or a denial, passes: %s', (sentence) => {
      expect(rule(sentence, 'large_patch_summer_disease')).toBe(false);
    });

    test.each([
      'Large patch occurs in warm, humid weather and is encouraged by excessive nitrogen.',
      'Large patch is normally not observed in the summer months.',
      'Large patch is most likely from November through May when temperatures are below 80°F.',
      'Large patch appears in spring and fall; it is not a summer disease.',
      'In summer, brown spots are usually chinch bugs, not large patch.',
      'Rhizoctonia leaf and sheath spot occurs in summer above 80°F, and its controls are very different from large patch.',
      'A summer patch is often mistaken for large patch.',
      'Unlike large patch, gray leaf spot is a summer disease.',
    ])('UF\'s own wording and the correct contrasts pass: %s', (sentence) => {
      expect(rule(sentence, 'large_patch_summer_disease')).toBe(false);
    });

    test.each([
      'Large patch thrives when temperatures exceed 80°F.',
      'Large patch thrives above 85°F.',
      'Large patch normally appears in spring. It flares up in the 90s.',
      'Large patch spreads fast once temperatures top ninety degrees.',
      'Large patch is worst when it is more than 85 degrees out.',
      'Large patch thrives in temperatures north of 80.',
      'Large patch loves the upper 80s.',
      'Large patch thrives at 90°F.',
      'Large patch thrives in 90-degree weather.',
      'Large patch explodes in hot, humid weather.',
      'Large patch peaks during the warmest months.',
      'Large patch is common when temps climb to eighty-five.',
    ])('a rewrite of the 80°F threshold or the heat is still the claim: %s', (sentence) => {
      expect(rule(sentence, 'large_patch_summer_disease')).toBe(true);
    });

    // Copular forms of the threshold (codex #5187 follow-up): no preposition
    // before the figure, so the old degree branch missed them.
    test.each([
      'Large patch thrives when temperatures are 85°F.',
      'Large patch thrives when temperatures are 80°F or higher.',
      'Large patch is worst when temperatures are 90 degrees.',
      'Large patch takes off when it is 95 degrees out.',
      "Large patch flares up when it's 90°F.",
      'Large patch spreads when temperatures are 85 or higher.',
      'Large patch thrives when the temperature is about 88°F.',
      'Large patch thrives when temperatures are ninety degrees.',
    ])('a copular hot-temperature claim is still the claim: %s', (sentence) => {
      expect(rule(sentence, 'large_patch_summer_disease')).toBe(true);
    });

    // "rarely" / "seldom" before a receding word is a negation of the
    // receding, so the summer-disease claim stands (codex #5414 round 3 P1).
    test.each([
      'Large patch is rarely absent in summer.',
      'Large patch is seldom quiet in summer.',
      'Large patch rarely lets up in summer.',
      'Large patch is rarely dormant in summer.',
      'Large patch is hardly ever inactive in summer.',
      'Large patch rarely slows down once temperatures are above 85°F.',
      // Celsius is converted before the 80°F line is applied (codex #5414 round 4)
      'Large patch thrives at 30°C.',
      'Large patch thrives when temperatures are 30 degrees Celsius or higher.',
      'Large patch thrives when temperatures are between 29 and 35°C.',
      'Large patch spreads when temperatures are above 30°C.',
      'Large patch thrives between 85°F and 35°C.',
      'Large patch is worst when it is 32 Celsius out.',
      // a degree figure with real temperature context is still hot, even near a geometry word
      'Large patch thrives when temperatures are 90 degrees, forming arcs around sprinkler heads.',
    ])('a negated receding word is still the claim: %s', (sentence) => {
      expect(rule(sentence, 'large_patch_summer_disease')).toBe(true);
    });

    test.each([
      'Large patch is active when temperatures are 75°F.',
      'Large patch is active when temperatures are 80°F or lower.',
      'Large patch is active when temperatures are 80°F or below.',
      'Large patch is most likely when temperatures are 60 to 75 degrees.',
      'Large patch is active when the soil is 65°F.',
      'Large patch can cover an area that is 80 square feet.',
      'Large patch can cover patches that are 90 or more square feet across.',
      'Large patch is more likely in yards that are 85 or more years old.',
    ])('a copular cool-side temperature passes: %s', (sentence) => {
      expect(rule(sentence, 'large_patch_summer_disease')).toBe(false);
    });

    // Round-2 follow-ups: temperatures are folded at SENTENCE level before the
    // clause split, so "and"/dash inside a phrase cannot cut it in half.
    test.each([
      // hot ranges: the LOW end decides
      'Large patch thrives when temperatures are 85 to 95 degrees.',
      'Large patch thrives when temperatures are between 85 and 95 degrees.',
      'Large patch thrives when temperatures are 85–95°F.',
      'Large patch thrives when temperatures are 85-95°F.',
      'Large patch thrives when temperatures are between 85°F and 95°F.',
      'Large patch thrives when temperatures are between eighty and ninety degrees.',
      // "and" on the hot side
      'Large patch thrives when temperatures are 85 and up.',
      'Large patch thrives when temperatures are 85 and higher.',
      'Large patch thrives when temperatures are 90 and above.',
      'Large patch thrives when temperatures are 85°F and higher.',
      // adverbs between the copula and the figure
      'Large patch thrives when temperatures are consistently 85 degrees or higher.',
      'Large patch thrives when temperatures are still 90°F.',
      'Large patch thrives when temperatures are already 90 degrees.',
      'Large patch thrives when temperatures are regularly 85°F or higher.',
      'Large patch thrives when temperatures are typically 85 degrees Fahrenheit or higher.',
      // spelled-out units on the hot side
      'Large patch spreads when temperatures are 90 degrees Fahrenheit or higher.',
      'Large patch thrives when temperatures are 85 degrees Fahrenheit.',
      // a hot range in a sentence that also has a cool phrase
      'Large patch thrives when temperatures are 85 to 95 degrees, and it is not active when temperatures are 80°F and below.',
      // a figure that is a FLOOR or a peak, not a cap, stays hot
      'Large patch is active when temperatures have a minimum of 85°F.',
      'Large patch is active when temperatures have a minimum of 85 degrees.',
      'Large patch is active when temperatures have a minimum temperature of 85°F.',
      'Large patch is active when temperatures peak at 90°F.',
      'Large patch is active when temperatures have a high of 90°F.',
      'Large patch is active when temperatures are at least 85°F.',
    ])('a hot range, "and up", or adverb-fronted figure is still the claim: %s', (sentence) => {
      expect(rule(sentence, 'large_patch_summer_disease')).toBe(true);
    });

    test.each([
      // spelled-out units on the cool side
      'Large patch is active when temperatures are 80 degrees Fahrenheit or lower.',
      'Large patch is active when temperatures are 75 degrees Fahrenheit and lower.',
      // "and" on the cool side
      'Large patch is active when temperatures are 80°F and below.',
      'Large patch is active when temperatures are 80 degrees and lower.',
      'Large patch is active when temperatures are 80°F and cooler.',
      'Large patch is active when temperatures are 80 degrees Fahrenheit and cooler.',
      'Large patch is active when temperatures are 80°F and below, and stays quiet above that.',
      // the prepositional form agrees with the copular one
      'Large patch is active at 80°F or lower.',
      'Large patch is active at 80°F and below.',
      'Large patch is active at 80 degrees or lower.',
      // cool ranges (low end under 80)
      'Large patch is most likely when temperatures are 60 to 75 degrees.',
      'Large patch is most likely when temperatures are 70 to 85 degrees.',
      'Large patch is most likely when temperatures are between 60 and 75 degrees.',
      'Large patch is active when temperatures are between 50 and 80 degrees Fahrenheit.',
      'Large patch is most likely when temperatures are 70-85°F.',
      'Large patch is active when temperatures are 55–75°F.',
      // adverbs on the cool side
      'Large patch is active when temperatures are still 70°F.',
      'Large patch is active when temperatures are consistently 70 degrees or lower.',
      // count nouns and other units are not temperatures
      'Large patch can cover patches that are 90 or more square feet across.',
      'Large patch can cover 85 homes in a subdivision.',
      'Large patch can affect 90 to 100 lawns.',
      'Large patch is active when temperatures are 80 to 90 lawns.',
      'Large patch rings can be 85 inches across.',
      'Large patch rings can be 90 cm across.',
      'Large patch rings can reach 90 meters across.',
      // "rarely" / "seldom" recede only when they modify an uncommon or activity predicate
      'Large patch is rarely a problem in summer.',
      'Large patch is seldom an issue in summer.',
      'Large patch rarely spreads in summer.',
      'Large patch is hardly ever seen in summer.',
      'Large patch is absent in summer.',
      'Large patch goes quiet in summer.',
      // compound downward comparators cap the temperature
      'Large patch is active when temperatures are less than or equal to 80°F.',
      'Large patch is active when temperatures are lower than or equal to 80 degrees.',
      'Large patch is active when temperatures are at or below 80°F.',
      'Large patch is active when temperatures are equal to or less than 80 degrees Fahrenheit.',
      // cool Celsius figures stay cool once converted
      'Large patch is active between 70°F and 30°C.',
      'Large patch is active between 20°C and 85°F.',
      'Large patch is active when temperatures are 20°C.',
      'Large patch is most likely when temperatures are 15 to 25 degrees Celsius.',
      'Large patch is active when temperatures are below 30°C.',
      'Large patch is active when temperatures are 24°C or lower.',
      // angular degrees are not temperatures
      'Large patch often appears as a 90-degree arc around a sprinkler head.',
      'Large patch rings can meet at a 90° angle along a sidewalk.',
      'Large patch can follow a 90 degree turn in the irrigation line.',
      // ceiling-style downward bounds cap the temperature (one shared DOWNWARD_BOUND list)
      'Large patch is active when temperatures have a maximum of 80°F.',
      'Large patch is active when temperatures have a max of 80 degrees.',
      'Large patch is active when temperatures have a maximum of about 80°F.',
      'Large patch is active when temperatures have a max temperature of 80°F.',
      'Large patch is active when temperatures have a maximum temperature of 75 degrees Fahrenheit.',
      'Large patch is active when temperatures have a ceiling of 80°F.',
      'Large patch is active when temperatures have a high of 80°F or less.',
      'Large patch is active when temperatures are no higher than 80°F.',
      'Large patch is active when temperatures are no warmer than 80 degrees.',
      'Large patch is active when temperatures are not above 80°F.',
      'Large patch is active when temperatures are not over 80 degrees.',
      'Large patch is active when temperatures are not exceeding 80°F.',
      'Large patch is active when temperatures never exceed 80°F.',
      'Large patch is active when temperatures never go above 80°F.',
      "Large patch is active when temperatures don't exceed 80°F.",
      'Large patch is active when temperatures doesn\u2019t exceed 80°F.',
      'Large patch is active when temperatures are capped at 80°F.',
      'Large patch is active when temperatures top out at 80°F.',
      'Large patch is active when temperatures max out at 80°F.',
      'Large patch is active when the maximum temperature is 80°F.',
      'Large patch is active when temperatures are at most 80°F.',
      'Large patch is active when temperatures have an upper limit of 80°F.',
    ])('a cool-side or non-temperature phrase passes: %s', (sentence) => {
      expect(rule(sentence, 'large_patch_summer_disease')).toBe(false);
    });

    test.each([
      'Large patch thrives in summer as the grass slows down.',
      "Large patch doesn't slow down in summer.",
      'Large patch never goes dormant when it is above 80.',
      'Large patch is not uncommon in summer.',
    ])('a receding verb that belongs to something else, or is itself negated, does not clear the claim: %s', (sentence) => {
      expect(rule(sentence, 'large_patch_summer_disease')).toBe(true);
    });

    test.each([
      'Large patch is active when temperatures are below 80°F.',
      'Large patch slows once temperatures climb above 80°F.',
      'Large patch goes dormant in summer.',
      'Large patch fades in the heat.',
      'Large patch normally appears in spring. It slows down in the 90s.',
      'Large patch stops spreading when it gets above 85 degrees.',
      'Large patch is rare in the summer months.',
      'Large patch is less common in the hot months.',
      'Large patch, which spreads in cool weather, dies back once it is over 80 degrees.',
      "Large patch doesn't slow down until temperatures climb above 80.",
      'Large patch is active between 60 and 75 degrees.',
      'Large patch can cover over 80 square feet of lawn.',
    ])('a downward threshold, large patch receding in the heat, or a figure that is not a temperature passes: %s', (sentence) => {
      expect(rule(sentence, 'large_patch_summer_disease')).toBe(false);
    });

    test.each([
      'Large patch is dormant, not active, in the summer.',
      'Large patch slows down, of course, in the summer.',
      'Large patch goes dormant, for the most part, in the hottest months.',
      'Gray leaf spot thrives, unlike large patch, in the summer.',
    ])('a verbless fragment is judged with the clause it hangs off — the fact stated across commas passes: %s', (sentence) => {
      expect(rule(sentence, 'large_patch_summer_disease')).toBe(false);
    });

    test.each([
      'Large patch is a common sight, especially in the summer.',
      'Large patch is not dormant, in the summer.',
      'Large patch is dormant in spring; in the summer it thrives.',
      'Large patch shows up everywhere, in the 90s.',
    ])('a fragment hanging off a claim, or a clause with its own verb, is still the claim: %s', (sentence) => {
      expect(rule(sentence, 'large_patch_summer_disease')).toBe(true);
    });

    // Codex round 11 P1: a negation inside an intervening fragment
    // reinforces the claim clause — it never clears it.
    test.each([
      'Large patch thrives, without slowing, in summer.',
      'Large patch thrives, never slowing, in summer.',
      'Large patch is not dormant, in the summer.',
      'Large patch is a common sight, especially in the summer.',
    ])('a fragment inherits the verdict of the verb clause it hangs off, judged alone: %s', (sentence) => {
      expect(rule(sentence, 'large_patch_summer_disease')).toBe(true);
    });

    test.each([
      'Large patch is dormant, not active, in the summer.',
      'Large patch slows down, of course, in the summer.',
      'Gray leaf spot thrives, unlike large patch, in the summer.',
      'Large patch thrives, not in summer, but in fall.',
    ])('a receding governing clause, a contrast over the span, or a fragment carrying its own negation passes: %s', (sentence) => {
      expect(rule(sentence, 'large_patch_summer_disease')).toBe(false);
    });
  });

  describe('non_flea_vacuum_advice', () => {
    test.each([
      // every spelled number, not an allowlist (codex round 20 P1)
      'Vacuum for eleven days after treatment.',
      'Vacuum for fifteen days after treatment.',
      'Keep vacuuming for twenty-one days.',
      'Avoid vacuuming for 14 days after your ant treatment.',
      'For fleas, avoid vacuuming for 14 days so pupae hatch into the residual.',
      'Vacuum daily for 14 days after your ant treatment.',
      'For fleas, vacuum daily for about 14 days so pupae hatch into the residual.',
      'For fleas, vacuum daily for 3 weeks.',
      'Fleas may linger after treatment, but after ant treatment vacuum daily for 14 days.',
      'Wait 14 days before vacuuming after your ant treatment.',
      "Don't vacuum for 14 days after your flea treatment.",
      'Don’t vacuum for 14 days after your flea treatment.',
      'No vacuuming for 14 days after your flea treatment.',
      'Hold off on vacuuming for two weeks after your flea treatment.',
      'For fleas, vacuum daily for 14 days. For fleas, keep vacuuming for a few weeks.',
      'For fleas, keep vacuuming for a few weeks. Vacuum daily for 14 days after your ant treatment.',
      // every unit counts, months included (codex round 12 P1)
      'Vacuum daily for a month after your flea treatment.',
      'For fleas, vacuum for one month.',
      'Keep vacuuming for two months after your ant treatment.',
    ])('flags a fixed or negated vacuuming instruction the source does not support: %s', (sentence) => {
      expect(rule(sentence, 'non_flea_vacuum_advice')).toBe(true);
    });

    test.each([
      'For fleas, keep vacuuming for a few weeks after treatment.',
      'After a flea treatment, keep vacuuming for several weeks.',
      'For fleas, vacuum for 1 to 4 weeks; the cocoon stage lasts that long.',
      'Expect to see some fleas for a few weeks; keep vacuuming and retreat if they persist beyond 4 weeks.',
      'Vacuum before your treatment and keep vacuuming afterwards.',
    ])('the sourced flea guidance passes: %s', (sentence) => {
      expect(rule(sentence, 'non_flea_vacuum_advice')).toBe(false);
    });
  });

  describe('absolute_safety_claim', () => {
    test.each([
      // any audience "-safe" compound (codex round 20 P1), and a negation elsewhere in the sentence does not clear it
      'Our treatment is pollinator-safe.',
      'This pesticide is wildlife-safe.',
      "Our pet-safe treatment won't stain.",
      'Our family-safe treatment keeps everyone comfortable.',
      'It is safe for the whole family.',
      'Kid-safe once it dries.',
      'Safe for children and pets.',
      'A child-safe barrier.',
      'Completely safe for your pets.',
      'Safe around kids and dogs once dry.',
      'A cat-safe, dog-safe formula.',
      'It is safe around our pets.',
      'Our spray is completely bee-safe.',
      'This treatment is pet-safe for the whole family.',
      'Our spray is safe for people and pets.',
      'It is safe to use around pets.',
      'The lawn is safe once dry.',
      'Keep pets off the lawn until it is dry, then it is safe to let them back out.',
      'It is kid safe once dry.',
      'Choose our safe lawn treatment.',
      'We offer a safe treatment option.',
      'A safe, effective spray for the whole yard.',
      'The safe choice for Florida lawns.',
      'Our technician confirms this pesticide is completely safe for children and pets.',
      'The treatment is safe after 15 minutes, as your technician will confirm.',
      'Your technician will confirm the product is safe for your family.',
      'The lawn is safe to walk on after 30 minutes; ask your technician.',
      'The treatment is safe and works after it dries; your technician confirms timing.',
      'A safer option for homes with pets.',
      'The safest lawn treatment in Sarasota.',
      'It can be used safely around pets and children.',
      'Our formula is safer than the old one for your family.',
      'A pet-safer alternative.',
      'This treatment is safer for pets once dry; your technician confirms timing.',
      'Once dry it is the safest choice for pollinators — your technician confirms the timing.',
      'The treatment is safe, your technician confirms timing, once it dries.',
      // The repo-wide compliance predicate flags these too; its verdict is authoritative here.
      'Keep your family safe from mosquitoes this summer.',
      'Once the treated areas have dried they are safe to use again — your technician confirms the timing at the visit.',
      // The idiom is exactly "safe" — a comparative or adverb is never exempt.
      'Our treatment is safer once dry; your technician confirms timing.',
      'The lawn is safest once dry, and your technician will confirm the timing.',
      'It can be used safely once dry; your technician confirms timing.',
    ])('flags: %s', (sentence) => {
      expect(rule(sentence, 'absolute_safety_claim')).toBe(true);
    });

    test.each([
      'The lawn is safe once dry, and your technician will confirm the timing.',
      'Once it has dried, the lawn is safe again; your technician confirms the timing.',
      // The adjective form takes the same exemption (codex round 11 P2).
      'This is a safe treatment once dry, and your technician confirms timing.',
    ])('the plain "safe once dry" idiom with the technician confirming passes: %s', (sentence) => {
      expect(rule(sentence, 'absolute_safety_claim')).toBe(false);
    });

    test.each([
      'This is a safe treatment for pets once dry, and your technician confirms timing.',
      'This is a safer treatment once dry, and your technician confirms timing.',
      'Choose our safe lawn treatment.',
      'Our pet-safe treatment is fine once dry, and your technician confirms timing.',
    ])('the adjective form outside the narrow idiom — an audience, a comparative, no dry state, or a compound — still blocks: %s', (sentence) => {
      expect(rule(sentence, 'absolute_safety_claim')).toBe(true);
    });

    test.each([
      'Do not permit humans or pets to contact treated surfaces until the spray has dried.',
      'Do not allow people or pets on treated surfaces until spray has dried.',
      'Keep pets off the lawn until it is dry; your technician will confirm when it is safe to let them back out.',
      'It is safe to say termites are active.',
      'Have a safe Labor Day weekend.',
      'The product is highly toxic to bees exposed to direct treatment.',
      'Keep a safe distance from fire ant mounds.',
      'It is a safe bet that lovebugs return in September.',
      'Have a safe trip home for the holidays.',
    ])('the label\'s wording, "safe to say", "safe distance/bet/trip" and the technician-confirms idiom pass: %s', (sentence) => {
      expect(rule(sentence, 'absolute_safety_claim')).toBe(false);
    });
  });

  describe('fixed_reentry_time — a minute or hour figure for re-entry or drying, with or without "safe"', () => {
    test.each([
      // the same number grammar as every duration rule (codex round 20)
      'Keep pets off the lawn for seven minutes.',
      'Stay off the treated yard for forty five minutes.',
      'Keep children and pets off the treated lawn for 30 minutes.',
      'The spray dries in about 20 minutes.',
      'Wait 2 hours before letting the dog back out.',
      'Stay off the grass for one hour after we leave.',
      'Pets can go back outside after 45 minutes.',
      'Re-entry is fine after 4 hours.',
      // Worded fractions of an hour (codex round 11 P1).
      'Keep pets off the treated lawn for a quarter hour.',
      'Keep pets off the treated lawn for a quarter-hour.',
      'Wait three quarters of an hour before letting the dog out.',
      'Stay off the grass for a half hour.',
      'Keep kids off the lawn for an hour and a half.',
    ])('flags: %s', (sentence) => {
      expect(rule(sentence, 'fixed_reentry_time')).toBe(true);
    });

    test.each([
      'Keep pets off the lawn until it is dry; your technician will confirm the timing.',
      'Do not permit humans or pets to contact treated surfaces until the spray has dried.',
      'For best results, postpone watering or mowing for 24 hours after application.',
      'Apply in calm weather when rain is not predicted for the next 24 hours.',
      'Our visit usually takes about 30 minutes.',
      'The dry season runs about 6 months.',
      'Water only between 12:01 a.m. and 4 a.m. on your day.',
    ])('the dry-state idiom, label wording and unrelated durations pass: %s', (sentence) => {
      expect(rule(sentence, 'fixed_reentry_time')).toBe(false);
    });
  });

  test('a safety claim with no time figure is reported once, as a safety claim — never also as a fixed re-entry time', () => {
    expect(findUnverifiedClaims('Our treatment is pet-safe.').map((c) => c.rule)).toEqual(['absolute_safety_claim']);
    expect(findUnverifiedClaims('Keep pets off the treated lawn for 30 minutes.').map((c) => c.rule)).toEqual(['fixed_reentry_time']);
  });

  test('a clean draft with no known-false claim shapes returns nothing', () => {
    expect(findUnverifiedClaims('Mosquito season is here. Call us for a quote.')).toEqual([]);
  });

  test('curly apostrophes and quotes are normalised before the rules run', () => {
    expect(findUnverifiedClaims('Termites don’t have a second swarm after storms.')).toEqual([]);
    expect(rule('Termites “swarm again” after storms.', 'termite_second_swarm')).toBe(true);
  });

  test('one result per rule, with the offending clause as the excerpt', () => {
    const claims = findUnverifiedClaims('Termites swarm again after storms. Termites have a second swarm every fall. Vacuum for 14 days after ant treatment.');
    expect(claims.map((c) => c.rule)).toEqual(['termite_second_swarm', 'non_flea_vacuum_advice']);
    expect(claims[0].excerpt).toBe('Termites swarm again after storms');
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
    const mosquito = bySlug('fact-container-mosquitoes');
    const taurus = bySlug('fact-taurus-sc-non-repellent');
    db.mockImplementation(() => chain([
      { ...rowFor(mosquito), metadata: JSON.stringify(rowFor(mosquito).metadata) },
      rowFor(taurus),
    ]));

    const block = await factsPromptBlock({ ensure: false, now: NOW });

    expect(block).toContain('VERIFIED FACTS');
    expect(block).toContain('A mosquito egg takes 7–10 days');
    expect(block).toContain('https://www.cdc.gov/mosquitoes/about/life-cycle-of-aedes-mosquitoes.html');
    expect(block).toContain('The manufacturer states no time to control');
    expect(block).toContain('If the list does not cover a claim, leave the claim out');
    expect(block).toContain('Never write a number of days, weeks or months that does not appear in the list');
  });

  test('throws when the register is empty, so a draft is never written ungrounded', async () => {
    db.mockImplementation(() => chain([]));
    await expect(factsPromptBlock({ ensure: false, now: NOW })).rejects.toThrow(/fact register is empty/);
  });

  test('a row without provenance is not rendered even when it is the only row', async () => {
    db.mockImplementation(() => chain([rowFor(TERMITE, { content: 'edited by a person' })]));
    await expect(factsPromptBlock({ ensure: false, now: NOW })).rejects.toThrow(/fact register is empty/);
  });

  test('when the on-demand sync fails, the block still renders from the stored facts', async () => {
    // The mocked db has no schema/transaction, so the sync throws; the
    // draft must still be grounded in what is stored.
    const block = await factsPromptBlock({ now: NOW });
    expect(block).toContain('VERIFIED FACTS');
    expect(block).toContain(CHINCH.title);
  });
});

describe('codex round 20 — what the widened rules must still leave alone', () => {
  const { findUnverifiedClaims } = require('../services/email-division/fact-register');
  test.each([
    ['This pesticide is not pet-safe.', 'absolute_safety_claim'],
    ["This pesticide isn't really wildlife-safe.", 'absolute_safety_claim'],
    ['The design is fail-safe.', 'absolute_safety_claim'],
    ['R. zeae thrives in summer heat.', 'large_patch_summer_disease'],
    ['Rhizoctonia zeae leaf and sheath spot is a summer disease.', 'large_patch_summer_disease'],
    ['For fleas, keep vacuuming for a few weeks.', 'non_flea_vacuum_advice'],
    ['Postpone watering or mowing for 24 hours.', 'fixed_reentry_time'],
  ])('does NOT flag: %s', (sentence, rule) => {
    expect(findUnverifiedClaims(sentence).some((r) => r.rule === rule)).toBe(false);
  });

  test('generic product nouns in event copy are not treatment context; owned or pest-qualified ones are (codex round 20 P2)', () => {
    const scoped = (t) => findUnverifiedClaims(t, { treatmentContextOnly: true }).some((r) => r.rule === 'absolute_safety_claim');
    expect(scoped("Browse family-safe products at Saturday's market.")).toBe(false);
    expect(scoped('Our lawn products are pollinator-safe.')).toBe(true);
    expect(scoped('Our pest control products are family-safe.')).toBe(true);
  });
});

