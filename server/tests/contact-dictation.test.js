/**
 * Contact-field dictation decoder — transcript is evidence, not source of
 * truth. LLM calls injected via deps; policy + sanitizers are pure.
 */

const {
  detectContactDictationSignals,
  decodeDictatedContacts,
  applyEmailDictationPolicy,
  sanitizeEmailCandidates,
  buildDecoderPrompt,
  CONTACT_DICTATION_TRANSCRIPTION_PROMPT,
} = require('../services/contact-dictation');

describe('detectContactDictationSignals', () => {
  test('email dictation phrases', () => {
    expect(detectContactDictationSignals('my email is jay at gmail dot com').email).toBe(true);
    expect(detectContactDictationSignals('B as in boy, V as in Victor').email).toBe(false); // spelling alone is not email
    expect(detectContactDictationSignals('reach me at j@x.io, spell that? J as in juliet').email).toBe(true);
  });
  test('address dictation phrases', () => {
    expect(detectContactDictationSignals('Service address is 5039 C. Phone Trail. Lakewood Ranch').address).toBe(true);
    expect(detectContactDictationSignals('what is your zip code').address).toBe(true);
  });
  test('no signals on ordinary conversation', () => {
    const out = detectContactDictationSignals('are you coming today? the tech said noon');
    expect(out.any).toBe(false);
  });
  test('safe on empty', () => {
    expect(detectContactDictationSignals(null).any).toBe(false);
  });
});

