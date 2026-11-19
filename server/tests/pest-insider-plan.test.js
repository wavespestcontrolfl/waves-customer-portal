// Pest Insider plan: which fact leads and which species fills "What's this?".
const { planIssue, SPECIES, CATEGORY_SERVICES, SEASONAL_MAX_MONTHS } = require('../services/pest-insider/plan');
const { factsForSend, factById } = require('../services/pest-insider/facts');

const relates = (s, service) => (CATEGORY_SERVICES[s.category] || []).includes(service);
const named = (s, fact) => s.name.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 3)
  .some((w) => new RegExp(`\\b${w}(?:s|es)?\\b`).test(`${fact.title} ${fact.statement}`.toLowerCase()));

describe('planIssue', () => {
  test('is deterministic for the same inputs', () => {
    const a = planIssue({ sendDate: '2026-12-03', recentFactIds: ['A01'], recentSpeciesSlugs: ['fire-ant'] });
    const b = planIssue({ sendDate: '2026-12-03', recentFactIds: ['A01'], recentSpeciesSlugs: ['fire-ant'] });
    expect(a).toEqual(b);
  });

  test('leads with a pest-kind fact of the month, seasonal first, when one exists', () => {
    const { leadFact } = planIssue({ sendDate: '2026-12-03' });
    const pool = factsForSend('2026-12-03');
    expect(leadFact.kind).toBe('pest');
    expect(leadFact.months).toContain(12);
    const seasonalPest = pool.filter((f) => f.kind === 'pest' && f.months.length <= SEASONAL_MAX_MONTHS);
    if (seasonalPest.length) expect(leadFact.months.length).toBeLessThanOrEqual(SEASONAL_MAX_MONTHS);
  });

  test('skips the previous issue\'s service when another service fits the month', () => {
    const first = planIssue({ sendDate: '2026-12-03' }).leadFact;
    const next = planIssue({ sendDate: '2026-12-17', recentFactIds: [first.id] }).leadFact;
    const others = factsForSend('2026-12-17', { excludeIds: [first.id] }).filter((f) => f.service !== first.service);
    expect(others.length).toBeGreaterThan(0);
    expect(next.service).not.toBe(first.service);
  });

  test('falls back to the same service when no other service fits', () => {
    const pool = factsForSend('2026-12-03');
    const [prev, only] = pool.filter((f) => f.service === 'pest');
    const others = pool.filter((f) => f.id !== prev.id && f.id !== only.id).map((f) => f.id);
    // Oldest first: the last id is the previous issue, and only `only` is left.
    const { leadFact } = planIssue({ sendDate: '2026-12-03', recentFactIds: [...others, prev.id] });
    expect(leadFact.id).toBe(only.id);
    expect(leadFact.service).toBe(factById(prev.id).service);
  });

  test('a fact used in the last six issues never repeats', () => {
    const recent = [];
    const seen = [];
    for (let i = 0; i < 7; i += 1) {
      const { leadFact } = planIssue({ sendDate: '2026-12-03', recentFactIds: recent.slice(-6) });
      expect(recent.slice(-6)).not.toContain(leadFact.id);
      seen.push(leadFact.id);
      recent.push(leadFact.id);
    }
    expect(new Set(seen.slice(0, 6)).size).toBe(6);
  });

  test('only facts that fit the send month are chosen', () => {
    for (const date of ['2026-12-03', '2027-02-04', '2027-05-06', '2027-07-15']) {
      const month = Number(date.slice(5, 7));
      expect(planIssue({ sendDate: date }).leadFact.months).toContain(month);
    }
  });

  test('returns no fact when every fact of the month was used lately', () => {
    const all = factsForSend('2027-01-07').map((f) => f.id);
    expect(planIssue({ sendDate: '2027-01-07', recentFactIds: all })).toEqual({ leadFact: null, idItem: null, reason: 'no_fact_for_month' });
  });

  test('never picks the species the lead fact is about, and prefers another corner of the yard', () => {
    for (const date of ['2026-12-03', '2026-12-17', '2027-01-07', '2027-04-01', '2027-06-03']) {
      const { leadFact, idItem } = planIssue({ sendDate: date });
      expect(named(idItem, leadFact)).toBe(false);
      const otherCorner = SPECIES.filter((s) => !named(s, leadFact) && !relates(s, leadFact.service));
      if (otherCorner.length) expect(relates(idItem, leadFact.service)).toBe(false);
    }
  });

  test('never reuses a species from the last six issues, falling back to any unused one', () => {
    const first = planIssue({ sendDate: '2026-12-03' });
    const again = planIssue({ sendDate: '2026-12-03', recentSpeciesSlugs: [first.idItem.slug] });
    expect(again.idItem.slug).not.toBe(first.idItem.slug);
    // Exclude every species from another corner: an unused related species still fills the slot.
    const otherCorner = SPECIES.filter((s) => !relates(s, first.leadFact.service)).map((s) => s.slug);
    const fallback = planIssue({ sendDate: '2026-12-03', recentSpeciesSlugs: otherCorner });
    expect(otherCorner).not.toContain(fallback.idItem.slug);
    expect(planIssue({ sendDate: '2026-12-03', recentSpeciesSlugs: SPECIES.map((s) => s.slug) })).toMatchObject({ idItem: null, reason: 'no_species' });
  });
});
