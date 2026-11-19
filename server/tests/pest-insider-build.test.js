// Pest Insider buildIssue: plan -> write -> check -> render, with a fake writer.
const { buildIssue } = require('../services/pest-insider');
const { factById } = require('../services/pest-insider/facts');
const { SPECIES } = require('../services/pest-insider/plan');

// A fixed plan: fact A01 (white-footed ants) and the White-footed Ant species,
// so these cases test write -> check -> render, not the planner's rotation.
const fixedPlan = () => ({ leadFact: factById('A01'), idItem: SPECIES.find((s) => s.slug === 'white-footed-ant') });
const draft = (over = {}) => ({
  subject: '🐜 White-footed ant colonies can reach 3 million',
  preview: 'Branches are the bridge.',
  lead: {
    headline: 'Three million ants in a nest',
    sentences: [
      { text: 'UF/IFAS says white-footed ant colonies can reach 3 million ants.', fact_id: 'A01' },
      { text: 'Nearly half of a colony is fertile, reproductive females.', fact_id: 'A01' },
      { text: 'Ants can reach a house over branches that touch it, and the colony had 5 queens.', fact_id: 'A01' },
    ],
  },
  id_item: { text: 'Colonies can hold a million-plus ants, and most workers never leave the nest.' },
  ...over,
});
const writer = (d) => jest.fn().mockResolvedValue({ ok: true, draft: d, provider: 'anthropic', model: 'test-model' });

describe('buildIssue', () => {
  test('builds an issue, cuts the failing sentence and reports it in diagnostics', async () => {
    const write = writer(draft());
    const r = await buildIssue({ sendDate: '2026-12-03', plan: fixedPlan, write, blogUrl: 'https://www.wavespestcontrol.com/blog/white-footed-ants/' });
    expect(r.ok).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toMatchObject({ sendDate: '2026-12-03', leadFact: { id: 'A01' }, idItem: { slug: 'white-footed-ant' } });
    expect(r.issue.subject).toBe('🐜 White-footed ant colonies can reach 3 million');
    expect(r.issue.html_body).toContain('UF/IFAS says white-footed ant colonies can reach 3 million ants.');
    expect(r.issue.html_body).not.toContain('5 queens');
    expect(r.issue.html_body).toContain('Read the full story');
    expect(r.diagnostics).toMatchObject({ sendDate: '2026-12-03', factId: 'A01', speciesSlug: 'white-footed-ant', provider: 'anthropic', model: 'test-model' });
    expect(r.diagnostics.cut).toEqual([{ text: expect.stringContaining('5 queens'), reason: expect.stringContaining('number not in the source: 5') }]);
  });

  test('recent picks are passed to the plan', async () => {
    const r = await buildIssue({ sendDate: '2026-12-03', recent: { factIds: ['A01'], speciesSlugs: ['white-footed-ant'] }, write: writer(draft()) });
    expect(r.diagnostics.factId).not.toBe('A01');
    expect(r.diagnostics.speciesSlug).not.toBe('white-footed-ant');
  });

  test('fails with the claim-check reason when fewer than two sentences survive', async () => {
    const bad = draft({ lead: { headline: 'x', sentences: [{ text: 'Colonies hold 9 million ants.', fact_id: 'A01' }, { text: 'Bleach works.', fact_id: 'A01' }] } });
    const r = await buildIssue({ sendDate: '2026-12-03', plan: fixedPlan, write: writer(bad) });
    expect(r).toMatchObject({ ok: false, issue: null, reason: expect.stringContaining('only 0 lead sentence') });
    expect(r.diagnostics.cut).toHaveLength(2);
  });

  test('fails when the identifier text states a number the species entry does not', async () => {
    const r = await buildIssue({ sendDate: '2026-12-03', plan: fixedPlan, write: writer(draft({ id_item: { text: 'Colonies hold 12 million ants.' } })) });
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining('id_item failed') });
  });

  test('a bad subject falls back to the fact title with its service emoji; a bad preview to the species name', async () => {
    const r = await buildIssue({ sendDate: '2026-12-03', plan: fixedPlan, write: writer(draft({ subject: 'Plain subject', preview: 'Costs $5' })) });
    expect(r.ok).toBe(true);
    expect(r.issue.subject).toBe('🐜 White-footed ant colonies reach 3 million');
    expect(r.issue.preview).toBe("What's this? White-footed Ant");
    expect(r.diagnostics.fallbacks).toEqual(['subject', 'preview']);
  });

  test('passes through writer failures and planning failures', async () => {
    expect(await buildIssue({ sendDate: '2026-12-03', plan: fixedPlan, write: jest.fn().mockResolvedValue({ ok: false, reason: 'anthropic_timeout' }) }))
      .toMatchObject({ ok: false, reason: 'writer_failed:anthropic_timeout' });
    const { factsForSend } = require('../services/pest-insider/facts');
    const used = factsForSend('2026-12-03').map((f) => f.id);
    const noFact = await buildIssue({ sendDate: '2026-12-03', recent: { factIds: used }, write: jest.fn() });
    expect(noFact).toMatchObject({ ok: false, reason: 'no_fact_for_month' });
  });

  test('optional blocks reach the renderer', async () => {
    const r = await buildIssue({ sendDate: '2026-12-03', plan: fixedPlan, write: writer(draft()), areaLine: 'Sample area line.', home: { lastVisit: { date: '2026-11-04', areas: ['lanai'] } } });
    expect(r.issue.html_body).toContain('Sample area line.');
    expect(r.issue.html_body).toContain('Your home');
  });
});
