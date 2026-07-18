process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ error: jest.fn(), info: jest.fn(), warn: jest.fn() }));

const db = require('../models/db');
const {
  FEEDBACK_HTML_TOKEN,
  FEEDBACK_TEXT_TOKEN,
  FEEDBACK_QUESTION,
  REACTIONS,
  MISSING_OPTIONS,
  resolveMissingKeys,
  renderFeedbackHtml,
  renderFeedbackText,
  hasFeedbackToken,
  buildFeedbackSubstitutions,
  neutralizeFeedbackTokens,
  recordFeedbackReaction,
} = require('../services/newsletter-feedback');

const TOKEN = '11111111-2222-3333-4444-555555555555';

describe('feedback config contract', () => {
  test('owner-specified reactions and follow-up options, in order', () => {
    expect(REACTIONS.map((r) => `${r.emoji} ${r.label}`)).toEqual([
      '👍 Great', '😐 Okay', '👎 Needs work',
    ]);
    expect(FEEDBACK_QUESTION).toBe("How was this week's newsletter?");
    expect(MISSING_OPTIONS.map((o) => o.label)).toEqual([
      'Closer events', 'More local news', 'Restaurant openings',
      'Family activities', 'Home tips',
    ]);
  });

  test('resolveMissingKeys accepts string or array and drops unknown keys', () => {
    expect(resolveMissingKeys('local-news')).toEqual(['local-news']);
    expect(resolveMissingKeys(['home-tips', 'closer-events', 'nope', 'home-tips']))
      .toEqual(['closer-events', 'home-tips']); // config order, deduped
    expect(resolveMissingKeys(undefined)).toEqual([]);
  });
});

describe('feedback rendering', () => {
  // The question renders HTML-escaped (' → &#39;) inside the block.
  const QUESTION_ESCAPED = 'How was this week&#39;s newsletter?';

  test('recipient render links all three reactions through the engagement token', () => {
    const html = renderFeedbackHtml({ token: TOKEN });
    expect(html).toContain(QUESTION_ESCAPED);
    for (const r of REACTIONS) {
      expect(html).toContain(`/api/public/newsletter/feedback/${TOKEN}/${r.key}`);
      expect(html).toContain(`${r.emoji} ${r.label}`);
    }
    const text = renderFeedbackText({ token: TOKEN });
    expect(text).toContain(`/api/public/newsletter/feedback/${TOKEN}/needs-work`);
  });

  test('missing or malformed token degrades to inert chips — never dead links', () => {
    for (const bad of [undefined, null, '', 'not-a-uuid']) {
      const html = renderFeedbackHtml({ token: bad });
      expect(html).toContain(QUESTION_ESCAPED);
      expect(html).not.toContain('href');
      expect(renderFeedbackText({ token: bad })).toContain(FEEDBACK_QUESTION);
      expect(renderFeedbackText({ token: bad })).not.toContain('http');
    }
  });

  test('substitutions resolve the html and text tokens to their own renders', () => {
    const body = `intro\n${FEEDBACK_HTML_TOKEN}\n${FEEDBACK_TEXT_TOKEN}`;
    expect(hasFeedbackToken(body)).toBe(true);
    const subs = buildFeedbackSubstitutions(body, { token: TOKEN });
    expect(Object.keys(subs).sort()).toEqual([FEEDBACK_TEXT_TOKEN, FEEDBACK_HTML_TOKEN].sort());
    expect(subs[FEEDBACK_HTML_TOKEN]).toContain('<a href');
    expect(subs[FEEDBACK_TEXT_TOKEN]).not.toContain('<a href');
    expect(subs[FEEDBACK_TEXT_TOKEN]).toContain(TOKEN);
  });

  test('neutralizeFeedbackTokens leaves no literal token on archive surfaces', () => {
    const out = neutralizeFeedbackTokens(`a ${FEEDBACK_HTML_TOKEN} b ${FEEDBACK_TEXT_TOKEN} c`);
    expect(out).not.toContain('{{feedback');
    expect(out).toContain(FEEDBACK_QUESTION);
    expect(out).not.toContain('href');
  });
});

describe('recordFeedbackReaction', () => {
  let q;
  beforeEach(() => {
    jest.clearAllMocks();
    q = {};
    ['where', 'select'].forEach((m) => { q[m] = jest.fn(() => q); });
    q.first = jest.fn(async () => ({ id: 'delivery-1' }));
    q.update = jest.fn(async () => 1);
    db.mockImplementation(() => q);
  });

  test('stamps the delivery row; 👎 keeps only allowlisted follow-up keys', async () => {
    const result = await recordFeedbackReaction({
      token: TOKEN,
      reaction: 'needs-work',
      missing: ['local-news', 'bogus', 'home-tips'],
    });
    expect(result).toEqual({ ok: true, reason: 'recorded' });
    const payload = q.update.mock.calls[0][0];
    expect(payload.feedback_reaction).toBe('needs-work');
    expect(JSON.parse(payload.feedback_missing)).toEqual(['local-news', 'home-tips']);
    expect(payload.feedback_at).toBeInstanceOf(Date);
  });

  test('a positive vote clears any stored follow-up list (changed mind)', async () => {
    await recordFeedbackReaction({ token: TOKEN, reaction: 'great', missing: ['local-news'] });
    expect(q.update.mock.calls[0][0].feedback_missing).toBeNull();
    expect(q.update.mock.calls[0][0].feedback_reaction).toBe('great');
  });

  test('rejects bad tokens and unknown reactions without touching the DB', async () => {
    expect(await recordFeedbackReaction({ token: 'nope', reaction: 'great' }))
      .toEqual({ ok: false, reason: 'bad-token' });
    expect(await recordFeedbackReaction({ token: TOKEN, reaction: 'amazing' }))
      .toEqual({ ok: false, reason: 'bad-reaction' });
    expect(q.update).not.toHaveBeenCalled();
  });

  test('missing delivery row is a quiet no-op', async () => {
    q.first = jest.fn(async () => null);
    expect(await recordFeedbackReaction({ token: TOKEN, reaction: 'okay' }))
      .toEqual({ ok: false, reason: 'no-delivery' });
    expect(q.update).not.toHaveBeenCalled();
  });
});
