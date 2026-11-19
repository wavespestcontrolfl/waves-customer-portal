/**
 * A social or Google Business Profile post carries only a shared line (the
 * main line and the office lines, config/shared-phone-lines). A website-only
 * line proves a website visit, so a post never shows one: a caller who found
 * it in a post would be counted as a website lead.
 */
const { validateContent } = require('../services/social-media');
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
