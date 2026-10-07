/**
 * Contact-field dictation decoder — transcript is evidence, not source of
 * truth. LLM calls injected via deps; policy + sanitizers are pure.
 */

const {
  detectContactDictationSignals,
  decodeDictatedContacts,
  applyEmailDictationPolicy,
  applyNameDictationPolicy,
  applyNameDictationToV2Caller,
  sanitizeNameEntries,
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
  test('spelled-name phrases trip the name signal; ordinary talk does not', () => {
    expect(detectContactDictationSignals('Caller: Varnum, V-A-R-N-U-M.').name).toBe(true);
    expect(detectContactDictationSignals('Caller: V A R N U M.').name).toBe(true);
    expect(detectContactDictationSignals('Caller: the last name is spelled differently').name).toBe(true);
    expect(detectContactDictationSignals('Caller: V as in Victor, A, R.').name).toBe(true);
    expect(detectContactDictationSignals('Caller: I like in-ground sprinklers and I like pizza.').name).toBe(false);
    expect(detectContactDictationSignals('Caller: can you come on the 14-15 or 3-4-5 weekend').name).toBe(false);
    expect(detectContactDictationSignals('Caller: Varnum, V-A-R-N-U-M.').any).toBe(true);
  });
  test('lowercase spaced runs and short spelled names trip the name signal', () => {
    for (const line of ['Caller: v a r n u m', 'Caller: L-E-E', 'Caller: l-e-e', 'Caller: my last name is l e e',
      'Caller: Smith, S, M, I, T, H', 'Caller: my last name is L E']) {
      expect(detectContactDictationSignals(line).name).toBe(true);
    }
  });
  test('ordinary sentences do not trip the name signal', () => {
    for (const line of ['Caller: I need a B test on the lawn', 'Caller: I have a B plan or a c plan', 'Caller: press 1 or 2',
      'Caller: the name is Bob, a plumber', 'Caller: J. R. Smith called', 'Caller: my name is Jordan Rivers',
      'Caller: that is a-ok', 'Caller: we have a lot of ants', 'Caller: my name is Lee, a customer since 2020',
      'Caller: I live on 5th and A street']) {
      expect(detectContactDictationSignals(line).name).toBe(false);
    }
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

describe('spelled-name decoding', () => {
  const entry = (over = {}) => ({
    raw_spoken: 'Caller: Orlmeyer, O-R-L-M-E-Y-E-R',
    spelled_value: 'Orlmeyer',
    field: 'last_name',
    whose: 'caller',
    confidence: 0.92,
    ...over,
  });
  const dictation = (...names) => ({ emails: [], addresses: [], names: sanitizeNameEntries(names) });

  test('decodeDictatedContacts returns sanitized names and keeps emails/addresses', async () => {
    const out = await decodeDictatedContacts({
      transcript: 'Caller: Varnum, V-A-R-N-U-M.',
      deps: {
        fetchResponse: async (prompt) => {
          expect(prompt).toMatch(/NAME RULES/);
          expect(prompt).toMatch(/"names"/);
          return JSON.stringify({
            emails: [],
            addresses: [],
            names: [
              { raw_spoken: 'V-A-R-N-U-M', spelled_value: 'VARNUM', field: 'last_name', whose: 'caller', confidence: 0.9 },
              { raw_spoken: 'x', spelled_value: 'Q', field: 'last_name', whose: 'caller', confidence: 0.9 }, // too short
              { raw_spoken: 'x', spelled_value: 'Bad<script>', field: 'last_name', whose: 'caller', confidence: 0.9 },
              { raw_spoken: 'x', spelled_value: 'Tobias', field: 'nickname', whose: 'caller', confidence: 0.9 },
              { raw_spoken: 'x', spelled_value: 'Tobias', field: 'first_name', whose: 'someone', confidence: 9 },
            ],
          });
        },
      },
    });
    expect(out.names).toEqual([
      { raw_spoken: 'V-A-R-N-U-M', spelled_value: 'Varnum', field: 'last_name', whose: 'caller', confidence: 0.9 },
      { raw_spoken: 'x', spelled_value: 'Tobias', field: 'first_name', whose: 'other', confidence: 1 },
    ]);
  });

  test('a missing names section decodes to an empty list', async () => {
    const out = await decodeDictatedContacts({
      transcript: 'Caller: hello there',
      deps: { fetchResponse: async () => JSON.stringify({ emails: [], addresses: [] }) },
    });
    expect(out.names).toEqual([]);
  });

  test.each([
    ['one swapped vowel', 'McDermond', 'McDarmond'],
    ['one swapped letter', 'Varnum', 'Varnim'],
    ['two edits on a long name', 'Orlmeyer', 'Earlmeyer'],
    ['same letters, wrong case', 'McDermond', 'Mcdermond'],
  ])('replaces the misheard caller surname: %s', (_label, spelled, heard) => {
    const out = applyNameDictationPolicy({
      current: { first_name: 'Quentrell', last_name: heard },
      dictation: dictation(entry({ spelled_value: spelled })),
    });
    expect(out).toEqual({ last_name: spelled });
  });

  test('fills an empty name and handles a first name', () => {
    expect(applyNameDictationPolicy({
      current: { first_name: null, last_name: '' },
      dictation: dictation(entry({ spelled_value: 'Varnum' }), entry({ spelled_value: 'Quentrell', field: 'first_name' })),
    })).toEqual({ first_name: 'Quentrell', last_name: 'Varnum' });
  });

  test('leaves a name that is not close to the spelling (a different name stays)', () => {
    expect(applyNameDictationPolicy({
      current: { first_name: 'Quentrell', last_name: 'Smith' },
      dictation: dictation(entry({ spelled_value: 'Varnum' })),
    })).toEqual({});
  });

  test('leaves an already-correct name alone', () => {
    expect(applyNameDictationPolicy({
      current: { last_name: 'Varnum' },
      dictation: dictation(entry({ spelled_value: 'Varnum' })),
    })).toEqual({});
  });

  test('never applies a spelling the model assigned to someone else', () => {
    expect(applyNameDictationPolicy({
      current: { last_name: 'Varnim' },
      dictation: dictation(entry({ spelled_value: 'Varnum', whose: 'other' })),
    })).toEqual({});
  });

  test('never applies below the adopt confidence', () => {
    expect(applyNameDictationPolicy({
      current: { last_name: 'Varnim' },
      dictation: dictation(entry({ spelled_value: 'Varnum', confidence: 0.6 })),
    })).toEqual({});
  });

  test('never applies when two caller spellings of one field disagree', () => {
    expect(applyNameDictationPolicy({
      current: { last_name: 'Varnim' },
      dictation: dictation(entry({ spelled_value: 'Varnum' }), entry({ spelled_value: 'Varnem', confidence: 0.5 })),
    })).toEqual({});
    // A spelling labeled "other" for the same field is a different person, not a disagreement.
    expect(applyNameDictationPolicy({
      current: { last_name: 'Varnim' },
      dictation: dictation(entry({ spelled_value: 'Varnum' }), entry({ spelled_value: 'Thornquist', whose: 'other' })),
    })).toEqual({ last_name: 'Varnum' });
  });

  test('inert without a names section', () => {
    expect(applyNameDictationPolicy({ current: { last_name: 'Varnim' }, dictation: null })).toEqual({});
    expect(applyNameDictationPolicy({ current: { last_name: 'Varnim' }, dictation: { emails: [], addresses: [] } })).toEqual({});
  });

  describe('V2 caller block', () => {
    test('rewrites split fields and name_full; never touches secondary contacts', () => {
      const extraction = {
        caller: { first_name: 'Quentrell', last_name: 'Varnim', name_full: 'Quentrell Varnim' },
        secondary_contacts: [{ first_name: 'Odalys', last_name: 'Varnim', name_full: 'Odalys Varnim' }],
      };
      const changes = applyNameDictationToV2Caller(extraction.caller, dictation(entry({ spelled_value: 'Varnum' })));
      expect(changes).toEqual({ last_name: 'Varnum' });
      expect(extraction.caller).toEqual({ first_name: 'Quentrell', last_name: 'Varnum', name_full: 'Quentrell Varnum' });
      expect(extraction.secondary_contacts[0]).toEqual({ first_name: 'Odalys', last_name: 'Varnim', name_full: 'Odalys Varnim' });
    });

    test('derives the misheard surname from name_full when the split fields are empty', () => {
      const caller = { first_name: null, last_name: null, name_full: 'Quentrell Varnim' };
      applyNameDictationToV2Caller(caller, dictation(entry({ spelled_value: 'Varnum' })));
      expect(caller).toEqual({ first_name: null, last_name: 'Varnum', name_full: 'Quentrell Varnum' });
    });

    test('a single-token name_full is replaced only when it is the same name misheard', () => {
      const near = { first_name: null, last_name: 'Varnim', name_full: 'Varnim' };
      applyNameDictationToV2Caller(near, dictation(entry({ spelled_value: 'Varnum' })));
      expect(near.name_full).toBe('Varnum');
      const far = { first_name: 'Odalys', last_name: null, name_full: 'Odalys' };
      applyNameDictationToV2Caller(far, dictation(entry({ spelled_value: 'Varnum' })));
      expect(far).toEqual({ first_name: 'Odalys', last_name: 'Varnum', name_full: 'Odalys' });
    });

    test('replaces a whole compound component in name_full, not a token', () => {
      const last = { first_name: 'Test', last_name: 'De Silvo', name_full: 'Test De Silvo' };
      applyNameDictationToV2Caller(last, dictation(entry({ spelled_value: 'De Silva' })));
      expect(last).toEqual({ first_name: 'Test', last_name: 'De Silva', name_full: 'Test De Silva' });
      const first = { first_name: 'Mary Ann', last_name: 'Varnum', name_full: 'Mary Ann Varnum' };
      applyNameDictationToV2Caller(first, dictation(entry({ spelled_value: 'Maryanne', field: 'first_name' })));
      expect(first.name_full).toBe('Maryanne Varnum');
      // Three tokens and no split value: the component boundary is unknown, so name_full is not guessed at.
      const unknown = { first_name: null, last_name: null, name_full: 'Test De Silvo' };
      expect(applyNameDictationToV2Caller(unknown, dictation(entry({ spelled_value: 'De Silva' })))).toEqual({});
      expect(unknown).toEqual({ first_name: null, last_name: null, name_full: 'Test De Silvo' });
    });

    test('rewrites the component at its own end of name_full when both parts match', () => {
      const lee = { first_name: 'Odell', last_name: 'Odell', name_full: 'Odell Odell' };
      applyNameDictationToV2Caller(lee, dictation(entry({ spelled_value: 'Odele', field: 'last_name' })));
      expect(lee).toEqual({ first_name: 'Odell', last_name: 'Odele', name_full: 'Odell Odele' });
      const leeFirst = { first_name: 'Odell', last_name: 'Odell', name_full: 'Odell Odell' };
      applyNameDictationToV2Caller(leeFirst, dictation(entry({ spelled_value: 'Odele', field: 'first_name' })));
      expect(leeFirst).toEqual({ first_name: 'Odele', last_name: 'Odell', name_full: 'Odele Odell' });
    });

    test('derives the missing part from a compound name_full by removing the known part', () => {
      const firstOnly = { first_name: 'Mary Ann', last_name: null, name_full: 'Mary Ann Smyth' };
      expect(applyNameDictationToV2Caller(firstOnly, dictation(entry({ spelled_value: 'Smith' })))).toEqual({ last_name: 'Smith' });
      expect(firstOnly).toEqual({ first_name: 'Mary Ann', last_name: 'Smith', name_full: 'Mary Ann Smith' });
      const lastOnly = { first_name: null, last_name: 'De Silvo', name_full: 'Mary Ann De Silvo' };
      expect(applyNameDictationToV2Caller(lastOnly, dictation(entry({ spelled_value: 'Maryanne', field: 'first_name' })))).toEqual({ first_name: 'Maryanne' });
      expect(lastOnly.name_full).toBe('Maryanne De Silvo');
      // name_full that disagrees with the present part derives nothing.
      const disagree = { first_name: 'Rita', last_name: null, name_full: 'Jane Garcia' };
      expect(applyNameDictationToV2Caller(disagree, dictation(entry({ spelled_value: 'Garcia' })))).toEqual({});
    });

    test('tolerates a missing caller', () => {
      expect(applyNameDictationToV2Caller(null, dictation(entry()))).toEqual({});
    });
  });
});
