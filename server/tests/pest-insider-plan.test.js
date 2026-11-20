// Pest Insider plan: which fact leads and which species fills "What's this?".
const { planIssue, SPECIES, CATEGORY_SERVICES, SEASONAL_MAX_MONTHS, TOOL_RECENT_WINDOW } = require('../services/pest-insider/plan');
const { factsForSend, factById, FACTS } = require('../services/pest-insider/facts');
const { tools: TOOLS } = require('../services/pest-insider/tools').loadTools();

// Every fact counts as having a live post here, so these cases test the
// rotation; the live-post rule has its own cases below.
const ALL_LIVE = FACTS.map((f) => f.id);
const plan = (input) => planIssue({ livePostFactIds: ALL_LIVE, ...input });

const relates = (s, service) => (CATEGORY_SERVICES[s.category] || []).includes(service);
const named = (s, fact) => s.name.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 3)
  .some((w) => new RegExp(`\\b${w}(?:s|es)?\\b`).test(`${fact.title} ${fact.statement}`.toLowerCase()));

describe('planIssue', () => {
  test('only a fact whose blog post is live can lead; when its post is down, the next fact leads', () => {
    const first = plan({ sendDate: '2026-12-03' }).leadFact;
    const live = ALL_LIVE.filter((id) => id !== first.id);
    const next = planIssue({ sendDate: '2026-12-03', livePostFactIds: live }).leadFact;
    expect(next.id).not.toBe(first.id);
    expect(live).toContain(next.id);
    expect(next.months).toContain(12);
    // facts fit the month, but none has a live post
    expect(planIssue({ sendDate: '2026-12-03', livePostFactIds: [] })).toEqual({ leadFact: null, idItem: null, reason: 'no_live_post_for_month' });
    // a live post for a fact outside the month changes nothing
    const june = factsForSend('2027-06-03').map((f) => f.id).filter((id) => !factById(id).months.includes(12));
    expect(planIssue({ sendDate: '2026-12-03', livePostFactIds: june })).toMatchObject({ leadFact: null, reason: 'no_live_post_for_month' });
  });

  test('refuses a plan with no live-post list: a plan with no post check would lead with an unlinked fact', () => {
    expect(() => planIssue({ sendDate: '2026-12-03' })).toThrow(/livePostFactIds must list/);
    expect(() => planIssue({ sendDate: '2026-12-03', livePostFactIds: 'A01' })).toThrow(/livePostFactIds must list/);
  });

  test('is deterministic for the same inputs', () => {
    const a = plan({ sendDate: '2026-12-03', recentFactIds: ['A01'], recentSpeciesSlugs: ['fire-ant'] });
    const b = plan({ sendDate: '2026-12-03', recentFactIds: ['A01'], recentSpeciesSlugs: ['fire-ant'] });
    expect(a).toEqual(b);
  });

  test('leads with a pest-kind fact of the month, seasonal first, when one exists', () => {
    const { leadFact } = plan({ sendDate: '2026-12-03' });
    const pool = factsForSend('2026-12-03');
    expect(leadFact.kind).toBe('pest');
    expect(leadFact.months).toContain(12);
    const seasonalPest = pool.filter((f) => f.kind === 'pest' && f.months.length <= SEASONAL_MAX_MONTHS);
    if (seasonalPest.length) expect(leadFact.months.length).toBeLessThanOrEqual(SEASONAL_MAX_MONTHS);
  });

  test('skips the previous issue\'s service when another service fits the month', () => {
    const first = plan({ sendDate: '2026-12-03' }).leadFact;
    const next = plan({ sendDate: '2026-12-17', recentFactIds: [first.id] }).leadFact;
    const others = factsForSend('2026-12-17', { excludeIds: [first.id] }).filter((f) => f.service !== first.service);
    expect(others.length).toBeGreaterThan(0);
    expect(next.service).not.toBe(first.service);
  });

  test('falls back to the same service when no other service fits', () => {
    const pool = factsForSend('2026-12-03');
    const [prev, only] = pool.filter((f) => f.service === 'pest');
    const others = pool.filter((f) => f.id !== prev.id && f.id !== only.id).map((f) => f.id);
    // Oldest first: the last id is the previous issue, and only `only` is left.
    const { leadFact } = plan({ sendDate: '2026-12-03', recentFactIds: [...others, prev.id] });
    expect(leadFact.id).toBe(only.id);
    expect(leadFact.service).toBe(factById(prev.id).service);
  });

  test('a fact used in the last six issues never repeats', () => {
    const recent = [];
    const seen = [];
    for (let i = 0; i < 7; i += 1) {
      const { leadFact } = plan({ sendDate: '2026-12-03', recentFactIds: recent.slice(-6) });
      expect(recent.slice(-6)).not.toContain(leadFact.id);
      seen.push(leadFact.id);
      recent.push(leadFact.id);
    }
    expect(new Set(seen.slice(0, 6)).size).toBe(6);
  });

  test('only facts that fit the send month are chosen', () => {
    for (const date of ['2026-12-03', '2027-02-04', '2027-05-06', '2027-07-15']) {
      const month = Number(date.slice(5, 7));
      expect(plan({ sendDate: date }).leadFact.months).toContain(month);
    }
  });

  test('returns no fact when every fact of the month was used lately', () => {
    const all = factsForSend('2027-01-07').map((f) => f.id);
    expect(plan({ sendDate: '2027-01-07', recentFactIds: all })).toEqual({ leadFact: null, idItem: null, reason: 'no_fact_for_month' });
  });

  test('never picks the species the lead fact is about, and prefers another corner of the yard', () => {
    for (const date of ['2026-12-03', '2026-12-17', '2027-01-07', '2027-04-01', '2027-06-03']) {
      const { leadFact, idItem } = plan({ sendDate: date });
      expect(named(idItem, leadFact)).toBe(false);
      const otherCorner = SPECIES.filter((s) => !named(s, leadFact) && !relates(s, leadFact.service));
      if (otherCorner.length) expect(relates(idItem, leadFact.service)).toBe(false);
    }
  });

  test('never reuses a species from the last six issues, falling back to any unused one', () => {
    const first = plan({ sendDate: '2026-12-03' });
    const again = plan({ sendDate: '2026-12-03', recentSpeciesSlugs: [first.idItem.slug] });
    expect(again.idItem.slug).not.toBe(first.idItem.slug);
    // Exclude every species from another corner: an unused related species still fills the slot.
    const otherCorner = SPECIES.filter((s) => !relates(s, first.leadFact.service)).map((s) => s.slug);
    const fallback = plan({ sendDate: '2026-12-03', recentSpeciesSlugs: otherCorner });
    expect(otherCorner).not.toContain(fallback.idItem.slug);
    expect(plan({ sendDate: '2026-12-03', recentSpeciesSlugs: SPECIES.map((s) => s.slug) })).toMatchObject({ idItem: null, reason: 'no_species' });
  });
});

