/**
 * heardAboutFromCallReferral — maps the call reader's free-text
 * customer_history.referral_source onto the quote-form "How did you hear
 * about us?" allowlist. Cases are the shapes the reader actually wrote on
 * prod calls 2026-09-28..10-29 (names replaced with synthetic ones).
 */
const fs = require('fs');
const path = require('path');
const { heardAboutFromCallReferral, HEARD_ABOUT_OPTIONS } = require('../services/heard-about');

describe('heardAboutFromCallReferral', () => {
  test.each([
    ['chatgpt', 'chatgpt'],
    ['ChatGPT', 'chatgpt'],
    ['chat gpt told me about you', 'chatgpt'],
    ['ai', 'other_ai'],
    ['asked an AI assistant', 'other_ai'],
    ['Gemini', 'other_ai'],
    ['google', 'google_search'],
    ['googled pest control', 'google_search'],
    ['online search', 'google_search'],
    ['google maps', 'google_maps'],
    ['next-door neighbor', 'friend_neighbor'],
    ['my next door neighbour uses you', 'friend_neighbor'],
    ['nextdoor', 'nextdoor'],
    ['saw a post on next door', 'nextdoor'],
    ['facebook group', 'facebook_instagram'],
    ['yelp', 'yelp'],
    ['saw your truck', 'truck_yard_sign'],
    ['highly recommended', 'friend_neighbor'],
    ['positive word of mouth/reputation', 'friend_neighbor'],
    ['son is a waves customer', 'friend_neighbor'],
    ["caller's mother recently signed up with waves", 'friend_neighbor'],
    ['daughter previously received waves service', 'friend_neighbor'],
  ])('%s -> %s', (text, expected) => {
    expect(heardAboutFromCallReferral(text)).toBe(expected);
  });

  test.each([
    'online', 'website', 'waves website', 'online quote', 'online form', 'online inquiry',
    'online reviews', 'chat', 'pat jones', 'Claude', 'my fellow that cuts my lawn', '', '   ',
  ])('%s -> null (no clear channel)', (text) => {
    expect(heardAboutFromCallReferral(text)).toBeNull();
  });

  test('non-strings are null', () => {
    for (const v of [null, undefined, 42, {}, ['google']]) expect(heardAboutFromCallReferral(v)).toBeNull();
  });

  test('every mapped value is on the allowlist', () => {
    for (const text of ['chatgpt', 'ai', 'google', 'google maps', 'nextdoor', 'facebook', 'yelp', 'truck', 'friend']) {
      expect(HEARD_ABOUT_OPTIONS.has(heardAboutFromCallReferral(text))).toBe(true);
    }
  });
});

describe('call processor writes the call answer like the other fill-only lead fields', () => {
  // Source pins: Step 4b's lead enrichment is one long pass inside the call
  // processor; these keep heard_about on every list the fill-only contract
  // spans (fill-if-empty, locked re-decision, restamp re-supply,
  // reaffirmation claim, rejection restore).
  const src = fs.readFileSync(path.join(__dirname, '../services/call-recording-processor.js'), 'utf8');

  test('fills heard_about only while the lead has none', () => {
    expect(src).toContain('if (callHeardAbout && isEmpty(current?.heard_about)) leadUpdates.heard_about = callHeardAbout;');
  });

  test('re-decided under the row lock and re-supplied on a restamp', () => {
    expect(src).toMatch(/const FILL_ONLY_LEAD_FIELDS = \[[^\]]*'heard_about'/);
    expect(src).toContain("resupply('heard_about', callHeardAbout);");
  });

  test('a restated answer is claimed, and a rejected call restores it', () => {
    expect(src).toMatch(/const suppliedIdentity = \{[^}]*heard_about: callHeardAbout,[^}]*\}/s);
    expect(src).toMatch(/const STAMPED_LEAD_RESTORE_FIELDS = \[[^\]]*'heard_about'/s);
  });

  test('reads only a valid V2 extraction', () => {
    expect(src).toMatch(/heardAboutFromCallReferral\(\s*v2Result\?\.status === 'valid' && isV2Extraction\(v2Result\.extraction\)/);
  });
});
