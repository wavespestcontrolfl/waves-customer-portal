// The PDF queue's Visit Summary cache fence (GATE_LAWN_VISIT_SUMMARY_V2, codex
// #6087 r6): a render is uncached only when the summary it printed differs from
// the one the key names, and only when the Visit Summary or the plain recap won
// the summary slot.
const { visitSummaryRenderMismatch } = require('../services/service-report/pdf-queue');

const base = { live: true, pinned: true, renderedSignature: ':vs=abc', keySignature: ':vs=abc' };

test('same signature: cache', () => {
  expect(visitSummaryRenderMismatch({ ...base, renderedSource: 'lawn_visit_summary' })).toBe(false);
});

test('the race: key names a frozen summary, the render printed the plain recap → do not cache', () => {
  expect(visitSummaryRenderMismatch({ ...base, renderedSource: 'recap', renderedSignature: '' })).toBe(true);
});

test('a technician report or typed narrative won the slot: no comparison, cache', () => {
  for (const renderedSource of ['technician_report', 'typed_narrative', 'rodent_narrative']) {
    expect(visitSummaryRenderMismatch({ ...base, renderedSource, renderedSignature: '' })).toBe(false);
  }
});

test('gate off or unpinned render: never fences', () => {
  expect(visitSummaryRenderMismatch({ ...base, live: false, renderedSource: 'recap', renderedSignature: '' })).toBe(false);
  expect(visitSummaryRenderMismatch({ ...base, pinned: false, renderedSource: 'recap', renderedSignature: '' })).toBe(false);
});
