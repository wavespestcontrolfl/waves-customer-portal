// GATE_CALL_EMAIL_CHECKS (owner 2026-10-29): the call processor's side of the
// email checks. spelledLettersSettled is the 2026-10-05 trust rule read from
// the transcripts when the dictation decoder left no result; applyDeadDomainReason
// and callEmailCheckCardPayload turn a domain with no mail server into an
// email_invalid card that says why. Fixtures are synthetic.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/twilio-numbers', () => ({
  isInternalNumber: jest.fn(() => false),
  isOwnedNumber: jest.fn(() => false),
  findByNumber: jest.fn(() => null),
  getLeadSourceFromNumber: jest.fn(() => ({ source: 'phone_call' })),
}));

const processor = require('../services/call-recording-processor');

const { spelledLettersSettled, applyDeadDomainReason, callEmailCheckCardPayload } = processor;
const SAVED = { email: 'brightonkayla@gmail.com' };

describe('spelledLettersSettled', () => {
  test('the letters match and the decoder left nothing: settled', () => {
    expect(spelledLettersSettled({ extracted: SAVED, dictationEmailPayload: null, correctedEmail: null, callEmailCheck: { spelled_match: true } })).toBe(true);
  });
  test('never overrides a decoder that ran and held the spelling', () => {
    const decoderHeld = { email_candidates: [{ value: 'brightonkayla@gmail.com' }, { value: 'brightonkayla0@gmail.com' }] };
    expect(spelledLettersSettled({ extracted: SAVED, dictationEmailPayload: decoderHeld, correctedEmail: null, callEmailCheck: { spelled_match: true } })).toBe(false);
  });
  test('a domain-typo correction that would change the address keeps the card', () => {
    expect(spelledLettersSettled({ extracted: { email: 'brightonkayla@gmial.com' }, dictationEmailPayload: null, correctedEmail: 'brightonkayla@gmail.com', callEmailCheck: { spelled_match: true } })).toBe(false);
    expect(spelledLettersSettled({ extracted: SAVED, dictationEmailPayload: null, correctedEmail: 'brightonkayla@gmail.com', callEmailCheck: { spelled_match: true } })).toBe(true);
  });
  test('no match, no check (gate off), or no saved email: not settled', () => {
    expect(spelledLettersSettled({ extracted: SAVED, dictationEmailPayload: null, correctedEmail: null, callEmailCheck: { spelled_match: false } })).toBe(false);
    expect(spelledLettersSettled({ extracted: SAVED, dictationEmailPayload: null, correctedEmail: null, callEmailCheck: null })).toBe(false);
    expect(spelledLettersSettled({ extracted: { email: null }, dictationEmailPayload: null, correctedEmail: null, callEmailCheck: { spelled_match: true } })).toBe(false);
  });
});

describe('applyDeadDomainReason', () => {
  const DEAD = { dead_domain: { domain: 'nosuchdomain.me', deliverable: false, dns_error: 'ENOTFOUND' } };
  test('a dead domain turns the read-back reason into email_invalid', () => {
    expect(applyDeadDomainReason(['missing_unit_number', 'email_unverified'], DEAD)).toEqual(['missing_unit_number', 'email_invalid']);
  });
  test('adds email_invalid once when no email reason was there yet', () => {
    expect(applyDeadDomainReason([], DEAD)).toEqual(['email_invalid']);
    expect(applyDeadDomainReason(['email_invalid'], DEAD)).toEqual(['email_invalid']);
  });
  test('anything else leaves the reasons alone', () => {
    expect(applyDeadDomainReason(['email_unverified'], { spelled_match: false })).toEqual(['email_unverified']);
    expect(applyDeadDomainReason(['email_unverified'], null)).toEqual(['email_unverified']);
  });
});

describe('callEmailCheckCardPayload', () => {
  test('a dead domain puts the domain and the read-back question on the card', () => {
    expect(callEmailCheckCardPayload({ dead_domain: { domain: 'nosuchdomain.me', deliverable: false, dns_error: 'ENOTFOUND' } })).toEqual({
      email_domain_check: { domain: 'nosuchdomain.me', deliverable: false, dns_error: 'ENOTFOUND' },
      confirmation_question: 'No mail server answers for "nosuchdomain.me". Ask the caller to spell the whole email again.',
    });
  });
  test('nothing for a live domain or no check', () => {
    expect(callEmailCheckCardPayload({ spelled_match: true, domain_deliverable: true })).toEqual({});
    expect(callEmailCheckCardPayload(null)).toEqual({});
  });
});
