// PAN redaction guard (card-on-file spec Phase 0). Unit tests for the
// Luhn-gated scrubber plus the processor's three-artifact wrapper
// (transcript string + diarized segments + contact-pass stream).

const { luhnValid, scrubPans, scrubPansDetailed, scrubSegments } = require('../utils/pan-scrub');

// The processor's wrapper is exercised via the _test export (harness
// convention — see call-transcription-hallucination-guard.test.js).
jest.mock('../models/db', () => {
  const mock = jest.fn(() => { throw new Error('db not expected in this suite'); });
  mock.fn = { now: jest.fn() };
  mock.raw = jest.fn();
  return mock;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const { scrubTranscriptArtifacts, scrubStructuredTranscript } = require('../services/call-recording-processor')._test;

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

  // Codex #2676 round-2/3: provider punctuation at pauses must not break
  // the run into unmatchable islands.
  describe('punctuation separators', () => {
    it('masks a comma-separated readback', () => {
      expect(scrubPans('card 4242, 4242, 4242, 4242, thanks'))
        .toBe('card [card ending 4242], thanks');
    });
    it('masks a period-separated readback', () => {
      expect(scrubPans('4242. 4242. 4242. 4242.'))
        .toBe('[card ending 4242].');
    });
    it('masks a spaced-dash readback (" - " between groups)', () => {
      expect(scrubPans('card 4242 - 4242 - 4242 - 4242 end'))
        .toBe('card [card ending 4242] end');
    });
    it('masks a readback bridged by a mid-run diarization label (round 5)', () => {
      const r = scrubPansDetailed('Caller: 4242 4242\nCaller: 4242 4242 ok');
      expect(r.count).toBe(1);
      expect(r.text).not.toContain('4242 4242');
      expect(r.text).toContain('[card ending 4242]');
    });
    it('the digit inside "Speaker 1:" never poisons the bridged Luhn stream (round 6)', () => {
      const r = scrubPansDetailed('Speaker 1: 4242 4242\nSpeaker 1: 4242 4242');
      expect(r.count).toBe(1);
      expect(r.text).not.toContain('4242 4242');
      expect(r.text).toContain('[card ending 4242]');
      // And a label digit alone never starts a run that misaligns masking.
      const r2 = scrubPansDetailed(`Speaker 1: ${VISA16} thanks`);
      expect(r2.text).toBe('Speaker 1: [card ending 4242] thanks');
    });
  });

  // Codex #2676 round-3 P2: IIN-aware length priority — an Amex (native 15)
  // followed by code digits must never mask as a 16 that swallows a code
  // digit into the displayed last4.
  it('prefers the Amex-native 15 over a 16 window that would eat a code digit', () => {
    expect(scrubPans(`amex ${AMEX15} 234 end`))
      .toBe('amex [card ending 0005] [code removed] end');
  });

  // Codex #2676 round-2 P1: a code-shaped tail whose concatenation with the
  // PAN happens to ALSO pass Luhn must never leak into the last4 mask —
  // PAN-length priority picks the real 16 before the colliding 19.
  it('prefers the real 16-digit PAN over a Luhn-colliding 19-digit span', () => {
    // Find a 3-digit tail that makes the combined 19 digits Luhn-valid.
    let collidingTail = null;
    for (let t = 0; t < 1000; t += 1) {
      const tail = String(t).padStart(3, '0');
      if (luhnValid(`${VISA16}${tail}`)) { collidingTail = tail; break; }
    }
    expect(collidingTail).not.toBeNull();
    expect(scrubPans(`card ${VISA16} ${collidingTail} ok`))
      .toBe('card [card ending 4242] [code removed] ok');
  });

  // Codex #2676 round-2 P2: dictated phone numbers in area/exchange/line
  // groups feed contact extraction — a Luhn coincidence must never eat them.
  describe('NANP phone-block protection', () => {
    it('never masks grouped phone numbers', () => {
      const s = 'call 239 555 1234 239 555 9876 anytime';
      expect(scrubPans(s)).toBe(s);
    });
    it('locks the country-code "1" prefix with the phone block', () => {
      const s = 'reach me at 1 941 555 1234 or 1 941 555 9876';
      expect(scrubPans(s)).toBe(s);
    });
    it('still masks a card that FOLLOWS a grouped phone in the same run', () => {
      expect(scrubPans(`239 555 1234 ${VISA16}`))
        .toBe('239 555 1234 [card ending 4242]');
    });
    it('never absorbs a trailing phone block as expiry/CVV', () => {
      expect(scrubPans(`${VISA16} 239 555 9876`))
        .toBe('[card ending 4242] 239 555 9876');
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

  // Codex #2676 round-3 P2: two dictated callback numbers read as words must
  // never be eaten by a Luhn coincidence — the spoken twin of the numeric
  // phone-lock. A real card + valid expiry that HAPPENS to parse as phones
  // still masks (the MMYY tail check breaks the tie).
  describe('spoken NANP protection', () => {
    it('leaves two spoken phone numbers untouched', () => {
      const phones = 'two three nine five five five one two three four two three nine five five five nine eight seven six';
      expect(scrubPans(phones)).toBe(phones);
    });
    it('leaves phone pairs alone even when the tail is MMYY-shaped (weak IIN loses to phones — round 4)', () => {
      // Codex round-4 example: 239-555-1234 then 305-234-0123 — fully NANP,
      // and the final 0123 would pass the MMYY check; the weak 2xx prefix
      // means phones win regardless of any Luhn coincidence.
      const phones = 'two three nine five five five one two three four three zero five two three four zero one two three';
      expect(scrubPans(phones)).toBe(phones);
    });
    it('still masks a strong-IIN spoken card + valid expiry that also parses as phones', () => {
      // 4242… parses as NANP (424 exchange 242…), but the prefix is a strong
      // Visa IIN and the trailing 12 28 is a real MMYY — the card wins.
      const spoken = 'four two four two four two four two four two four two four two four two one two two eight';
      expect(scrubPans(spoken)).toBe('[card ending 4242] [code removed]');
    });
    it('masks a spoken readback wrapped across a provider line break (round 4)', () => {
      const wrapped = 'four two four two four two four two\nfour two four two four two four two';
      expect(scrubPans(wrapped)).toBe('[card ending 4242]');
    });
    it('masks a spoken readback with fillers between groups (round 5 — the prompt preserves "um"/"uh")', () => {
      const withFillers = 'four two four two um four two four two uh four two four two four two four two';
      expect(scrubPans(`Caller: ${withFillers} thanks`)).toBe('Caller: [card ending 4242] thanks');
    });
  });
});

describe('scrubSegments — diarized-segment scrub with cross-boundary bridging (round 5)', () => {
  it('masks a readback the provider split across two adjacent segments', () => {
    const r = scrubSegments([
      { id: 's1', speaker: 'caller', text: 'my card is 4242 4242' },
      { id: 's2', speaker: 'caller', text: '4242 4242 got it?' },
      { id: 's3', speaker: 'agent', text: 'please use the link instead' },
    ]);
    expect(r.count).toBeGreaterThan(0);
    const joinedOut = r.segments.map((s) => s.text).join(' ');
    expect(joinedOut).not.toContain('4242 4242');
    expect(joinedOut).toContain('[card ending 4242]');
    expect(r.segments[2].text).toBe('please use the link instead');
  });
  it('leaves clean segment arrays untouched and passes non-arrays through', () => {
    const segs = [{ id: 's1', text: 'hello' }, { id: 's2', text: 'phone 941-555-1234' }];
    expect(scrubSegments(segs)).toEqual({ segments: segs, count: 0 });
    expect(scrubSegments(null)).toEqual({ segments: null, count: 0 });
  });
});

describe('scrubPans — CVV context redaction', () => {
  it('masks a numeric CVV named in context', () => {
    expect(scrubPans('the cvv is 123 thanks')).toBe('the cvv is [code removed] thanks');
    expect(scrubPans('security code 4 5 6 7.')).toBe('security code [code removed].');
  });
  it('masks a punctuated CVV readback (round-3: providers punctuate pauses)', () => {
    expect(scrubPans('cvv is 1, 2, 3 ok')).toBe('cvv is [code removed] ok');
    expect(scrubPans('security code 4. 5. 6 done')).toBe('security code [code removed] done');
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

describe('scrubStructuredTranscript (fallback-heal for legacy transcript_structured)', () => {
  it('scrubs segments and the contact-pass stream inside the stored JSON', () => {
    const stored = JSON.stringify({
      provider: 'openai',
      segments: [{ id: 's1', text: `card ${VISA16}` }, { id: 's2', text: 'hello' }],
      contact_pass_transcript: `digits ${VISA16}`,
    });
    const r = scrubStructuredTranscript(stored);
    expect(r.count).toBe(2);
    const parsed = JSON.parse(r.json);
    expect(parsed.segments[0].text).toBe('card [card ending 4242]');
    expect(parsed.segments[1].text).toBe('hello');
    expect(parsed.contact_pass_transcript).toBe('digits [card ending 4242]');
  });
  it('passes null/unparseable/clean blobs through untouched', () => {
    expect(scrubStructuredTranscript(null)).toEqual({ json: null, count: 0 });
    expect(scrubStructuredTranscript('not-json{')).toEqual({ json: 'not-json{', count: 0 });
    const clean = JSON.stringify({ segments: [{ text: 'hi' }] });
    expect(scrubStructuredTranscript(clean)).toEqual({ json: clean, count: 0 });
  });
});
