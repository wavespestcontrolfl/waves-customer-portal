/**
 * Waves Newsletter polls (owner 2026-11-20: the NL1-NL10 list, "other than
 * that looks good"): the list itself, the every-3rd-issue chooser, where the
 * flagship puts the poll, what a reader and the archive see, and SendGrid's
 * per-reader size cap. The Waves Pest Insider's own list (PI1-PI6, approved
 * the same day) on the same chooser. The sent-issue query
 * (newsletterIssuePolls) runs against real Postgres in
 * newsletter-polls-postgres.test.js.
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
  NEWSLETTER_POLL_IDS, PEST_INSIDER_POLL_IDS, RETIRED_PEST_INSIDER_POLL_IDS, POLL_ID_MARK, POLL_ISSUE_GAP, QUIZ_TOKEN_PATTERN, getQuiz, isPestInsiderPoll,
  chooseNewsletterPoll, pollInIssue, hasQuizToken, buildQuizSubstitutions, neutralizeQuizTokens, pollResultLine, recordQuizResponse, newsletterLastPoll,
} = require('../services/newsletter-quiz');
const {
  assembleWeeklyNewsletter, buildFlagshipTextBody, createNewsletterDraft, GREETING_NAME_TOKEN, CITY_TOKEN, GRASS_TYPE_TOKEN,
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
      sourceTitle: `Event ${i + 1}`,
      startAt: `2026-12-0${3 + (i % 4)}T23:00:00Z`,
      town: 'Sarasota',
      why: `Reason ${i + 1}.`,
      eventUrl: `https://events.example.com/2026/11/a-long-event-page-name-${i}?ref=calendar`,
    })),
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

  test('the flagship carries the poll once, after the events and before the closing line and sign-off, in both parts', async () => {
    const html = await assembleWeeklyNewsletter(draft(), { pollQuizId: P3 });
    const text = buildFlagshipTextBody(draft(), { pollQuizId: P3 });
    const htmlToken = `{{quiz:${P3}}}`;
    const textToken = `{{quiz-text:${P3}}}`;
    expect(html.split(htmlToken)).toHaveLength(2);
    expect(html).toContain('Quick poll');
    // After the last event, before the "Dates can change" line and the sign-off.
    expect(html.indexOf('Event 4')).toBeLessThan(html.indexOf(htmlToken));
    expect(html.indexOf(htmlToken)).toBeLessThan(html.indexOf('Dates can change. Check before you go.'));
    expect(text.split(textToken)).toHaveLength(2);
    expect(text.indexOf('Event 4')).toBeLessThan(text.indexOf(textToken));
    expect(text.indexOf(textToken)).toBeLessThan(text.indexOf('Dates can change. Check before you go.'));
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
      weekendPoints: ['Art walk Saturday in Bradenton', 'Harbor views all afternoon', 'Local artists on the water'],
      events: [{ eventId, why: 'Local artists show their work along the harbor.' }],
      signoff: '— The Waves Team',
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
    ['only two weekend points', { weekendPoints: ['One', 'Two'] }, /exactly 3/],
    ['a blank weekend point', { weekendPoints: ['One', '  ', 'Three'] }, /exactly 3/],
    ['no weekend points at all', { weekendPoints: undefined }, /exactly 3/],
    ['a blank sentence for an event', { events: [{ eventId: 'b0000000-0000-4000-8000-000000000001', why: '   ' }] }, /no sentence/],
    ['a sentence that is only a URL', { events: [{ eventId: 'b0000000-0000-4000-8000-000000000001', why: 'https://spam.example/x' }] }, /no sentence/],
  ])('the weekly draft is refused before it is saved when the writer gives %s', async (_name, change, message) => {
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
      weekendPoints: ['Art walk Saturday', 'Harbor views', 'Local artists'],
      events: [{ eventId, why: 'Local artists show their work along the harbor.' }],
      signoff: '— The Waves Team',
      ...change,
    } });
    try {
      await expect(createNewsletterDraft({
        prompt: 'Weekend events.', eventIds: [eventId], newsletterType: 'local-weekly-fresh-events',
        issueReference: '2026-12-01T11:00:00Z', persist: false,
      })).rejects.toThrow(message);
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
    const html = await assembleWeeklyNewsletter(draft(), { pollQuizId });
    const text = buildFlagshipTextBody(draft(), { pollQuizId });
    expect(hasQuizToken(html) || hasQuizToken(text)).toBe(false);
    expect(html).not.toContain('Quick poll');
  });

  test('a reader gets one vote link per answer; with no reader (archive, Monday copy) the poll shows without links or a free-check line', async () => {
    const html = await assembleWeeklyNewsletter(draft(), { pollQuizId: P1 });
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
        await assembleWeeklyNewsletter(issue, { pollQuizId: poll }),
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

describe('Waves Pest Insider polls', () => {
  const [PI1, PI2] = PEST_INSIDER_POLL_IDS;

  test('the polls are the wording and order the owner approved on 2026-11-22 (polls rec, C), on the Waves Newsletter poll rules', () => {
    expect(PEST_INSIDER_POLL_IDS.map((id) => {
      const quiz = getQuiz(id);
      return `${quiz.question} ${quiz.answers.map((a) => a.label).join(' · ')}`;
    })).toEqual([
      'Spider in the house. What happens next? Cup and card · Leave it be · Shoe · Move out',
      'Which pest is the worst house guest? Ants · Roaches · Mosquitoes · Spiders',
      'Lizards on the lanai: friend or foe? Friend · Foe · Depends · What lizards?',
      'Biggest Florida bug surprise? Palmetto bugs · Lovebugs · Fire ants · No-see-ums',
      'Best smell in a Florida yard? Orange blossom · Cut grass · Jasmine · Rain coming',
      'Who gets the mosquito bites at your house? Me, always · Everyone · Not me · Nobody',
    ]);
    for (const id of [...NEWSLETTER_POLL_IDS, ...PEST_INSIDER_POLL_IDS]) {
      const quiz = getQuiz(id);
      expect(new RegExp(QUIZ_TOKEN_PATTERN).exec(`{{quiz:${id}}}`)[2]).toBe(id);
      // The history query's prefilter finds a poll only by this mark.
      expect(id).toContain(POLL_ID_MARK);
      expect(quiz.answers.every((a) => a.tags.length === 0 && /^[a-z0-9-]+$/.test(a.key))).toBe(true);
      expect(quiz.landingCtaSuppressed).toBe(true);
      expect(quiz.emailCta).toBe('Tap one, then confirm. Just for fun.');
    }
    expect(PEST_INSIDER_POLL_IDS).toEqual([
      'pi-poll-house-spider-v1', 'pi-poll-worst-guest-v1', 'pi-poll-lizards-v1',
      'pi-poll-bug-surprise-v1', 'pi-poll-yard-smell-v1', 'pi-poll-mosquito-bites-v1',
    ]);
    expect(getQuiz('pi-poll-worst-guest-v1').label).toBe('Poll: worst house guest');
    // The reworded poll has a new id; the old one is retired (see the retired-poll cases below).
    expect(PEST_INSIDER_POLL_IDS).not.toContain('pi-poll-bugging-you-v1');
    // Each thank-you page names its own newsletter: the Pest Insider's says the top answer will come in the issue.
    expect(getQuiz(PI1).landingLine).toBe("Your vote is in. We'll share the top answer in the Waves Pest Insider.");
    expect(getQuiz(P1).landingLine).toBe('Your vote is in. See you in the next Waves Newsletter.');
  });

  test('over 20 issues: a poll in every 3rd issue, each Pest Insider poll once in the owner\'s order, then none', () => {
    const sent = [];
    for (let issue = 0; issue < 20; issue += 1) {
      const recent = sent.slice(-POLL_ISSUE_GAP).reverse();
      sent.push(chooseNewsletterPoll({ recent, used: sent.filter(Boolean), ids: PEST_INSIDER_POLL_IDS }));
    }
    expect(sent.flatMap((poll, issue) => (poll ? [issue] : []))).toEqual([0, 3, 6, 9, 12, 15]);
    expect(sent.filter(Boolean)).toEqual([...PEST_INSIDER_POLL_IDS]);
  });

  test("each newsletter reads only its own list: a Pest Insider issue's poll is never a Waves Newsletter poll, or the other way round", () => {
    const issue = { html_body: `{{quiz:${P1}}} {{quiz:${PI2}}}`, text_body: '' };
    expect(pollInIssue(issue, PEST_INSIDER_POLL_IDS)).toBe(PI2);
    expect(pollInIssue(issue)).toBe(P1);
    expect(pollInIssue({ html_body: `{{quiz:${PI1}}}`, text_body: '' })).toBeNull();
    expect(chooseNewsletterPoll({ recent: [], used: [P1, P2], ids: PEST_INSIDER_POLL_IDS })).toBe(PI1);
  });
});

describe('the last poll result line (Waves Pest Insider)', () => {
  const SPIDER = 'pi-poll-house-spider-v1'; // Cup and card · Leave it be · Shoe · Move out
  const LIZARDS = 'pi-poll-lizards-v1'; // Friend · Foe · Depends · What lizards?
  const QUESTION = 'Spider in the house. What happens next?';

  test.each([
    ['one top answer', { 'cup-and-card': 7, 'leave-it-be': 3, shoe: 1 }, `Last poll: ${QUESTION} The top answer was Cup and card.`],
    ['one top answer, whatever its place in the list', { 'cup-and-card': 1, 'move-out': 2 }, `Last poll: ${QUESTION} The top answer was Move out.`],
    ['two tied: the poll\'s own order', { 'leave-it-be': 4, 'move-out': 4, shoe: 1 }, `Last poll: ${QUESTION} It was a tie between Leave it be and Move out.`],
    ['two tied, one label holds " and ": it goes last', { 'cup-and-card': 2, shoe: 2 }, `Last poll: ${QUESTION} It was a tie between Shoe and Cup and card.`],
    ['three tied', { 'cup-and-card': 2, 'leave-it-be': 2, shoe: 2, 'move-out': 1 }, `Last poll: ${QUESTION} It was a tie. No answer came out on top.`],
    ['four tied', { 'cup-and-card': 1, 'leave-it-be': 1, shoe: 1, 'move-out': 1 }, `Last poll: ${QUESTION} It was a tie. No answer came out on top.`],
    ['an answer unknown to the poll is ignored', { 'not-a-key': 99, shoe: 1 }, `Last poll: ${QUESTION} The top answer was Shoe.`],
  ])('%s', (_name, counts, want) => {
    expect(pollResultLine({ quizId: SPIDER, counts })).toBe(want);
  });

  test('a label that ends in a question mark takes no second period', () => {
    expect(pollResultLine({ quizId: LIZARDS, counts: { 'what-lizards': 5 } }))
      .toBe('Last poll: Lizards on the lanai: friend or foe? The top answer was What lizards?');
    expect(pollResultLine({ quizId: LIZARDS, counts: { friend: 2, 'what-lizards': 2 } }))
      .toBe('Last poll: Lizards on the lanai: friend or foe? It was a tie between Friend and What lizards?');
  });

  test.each([
    ['no votes', { quizId: SPIDER, counts: {} }],
    ['zero votes', { quizId: SPIDER, counts: { shoe: 0 } }],
    ['only unknown answers', { quizId: SPIDER, counts: { nope: 5 } }],
    ['counts that are not numbers', { quizId: SPIDER, counts: { shoe: 'many', 'move-out': -2 } }],
    ['an unknown poll', { quizId: 'pi-poll-unknown-v1', counts: { shoe: 3 } }],
    ['a Waves Newsletter poll', { quizId: P1, counts: { beach: 3 } }],
    ['a service quiz', { quizId: 'pest-pressure-v1', counts: { ants: 3 } }],
    ['nothing at all', undefined],
  ])('no line for %s', (_name, result) => {
    expect(pollResultLine(result)).toBeNull();
  });

  test('no line prints a count, a percentage or any digit, for every poll and every vote mix', () => {
    for (const id of PEST_INSIDER_POLL_IDS) {
      const keys = getQuiz(id).answers.map((a) => a.key);
      const mixes = [
        { [keys[0]]: 12 }, { [keys[1]]: 7, [keys[2]]: 1 }, { [keys[0]]: 3, [keys[3]]: 3 },
        { [keys[0]]: 2, [keys[1]]: 2, [keys[2]]: 2 }, Object.fromEntries(keys.map((k) => [k, 5])),
      ];
      for (const counts of mixes) {
        const line = pollResultLine({ quizId: id, counts });
        expect(line).toMatch(/^Last poll: /);
        expect(line).not.toMatch(/\d|%/);
      }
    }
  });
});

describe('a retired Waves Pest Insider poll (an email already sent can still carry its vote links)', () => {
  const RETIRED = 'pi-poll-bugging-you-v1';
  const [PI1] = PEST_INSIDER_POLL_IDS;

  // recordQuizResponse on a fake database: the delivery row, then the issue body it reads.
  function voteOn(body) {
    const updates = [];
    db.mockImplementation((table) => {
      const q = {
        where: jest.fn(() => q),
        first: jest.fn(async () => (table === 'newsletter_send_deliveries'
          ? { id: 7, subscriber_id: 5, send_id: 3 }
          : { html_body: body, text_body: '' })),
        update: jest.fn(async (row) => { updates.push({ table, ...row }); }),
      };
      return q;
    });
    return updates;
  }

  test('it keeps its words and its poll rules, and no new issue can pick it or report it', () => {
    expect(RETIRED_PEST_INSIDER_POLL_IDS).toEqual([RETIRED]);
    const quiz = getQuiz(RETIRED);
    expect(`${quiz.question} ${quiz.answers.map((a) => a.label).join(' · ')}`).toBe('Which pest bugs you most this month? Ants · Roaches · Mosquitoes · Spiders');
    expect(quiz).toMatchObject({ poll: true, landingCtaSuppressed: true, landingLine: 'Your vote is in. See you in the next Waves Pest Insider.' });
    expect(quiz.answers.every((a) => a.tags.length === 0)).toBe(true);
    expect(RETIRED).toContain(POLL_ID_MARK);
    // Not a current poll: the renderer shows a current poll only, and the planner picks from the current list.
    expect(isPestInsiderPoll(RETIRED)).toBe(false);
    expect(PEST_INSIDER_POLL_IDS).not.toContain(RETIRED);
    for (let used = 0; used <= PEST_INSIDER_POLL_IDS.length; used += 1) {
      expect(chooseNewsletterPoll({ recent: [], used: PEST_INSIDER_POLL_IDS.slice(0, used), ids: PEST_INSIDER_POLL_IDS })).not.toBe(RETIRED);
    }
    // The result line never reports it.
    expect(pollResultLine({ quizId: RETIRED, counts: { ants: 3 } })).toBeNull();
  });

  test('a vote from an old issue that shows it still counts', async () => {
    const updates = voteOn(`{{quiz:${RETIRED}}}`);
    await expect(recordQuizResponse({ token: TOKEN, quizId: RETIRED, answerKey: 'ants' })).resolves.toEqual({ ok: true, reason: 'tagged' });
    expect(updates.map((u) => [u.table, u.quiz_id, u.quiz_answer])).toEqual([['newsletter_send_deliveries', RETIRED, 'ants']]);
  });

  test('that issue takes no other quiz\'s answer: a hand-made link cannot replace the vote or add service tags', async () => {
    for (const [quizId, answerKey] of [['pest-pressure-v1', 'ants'], [PI1, 'shoe']]) {
      const updates = voteOn(`{{quiz:${RETIRED}}}`);
      await expect(recordQuizResponse({ token: TOKEN, quizId, answerKey })).resolves.toEqual({ ok: false, reason: 'not-in-issue' });
      expect(updates).toEqual([]);
    }
  });

  test('a vote for it from an issue that never showed it is refused', async () => {
    const updates = voteOn(`{{quiz:${PI1}}}`);
    await expect(recordQuizResponse({ token: TOKEN, quizId: RETIRED, answerKey: 'ants' })).resolves.toEqual({ ok: false, reason: 'not-in-issue' });
    expect(updates).toEqual([]);
  });
});

describe('a vote from the same email twice (the last vote counts)', () => {
  test('recordQuizResponse overwrites the delivery row: no "first vote wins" guard', async () => {
    const [PI] = PEST_INSIDER_POLL_IDS;
    const updates = [];
    db.mockImplementation((table) => {
      const q = {
        where: jest.fn(() => q),
        first: jest.fn(async () => (table === 'newsletter_send_deliveries'
          ? { id: 7, subscriber_id: null, send_id: 3 }
          : { html_body: `{{quiz:${PI}}}`, text_body: '' })),
        update: jest.fn(async (row) => { updates.push({ table, ...row }); }),
      };
      return q;
    });
    await recordQuizResponse({ token: TOKEN, quizId: PI, answerKey: 'cup-and-card' });
    await recordQuizResponse({ token: TOKEN, quizId: PI, answerKey: 'shoe' });
    expect(updates.map((u) => [u.table, u.quiz_id, u.quiz_answer])).toEqual([
      ['newsletter_send_deliveries', PI, 'cup-and-card'],
      ['newsletter_send_deliveries', PI, 'shoe'],
    ]);
  });
});

describe('newsletterLastPoll (the planner\'s read, on a fake database; real SQL runs in newsletter-polls-postgres.test.js)', () => {
  const [PI] = PEST_INSIDER_POLL_IDS;
  // The newest issue readers got (the query's own ordering and reach rule are SQL), and the vote rows.
  function fakeKnex({ issue, votes = [] }) {
    const seen = { votes: null, notNull: null, groupBy: null };
    const issues = {};
    ['where', 'whereExists', 'orderByRaw', 'limit'].forEach((m) => { issues[m] = jest.fn(() => issues); });
    issues.select = jest.fn(async () => (issue ? [issue] : []));
    const voteQuery = {
      where: jest.fn((cond) => { seen.votes = cond; return voteQuery; }),
      whereNotNull: jest.fn((col) => { seen.notNull = col; return voteQuery; }),
      groupBy: jest.fn((col) => { seen.groupBy = col; return voteQuery; }),
      select: jest.fn(() => voteQuery),
      count: jest.fn(async () => votes),
    };
    const knex = jest.fn((table) => (String(table).startsWith('newsletter_sends') ? issues : voteQuery));
    knex.raw = jest.fn((sql) => sql);
    return { knex, seen, issues };
  }
  const issueOf = (poll, time) => ({ id: 41, html_body: poll ? `{{quiz:${poll}}}` : '<p>x</p>', text_body: '', issue_time: new Date(time) });
  const read = (knex) => newsletterLastPoll({ newsletterType: 'pest-insider-monthly', sendDate: '2026-12-03', knex });

  test('the newest issue readers got held a poll: its own answered rows, counted per answer', async () => {
    const { knex, seen, issues } = fakeKnex({
      issue: issueOf(PI, '2026-11-19T12:00:00Z'),
      votes: [{ quiz_answer: 'shoe', n: '3' }, { quiz_answer: 'move-out', n: 1 }],
    });
    expect(await read(knex)).toEqual({ quizId: PI, counts: { shoe: 3, 'move-out': 1 } });
    expect(issues.limit).toHaveBeenCalledWith(1);
    expect(seen).toEqual({ votes: { send_id: 41, quiz_id: PI }, notNull: 'quiz_answered_at', groupBy: 'quiz_answer' });
  });

  test('no poll in the newest issue readers got, or no such issue: no read of votes, no result', async () => {
    for (const issue of [issueOf(null, '2026-11-19T12:00:00Z'), issueOf(NEWSLETTER_POLL_IDS[0], '2026-11-19T12:00:00Z'), null]) {
      const { knex } = fakeKnex({ issue, votes: [{ quiz_answer: 'shoe', n: 1 }] });
      expect(await read(knex)).toBeNull();
      expect(knex).not.toHaveBeenCalledWith('newsletter_send_deliveries');
    }
  });

  test('a poll issue 45 days before the new issue (by ET date) counts; 46 days does not', async () => {
    const votes = [{ quiz_answer: 'shoe', n: 1 }];
    // 2026-10-19 8:00 AM ET is 45 days before 2026-12-03; the late-evening ET edge is still that ET date.
    for (const time of ['2026-10-19T12:00:00Z', '2026-10-20T03:30:00Z']) {
      expect(await read(fakeKnex({ issue: issueOf(PI, time), votes }).knex)).toEqual({ quizId: PI, counts: { shoe: 1 } });
    }
    for (const time of ['2026-10-18T12:00:00Z', '2026-10-19T03:30:00Z']) {
      expect(await read(fakeKnex({ issue: issueOf(PI, time), votes }).knex)).toBeNull();
    }
  });
});
