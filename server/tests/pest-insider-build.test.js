// Pest Insider buildIssue: plan -> copy check -> render -> send validator.
// Every word comes from the fact bank's reviewed copy; no model is called.
const { buildIssue } = require('../services/pest-insider');
const { FACTS, factById, factsForSend } = require('../services/pest-insider/facts');
const { SPECIES, RECENT_WINDOW } = require('../services/pest-insider/plan');

const A01 = factById('A01');
const WFA = SPECIES.find((s) => s.slug === 'white-footed-ant');
// A fixed plan: fact A01 (white-footed ants) and the White-footed Ant species,
// so these cases test check -> render -> validate, not the planner's rotation.
const planOf = (leadFact, idItem = WFA) => jest.fn(() => ({ leadFact, idItem }));

describe('buildIssue', () => {
  test("builds the issue from the fact's reviewed lead, title and species entry", () => {
    const plan = planOf(A01);
    const r = buildIssue({ sendDate: '2026-12-03', plan });
    expect(r.ok).toBe(true);
    expect(plan).toHaveBeenCalledWith({ sendDate: '2026-12-03', recentFactIds: [], recentSpeciesSlugs: [], recheckedFactIds: [] });
    expect(r.issue.subject).toBe(`🐜 ${A01.title}`);
    expect(r.issue.preview).toBe("What's this? White-footed Ant");
    for (const line of A01.lead) {
      expect(r.issue.html_body).toContain(line);
      expect(r.issue.text_body).toContain(line);
    }
    expect(r.issue.text_body).toContain(WFA.fact);
    expect(r.diagnostics).toEqual({ sendDate: '2026-12-03', factId: 'A01', speciesSlug: 'white-footed-ant', problems: [] });
  });

  test('recent picks are passed to the plan', () => {
    const r = buildIssue({ sendDate: '2026-12-03', recent: { factIds: ['T03'], speciesSlugs: ['house-centipede'] } });
    expect(r.ok).toBe(true);
    expect(r.diagnostics.factId).not.toBe('T03');
    expect(r.diagnostics.speciesSlug).not.toBe('house-centipede');
  });

  test('a copy problem fails the issue and names every problem; nothing is cut', () => {
    const bad = { ...A01, lead: [A01.lead[0], 'Colonies hold 9 million ants.', 'Bleach works on them.'] };
    const r = buildIssue({ sendDate: '2026-12-03', plan: planOf(bad) });
    expect(r).toMatchObject({ ok: false, issue: null, reason: expect.stringMatching(/^copy_check_failed: lead: number not in the source: 9; lead: pesticide or brand name/) });
    expect(r.diagnostics.problems.map((p) => p.text)).toEqual(['Colonies hold 9 million ants.', 'Bleach works on them.']);
  });

  test('the send validator reads the whole rendered issue, where one sentence reads the one before it', () => {
    // On its own "They swarm again in June." names no termite, so the copy
    // check passes it; under the "Formosan Termite" heading the shared
    // register reads it as the false second-swarm claim, as the send would.
    const formosan = { ...SPECIES.find((s) => s.slug === 'formosan-termite'), fact: 'They swarm again in June.' };
    const r = buildIssue({ sendDate: '2027-05-06', plan: planOf(factById('T02'), formosan) });
    expect(r).toMatchObject({ ok: false, issue: null, reason: expect.stringMatching(/^send_validator_blocked: Unverified claim \(termite_second_swarm\)/) });
    expect(r.diagnostics.problems[0]).toMatchObject({ part: 'send_validator' });
  });

  test('a lead fact marked for a send-time recheck is refused unless the caller names it as rechecked', () => {
    const M01 = factById('M01');
    expect(M01.recheck_before_send).toBe(true);
    const plan = planOf(M01, SPECIES.find((s) => s.slug === 'house-centipede'));
    expect(buildIssue({ sendDate: '2027-06-03', plan })).toMatchObject({ ok: false, issue: null, reason: 'recheck_needed: M01' });
    expect(buildIssue({ sendDate: '2027-06-03', plan, recheckedFactIds: ['M01'] }).ok).toBe(true);
    expect(plan.mock.calls[1][0].recheckedFactIds).toEqual(['M01']);
  });

  test('passes planning failures through', () => {
    const used = factsForSend('2026-12-03').map((f) => f.id);
    expect(buildIssue({ sendDate: '2026-12-03', recent: { factIds: used } })).toMatchObject({ ok: false, reason: 'no_fact_for_month', issue: null });
  });

  test('an impossible send date is refused before any plan is made', () => {
    const plan = jest.fn();
    expect(() => buildIssue({ sendDate: '2027-02-30', plan })).toThrow(/not a real calendar date/);
    expect(plan).not.toHaveBeenCalled();
  });
});

describe('every issue the bank can make', () => {
  test.each(FACTS.filter((f) => !f.reserve).map((f) => [f.id, f]))('%s builds an issue the send validator accepts', (_id, fact) => {
    const r = buildIssue({ sendDate: '2026-12-03', plan: planOf(fact), recheckedFactIds: [fact.id] });
    expect({ reason: r.reason, problems: r.diagnostics.problems }).toEqual({ reason: null, problems: [] });
  });

  test('every identifier species builds an issue the send validator accepts', () => {
    const failed = SPECIES
      .map((species) => ({ slug: species.slug, r: buildIssue({ sendDate: '2026-12-03', plan: planOf(A01, species) }) }))
      .filter(({ r }) => !r.ok)
      .map(({ slug, r }) => `${slug}: ${r.reason}`);
    expect(failed).toEqual([]);
  });

  test('the first and third Thursdays from December 2026 through 2027 all build, in order', () => {
    const days = ['2026-12-03', '2026-12-17'];
    for (let month = 0; month < 12; month += 1) {
      const thursdays = [];
      for (let day = 1; day <= 31; day += 1) {
        const d = new Date(Date.UTC(2027, month, day));
        if (d.getUTCMonth() === month && d.getUTCDay() === 4) thursdays.push(d.toISOString().slice(0, 10));
      }
      days.push(thursdays[0], thursdays[2]);
    }
    const recent = { factIds: [], speciesSlugs: [] };
    const built = days.map((sendDate) => {
      const r = buildIssue({ sendDate, recent: { factIds: recent.factIds.slice(-RECENT_WINDOW), speciesSlugs: recent.speciesSlugs.slice(-RECENT_WINDOW) } });
      if (r.ok) {
        recent.factIds.push(r.diagnostics.factId);
        recent.speciesSlugs.push(r.diagnostics.speciesSlug);
      }
      return { sendDate, reason: r.reason };
    });
    expect(built).toHaveLength(26);
    expect(built.filter((b) => b.reason)).toEqual([]);
    // With no recheck recorded, no fact marked for one ever leads.
    expect(recent.factIds.filter((id) => factById(id).recheck_before_send)).toEqual([]);
    // The two default sample dates (ops/agents/pest-insider-sample.js).
    expect(recent.factIds.slice(0, 2)).toEqual(['T03', 'A01']);
  });
});
