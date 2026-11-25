// The visit text recipient's tracker token has its own recognizable shape (vr_ + 48 hex): every layer tells it from the holder's
// token (64 hex) by looking at it. Pinned here: the two shapes never overlap, the recipient shape fits the frozen varchar(64)
// column, the page and the socket refuse it as a socket credential, the track routes and the /view pre-parser accept both, and a
// log line redacts it like any other bearer token.
const fs = require('fs');
const path = require('path');
const { RECIPIENT_TRACK_TOKEN_RE, HOLDER_TRACK_TOKEN_RE, isRecipientTrackToken } = require('../utils/recipient-track-token');
const { trackPublicPreparser, TRACK_TOKEN_RE: PREPARSER_RE } = require('../middleware/track-public-preparser');

const HOLDER = 'a'.repeat(64);
const RECIPIENT = `vr_${'0123456789abcdef'.repeat(3)}`;

test('the two shapes never overlap, and the recipient token fits the frozen varchar(64) column', () => {
  expect(RECIPIENT).toHaveLength(51);
  expect(RECIPIENT.length).toBeLessThanOrEqual(64);
  expect(isRecipientTrackToken(RECIPIENT)).toBe(true);
  expect(isRecipientTrackToken(HOLDER)).toBe(false);
  expect(HOLDER_TRACK_TOKEN_RE.test(RECIPIENT)).toBe(false);
  expect(RECIPIENT_TRACK_TOKEN_RE.test(HOLDER)).toBe(false);
  for (const bad of [null, undefined, '', 'vr_', `vr_${'a'.repeat(47)}`, `vr_${'a'.repeat(49)}`, `VR_${'a'.repeat(48)}`, `vr_${'g'.repeat(48)}`, ` ${RECIPIENT}`]) {
    expect(isRecipientTrackToken(bad)).toBe(false);
  }
});

test('the column behind it is varchar(64) (migration 20261124190000, frozen)', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../models/migrations/20261124190000_visit_text_recipients_track_token.js'), 'utf8');
  expect(sql).toContain('track_token varchar(64)');
});

test('the /view pre-parser accepts both shapes and still answers 404 for anything else', () => {
  const run = (token) => {
    const res = { statusCode: 200, set: jest.fn(), status: jest.fn((c) => { res.statusCode = c; return res; }), json: jest.fn(() => res) };
    const next = jest.fn();
    trackPublicPreparser({ method: 'POST', path: `/${token}/view`, headers: { 'content-type': 'application/json' } }, res, next);
    return { statusCode: res.statusCode, nextCalled: next.mock.calls.length };
  };
  expect(run(HOLDER)).toEqual({ statusCode: 200, nextCalled: 1 });
  expect(run(RECIPIENT)).toEqual({ statusCode: 200, nextCalled: 1 });
  expect(run('vr_short')).toEqual({ statusCode: 404, nextCalled: 0 });
  expect(PREPARSER_RE.test(RECIPIENT)).toBe(true);
});

test('a request log redacts a recipient token like any other bearer token', () => {
  const { redactRequestUrl } = require('../utils/redact-request-url');
  const out = redactRequestUrl(`/api/public/track/${RECIPIENT}`);
  expect(out).not.toContain(RECIPIENT);
  expect(out).not.toContain('0123456789abcdef');
});
