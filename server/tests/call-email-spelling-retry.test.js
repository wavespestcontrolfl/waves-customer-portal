/**
 * settledOtherSpelling: the reader of what the call pipeline writes (ai_extraction.email_spelling_settled) for the drip-path
 * resend to the other spelling (GATE_CALL_BOUNCE_OTHER_SPELLING). Pure; the DB behavior is in call-email-spelling-retry-postgres.test.js.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const retry = require('../services/call-email-spelling-retry');

describe('settledOtherSpelling', () => {
  test('returns the lowercased other spelling only for a matching, distinct, non-Gmail-equivalent address', () => {
    const x = (settled, bouncedEmail = 'jondoe@example.com') => retry.settledOtherSpelling({ email_spelling_settled: settled }, bouncedEmail);
    expect(x({ email: 'JonDoe@example.com', other_spelling: 'JonDoh@Example.com' })).toBe('jondoh@example.com');
    expect(x({ email: 'jondoe@example.com', other_spelling: 'jondoe@example.com' })).toBeNull();
    expect(x({ email: 'jondoe@example.com', other_spelling: 'jon.doe@example.com' })).toBe('jon.doe@example.com'); // dots matter off Gmail
    expect(x({ email: 'jondoe@gmail.com', other_spelling: 'jon.doe@gmail.com' }, 'jondoe@gmail.com')).toBeNull();
    expect(retry.settledOtherSpelling('{broken', 'jondoe@example.com')).toBeNull();
    expect(retry.settledOtherSpelling(undefined, 'jondoe@example.com')).toBeNull();
  });
});

// Producer → consumer contract (pre-push audit P1 on this PR): the call pipeline is the only writer of
// ai_extraction.email_spelling_settled (call-recording-processor.js, GATE_CALL_SPELLED_EMAIL_SETTLES). Build the
// record with the producer's own rule and the exact shape the processor stores, then read it back through the
// drip retry's reader and the source-call filter. If either side renames a key, this fails.
describe('email_spelling_settled: what the call pipeline writes is what the drip retry reads', () => {
  const fs = require('fs');
  const path = require('path');
  const { spelledLettersSettleEmailDisagreement } = require('../services/call-triage-flags');
  const processorSrc = fs.readFileSync(path.join(__dirname, '../services/call-recording-processor.js'), 'utf8');
  const reverifySrc = fs.readFileSync(path.join(__dirname, '../services/email-bounce-reverify.js'), 'utf8');

  test('the processor stores the settled pair under the keys the reader uses', () => {
    expect(processorSrc).toContain('email_spelling_settled: { email: settled.email, other_spelling: settled.otherSpelling }');
    expect(processorSrc).toContain('ai_extraction: JSON.stringify(extracted)');
  });

  test('a settled call round-trips: the saved spelling bounces, the reader names the other pass', () => {
    // V1 wrote the spoken name, V2 and the spelled letters agree.
    const extracted = { email: 'JonDoh@Gmail.com', email_candidates: ['jondoe@gmail.com', 'JonDoh@gmail.com'] };
    const settled = spelledLettersSettleEmailDisagreement(extracted, { email_candidates: [{ value: 'JonDoh@Gmail.com', confidence: 1 }] });
    expect(settled).toEqual({ email: 'jondoh@gmail.com', otherSpelling: 'jondoe@gmail.com' });
    // The processor's stored shape (pinned above), serialized as ai_extraction is.
    const stored = { ...extracted, email_spelling_settled: { email: settled.email, other_spelling: settled.otherSpelling } };
    delete stored.email_candidates;
    const aiExtraction = JSON.stringify(stored);
    // findSourceCall's settled filter is a text LIKE on that column.
    expect(reverifySrc).toContain('%"email_spelling_settled"%');
    expect(aiExtraction).toContain('"email_spelling_settled"');
    expect(retry.settledOtherSpelling(aiExtraction, 'JonDoh@gmail.com')).toBe('jondoe@gmail.com');
    // A bounce of the OTHER spelling is not this record's saved address: no candidate.
    expect(retry.settledOtherSpelling(aiExtraction, 'jondoe@gmail.com')).toBeNull();
  });
});
