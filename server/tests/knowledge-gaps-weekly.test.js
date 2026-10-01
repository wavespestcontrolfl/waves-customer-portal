/**
 * Weekly knowledge-gaps email: grouping and ranking of the week's
 * unanswered questions, the quiet-week email, and the send guards
 * (kill switch, internal-only recipient, once per week, stamp only on success).
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { runKnowledgeGapsWeekly, _private } = require('../services/knowledge/knowledge-gaps-weekly');

const { composeGapsEmail, reportWindow, questionKey } = _private;
const NOW = new Date('2026-10-05T13:00:00Z'); // Monday 9:00 ET, after the 8:41 tick
const row = (query, askedBy = 'lead_agent', coverage = 'none', at = '2026-10-01T15:00:00Z') => ({ query, asked_by: askedBy, coverage, created_at: at });

describe('composeGapsEmail', () => {
  test('groups repeats (case and punctuation ignored) and ranks most asked first', () => {
    const { subject, text, gaps } = composeGapsEmail([
      row('One-Time Pest Control'),
      row('one time pest control?', 'lead_agent', 'partial'),
      row('dollar spot on St. Augustine', 'brief_driven_agent'),
      row('One-time pest control', 'tech_field'),
    ], NOW);
    expect(gaps).toBe(4);
    expect(subject).toBe('Knowledge gaps: 4 questions this week');
    const first = text.indexOf('1. "One-Time Pest Control" — asked 3×');
    expect(first).toBeGreaterThan(-1);
    expect(text).toContain('not or only partly answered · lead agent, tech Q&A');
    expect(text).toContain('2. "dollar spot on St. Augustine"');
    expect(text).toContain('not answered · blog writer');
    expect(text).toMatch(/Asked by: lead agent 2, blog writer 1, tech Q&A 1\./);
  });

  test('caps the list at 10 and says how many more', () => {
    const rows = Array.from({ length: 13 }, (_, i) => row(`question ${i}`));
    const { text } = composeGapsEmail(rows, NOW);
    expect(text).toContain('10. "');
    expect(text).not.toContain('11. "');
    expect(text).toContain('…and 3 more.');
  });

  test('a quiet week still sends a one-line email', () => {
    expect(composeGapsEmail([], NOW)).toEqual({
      subject: 'Knowledge gaps: none this week',
      text: 'Every question asked of the knowledge base last week was fully answered.',
      gaps: 0,
    });
  });

  test('question key ignores case, punctuation and spacing', () => {
    expect(questionKey('  Is it SAFE for my dog?! ')).toBe(questionKey('is it safe for my dog'));
  });
});

test('report week ends at the latest Monday 8:41 ET tick and spans 7 days', () => {
  const { start, end } = reportWindow(NOW);
  expect(end.toISOString()).toBe('2026-10-05T12:41:00.000Z');
  expect(start.toISOString()).toBe('2026-09-28T12:41:00.000Z');
  // Before Monday's tick, the report is the previous week's.
  expect(reportWindow(new Date('2026-10-05T12:00:00Z')).end.toISOString()).toBe('2026-09-28T12:41:00.000Z');
});

describe('runKnowledgeGapsWeekly', () => {
  const env = { ...process.env };
  let mailer;
  let stampSent;
  const run = (extra = {}) => runKnowledgeGapsWeekly({
    now: NOW,
    sendgrid: mailer,
    loadWeek: async () => [row('door sweeps')],
    sentThisWeek: async () => false,
    stampSent,
    ...extra,
  });

  beforeEach(() => {
    process.env = { ...env };
    delete process.env.KNOWLEDGE_GAPS_WEEKLY;
    delete process.env.KNOWLEDGE_GAPS_EMAIL;
    mailer = { isConfigured: () => true, sendOne: jest.fn(async () => ({ ok: true })) };
    stampSent = jest.fn(async () => {});
  });
  afterAll(() => { process.env = env; });

  test('sends to contact@ and stamps the week', async () => {
    expect(await run()).toEqual({ sent: true, gaps: 1 });
    expect(mailer.sendOne).toHaveBeenCalledWith(expect.objectContaining({
      to: 'contact@wavespestcontrol.com',
      subject: 'Knowledge gaps: 1 question this week',
    }));
    expect(stampSent).toHaveBeenCalled();
  });

  test('kill switch sends nothing', async () => {
    process.env.KNOWLEDGE_GAPS_WEEKLY = 'off';
    expect(await run()).toEqual({ skipped: 'disabled' });
    expect(mailer.sendOne).not.toHaveBeenCalled();
  });

  test('a non-internal recipient is refused', async () => {
    process.env.KNOWLEDGE_GAPS_EMAIL = 'someone@example.com';
    expect(await run()).toEqual({ skipped: 'recipient' });
    expect(mailer.sendOne).not.toHaveBeenCalled();
  });

  test('this week already sent: nothing sent', async () => {
    expect(await run({ sentThisWeek: async () => true })).toEqual({ skipped: 'recent_send' });
    expect(mailer.sendOne).not.toHaveBeenCalled();
  });

  test('a failed send is not stamped, so the next tick retries', async () => {
    mailer.sendOne = jest.fn(async () => ({ ok: false, error: 'boom' }));
    expect(await run()).toMatchObject({ sent: false, error: true });
    expect(stampSent).not.toHaveBeenCalled();
  });

  test('a failed query sends nothing', async () => {
    expect(await run({ loadWeek: async () => { throw new Error('db down'); } })).toEqual({ skipped: 'query_failed' });
    expect(mailer.sendOne).not.toHaveBeenCalled();
  });
});
