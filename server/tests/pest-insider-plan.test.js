// Pest Insider plan: which fact leads and which species fills "What's this?".
const { planIssue, SPECIES, CATEGORY_SERVICES } = require('../services/pest-insider/plan');
const { factsForSend } = require('../services/pest-insider/facts');

describe('planIssue', () => {
  test('is deterministic for the same inputs', () => {
    const a = planIssue({ sendDate: '2026-12-03', recentFactIds: ['A01'], recentSpeciesSlugs: ['fire-ant'] });
    const b = planIssue({ sendDate: '2026-12-03', recentFactIds: ['A01'], recentSpeciesSlugs: ['fire-ant'] });
    expect(a).toEqual(b);
  });

  test('leads with the first pest-kind, high-confidence fact of the month', () => {
    const { leadFact } = planIssue({ sendDate: '2026-12-03' });
    expect(leadFact).toBe(factsForSend('2026-12-03')[0]);
    expect(leadFact.kind).toBe('pest');
    expect(leadFact.months).toContain(12);
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

  test('picks a species whose category relates to the lead fact service', () => {
    // T01 is a termite fact; the Termites category is the only one that relates to it.
    const { leadFact, idItem } = planIssue({ sendDate: '2026-12-03', recentFactIds: factsForSend('2026-12-03').filter((f) => f.service !== 'termite').map((f) => f.id) });
    expect(leadFact.service).toBe('termite');
    expect(CATEGORY_SERVICES[idItem.category]).toContain('termite');
  });

  test('prefers the species the fact names', () => {
    const { leadFact, idItem } = planIssue({ sendDate: '2026-12-03' });
    expect(leadFact.id).toBe('A01'); // white-footed ant colonies
    expect(idItem.slug).toBe('white-footed-ant');
  });

  test('never reuses a species from the last six issues, falling back to any unused one', () => {
    const first = planIssue({ sendDate: '2026-12-03' });
    const again = planIssue({ sendDate: '2026-12-03', recentSpeciesSlugs: [first.idItem.slug] });
    expect(again.idItem.slug).not.toBe(first.idItem.slug);
    // Exclude every related species: any other unused species still fills the slot.
    const related = SPECIES.filter((s) => (CATEGORY_SERVICES[s.category] || []).includes(first.leadFact.service)).map((s) => s.slug);
    const fallback = planIssue({ sendDate: '2026-12-03', recentSpeciesSlugs: related });
    expect(related).not.toContain(fallback.idItem.slug);
    expect(planIssue({ sendDate: '2026-12-03', recentSpeciesSlugs: SPECIES.map((s) => s.slug) })).toMatchObject({ idItem: null, reason: 'no_species' });
  });
});
