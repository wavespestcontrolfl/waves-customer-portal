/**
 * A social or Google Business Profile post carries only a shared line (the
 * main line and the office lines, config/shared-phone-lines). A website-only
 * line proves a website visit, so a post never shows one: a caller who found
 * it in a post would be counted as a website lead. LinkedIn also shows the
 * title and description on the article card, so both get the same check.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/linkedin', () => ({
  configured: true,
  getStatus: jest.fn(async () => ({ connected: true, companyId: 'fixture-company', orgVerified: true })),
}));
jest.mock('../services/social-compliance-judge', () => ({
  judgeSocialCopy: jest.fn(async () => ({ ok: true, compliant: true, violations: [] })),
}));

const social = require('../services/social-media');
const logger = require('../services/logger');
const { validateContent } = social;
const TWILIO_NUMBERS = require('../config/twilio-numbers');
const { websiteOnlyLines } = require('../config/shared-phone-lines');

const phoneIssues = (text) => validateContent(text, 'gbp').issues.filter((issue) => issue.startsWith('Unknown phone number'));

test('the main line and the office lines may appear in a post', () => {
  for (const line of [TWILIO_NUMBERS.mainLine, ...Object.values(TWILIO_NUMBERS.locations)]) {
    expect(phoneIssues(`Call us at ${line.formatted}.`)).toEqual([]);
    expect(phoneIssues(`Call us at ${line.number}.`)).toEqual([]);
  }
});

test('a website-only line never appears in a post, the main site web-only line included', () => {
  expect(phoneIssues('Call us at (941) 254-2617.')).toHaveLength(1);
  const lines = websiteOnlyLines(TWILIO_NUMBERS);
  expect(lines.length).toBeGreaterThan(1);
  for (const line of lines) {
    expect(phoneIssues(`Call us at ${line.number}.`)).toHaveLength(1);
  }
});

describe('the LinkedIn article card', () => {
  const BLOG = 'https://www.wavespestcontrol.com/pest-control/fixture-guide/';
  const WEB_LINE_CARD = 'Questions? Call (941) 254-2617.';
  const ENV = { SOCIAL_AUTOMATION_ENABLED: 'true', SOCIAL_LINKEDIN_ENABLED: 'true', SOCIAL_DRY_RUN: 'true' };
  const refusedForPhone = expect.objectContaining({ success: false, error: expect.stringMatching(/^Validation: Unknown phone number: \(941\) 254-2617/) });
  beforeEach(() => { Object.assign(process.env, ENV); });
  afterEach(() => { for (const key of Object.keys(ENV)) delete process.env[key]; });

  test('a single LinkedIn post refuses a website-only line in the card title or description', async () => {
    const post = (card) => social.postToSingle('linkedin', { ...card, link: BLOG, content: 'A clean caption.', complianceJudged: true });
    expect(await post({ title: WEB_LINE_CARD, description: 'Fixture guide.' })).toEqual(refusedForPhone);
    expect(await post({ title: 'Fixture guide', description: WEB_LINE_CARD })).toEqual(refusedForPhone);
    expect(await post({ title: 'Fixture guide', description: `Call ${TWILIO_NUMBERS.mainLine.formatted}.` })).toMatchObject({ dryRun: true });
  });

  test('the check reads only the card LinkedIn shows: a post with no link has none, and a description is cut at 300 characters', async () => {
    const post = (card) => social.postToSingle('linkedin', { content: 'A clean caption.', complianceJudged: true, ...card });
    expect(await post({ title: WEB_LINE_CARD, description: WEB_LINE_CARD })).toMatchObject({ dryRun: true });
    expect(await post({ link: BLOG, title: 'Fixture guide', description: `${'x'.repeat(300)} ${WEB_LINE_CARD}` })).toMatchObject({ dryRun: true });
    expect(await post({ link: BLOG, title: 'Fixture guide', description: `${'x'.repeat(250)} ${WEB_LINE_CARD}` })).toEqual(refusedForPhone);
    const publish = social.publishToAll({
      title: WEB_LINE_CARD, description: WEB_LINE_CARD, source: 'manual',
      customContent: { linkedin: 'A clean caption.' }, channels: ['linkedin'], noAiImage: true,
    });
    expect((await publish).platforms).toEqual([expect.objectContaining({ platform: 'linkedin', dryRun: true })]);
  });

  test('a publish to all channels refuses it on LinkedIn too, and its log masks the number', async () => {
    logger.warn.mockClear();
    const publish = (description) => social.publishToAll({
      title: 'Fixture guide', description, link: BLOG, source: 'manual',
      customContent: { linkedin: 'A clean caption.' }, channels: ['linkedin'], noAiImage: true,
    });
    const refused = (await publish(WEB_LINE_CARD)).platforms;
    expect(refused).toEqual([refusedForPhone]);
    expect(refused[0].platform).toBe('linkedin');
    // The number may be a customer's: the log line names the issue, never the number.
    const logged = logger.warn.mock.calls.map(([line]) => String(line)).join('\n');
    expect(logged).toContain('Content validation failed for linkedin: Unknown phone number: [phone]');
    expect(logged).not.toMatch(/254\D?2617/);
    expect((await publish('Fixture guide for homeowners.')).platforms).toEqual([expect.objectContaining({ platform: 'linkedin', dryRun: true })]);
  });
});