describe('sanitizeEmailCandidates', () => {
  test('drops URL-shaped and malformed values, keeps valid ones sorted by confidence', () => {
    const out = sanitizeEmailCandidates([
      { value: 'www.cw63@gmail.com', confidence: 0.9 },
      { value: 'not-an-email', confidence: 0.9 },
      { value: 'wcw63@gmail.com', confidence: 0.82, basis: ['spelled W C W'], risks: [] },
      { value: 'wwcw63@gmail.com', confidence: 0.45 },
    ]);
    expect(out.map((c) => c.value)).toEqual(['wcw63@gmail.com', 'wwcw63@gmail.com']);
  });
  test('dedupes keeping highest confidence and clamps to [0,1]', () => {
    const out = sanitizeEmailCandidates([
      { value: 'a@b.co', confidence: 0.4 },
      { value: 'A@B.co', confidence: 7 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].confidence).toBe(1);
  });
  test('handles garbage input', () => {
    expect(sanitizeEmailCandidates(null)).toEqual([]);
    expect(sanitizeEmailCandidates([{}, { value: null }])).toEqual([]);
  });
});

describe('applyEmailDictationPolicy', () => {
  const dictationWith = (candidates, extra = {}) => ({
    emails: [{
      raw_spoken: 'W, C as in Charlie, W, six three at Gmail dot com',
      candidates,
      needs_confirmation: true,
      confirmation_question: 'Is your email W-C-W-6-3 at gmail dot com?',
      ...extra,
    }],
    addresses: [],
  });

  test('single strong candidate with no extracted email → adopt + payload', () => {
    const out = applyEmailDictationPolicy({
      extracted: { email: null },
      dictation: dictationWith([{ value: 'wcw63@gmail.com', confidence: 0.82, basis: [], risks: [] }]),
    });
    expect(out.adopt).toBe('wcw63@gmail.com');
    expect(out.payload.email_candidates).toEqual([{ value: 'wcw63@gmail.com', confidence: 0.82 }]);
    expect(out.payload.confirmation_question).toMatch(/W-C-W-6-3/);
  });

  test('two candidates (the W vs WW ambiguity) → no adopt, both on the payload', () => {
    const out = applyEmailDictationPolicy({
      extracted: { email: null },
      dictation: dictationWith([
        { value: 'wcw63@gmail.com', confidence: 0.82, basis: [], risks: [] },
        { value: 'wwcw63@gmail.com', confidence: 0.45, basis: [], risks: [] },
      ]),
    });
    expect(out.adopt).toBeNull();
    expect(out.payload.email_candidates).toHaveLength(2);
  });

  test('single low-confidence candidate → no adopt', () => {
    const out = applyEmailDictationPolicy({
      extracted: { email: null },
      dictation: dictationWith([{ value: 'wcw63@gmail.com', confidence: 0.5, basis: [], risks: [] }]),
    });
    expect(out.adopt).toBeNull();
  });

  test('conflict with a clean already-extracted email → no adopt, HOLD the stored value', () => {
    const out = applyEmailDictationPolicy({
      extracted: { email: 'other@person.com' },
      dictation: dictationWith([{ value: 'wcw63@gmail.com', confidence: 0.9, basis: [], risks: [] }]),
    });
    expect(out.adopt).toBeNull();
    expect(out.hold).toBe(true);
    expect(out.payload).not.toBeNull();
  });

  test('candidate equal to extracted email → nothing to adopt, no hold, payload still surfaces', () => {
    const out = applyEmailDictationPolicy({
      extracted: { email: 'wcw63@gmail.com' },
      dictation: dictationWith([{ value: 'wcw63@gmail.com', confidence: 0.9, basis: [], risks: [] }]),
    });
    expect(out.adopt).toBeNull();
    expect(out.hold).toBe(false);
    expect(out.payload.email_candidates).toHaveLength(1);
  });

  test('ambiguous candidates with an extracted email among them → HOLD (demote before writes)', () => {
    const out = applyEmailDictationPolicy({
      extracted: { email: 'wwcw63@gmail.com' },
      dictation: dictationWith([
        { value: 'wcw63@gmail.com', confidence: 0.82, basis: [], risks: [] },
        { value: 'wwcw63@gmail.com', confidence: 0.45, basis: [], risks: [] },
      ]),
    });
    expect(out.adopt).toBeNull();
    expect(out.hold).toBe(true);
  });

  test('risk-flagged single candidate equal to the extracted email → HOLD', () => {
    const out = applyEmailDictationPolicy({
      extracted: { email: 'wwcw63@gmail.com' },
      dictation: dictationWith([{ value: 'wwcw63@gmail.com', confidence: 0.8, basis: [], risks: ['summary contradicts spelling'] }]),
    });
    expect(out.adopt).toBeNull();
    expect(out.hold).toBe(true);
  });

  test('undecodable dictation (raw evidence, zero candidates) with an extracted email → HOLD', () => {
    const out = applyEmailDictationPolicy({
      extracted: { email: 'wwcw63@gmail.com' },
      dictation: dictationWith([]),
    });
    expect(out.adopt).toBeNull();
    expect(out.hold).toBe(true);
    expect(out.payload.email_candidates).toEqual([]);
  });

  test('ambiguous candidates but NO extracted email → no hold (nothing to demote)', () => {
    const out = applyEmailDictationPolicy({
      extracted: { email: null },
      dictation: dictationWith([
        { value: 'wcw63@gmail.com', confidence: 0.82, basis: [], risks: [] },
        { value: 'wwcw63@gmail.com', confidence: 0.45, basis: [], risks: [] },
      ]),
    });
    expect(out.hold).toBe(false);
  });

  test('no dictation → inert', () => {
    expect(applyEmailDictationPolicy({ extracted: {}, dictation: null })).toEqual({ adopt: null, hold: false, payload: null });
    expect(applyEmailDictationPolicy({ extracted: {}, dictation: { emails: [], addresses: [] } })).toEqual({ adopt: null, hold: false, payload: null });
  });
});

describe('decodeDictatedContacts', () => {
  const TRANSCRIPT = 'Caller: My email is wlikenwhiskey, clikencharlie, wlikenwhiskey63 at gmail.com. Service address is 5039 C. Phone Trail, Lakewood Ranch, 34211.';

  test('parses, sanitizes, and caps the decoder output', async () => {
    const out = await decodeDictatedContacts({
      transcript: TRANSCRIPT,
      contactPassTranscript: 'Caller: W, C as in Charlie, W, six three at Gmail dot com.',
      deps: {
        fetchResponse: async (prompt) => {
          expect(prompt).toContain('SECOND-PASS TRANSCRIPT');
          return JSON.stringify({
            emails: [{
              raw_spoken: 'W, C as in Charlie, W, six three at Gmail dot com',
              candidates: [
                { value: 'wcw63@gmail.com', confidence: 0.82, basis: ['spelled W C W', 'six three -> 63'], risks: [] },
                { value: 'www.cw63@gmail.com', confidence: 0.2, basis: [], risks: ['URL-shaped'] },
              ],
              needs_confirmation: true,
              confirmation_question: 'Is it W-C-W-6-3 at gmail dot com?',
            }],
            addresses: [{
              raw_spoken: '5039 C. Phone Trail, Lakewood Ranch, 34211',
              parsed_as_heard: { house_number: '5039', street: 'C Phone Trail', city: 'Lakewood Ranch', state: 'FL', zip: '34211' },
              street_alternatives: ['Seafoam Trail', 'Sea Fawn Trail'],
              needs_confirmation: true,
              confirmation_question: 'Is the street Seafoam Trail?',
            }],
          });
        },
      },
    });
    expect(out.emails[0].candidates.map((c) => c.value)).toEqual(['wcw63@gmail.com']); // URL-shaped dropped
    expect(out.addresses[0].street_alternatives).toEqual(['Seafoam Trail', 'Sea Fawn Trail']);
    expect(out.addresses[0].parsed_as_heard.house_number).toBe('5039');
  });

  test('fails open on malformed model output', async () => {
    expect(await decodeDictatedContacts({ transcript: TRANSCRIPT, deps: { fetchResponse: async () => 'not json' } })).toBeNull();
    expect(await decodeDictatedContacts({ transcript: TRANSCRIPT, deps: { fetchResponse: async () => null } })).toBeNull();
  });

  test('inert on empty transcript or kill switch', async () => {
    expect(await decodeDictatedContacts({ transcript: '', deps: { fetchResponse: async () => '{}' } })).toBeNull();
    process.env.CONTACT_DICTATION_ENABLED = 'false';
    try {
      expect(await decodeDictatedContacts({ transcript: TRANSCRIPT, deps: { fetchResponse: async () => '{}' } })).toBeNull();
    } finally {
      delete process.env.CONTACT_DICTATION_ENABLED;
    }
  });
});

describe('prompt hygiene', () => {
  test('transcription + decoder prompts stay free of concrete seed examples', () => {
    for (const text of [CONTACT_DICTATION_TRANSCRIPTION_PROMPT, buildDecoderPrompt({ transcript: 'x' })]) {
      expect(text).not.toMatch(/seafoam|cw63|jimenez|bivona/i);
    }
  });
});

describe('applyEmailDictationPolicy — risk-flagged candidates are never adopted', () => {
  test('single strong candidate WITH a declared risk → quarantine (the live wwcw63 case)', () => {
    const out = applyEmailDictationPolicy({
      extracted: { email: null },
      dictation: {
        emails: [{
          raw_spoken: 'spelled sequence then a contradicting summary',
          candidates: [{
            value: 'wwcw63@gmail.com',
            confidence: 0.8,
            basis: ['decoded from phonetic spelling'],
            risks: ["Caller's summary contradicts the spelling"],
          }],
          needs_confirmation: true,
          confirmation_question: 'Did I get that right?',
        }],
        addresses: [],
      },
    });
    expect(out.adopt).toBeNull();
    expect(out.payload.email_candidates).toHaveLength(1);
  });
});
