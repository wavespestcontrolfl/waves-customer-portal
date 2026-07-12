// PAN redaction guard (card-on-file spec Phase 0). Unit tests for the
// Luhn-gated scrubber plus the processor's three-artifact wrapper
// (transcript string + diarized segments + contact-pass stream).

const { luhnValid, scrubPans, scrubPansDetailed } = require('../utils/pan-scrub');

// The processor's wrapper is exercised via the _test export (harness
// convention — see call-transcription-hallucination-guard.test.js).
jest.mock('../models/db', () => {
  const mock = jest.fn(() => { throw new Error('db not expected in this suite'); });
  mock.fn = { now: jest.fn() };
  mock.raw = jest.fn();
  return mock;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const { scrubTranscriptArtifacts } = require('../services/call-recording-processor')._test;

// Luhn-valid fixtures: standard Stripe test PANs.
const VISA16 = '4242424242424242';
const VISA13 = '4222222222222';
const AMEX15 = '378282246310005';
const INVALID16 = '4242424242424241';

describe('luhnValid', () => {
  it('accepts valid 13/15/16-digit PANs', () => {
    expect(luhnValid(VISA16)).toBe(true);
    expect(luhnValid(VISA13)).toBe(true);
    expect(luhnValid(AMEX15)).toBe(true);
  });
  it('rejects invalid checksums, wrong lengths, non-digits', () => {
    expect(luhnValid(INVALID16)).toBe(false);
    expect(luhnValid('4242')).toBe(false);
    expect(luhnValid('42424242424242424242')).toBe(false); // 20 digits
    expect(luhnValid('4242-4242')).toBe(false);
    expect(luhnValid(null)).toBe(false);
  });
});

describe('scrubPans — numeric forms', () => {
  it('masks a contiguous 16-digit PAN to last4', () => {
    expect(scrubPans(`my card is ${VISA16} okay`))
      .toBe('my card is [card ending 4242] okay');
  });
  it('masks spaced and dashed groupings', () => {
    expect(scrubPans('card 4242 4242 4242 4242 exp 12/28'))
      .toBe('card [card ending 4242] exp 12/28');
    expect(scrubPans('card 4242-4242-4242-4242.'))
      .toBe('card [card ending 4242].');
  });
  it('masks 13-digit and 15-digit (Amex) PANs', () => {
    expect(scrubPans(`visa ${VISA13} end`)).toBe('visa [card ending 2222] end');
    expect(scrubPans(`amex 3782 822463 10005 end`)).toBe('amex [card ending 0005] end');
  });
  it('leaves Luhn-invalid runs untouched', () => {
    const s = `ref number ${INVALID16} on file`;
    expect(scrubPans(s)).toBe(s);
  });
  it('leaves phone numbers and short/long digit runs untouched', () => {
    const s = 'call me at 941-555-1234 or (941) 555-9876, order 123456789012, tracking 42424242424242424242';
    expect(scrubPans(s)).toBe(s);
  });
  it('masks multiple PANs independently', () => {
    const r = scrubPansDetailed(`first ${VISA16} then ${AMEX15}`);
    expect(r.text).toBe('first [card ending 4242] then [card ending 0005]');
    expect(r.count).toBe(2);
  });

  // Codex #2676 round-1 P1: PAN read back-to-back with expiry/CVV must not
  // survive because the COMBINED run fails Luhn.
  describe('PAN with adjacent expiry/CVV digits', () => {
    it('masks the PAN and absorbs a trailing spoken-style expiry pair', () => {
      expect(scrubPans('card 4242 4242 4242 4242 12 28 thanks'))
        .toBe('card [card ending 4242] [code removed] thanks');
    });
    it('masks the PAN and absorbs a trailing CVV group', () => {
      expect(scrubPans(`number ${VISA16} 123 end`))
        .toBe('number [card ending 4242] [code removed] end');
    });
    it('masks the PAN and absorbs expiry + CVV together', () => {
      expect(scrubPans('4242 4242 4242 4242 12 28 123'))
        .toBe('[card ending 4242] [code removed]');
    });
    it('still ignores adjacent PHONE numbers (no 13–19 group span exists)', () => {
      const s = 'numbers 9415551234 9415559876 on file';
      expect(scrubPans(s)).toBe(s);
    });
    it('rejects non-card issuer prefixes even when Luhn-valid', () => {
      // 79927398713 is the classic Luhn example but 11 digits; build a
      // Luhn-valid 16-digit starting with 9 (not a card IIN): 9999999999999995
      expect(luhnValid('9999999999999995')).toBe(true);
      const s = 'ref 9999999999999995 code';
      expect(scrubPans(s)).toBe(s);
    });
  });
});

describe('scrubPans — spoken-digit form', () => {
  const SPOKEN_VISA = 'four two four two four two four two four two four two four two four two';
  it('masks a 16-word spoken PAN (Luhn-valid)', () => {
    expect(scrubPans(`Caller: it's ${SPOKEN_VISA} okay?`))
      .toBe("Caller: it's [card ending 4242] okay?");
  });
  it('accepts "oh" as zero', () => {
    // 378282246310005 spoken, with "oh" for the zeros.
    const amexSpoken = 'three seven eight two eight two two four six three one oh oh oh five';
    expect(scrubPans(`amex ${amexSpoken} thanks`)).toBe('amex [card ending 0005] thanks');
  });
  it('leaves short spoken digit runs (phone numbers) untouched', () => {
    const s = 'nine four one five five five one two three four';
    expect(scrubPans(s)).toBe(s);
  });
  it('leaves Luhn-invalid spoken runs untouched', () => {
    const s = 'one one one one one one one one one one one one one one one one';
    expect(scrubPans(s)).toBe(s);
  });
  it('masks a spoken PAN with trailing spoken expiry/CVV (prefix window)', () => {
    const spoken = 'four two four two four two four two four two four two four two four two one two two eight one two three';
    expect(scrubPans(`Caller: ${spoken}`)).toBe('Caller: [card ending 4242] [code removed]');
  });
});

describe('scrubPans — CVV context redaction', () => {
  it('masks a numeric CVV named in context', () => {
    expect(scrubPans('the cvv is 123 thanks')).toBe('the cvv is [code removed] thanks');
    expect(scrubPans('security code 4 5 6 7.')).toBe('security code [code removed].');
  });
  it('masks a spoken CVV named in context', () => {
    expect(scrubPans('my cvc is one two three ok')).toBe('my cvc is [code removed] ok');
  });
  it('leaves bare 3-4 digit runs without context untouched', () => {
    const s = 'gate code 1234 and unit 567';
    expect(scrubPans(s)).toBe(s);
  });
});

describe('scrubPans — safety', () => {
  it('passes non-strings and empties through untouched', () => {
    expect(scrubPansDetailed(null)).toEqual({ text: null, count: 0 });
    expect(scrubPansDetailed(undefined)).toEqual({ text: undefined, count: 0 });
    expect(scrubPansDetailed('')).toEqual({ text: '', count: 0 });
  });
});

describe('scrubTranscriptArtifacts (processor wrapper)', () => {
  it('scrubs transcript, contact-pass stream, and diarized segments together', () => {
    const r = scrubTranscriptArtifacts({
      transcription: `Agent: card number?\nCaller: ${VISA16}`,
      contactPassTranscript: `digits heard: 4242 4242 4242 4242`,
      segments: [
        { id: 's1', speaker: 'caller', text: `it's ${VISA16}` },
        { id: 's2', speaker: 'agent', text: 'thank you' },
      ],
    });
    expect(r.transcription).toContain('[card ending 4242]');
    expect(r.transcription).not.toContain(VISA16);
    expect(r.contactPassTranscript).toBe('digits heard: [card ending 4242]');
    expect(r.segments[0].text).toBe("it's [card ending 4242]");
    expect(r.segments[1]).toEqual({ id: 's2', speaker: 'agent', text: 'thank you' });
    expect(r.count).toBe(3);
  });
  it('handles absent artifacts without throwing', () => {
    const r = scrubTranscriptArtifacts({ transcription: 'hello', contactPassTranscript: null, segments: null });
    expect(r).toEqual({ transcription: 'hello', contactPassTranscript: null, segments: null, count: 0 });
    expect(scrubTranscriptArtifacts({}).count).toBe(0);
  });
});
