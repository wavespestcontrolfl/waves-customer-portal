/**
 * Waves Newsletter polls (owner 2026-11-20: the NL1-NL10 list, "other than
 * that looks good"): the list itself, the every-3rd-issue chooser, where the
 * flagship puts the poll, what a reader and the archive see, and SendGrid's
 * per-reader size cap. The sent-issue query (newsletterIssuePolls) runs
 * against real Postgres in newsletter-polls-postgres.test.js.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ error: jest.fn(), info: jest.fn(), warn: jest.fn() }));
// For the full weekly draft below: the writer's answer, the lineup rows, and
// no fact, image or event-history lookups.
const mockDispatch = jest.fn();
const mockEventRows = [];
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: mockDispatch }));
jest.mock('../services/email-division/fact-register', () => ({
  factsPromptBlock: jest.fn(async () => ''), findUnverifiedClaims: jest.fn(() => []), listFacts: jest.fn(async () => []),
}));
jest.mock('../services/content/image-generator', () => ({
  generate: jest.fn(async () => { throw new Error('no image calls in tests'); }),
}));
jest.mock('../services/event-freshness', () => ({
  ...jest.requireActual('../services/event-freshness'),
  isEligibleForFreshDigest: () => true,
  excludeRoutineRecurringFromQuery: async () => mockEventRows,
}));
jest.mock('../services/newsletter-event-selection', () => ({
  ...jest.requireActual('../services/newsletter-event-selection'),
  loadSharedYearPool: async () => [],
  filterRepeatedDateIdentities: async (rows) => rows,
  filterPreviouslyFeaturedIdentities: async (rows) => rows,
}));

const db = require('../models/db');
const {
  NEWSLETTER_POLL_IDS, POLL_ISSUE_GAP, QUIZ_TOKEN_PATTERN, getQuiz, chooseNewsletterPoll, pollInIssue,
  hasQuizToken, buildQuizSubstitutions, neutralizeQuizTokens,
} = require('../services/newsletter-quiz');
const {
  assembleBeehiivNewsletter, buildFlagshipTextBody, createNewsletterDraft, GREETING_NAME_TOKEN, CITY_TOKEN, GRASS_TYPE_TOKEN,
} = require('../services/newsletter-draft');
const { buildFeedbackSubstitutions } = require('../services/newsletter-feedback');
const { buildEvclickSubstitutions } = require('../services/newsletter-event-clicks');
const { unsubscribeUrl } = require('../services/sendgrid-mail');

const TOKEN = '11111111-2222-4333-8444-555555555555';
const [P1, P2, P3] = NEWSLETTER_POLL_IDS;

function draft(eventCount = 4) {
  return {
    selectedSubject: 'Local picks',
    events: Array.from({ length: eventCount }, (_, i) => ({
      eventId: `a0000000-0000-4000-8000-0000000000${String(i).padStart(2, '0')}`,
      title: `Event ${i + 1}`,
      emoji: '🌊',
      description: `Description ${i + 1}`,
      eventUrl: `https://events.example.com/2026/11/a-long-event-page-name-${i}?ref=calendar`,
    })),
    closingHeading: 'See You Out There',
    closingText: 'Closing words.',
    signoff: '— The Waves Team',
  };
}

describe('Waves Newsletter polls', () => {
  test('the polls are the list the owner approved on 2026-11-20, in his order, with no sales tag and no booking button', () => {
    expect(NEWSLETTER_POLL_IDS.map((id) => {
      const quiz = getQuiz(id);
      return `${quiz.question} ${quiz.answers.map((a) => a.label).join(' · ')}`;
    })).toEqual([
      'Where will you be this weekend? Beach · Park · Home · Out to eat',
      'How far will you drive for a good event? 15 minutes · Half an hour · An hour · Road trip!',
      'Your Gulf sunset spot? Siesta Key · Anna Maria · St. Pete Beach · Somewhere else',
      'Pick one Florida classic Grouper sandwich · Cuban sandwich · Stone crab · Key lime pie',
      'Rainy afternoon plan? Museum · Movie · Mall · Nap',
      "How do you find out what's on? Waves Newsletter · Friends · Social media · I wing it",
      "Dogs at events: more, please? More, please · They're fine · Fewer, please · No opinion",
      "Sunrise or sunset? Sunrise · Sunset · Both · I'm asleep",
      'Best Florida season? Winter · Spring · Summer · Fall (what fall?)',
      "Live music: what's your speed? Rock · Country · Jazz or blues · Anything live",
    ]);
    for (const id of NEWSLETTER_POLL_IDS) {
      const quiz = getQuiz(id);
      // The body token must parse back to this id, or the poll never renders.
      expect(new RegExp(QUIZ_TOKEN_PATTERN).exec(`{{quiz:${id}}}`)[2]).toBe(id);
      expect(quiz.answers.every((a) => a.tags.length === 0 && /^[a-z0-9-]+$/.test(a.key))).toBe(true);
      expect(quiz.landingCtaSuppressed).toBe(true);
    }
  });

  test('over 40 weekly issues: a poll in every 3rd issue, each poll once in the owner\'s order, then none', () => {
    const sent = [];
    for (let week = 0; week < 40; week += 1) {
      const recent = sent.slice(-POLL_ISSUE_GAP).reverse();
      sent.push(chooseNewsletterPoll({ recent, used: sent.filter(Boolean) }));
    }
    expect(sent.flatMap((poll, week) => (poll ? [week] : []))).toEqual([0, 3, 6, 9, 12, 15, 18, 21, 24, 27]);
    expect(sent.filter(Boolean)).toEqual([...NEWSLETTER_POLL_IDS]);
  });

  test.each([
    ['the issue before last had a poll', { recent: [null, P1], used: [P1] }, null],
    ['polls already sent are skipped, whatever order they went out in', { recent: [null, null], used: [P2, P1] }, P3],
  ])('chooser: %s', (_name, history, want) => {
    expect(chooseNewsletterPoll(history)).toBe(want);
  });

  test('pollInIssue reads a poll token of either form in either part, as the sender renders it, and ignores the other quizzes', () => {
    expect(pollInIssue({ html_body: `<p>Hi</p>{{quiz:${P2}}}<p>Bye</p>`, text_body: 'Hi' })).toBe(P2);
    expect(pollInIssue({ html_body: '<p>Hi</p>', text_body: `Hi\n{{QUIZ-TEXT:${P2}}}` })).toBe(P2);
    // The sender builds one substitution map from both parts, so this renders too.
    expect(pollInIssue({ html_body: `{{quiz-text:${P2}}}`, text_body: 'Hi' })).toBe(P2);
    expect(pollInIssue({ html_body: '{{quiz}} {{quiz:lawn-headache-v1}} {{quiz:stay-subscribed-v1}}', text_body: '' })).toBeNull();
    expect(pollInIssue(null)).toBeNull();
  });

  test('the flagship carries the poll once, after the closing and before the sign-off, in both parts', async () => {
    const html = await assembleBeehiivNewsletter(draft(), { pollQuizId: P3 });
    const text = buildFlagshipTextBody(draft(), { pollQuizId: P3 });
    const htmlToken = `{{quiz:${P3}}}`;
    const textToken = `{{quiz-text:${P3}}}`;
    expect(html.split(htmlToken)).toHaveLength(2);
    expect(html).toContain('Quick poll');
    expect(html.indexOf('Closing words.')).toBeLessThan(html.indexOf(htmlToken));
    expect(html.indexOf(htmlToken)).toBeLessThan(html.indexOf('Catch you out there this week.'));
    expect(text.split(textToken)).toHaveLength(2);
    expect(text.indexOf('Closing words.')).toBeLessThan(text.indexOf(textToken));
    expect(text.indexOf(textToken)).toBeLessThan(text.indexOf('— The Waves Team'));
  });

  test('the weekly draft carries the poll in both parts, even when the writer adds its own plain text', async () => {
    const eventId = 'b0000000-0000-4000-8000-000000000001';
    mockEventRows.splice(0, mockEventRows.length, {
      id: eventId, title: 'Harbor Art Walk', description: 'Local artists along the harbor.',
      start_at: '2026-12-05T22:00:00Z', end_at: null, venue_name: 'Harbor Park', venue_address: '1 Harbor Way',
      city: 'Bradenton', event_url: 'https://events.example.com/art-walk', image_url: null, categories: ['arts'],
      is_free: true, admin_status: 'approved', event_type: 'one_time', recurrence_type: 'none',
      freshness_status: 'fresh_one_time', times_featured: 0, last_featured_at: null, pulled_at: '2026-11-28T12:00:00Z',
      price_text: null, family_friendly: true, audience_tags: [], novelty_type: null, region_zone: null,
      score_breakdown: {}, source_name: 'Synthetic source',
    });
    const lineupQuery = {};
    ['leftJoin', 'select', 'whereIn', 'whereNull', 'whereNotIn', 'orderByRaw']
      .forEach((m) => { lineupQuery[m] = jest.fn(() => lineupQuery); });
    db.mockImplementation(() => lineupQuery);
    mockDispatch.mockResolvedValue({ ok: true, json: {
      selectedSubject: 'Local picks',
      events: [{ eventId, title: 'Harbor Art Walk', emoji: '🎨', description: 'Go see it.' }],
      closingHeading: 'See You Out There', closingText: 'Closing words.', signoff: '— The Waves Team',
      textBody: 'WRITER TEXT WITH NO POLL',
    } });
    try {
      const { draft: issue } = await createNewsletterDraft({
        prompt: 'Weekend events.', eventIds: [eventId], newsletterType: 'local-weekly-fresh-events',
        issueReference: '2026-12-01T11:00:00Z', persist: false, pollQuizId: P2,
      });
      expect(issue.htmlBody.split(`{{quiz:${P2}}}`)).toHaveLength(2);
      expect(issue.textBody.split(`{{quiz-text:${P2}}}`)).toHaveLength(2);
      expect(issue.textBody).toContain('Harbor Art Walk');
      expect(issue.textBody).not.toContain('WRITER TEXT WITH NO POLL');
    } finally {
      db.mockReset();
      mockDispatch.mockReset();
    }
  });

  test.each([
    ['no poll', undefined],
    ['a quiz that is not a poll', 'lawn-headache-v1'],
    ['an unknown id', 'nl-poll-unknown-v1'],
  ])('the flagship carries no poll for %s', async (_name, pollQuizId) => {
    const html = await assembleBeehiivNewsletter(draft(), { pollQuizId });
    const text = buildFlagshipTextBody(draft(), { pollQuizId });
    expect(hasQuizToken(html) || hasQuizToken(text)).toBe(false);
    expect(html).not.toContain('Quick poll');
  });

  test('a reader gets one vote link per answer; with no reader (archive, Monday copy) the poll shows without links or a free-check line', async () => {
    const html = await assembleBeehiivNewsletter(draft(), { pollQuizId: P1 });
    const text = buildFlagshipTextBody(draft(), { pollQuizId: P1 });
    const subs = buildQuizSubstitutions(`${html}\n${text}`, { token: TOKEN });
    const votePaths = ['beach', 'park', 'home', 'out-to-eat']
      .map((key) => `/api/public/newsletter/quiz/${TOKEN}/${P1}/${key}`);

    const block = subs[`{{quiz:${P1}}}`];
    expect(block).toContain('Where will you be this weekend?');
    expect(block).toContain('Tap one, then confirm. Just for fun.');
    expect(block.match(/\/api\/public\/newsletter\/quiz\/[^"]+/g)).toEqual(votePaths);
    for (const path of votePaths) expect(subs[`{{quiz-text:${P1}}}`]).toContain(path);

    const archiveHtml = neutralizeQuizTokens(html);
    expect(archiveHtml).toContain('Where will you be this weekend?');
    expect(archiveHtml).toContain('Readers vote right in the email. Just for fun.');
    expect(archiveHtml).not.toMatch(/free check|\/api\/public\/newsletter\/quiz/);
    expect(neutralizeQuizTokens(text)).toContain('Where will you be this weekend? (Beach / Park / Home / Out to eat)');
  });

  test('one reader\'s SendGrid substitutions stay under 10,000 bytes with the largest lineup and any poll', async () => {
    // Past 10,000 bytes SendGrid refuses the whole batch (HTTP 400 "Substitutions
    // are limited to 10000 bytes per personalization block"). The map below is
    // the one newsletter-sender.js builds for each reader, plus the
    // {{unsubscribe_url}} that sendgrid-mail.js sendBatch adds. 12 events is the
    // autopilot's LINEUP_CAP. Measured 2026-11-20: 7,775 bytes at most.
    const issue = draft(12);
    const urlById = new Map(issue.events.map((e) => [e.eventId.toLowerCase(), e.eventUrl]));
    for (const poll of NEWSLETTER_POLL_IDS) {
      const body = [
        await assembleBeehiivNewsletter(issue, { pollQuizId: poll }),
        buildFlagshipTextBody(issue, { pollQuizId: poll }),
      ].join('\n');
      const subs = {
        [GREETING_NAME_TOKEN]: ', Alexandria-Josephine',
        [CITY_TOKEN]: 'Lakewood Ranch',
        [GRASS_TYPE_TOKEN]: 'St. Augustine',
        ...buildQuizSubstitutions(body, { token: TOKEN }),
        ...buildFeedbackSubstitutions(body, { token: TOKEN }),
        ...buildEvclickSubstitutions(body, { token: TOKEN, urlById }),
        '{{unsubscribe_url}}': unsubscribeUrl(TOKEN),
      };
      expect(Object.keys(subs).filter((k) => k.startsWith('{{quiz'))).toHaveLength(2);
      const bytes = Object.entries(subs)
        .reduce((n, [k, v]) => n + Buffer.byteLength(k) + Buffer.byteLength(String(v)), 0);
      expect(bytes).toBeLessThan(10000);
    }
  });
});