describe('planIssue: "A tool we\'d use"', () => {
  const ALL_TOOLS = TOOLS.map((t) => t.productId);
  // The live check's proof is a link: the tool links whose page passed it.
  const urls = (productIds) => TOOLS.filter((t) => productIds.includes(t.productId)).map((t) => t.url);
  const ALL_URLS = urls(ALL_TOOLS);
  const ids = (list) => list.map((t) => t.productId);
  // With no recent issues, Dec 3 leads with a termite fact (T03), Feb 4 with a
  // pest fact (R02) and May 6 with a mosquito fact (M04; no tool lists mosquito).
  const DEC = '2026-12-03';
  const FEB = '2027-02-04';
  const MAY = '2027-05-06';

  test('no live tool link: no tool item, and the issue still plans', () => {
    const r = plan({ sendDate: DEC });
    expect(r.tool).toBeNull();
    expect(r.leadFact).not.toBeNull();
    expect(r.idItem).not.toBeNull();
  });

  test("a tool for the lead fact's service comes first, and only a tool whose link passed the live check is picked", () => {
    for (const sendDate of [DEC, FEB]) {
      const { leadFact, tool } = plan({ sendDate, liveToolUrls: ALL_URLS });
      expect(tool.services).toContain(leadFact.service);
      const others = ALL_TOOLS.filter((id) => id !== tool.productId);
      const next = plan({ sendDate, liveToolUrls: urls(others) }).tool;
      expect(others).toContain(next.productId);
    }
    expect([plan({ sendDate: DEC }).leadFact.service, plan({ sendDate: FEB }).leadFact.service]).toEqual(['termite', 'pest']);
  });

  test("with no live tool for the lead's service, any live tool fills the item", () => {
    const { leadFact } = plan({ sendDate: DEC });
    const otherService = ids(TOOLS.filter((t) => !t.services.includes(leadFact.service)));
    expect(otherService.length).toBeGreaterThan(0);
    expect(otherService).toContain(plan({ sendDate: DEC, liveToolUrls: urls(otherService) }).tool.productId);
    // no tool lists mosquito: a mosquito lead still gets a live tool
    const may = plan({ sendDate: MAY, liveToolUrls: ALL_URLS });
    expect(may.leadFact.service).toBe('mosquito');
    expect(TOOLS.some((t) => t.services.includes('mosquito'))).toBe(false);
    expect(ALL_TOOLS).toContain(may.tool.productId);
  });

  test('the last two issues\' tools are skipped, and an issue without a tool counts as one of them', () => {
    expect(TOOL_RECENT_WINDOW).toBe(2);
    const first = plan({ sendDate: DEC, liveToolUrls: ALL_URLS }).tool.productId;
    const again = plan({ sendDate: DEC, liveToolUrls: ALL_URLS, recentToolIds: [first] }).tool.productId;
    expect(again).not.toBe(first);
    const recentTwo = plan({ sendDate: DEC, liveToolUrls: ALL_URLS, recentToolIds: [again, first] }).tool.productId;
    expect([first, again]).not.toContain(recentTwo);
    // three issues ago is outside the window: the first pick comes back
    const older = ALL_TOOLS.filter((id) => id !== first).slice(0, 2);
    expect(plan({ sendDate: DEC, liveToolUrls: ALL_URLS, recentToolIds: [first, ...older] }).tool.productId).toBe(first);
    // one entry per issue, null without a tool (pre-push PR 3 r4)
    const only = urls([first]);
    expect(plan({ sendDate: DEC, liveToolUrls: only, recentToolIds: [first, null] }).tool).toBeNull();
    expect(plan({ sendDate: DEC, liveToolUrls: only, recentToolIds: [first, null, null] }).tool.productId).toBe(first);
    // every live tool used in the last two issues: no tool item
    expect(plan({ sendDate: DEC, liveToolUrls: urls([first, again]), recentToolIds: [first, again] }).tool).toBeNull();
  });

  test('is deterministic, counts only a usable tool\'s link, and refuses a list that is not a list', () => {
    expect(plan({ sendDate: DEC, liveToolUrls: ALL_URLS })).toEqual(plan({ sendDate: DEC, liveToolUrls: ALL_URLS }));
    // a product id is not a link, and a link no tool has counts for nothing
    expect(plan({ sendDate: DEC, liveToolUrls: [...ALL_TOOLS, 'https://www.amazon.com/dp/B000000000?tag=wavespestcont-20'] }).tool).toBeNull();
    expect(() => plan({ sendDate: DEC, liveToolUrls: ALL_URLS[0] })).toThrow(/must be lists/);
    expect(() => plan({ sendDate: DEC, recentToolIds: null })).toThrow(/must be lists/);
  });
});
