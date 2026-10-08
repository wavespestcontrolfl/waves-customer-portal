/**
 * Contact-field dictation decoder — transcript is evidence, not source of
 * truth. LLM calls injected via deps; policy + sanitizers are pure.
 */

const {
  detectContactDictationSignals,
  decodeDictatedContacts,
  applyEmailDictationPolicy,
  applyNameDictationPolicy,
  spelledNameDecision,
  callerSpelledName,
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
    for (const line of ['V like Victor', 'v like victor', 'S for Sam', 's as in sam', 'it is V like Victor, A like Adam']) {
      expect(detectContactDictationSignals(`Caller: ${line}`).name).toBe(true);
    }
    for (const line of ['how do you spell that', 'let me spell my name', 'can you spell it for me', 'what is the spelling']) {
      expect(detectContactDictationSignals(`Caller: ${line}`).name).toBe(true);
    }
    expect(detectContactDictationSignals('Caller: V as in Victor, A, R.').name).toBe(true);
    expect(detectContactDictationSignals('Caller: I like in-ground sprinklers and I like pizza.').name).toBe(false);
    expect(detectContactDictationSignals('Caller: can you come on the 14-15 or 3-4-5 weekend').name).toBe(false);
    expect(detectContactDictationSignals('Caller: Varnum, V-A-R-N-U-M.').any).toBe(true);
    // A two-letter name is accepted only when anchored by the name just spoken.
    expect(detectContactDictationSignals('Caller: my last name is Li, L-I').name).toBe(true);
    expect(detectContactDictationSignals('Caller: my last name is L E').name).toBe(false);
    expect(detectContactDictationSignals('Caller: press A B to continue, I mean A-B').name).toBe(false);
  });
  test('lowercase spaced runs and short spelled names trip the name signal', () => {
    for (const line of ['Caller: v a r n u m', 'Caller: L-E-E', 'Caller: l-e-e', 'Caller: my last name is l e e',
      'Caller: Smith, S, M, I, T, H', 'Caller: Li, L-I', 'Caller: it is Li, L I']) {
      expect(detectContactDictationSignals(line).name).toBe(true);
    }
  });
  test('ordinary sentences do not trip the name signal', () => {
    for (const line of ['Caller: I need a B test on the lawn', 'Caller: I have a B plan or a c plan', 'Caller: press 1 or 2',
      'Caller: the name is Bob, a plumber', 'Caller: J. R. Smith called', 'Caller: my name is Jordan Rivers',
      'Caller: that is a-ok', 'Caller: we have a lot of ants', 'Caller: my name is Lee, a customer since 2020',
      'Caller: I live on 5th and A street', 'Caller: I like pizza', 'Caller: I like it a lot', 'Caller: we like in-ground sprinklers', 'Caller: we have had a dry spell', 'Caller: a cold spell is coming']) {
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
  const spellOut = (v, field) => `Caller: my ${field === 'first_name' ? 'first' : 'last'} name is ${v.split('').join('-').toUpperCase()}`;
  const entry = (over = {}) => {
    const spelled = over.spelled_value || 'Orlmeyer';
    return {
      raw_spoken: spellOut(spelled, over.field),
      spelled_value: spelled,
      field: 'last_name',
      whose: 'caller',
      confidence: 0.92,
      ...over,
    };
  };
  // Entries here are grounded in their own raw_spoken, as the decoder's transcript would be.
  const dictation = (...names) => ({
    emails: [],
    addresses: [],
    names: sanitizeNameEntries(names, names.map((n) => n.raw_spoken)),
  });

  test('decodeDictatedContacts returns sanitized, grounded names and keeps emails/addresses', async () => {
    const out = await decodeDictatedContacts({
      transcript: 'Caller: Varnum, V-A-R-N-U-M. And my sister is Tobias, T-O-B-I-A-S.',
      deps: {
        fetchResponse: async (prompt) => {
          expect(prompt).toMatch(/NAME RULES/);
          expect(prompt).toMatch(/"names"/);
          return JSON.stringify({
            emails: [],
            addresses: [],
            names: [
              { raw_spoken: 'V-A-R-N-U-M', spelled_value: 'VARNUM', field: 'last_name', whose: 'caller', confidence: 0.9 },
              { raw_spoken: 'V-A-R-N-U-M', spelled_value: 'Q', field: 'last_name', whose: 'caller', confidence: 0.9 }, // too short
              { raw_spoken: 'V-A-R-N-U-M', spelled_value: 'Bad<script>', field: 'last_name', whose: 'caller', confidence: 0.9 },
              { raw_spoken: 'V-A-R-N-U-M', spelled_value: 'Varnum', field: 'nickname', whose: 'caller', confidence: 0.9 },
              { raw_spoken: 'T-O-B-I-A-S', spelled_value: 'Tobias', field: 'first_name', whose: 'someone', confidence: 9 },
            ],
          });
        },
      },
    });
    expect(out.names).toEqual([
      { raw_spoken: 'V-A-R-N-U-M', spelled_value: 'Varnum', field: 'last_name', whose: 'caller', confidence: 0.9, name_context: false },
      { raw_spoken: 'T-O-B-I-A-S', spelled_value: 'Tobias', field: 'first_name', whose: 'other', confidence: 1, name_context: false },
    ]);
  });

  describe('name context (filling an empty name)', () => {
    const ctx = (turn, raw, spelled = 'Jones', field = 'last_name') => sanitizeNameEntries(
      [{ raw_spoken: raw, spelled_value: spelled, field, whose: 'caller', confidence: 0.95 }], [turn],
    )[0]?.name_context;

    test('true right after name wording in the caller turn', () => {
      expect(ctx('Agent: how do you spell that?\nCaller: my last name is Jones, J-O-N-E-S', 'J-O-N-E-S')).toBe(true);
      expect(ctx('Caller: it is spelled J O N E S', 'J O N E S')).toBe(true);
    });
    test('an agent read-back never counts, and neither does an unlabeled or Speaker-N line', () => {
      const e = [{ raw_spoken: 'S-M-Y-T-H', spelled_value: 'Smyth', field: 'last_name', whose: 'caller', confidence: 0.95 }];
      const nc = (...src) => sanitizeNameEntries(e, src)[0].name_context;
      expect(nc('Agent: your last name is spelled S-M-Y-T-H, correct?')).toBe(false);
      expect(nc('Agent: your last name is spelled S-M-Y-T-H')).toBe(false);
      expect(nc('Speaker 1: my last name is S-M-Y-T-H')).toBe(false);
      expect(nc('my last name is S-M-Y-T-H')).toBe(false);
      expect(nc('Agent: your last name is S-M-Y-T-H\nCaller: yes my last name is S-M-Y-T-H')).toBe(true);
    });
    test('scans every source and every occurrence until one qualifies', () => {
      const entry = [{ raw_spoken: 'J-O-N-E-S', spelled_value: 'Jones', field: 'last_name', whose: 'caller', confidence: 0.95 }];
      expect(sanitizeNameEntries(entry, ['Caller: J-O-N-E-S', 'Caller: my last name is J-O-N-E-S'])[0].name_context).toBe(true);
      expect(sanitizeNameEntries(entry, ['Caller: sure J-O-N-E-S\nCaller: my last name is J-O-N-E-S'])[0].name_context).toBe(true);
      expect(sanitizeNameEntries(entry, ['Caller: sure J-O-N-E-S', 'Caller: yes J-O-N-E-S'])[0].name_context).toBe(false);
    });
    test('false with no name wording, or in an email context', () => {
      expect(ctx('Caller: sure, J-O-N-E-S', 'J-O-N-E-S')).toBe(false);
      expect(ctx('Caller: my email is J-O-N-E-S at gmail dot com', 'J-O-N-E-S')).toBe(false);
      expect(ctx('Caller: my name is Bob. The email is, J-O-N-E-S, at example dot com', 'J-O-N-E-S')).toBe(false);
      expect(ctx('Caller: my name is Bob.\nCaller: ok? J-O-N-E-S', 'J-O-N-E-S')).toBe(false);
      // Email wording AFTER the spelling, in the same turn.
      expect(ctx('Caller: my last name is spelled J-O-N-E-S at gmail dot com', 'J-O-N-E-S')).toBe(false);
      // ...but email wording in a later turn does not count.
      expect(ctx('Caller: my last name is J-O-N-E-S\nCaller: and my email is x at gmail dot com', 'J-O-N-E-S')).toBe(true);
    });
    test('an empty name is NOT filled from a spelling with no name context (the J-O-N-E-S email case)', () => {
      const names = sanitizeNameEntries(
        [{ raw_spoken: 'J-O-N-E-S', spelled_value: 'Jones', field: 'last_name', whose: 'caller', confidence: 0.95 }],
        ['Caller: my email is J-O-N-E-S at example dot com'],
      );
      const d = { emails: [], addresses: [], names };
      expect(applyNameDictationPolicy({ current: { first_name: 'Quentrell', last_name: null }, dictation: d })).toEqual({});
      // One rule for fill and replace: a near-match name is not rewritten without name context either.
      expect(applyNameDictationPolicy({ current: { last_name: 'Jonas' }, dictation: d })).toEqual({});
      expect(applyNameDictationPolicy({ current: { first_name: 'Quentrell', last_name: 'Jonas' }, dictation: d })).toEqual({});
    });
  });

  describe('grounding', () => {
    const ground = (names, ...sources) => sanitizeNameEntries(names, sources);
    const base = { spelled_value: 'Varnum', field: 'last_name', whose: 'caller', confidence: 0.9 };

    test('drops an entry whose raw_spoken is not in any source transcript', () => {
      expect(ground([{ ...base, raw_spoken: 'V-A-R-N-U-M' }], 'Caller: my email is J-O-N-E-S at example dot com')).toEqual([]);
      expect(ground([{ ...base, raw_spoken: 'V-A-R-N-U-M' }], 'Caller: x', 'Caller: spelled v-a-r-n-u-m')).toHaveLength(1);
    });
    test('drops an entry whose spelled letters do not make spelled_value', () => {
      expect(ground([{ ...base, spelled_value: 'Jones', raw_spoken: 'V-A-R-N-U-M' }], 'Caller: V-A-R-N-U-M')).toEqual([]);
      expect(ground([{ ...base, raw_spoken: 'my name is Varnum' }], 'Caller: my name is Varnum')).toEqual([]); // said, not spelled
    });
    test('accepts spaced letters and phonetic markers; ignores apostrophe words', () => {
      expect(ground([{ ...base, raw_spoken: "it's V A R N U M" }], "Caller: it's V A R N U M")).toHaveLength(1);
      expect(ground([{ ...base, raw_spoken: 'V as in Victor, A as in Adam, R, N, U, M' }], 'Caller: V as in Victor, A as in Adam, R, N, U, M')).toHaveLength(1);
    });
    test('without sources nothing is grounded', () => {
      expect(sanitizeNameEntries([{ ...base, raw_spoken: 'V-A-R-N-U-M' }])).toEqual([]);
    });
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

  test('callerSpelledName carries the decoder confidence and quote', () => {
    const d = dictation(entry({ spelled_value: 'Varnum', confidence: 0.91 }));
    expect(callerSpelledName(d, 'last_name')).toMatchObject({ value: 'Varnum', confidence: 0.91, quote: expect.stringContaining('V-A-R-N-U-M'), nameContext: true });
    expect(callerSpelledName(d, 'first_name')).toBeNull();
  });

  test('inert without a names section', () => {
    expect(applyNameDictationPolicy({ current: { last_name: 'Varnim' }, dictation: null })).toEqual({});
    expect(applyNameDictationPolicy({ current: { last_name: 'Varnim' }, dictation: { emails: [], addresses: [] } })).toEqual({});
  });
});

describe('spelledNameDecision — casing and the carried decision', () => {
  const d = (spelled, over = {}) => ({
    emails: [],
    addresses: [],
    names: sanitizeNameEntries([{
      raw_spoken: `Caller: my last name is ${spelled.split('').join('-').toUpperCase()}`,
      spelled_value: spelled.toUpperCase(),
      field: 'last_name',
      whose: 'caller',
      confidence: 0.95,
      ...over,
    }], [`Caller: my last name is ${spelled.split('').join('-').toUpperCase()}`]),
  });

  test('the spelled value uses the repo proper-case (Mc / Mac / O\' / hyphen)', () => {
    expect(spelledNameDecision({ current: { last_name: 'Mcglaughlin' }, dictation: d('McLoughlin') }).last_name.value).toBe('McLoughlin');
    expect(spelledNameDecision({ current: {}, dictation: d('OBRIEN-SMITH') }).last_name.value).toBe('Obrien-Smith');
    expect(sanitizeNameEntries([{ raw_spoken: 'Caller: O-\'-B-R-I-E-N', spelled_value: "O'BRIEN", field: 'last_name', whose: 'caller', confidence: 0.9 }], ["Caller: O-'-B-R-I-E-N"])).toEqual([]);
  });

  test('extracted letters already equal the spelled letters: keep the extracted value (MCLOUGHLIN vs McLoughlin)', () => {
    expect(applyNameDictationPolicy({ current: { last_name: 'McLoughlin' }, dictation: d('McLoughlin') })).toEqual({});
    const out = spelledNameDecision({ current: { last_name: 'McLoughlin' }, dictation: d('MCLOUGHLIN') });
    // The decoder's confidence is carried for staging, but the value is the extracted one, unchanged.
    expect(out.last_name).toMatchObject({ value: 'McLoughlin', confidence: 0.95 });
    expect(spelledNameDecision({ current: { last_name: 'MCLOUGHLIN' }, dictation: d('McLoughlin') }).last_name.value).toBe('MCLOUGHLIN');
  });

  test('no decision without name context, for a far name, or for someone else', () => {
    expect(spelledNameDecision({ current: { last_name: 'Smith' }, dictation: d('Varnum') })).toEqual({});
    expect(spelledNameDecision({ current: {}, dictation: d('Varnum', { whose: 'other' }) })).toEqual({});
    const noCtx = { emails: [], addresses: [], names: sanitizeNameEntries([{ raw_spoken: 'V-A-R-N-U-M', spelled_value: 'Varnum', field: 'last_name', whose: 'caller', confidence: 0.95 }], ['Caller: sure, V-A-R-N-U-M']) };
    expect(spelledNameDecision({ current: {}, dictation: noCtx })).toEqual({});
  });
});

describe('processor wiring — one decision, used only where the canonical customer is known', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../services/call-recording-processor.js'), 'utf8');

  test('the decision is computed from inbound labeled calls, applies nothing to `extracted`, and does no customer lookup', () => {
    const at = src.indexOf('spelledNameDecision({ current: extracted');
    expect(at).toBeGreaterThan(0);
    const block = src.slice(at - 400, at + 400);
    expect(block).toMatch(/!isOutboundCall\(call\) && \/\^\\s\*caller\\s\*:\/im\.test\(transcription\)/);
    expect(block).toMatch(/Object\.assign\(spelledNameOverrides, spelledNameDecision/);
    expect(block).not.toMatch(/extracted\[field\] =|findCustomerForCallContact|countCustomers/);
    expect(src).not.toMatch(/countCustomersWithContactPhone|labeledInbound|NAME_DICTATION_MARKER|name_dictation|applyNameDictationToV2Caller/);
  });

  test('creation eligibility reads the resolved name too', () => {
    expect(src).toMatch(/const firstNameAdvisoryCreate = !createNameFor\('first_name'\)/);
    expect(src).toMatch(/\(createNameFor\('first_name'\) \|\| firstNameAdvisoryCreate\) && phone && !extracted\.is_voicemail && !v2NonCustomerCallNature\) \{/);
    expect(src).toMatch(/const customerExpected = !!\(\(createNameFor\('first_name'\) \|\| firstNameAdvisoryCreate\)/);
  });

  test('the decision reaches candidate staging for the linked customer', () => {
    expect(src).toMatch(/nameOverrides: spelledNameOverrides,/);
  });

  // A slot-only match that findCustomerForCallContact rejects ends in the create branch, which
  // reads the names through createNameFor, so the NEW customer / lead carries the spelled name.
  test('every new-customer and new-lead insert reads the name through createNameFor', () => {
    expect(src).toMatch(/const createNameFor = \(field\) => spelledNameOverrides\[field\]\?\.value \?\? extracted\[field\];/);
    const customerInsert = src.slice(src.indexOf("trx('customers').insert(applyContactNormalization({"), src.indexOf("trx('customers').insert(applyContactNormalization({") + 900);
    expect(customerInsert).toMatch(/first_name: createNameFor\('first_name'\) \|\| ''/);
    expect(customerInsert).toMatch(/last_name: createNameFor\('last_name'\) \|\| null/);
    const account = src.slice(src.indexOf('ensureCustomerAccount(db, {'), src.indexOf('ensureCustomerAccount(db, {') + 300);
    expect(account).toMatch(/firstName: createNameFor\('first_name'\)/);
    // The three lead inserts (new lead, shared-line conflict mint, claim-race mint).
    for (const marker of ["db('leads').insert({\n            lead_source_id", 'const [conflictFresh] = await db(\'leads\').insert({', 'const [raceFresh] = await db(\'leads\').insert({']) {
      const i = src.indexOf(marker);
      expect(i).toBeGreaterThan(0);
      const body = src.slice(i, i + 1100);
      expect(body).toMatch(/first_name: capitalizeName\(createNameFor\('first_name'\)\) \|\| null/);
      expect(body).toMatch(/last_name: capitalizeName\(createNameFor\('last_name'\)\) \|\| null/);
    }
  });
});
