/**
 * Weekly knowledge-gaps admin notification: grouping and ranking of the
 * week's unanswered questions, the quiet week (nothing written), the
 * copy rules the alert must pass, and the run guards (kill switch, a
 * failed query, a failed write).
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { composeAdminAlert } = require('../services/admin-alert-compose');
const { runKnowledgeGapsWeekly, withoutSavedGaps, _private } = require('../services/knowledge/knowledge-gaps-weekly');

const { composeGapsAlert, reportWindow, questionKey } = _private;
const NOW = new Date('2026-10-05T13:00:00Z'); // Monday 9:00 ET, after the 8:43 tick
const row = (query, askedBy = 'lead_agent', coverage = 'none', at = '2026-10-01T15:00:00Z') => ({ query, asked_by: askedBy, coverage, created_at: at });

describe('composeGapsAlert', () => {
  test('groups repeats (case and punctuation ignored) and ranks most asked first', () => {
    const { spec, detail, gaps } = composeGapsAlert({ rows: [
      row('One-Time Pest Control'),
      row('one time pest control?', 'lead_agent', 'partial'),
      row('dollar spot on St. Augustine', 'brief_driven_agent'),
      row('One-time pest control', 'tech_field'),
    ] }, NOW);
    expect(gaps).toBe(4);
    expect(composeAdminAlert(spec).headline).toBe('Content — fill 4 knowledge gaps from last week');
    expect(composeAdminAlert(spec).why).toBe('Most asked: “One-Time Pest Control”');
    expect(detail.indexOf('1. "One-Time Pest Control" — asked 3×')).toBeGreaterThan(-1);
    expect(detail).toContain('not or only partly answered · lead agent, tech Q&A');
    expect(detail).toContain('2. "dollar spot on St. Augustine"');
    expect(detail).toContain('not answered · blog writer');
    expect(detail).toMatch(/Asked by: lead agent 2, blog writer 1, tech Q&A 1\./);
  });

  test('gaps the operator added from the Intelligence Bar are labeled as such', () => {
    const { detail } = composeGapsAlert({ rows: [row('chinch bugs on zoysia', 'intelligence_bar')] }, NOW);
    expect(detail).toContain('not answered · Intelligence Bar');
    expect(detail).toMatch(/Asked by: Intelligence Bar 1\./);
  });

  test('questions in other scripts are listed, punctuation-only ones are not', () => {
    expect(questionKey('¿Cómo controlo las hormigas?')).toBe('cómo controlo las hormigas');
    expect(questionKey('Как избавиться от муравьёв')).toBe('как избавиться от муравьёв');
    expect(questionKey('???')).toBe('');
    const { detail, gaps } = composeGapsAlert({ rows: [row('Как избавиться от муравьёв', 'intelligence_bar')] }, NOW);
    expect(gaps).toBe(1);
    expect(detail).toContain('"Как избавиться от муравьёв"');
  });

  test('caps the list at 10 and says how many more', () => {
    const rows = Array.from({ length: 13 }, (_, i) => row(`question ${i}`));
    const { detail } = composeGapsAlert({ rows }, NOW);
    expect(detail).toContain('10. "');
    expect(detail).not.toContain('11. "');
    expect(detail).toContain('…and 3 more.');
  });

  test('a quiet week composes nothing', () => {
    expect(composeGapsAlert({ rows: [] }, NOW)).toBeNull();
    expect(composeGapsAlert({ rows: [row('???')], unrated: 3 }, NOW)).toBeNull();
  });

  test('unrated answers are reported as unknown, never as answered', () => {
    const busy = composeGapsAlert({ rows: [row('door sweeps')], unrated: 1 }, NOW);
    expect(busy.detail).toContain('1 answer had no coverage rating, so whether it fully answered is unknown.');
    const many = composeGapsAlert({ rows: [row('door sweeps')], unrated: 3 }, NOW);
    expect(many.detail).toContain('3 answers had no coverage rating, so whether they fully answered is unknown.');
  });

  test('a punctuation-only question is left out of every count', () => {
    const { detail, gaps } = composeGapsAlert({ rows: [row('door sweeps'), row('???', 'tech_field')] }, NOW);
    expect(gaps).toBe(1);
    expect(detail).toMatch(/Asked by: lead agent 1\./);
  });

  test('a customer question is masked in the detail, and a why that breaks the copy rules falls back to a plain line', () => {
    const { spec, detail } = composeGapsAlert({ rows: [row('call me at 941-555-0188 about ants since 2026-09-30')] }, NOW);
    expect(detail).not.toContain('555-0188');
    expect(composeAdminAlert(spec).why).toBe('The knowledge base could not fully answer a question last week.');
  });

  test('question key ignores case, punctuation and spacing', () => {
    expect(questionKey('  Is it SAFE for my dog?! ')).toBe(questionKey('is it safe for my dog'));
  });
});

test('report week ends at the latest Monday 8:43 ET tick and spans 7 days', () => {
  const { start, end } = reportWindow(NOW);
  expect(end.toISOString()).toBe('2026-10-05T12:43:00.000Z');
  expect(start.toISOString()).toBe('2026-09-28T12:43:00.000Z');
  // Before Monday's tick, the report is the previous week's.
  expect(reportWindow(new Date('2026-10-05T12:00:00Z')).end.toISOString()).toBe('2026-09-28T12:43:00.000Z');
});

describe('runKnowledgeGapsWeekly', () => {
  const env = { ...process.env };
  let raiseAlert;
  const run = (extra = {}) => runKnowledgeGapsWeekly({
    now: NOW,
    loadWeek: async () => ({ rows: [row('door sweeps')], unrated: 0 }),
    raiseAlert,
    ...extra,
  });

  beforeEach(() => {
    process.env = { ...env };
    delete process.env.KNOWLEDGE_GAPS_WEEKLY;
    raiseAlert = jest.fn(async () => ({ id: 'n1' }));
  });
  afterAll(() => { process.env = env; });

  test('raises the week\'s alert, keyed to the report week end', async () => {
    expect(await run()).toEqual({ raised: true, gaps: 1 });
    expect(raiseAlert).toHaveBeenCalledTimes(1);
    const [{ spec, detail }, weekEnd] = raiseAlert.mock.calls[0];
    expect(spec).toMatchObject({ area: 'Content', severity: 'needs-you', doneWhen: 'gaps_reviewed' });
    expect(detail).toContain('"door sweeps"');
    expect(weekEnd.toISOString()).toBe('2026-10-05T12:43:00.000Z');
  });

  test('a quiet week writes nothing', async () => {
    expect(await run({ loadWeek: async () => ({ rows: [], unrated: 0 }) })).toEqual({ skipped: 'nothing_found', gaps: 0 });
    expect(raiseAlert).not.toHaveBeenCalled();
  });

  test('kill switch writes nothing', async () => {
    process.env.KNOWLEDGE_GAPS_WEEKLY = 'off';
    expect(await run()).toEqual({ skipped: 'disabled' });
    expect(raiseAlert).not.toHaveBeenCalled();
  });

  test('a failed write reports an error, so the next catch-up tick retries the same week', async () => {
    raiseAlert = jest.fn(async () => { throw new Error('boom'); });
    expect(await run()).toMatchObject({ raised: false, error: true });
  });

  test('a failed query writes nothing', async () => {
    expect(await run({ loadWeek: async () => { throw new Error('db down'); } })).toEqual({ skipped: 'query_failed' });
    expect(raiseAlert).not.toHaveBeenCalled();
  });
});

describe('withoutSavedGaps', () => {
  test('recent Q&A lists leave out Intelligence Bar gaps but keep rows with no source', () => {
    const knex = require('knex')({ client: 'pg' });
    const sql = withoutSavedGaps(knex('knowledge_queries')).limit(30).toString();
    expect(sql).toBe('select * from "knowledge_queries" where ("asked_by" is null or not "asked_by" = \'intelligence_bar\') limit 30');
  });
});
