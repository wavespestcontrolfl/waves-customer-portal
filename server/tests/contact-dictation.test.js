/**
 * Contact-field dictation decoder — transcript is evidence, not source of
 * truth. LLM calls injected via deps; policy + sanitizers are pure.
 */

const {
  detectContactDictationSignals,
  decodeDictatedContacts,
  applyEmailDictationPolicy,
  nameSpellingDifferences,
  nameSpellingCardDecision,
  nameSpellingCardText,
  unsettledNameDifferences,
  nameSpellingCardPayload,
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

describe('spelled names — card-only', () => {
  const NAME_TURN = 'Caller: my last name is Serov, S-E-R-O-V';
  const entry = (over = {}) => ({ raw_spoken: 'S-E-R-O-V', spelled_value: 'Serov', field: 'last_name', whose: 'caller', confidence: 0.92, ...over });
  const names = (entries, ...sources) => sanitizeNameEntries(entries, sources.length ? sources : [NAME_TURN]);
  const diffs = (entries, saved, ...sources) => nameSpellingDifferences({ dictation: { names: names(entries, ...sources) }, saved });

  test('the decoder prompt asks for a names section and the decoder returns grounded entries', async () => {
    const out = await decodeDictatedContacts({
      transcript: `Agent: can you spell that?\n${NAME_TURN}. And my sister is Tobias, T-O-B-I-A-S.`,
      deps: {
        fetchResponse: async (prompt) => {
          expect(prompt).toMatch(/NAME RULES/);
          expect(prompt).toMatch(/"names"/);
          return JSON.stringify({
            emails: [],
            addresses: [],
            names: [
              { raw_spoken: 'S-E-R-O-V', spelled_value: 'SEROV', field: 'last_name', whose: 'caller', confidence: 0.9 },
              { raw_spoken: 'S-E-R-O-V', spelled_value: 'Q', field: 'last_name', whose: 'caller', confidence: 0.9 }, // too short
              { raw_spoken: 'S-E-R-O-V', spelled_value: 'Bad<script>', field: 'last_name', whose: 'caller', confidence: 0.9 },
              { raw_spoken: 'S-E-R-O-V', spelled_value: 'Serov', field: 'nickname', whose: 'caller', confidence: 0.9 },
              { raw_spoken: 'T-O-B-I-A-S', spelled_value: 'Tobias', field: 'first_name', whose: 'someone', confidence: 9 },
              { raw_spoken: 'Z-Z-Z-Z', spelled_value: 'Zzzz', field: 'last_name', whose: 'caller', confidence: 0.9 }, // not in the transcript
            ],
          });
        },
      },
    });
    expect(out.names.map((n) => [n.spelled_value, n.field, n.whose, n.confidence])).toEqual([
      ['Serov', 'last_name', 'caller', 0.9],
      ['Tobias', 'first_name', 'other', 1],
    ]);
    expect(out.names[0].turn).toBe('Caller: my last name is Serov, S-E-R-O-V. And my sister is Tobias, T-O-B-I-A-S.');
  });

  test('a missing names section decodes to an empty list', async () => {
    const out = await decodeDictatedContacts({ transcript: 'Caller: hello there', deps: { fetchResponse: async () => JSON.stringify({ emails: [], addresses: [] }) } });
    expect(out.names).toEqual([]);
  });

  describe('grounding', () => {
    test('raw_spoken must be in a source transcript, and its letters must make the value', () => {
      expect(names([entry()], 'Caller: x', 'Caller: spelled s-e-r-o-v')).toHaveLength(1);
      expect(names([entry()], 'Caller: nothing like it')).toEqual([]);
      expect(names([entry({ spelled_value: 'Jones' })])).toEqual([]);
      expect(names([entry({ raw_spoken: 'Serov', spelled_value: 'Serov' })], 'Caller: Serov')).toEqual([]); // said, not spelled
      expect(sanitizeNameEntries([entry()])).toEqual([]); // no sources, nothing grounded
    });
    test('spoken punctuation joins the run: O apostrophe N-E-I-L is O\'Neil, M-A-R-Y hyphen A-N-N is Mary-Ann', () => {
      const neil = names([entry({ raw_spoken: 'O apostrophe N-E-I-L', spelled_value: "O'NEIL" })], 'Caller: my last name is O apostrophe N-E-I-L');
      expect(neil).toHaveLength(1);
      expect(neil[0].spelled_value).toBe("O'Neil");
      const mary = names([entry({ field: 'first_name', raw_spoken: 'M-A-R-Y hyphen A-N-N', spelled_value: 'MARY-ANN' })], 'Caller: my first name is M-A-R-Y hyphen A-N-N');
      expect(mary[0].spelled_value).toBe('Mary-Ann');
      expect(names([entry({ raw_spoken: 'D dash E space L-A', spelled_value: 'DELA' })], 'Caller: my last name is D dash E space L-A')).toHaveLength(1);
      // The letters still have to make the value; punctuation words add nothing.
      expect(names([entry({ raw_spoken: 'O apostrophe N-E-I-L', spelled_value: "O'BRIEN" })], 'Caller: O apostrophe N-E-I-L')).toEqual([]);
      // ...and compare by letters: no card when the record already has O'Neil / Oneil.
      const d = { names: names([entry({ raw_spoken: 'O apostrophe N-E-I-L', spelled_value: "O'NEIL" })], 'Caller: my last name is O apostrophe N-E-I-L') };
      expect(nameSpellingDifferences({ dictation: d, saved: { last_name: 'Oneil' } })).toEqual([]);
      expect(nameSpellingDifferences({ dictation: d, saved: { last_name: 'Onell' } })).toHaveLength(1);
    });
    test('spaced letters and phonetic markers ground; the value is cased by the repo rule', () => {
      expect(names([entry({ raw_spoken: 'S E R O V' })], 'Caller: S E R O V')).toHaveLength(1);
      expect(names([entry({ raw_spoken: 'S as in Sam, E, R, O, V' })], 'Caller: S as in Sam, E, R, O, V')).toHaveLength(1);
      expect(names([entry({ spelled_value: 'MCLOUGHLIN', raw_spoken: 'M-C-L-O-U-G-H-L-I-N' })], 'Caller: M-C-L-O-U-G-H-L-I-N')[0].spelled_value).toBe('McLoughlin');
    });
  });

  describe('the simple qualifier', () => {
    test('a Caller turn qualifies; with labels present an Agent turn does not; an unlabeled transcript is taken as it is', () => {
      expect(names([entry()], NAME_TURN)[0].turn).toBe(NAME_TURN);
      expect(names([entry()], 'Agent: your last name is S-E-R-O-V\nCaller: yes')[0].turn).toBeNull();
      expect(names([entry()], 'my last name is S-E-R-O-V')[0].turn).toBe('my last name is S-E-R-O-V');
      expect(names([entry()], 'Speaker 1: my last name is S-E-R-O-V')[0].turn).toBe('Speaker 1: my last name is S-E-R-O-V');
    });
    test('another source can supply the caller turn', () => {
      expect(names([entry()], 'Agent: your last name is S-E-R-O-V\nCaller: yes', 'Caller: S-E-R-O-V')[0].turn).toBe('Caller: S-E-R-O-V');
    });
    test('an unlabeled pass cannot rescue a spelling the diarized transcript put in an Agent turn only', () => {
      const primary = 'Agent: your last name is S-E-R-O-V\nCaller: yes';
      expect(names([entry()], primary, 'my last name is S-E-R-O-V')[0].turn).toBeNull();
      expect(names([entry()], 'my last name is S-E-R-O-V', primary)[0].turn).toBeNull();
      // A Caller copy in the diarized transcript still qualifies; an unlabeled-only spelling is taken as it is.
      expect(names([entry()], 'Agent: is it S-E-R-O-V?\nCaller: S-E-R-O-V', 'S-E-R-O-V')[0].turn).toBe('Caller: S-E-R-O-V');
      expect(names([entry()], 'Agent: hello\nCaller: yes', 'my last name is S-E-R-O-V')[0].turn).toBe('my last name is S-E-R-O-V');
    });
    test('an email context disqualifies the turn', () => {
      expect(names([entry()], 'Caller: my email is S-E-R-O-V at gmail dot com')[0].turn).toBeNull();
      expect(names([entry()], 'Caller: S-E-R-O-V, at example dot com')[0].turn).toBeNull();
    });
  });

  describe('whole spelled runs and the evidence quote', () => {
    const smith = (over = {}) => entry({ raw_spoken: 'S-M-I-T-H', spelled_value: 'Smith', ...over });
    test('a decoder run that is only the front of a longer spelled run is not grounded', () => {
      expect(names([smith()], 'Caller: my last name is S-M-I-T-H-E')).toEqual([]);
    });
    test('an exact run is grounded; so is a run that appears whole elsewhere in the same turn', () => {
      expect(names([smith()], 'Caller: my last name is S-M-I-T-H')).toHaveLength(1);
      const both = 'Caller: not S-M-I-T-H-E, I said S-M-I-T-H';
      expect(names([smith()], both)).toHaveLength(1);
      expect(names([smith()], both)[0].turn).toBe(both);
    });
    test('a long caller turn is quoted as a window that contains the spelling', () => {
      const turn = `Caller: ${'blah '.repeat(90)}my last name is S-E-R-O-V and that is it`;
      expect(turn.length).toBeGreaterThan(450);
      const quote = names([entry()], turn)[0].turn;
      expect(quote).toContain('S-E-R-O-V');
      expect(quote.length).toBeLessThanOrEqual(302);
      expect(quote.startsWith('…')).toBe(true);
    });
  });

  describe('nameSpellingCardDecision retire rule', () => {
    const dictation = { names: [] }; // a later pass with no usable spelling
    const card = { field: 'first_name', spelled_value: 'Kwentrell', saved_value: 'Quentrell', also: [{ field: 'last_name', spelled_value: 'Serov', saved_value: 'Sirov' }] };
    const decide = (live) => nameSpellingCardDecision({ dictation, live, openCardPayload: card });
    test('one corrected field of two leaves the card open; both corrected retires it', () => {
      expect(decide({ first_name: 'Kwentrell', last_name: 'Sirov' }).retire).toBe(false);
      expect(decide({ first_name: 'Quentrell', last_name: 'Serov' }).retire).toBe(false);
      expect(decide({ first_name: 'Kwentrell', last_name: 'SEROV' }).retire).toBe(true);
    });
  });

  describe('settled-card dedupe key', () => {
    test('a cosmetic change of the stored value does not re-file a settled discrepancy', () => {
      const settled = [{ customer_ids: [], field: 'last_name', spelled_value: 'Serov', saved_value: 'Sirov' }];
      const diff = (savedValue, spelled = 'Serov') => [{ field: 'last_name', spelled_value: spelled, saved_value: savedValue }];
      expect(unsettledNameDifferences(diff('SIROV'), settled, null)).toEqual([]);
      expect(unsettledNameDifferences(diff("Si-rov", 'SEROV'), settled, null)).toEqual([]);
      expect(unsettledNameDifferences(diff('Sorov'), settled, null)).toHaveLength(1);
    });
  });

  describe('nameSpellingDifferences', () => {
    const saved = { first_name: 'Quentrell', last_name: 'Sirov' };

    test('a differing caller spelling is reported with the saved value, the caller turn and the confidence', () => {
      expect(diffs([entry()], saved)).toEqual([
        { field: 'last_name', spelled_value: 'Serov', saved_value: 'Sirov', quote: NAME_TURN, confidence: 0.92 },
      ]);
    });
    test.each([
      ['McLoughlin vs McLaughlin', 'McLoughlin', 'McLaughlin', 'M-C-L-O-U-G-H-L-I-N'],
      ['Irlbeck vs Earlbeck', 'Irlbeck', 'Earlbeck', 'I-R-L-B-E-C-K'],
    ])('the audited shape: %s', (_l, spelled, savedLast, letters) => {
      const out = diffs([entry({ spelled_value: spelled.toUpperCase(), raw_spoken: letters })], { last_name: savedLast }, `Caller: my last name is ${letters}`);
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ spelled_value: spelled, saved_value: savedLast });
    });
    test('equal letters in any case or punctuation make no card (MCLOUGHLIN vs McLoughlin)', () => {
      expect(diffs([entry({ spelled_value: 'MCLOUGHLIN', raw_spoken: 'M-C-L-O-U-G-H-L-I-N' })], { last_name: 'McLoughlin' }, 'Caller: M-C-L-O-U-G-H-L-I-N')).toEqual([]);
      expect(diffs([entry()], { last_name: 'SEROV' })).toEqual([]);
    });
    test('an entry the model gave to someone else, below the confidence bar, or outside a caller turn makes no card', () => {
      expect(diffs([entry({ whose: 'other' })], saved)).toEqual([]);
      expect(diffs([entry({ confidence: 0.5 })], saved)).toEqual([]);
      expect(diffs([entry()], saved, 'Agent: your last name is S-E-R-O-V\nCaller: yes')).toEqual([]);
      expect(diffs([entry()], saved, 'Caller: my email is S-E-R-O-V at example dot com')).toEqual([]);
    });
    test('two caller spellings of one field that disagree decide nothing; the same spelling twice is one', () => {
      const src = 'Caller: my last name is S-E-R-O-V or maybe S-E-R-A-V';
      expect(diffs([entry(), entry({ spelled_value: 'Serav', raw_spoken: 'S-E-R-A-V' })], saved, src)).toEqual([]);
      expect(diffs([entry(), entry({ confidence: 0.8 })], saved, src)).toHaveLength(1);
    });
    test('a weak alternate still counts as disagreement; the agreed spelling needs strong support', () => {
      const src = 'Caller: my last name is S-E-R-O-V or maybe S-E-R-A-V';
      const serav = (confidence) => entry({ spelled_value: 'Serav', raw_spoken: 'S-E-R-A-V', confidence });
      expect(diffs([entry(), serav(0.7)], saved, src)).toEqual([]);
      expect(diffs([entry(), entry({ confidence: 0.7 })], saved, src)).toEqual([
        { field: 'last_name', spelled_value: 'Serov', saved_value: 'Sirov', quote: src, confidence: 0.92 },
      ]);
      expect(diffs([entry({ confidence: 0.7 })], saved)).toEqual([]);
    });
    test('no saved name is the missing-name cards\' job; both fields can differ', () => {
      expect(diffs([entry()], { first_name: 'Quentrell', last_name: null })).toEqual([]);
      const out = diffs(
        [entry(), entry({ field: 'first_name', spelled_value: 'Kwentrell', raw_spoken: 'K-W-E-N-T-R-E-L-L' })],
        saved,
        'Caller: my last name is S-E-R-O-V and first name K-W-E-N-T-R-E-L-L',
      );
      expect(out.map((d) => d.field)).toEqual(['first_name', 'last_name']);
    });
    test('inert without a names section', () => {
      expect(nameSpellingDifferences({ dictation: null, saved })).toEqual([]);
      expect(nameSpellingDifferences({ dictation: { emails: [], addresses: [] }, saved })).toEqual([]);
    });
  });

  test('the card text reads as the owner worded it', () => {
    expect(nameSpellingCardText({ spelled_value: 'Serov', saved_value: 'Sirov' }))
      .toBe('Caller spelled their name S-E-R-O-V; the record says Sirov. Fix the name if the spelling is theirs.');
  });

  test('unsettledNameDifferences keys on the filing customer, field, spelling and saved name (main entry and also list)', () => {
    const d = { field: 'last_name', spelled_value: 'Serov', saved_value: 'Sirov' };
    const f = { field: 'first_name', spelled_value: 'Kwent', saved_value: 'Quent' };
    const settledA = [{ ...d, customer_ids: ['A'], also: [f] }];
    expect(unsettledNameDifferences([d, f], settledA, 'A')).toEqual([]);
    expect(unsettledNameDifferences([d, f], settledA, 'B')).toEqual([d, f]);
    expect(unsettledNameDifferences([d, f], settledA, null)).toEqual([d, f]);
    expect(unsettledNameDifferences([d], [{ ...d, customer_ids: [] }], null)).toEqual([]);
    expect(unsettledNameDifferences([d], [{ ...d, saved_value: 'Sirof', customer_ids: ['A'] }], 'A')).toEqual([d]);
  });

  test('nameSpellingCardPayload says what the spelling was compared against', () => {
    const top = { field: 'last_name', spelled_value: 'Serov', saved_value: 'Sirov', quote: 'q', confidence: 0.9 };
    const saved = { first_name: 'Quentrell', last_name: 'Sirov' };
    expect(nameSpellingCardPayload({ top, saved, filingCustomer: 'A' })).toMatchObject({
      customer_ids: ['A'], compared_against: { source: 'customer', name: 'Quentrell Sirov' }, also: [],
    });
    expect(nameSpellingCardPayload({ top, saved })).toMatchObject({ customer_ids: [], compared_against: { source: 'extracted' } });
  });

  test('nothing in the decoder module writes or rewrites a name', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../services/contact-dictation.js'), 'utf8');
    expect(src).not.toMatch(/applyNameDictationPolicy|spelledNameDecision|callerNameForWrites|nameOverrides/);
  });
});
