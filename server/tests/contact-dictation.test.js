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
  callerNameForWrites,
  callerSpelledName,
  sanitizeNameEntries,
  qualifyingNameEntry,
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
      transcript: 'Caller: my last name is Varnum, V-A-R-N-U-M. And my sister is Tobias, T-O-B-I-A-S.',
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
      { raw_spoken: 'V-A-R-N-U-M', spelled_value: 'Varnum', field: 'last_name', whose: 'caller', confidence: 0.9, qualifies: true },
      { raw_spoken: 'T-O-B-I-A-S', spelled_value: 'Tobias', field: 'first_name', whose: 'other', confidence: 1, qualifies: false },
    ]);
  });

  describe('qualifyingNameEntry — the one rule, every audited case', () => {
    const E = (raw, spelled, over = {}) => ({ raw_spoken: raw, spelled_value: spelled, field: 'last_name', whose: 'caller', confidence: 0.95, ...over });
    const cases = [
      // [label, entry, sources, qualifies]
      ['caller states the last name', E('J-O-N-E-S', 'Jones'), ['Caller: my last name is J-O-N-E-S'], true],
      ['first name, "my name is"', E('Q-U-E-N-T', 'Quent', { field: 'first_name' }), ['Caller: my name is Quent, Q-U-E-N-T'], true],
      ['surname wording', E('V-A-R-N-U-M', 'Varnum'), ['Caller: the surname is V-A-R-N-U-M'], true],
      ['intro "this is <name>, <spelling>"', E('V-A-R-N-U-M', 'Varnum'), ['Caller: this is Varnum, V-A-R-N-U-M'], true],
      ['spelling right after an agent asks for the name', E('S-M-Y-T-H', 'Smyth'), ['Agent: what is your last name?\nCaller: S-M-Y-T-H'], true],
      ['name context only in the contact-pass source', E('J-O-N-E-S', 'Jones'), ['Caller: J-O-N-E-S', 'Caller: my last name is J-O-N-E-S'], true],
      ['name context only in a later occurrence', E('J-O-N-E-S', 'Jones'), ['Caller: sure J-O-N-E-S\nCaller: my last name is J-O-N-E-S'], true],
      ['two-letter name anchored by the spoken name (Li, L-I)', E('L-I', 'Li'), ['Caller: my last name is Li, L-I'], true],
      ['MCLOUGHLIN spelled, cased by the repo rule', E('M-C-L-O-U-G-H-L-I-N', 'MCLOUGHLIN'), ['Caller: my last name is M-C-L-O-U-G-H-L-I-N'], true],
      ['phonetic markers', E('V as in Victor, A, R', 'Var'), ['Caller: my last name is V as in Victor, A, R'], true],
      // Rejected: the audited failures from rounds 2-9.
      ['email local part spelled (J-O-N-E-S at gmail dot com)', E('J-O-N-E-S', 'Jones'), ['Caller: my email is J-O-N-E-S at gmail dot com'], false],
      ['email wording AFTER a name-worded spelling', E('J-O-N-E-S', 'Jones'), ['Caller: my last name is spelled J-O-N-E-S at gmail dot com'], false],
      ['agent read-back', E('S-M-Y-T-H', 'Smyth'), ['Agent: your last name is spelled S-M-Y-T-H, correct?'], false],
      ['agent read-back without a question', E('S-M-Y-T-H', 'Smyth'), ['Agent: your last name is S-M-Y-T-H'], false],
      ['unlabeled transcript', E('S-M-Y-T-H', 'Smyth'), ['my last name is S-M-Y-T-H'], false],
      ['Speaker-N label (also what an outbound swap looks like)', E('S-M-Y-T-H', 'Smyth'), ['Speaker 1: my last name is S-M-Y-T-H'], false],
      ['bare "spelled" is not name wording', E('J-O-N-E-S', 'Jones'), ['Caller: it is spelled J O N E S'], false],
      ['bare "spell" (dry spell)', E('J-O-N-E-S', 'Jones'), ['Caller: we had a dry spell, then J-O-N-E-S'], false],
      ['no wording at all', E('J-O-N-E-S', 'Jones'), ['Caller: sure, J-O-N-E-S'], false],
      ['street name', E('P-I-N-E', 'Pine'), ['Caller: the street name is P-I-N-E'], false],
      ['company name', E('A-C-M-E', 'Acme'), ['Caller: my company name is A-C-M-E'], false],
      ['business name', E('A-C-M-E', 'Acme'), ['Caller: the business name is A-C-M-E'], false],
      ['pet name', E('R-E-X-X', 'Rexx'), ['Caller: my dog\'s pet name is R-E-X-X'], false],
      ['possessive (wife\'s name)', E('S-M-Y-T-H', 'Smyth'), ['Caller: my wife\'s last name is S-M-Y-T-H'], false],
      ['agent asked about the street, not the person', E('P-I-N-E', 'Pine'), ['Agent: what is the street name?\nCaller: P-I-N-E'], false],
      ['name wording far from the spelling in an earlier turn', E('J-O-N-E-S', 'Jones'), ['Caller: my name is Bob.\nCaller: ok? J-O-N-E-S'], false],
      ['spelling not in the transcript (ungrounded)', E('J-O-N-E-S', 'Jones'), ['Caller: my last name is S-M-I-T-H'], false],
      ['letters do not make the value', E('V-A-R-N-U-M', 'Jones'), ['Caller: my last name is V-A-R-N-U-M'], false],
      ['said, not spelled', E('Varnum', 'Varnum'), ['Caller: my last name is Varnum'], false],
      ['model says it is someone else\'s name', E('S-M-Y-T-H', 'Smyth', { whose: 'other' }), ['Caller: my last name is S-M-Y-T-H'], false],
      ['below the adopt confidence', E('S-M-Y-T-H', 'Smyth', { confidence: 0.6 }), ['Caller: my last name is S-M-Y-T-H'], false],
      ['wrong field label', E('S-M-Y-T-H', 'Smyth', { field: 'nickname' }), ['Caller: my last name is S-M-Y-T-H'], false],
    ];
    test.each(cases)('%s', (_label, entry, sources, expected) => {
      expect(Boolean(qualifyingNameEntry(entry, sources))).toBe(expected);
    });

    test('the normalized entry carries the repo casing and the same entry\'s confidence and quote', () => {
      expect(qualifyingNameEntry(E('M-C-L-O-U-G-H-L-I-N', 'MCLOUGHLIN', { confidence: 0.91 }), ['Caller: my last name is M-C-L-O-U-G-H-L-I-N']))
        .toEqual({ raw_spoken: 'M-C-L-O-U-G-H-L-I-N', spelled_value: 'McLoughlin', field: 'last_name', whose: 'caller', confidence: 0.91 });
    });

    test('one entry per field: disagreeing qualifying entries decide nothing; a non-qualifying entry never lends its context', () => {
      const src = ['Caller: my last name is V-A-R-N-U-M or maybe V-A-R-N-E-M\nCaller: sure V-A-R-N-I-M'];
      const names = sanitizeNameEntries([
        E('V-A-R-N-U-M', 'Varnum'), E('V-A-R-N-E-M', 'Varnem'), // both qualify, disagree
      ], src);
      expect(callerSpelledName({ names }, 'last_name')).toBeNull();
      // High-confidence entry WITHOUT context + low-confidence entry WITH context: neither qualifies, so nothing combines.
      const split = sanitizeNameEntries([
        E('V-A-R-N-I-M', 'Varnim', { confidence: 0.95 }),
        E('V-A-R-N-U-M', 'Varnum', { confidence: 0.5 }),
      ], src);
      expect(callerSpelledName({ names: split }, 'last_name')).toBeNull();
      // A single qualifying entry wins, with its OWN confidence and quote.
      const one = sanitizeNameEntries([E('V-A-R-N-U-M', 'Varnum', { confidence: 0.88 }), E('V-A-R-N-I-M', 'Varnim', { confidence: 0.99 })], src);
      expect(callerSpelledName({ names: one }, 'last_name')).toEqual({ value: 'Varnum', confidence: 0.88, quote: 'V-A-R-N-U-M' });
    });

    test('an empty or near-match name is NOT changed from a spelling with no qualifying context (J-O-N-E-S email case)', () => {
      const names = sanitizeNameEntries([E('J-O-N-E-S', 'Jones')], ['Caller: my email is J-O-N-E-S at example dot com']);
      const d = { emails: [], addresses: [], names };
      expect(applyNameDictationPolicy({ current: { first_name: 'Quentrell', last_name: null }, dictation: d })).toEqual({});
      expect(applyNameDictationPolicy({ current: { last_name: 'Jonas' }, dictation: d })).toEqual({});
      expect(spelledNameDecision({ current: { last_name: 'Jonas' }, dictation: d })).toEqual({});
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
      dictation: dictation(entry({ spelled_value: 'Varnum' }), entry({ spelled_value: 'Varnem' })),
    })).toEqual({});
    // A spelling labeled "other" for the same field is a different person, not a disagreement.
    expect(applyNameDictationPolicy({
      current: { last_name: 'Varnim' },
      dictation: dictation(entry({ spelled_value: 'Varnum' }), entry({ spelled_value: 'Thornquist', whose: 'other' })),
    })).toEqual({ last_name: 'Varnum' });
  });

  test('callerSpelledName carries the decoder confidence and quote', () => {
    const d = dictation(entry({ spelled_value: 'Varnum', confidence: 0.91 }));
    expect(callerSpelledName(d, 'last_name')).toMatchObject({ value: 'Varnum', confidence: 0.91, quote: expect.stringContaining('V-A-R-N-U-M') });
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

describe('callerNameForWrites — one resolved name for everything after the create sites', () => {
  const extracted = { first_name: 'Quentrell', last_name: 'Varnim' };
  const overrides = { last_name: { value: 'Varnum', confidence: 0.95, quote: 'V-A-R-N-U-M' } };

  test('a customer this pass created gets the spelled name (enrollment, greeting, alerts)', () => {
    expect(callerNameForWrites({ extracted, overrides, createdByThisPass: true, hasCustomer: true }))
      .toEqual({ first_name: 'Quentrell', last_name: 'Varnum' });
  });
  test('a lead-only caller (no customer) gets the spelled name', () => {
    expect(callerNameForWrites({ extracted, overrides, createdByThisPass: false, hasCustomer: false }).last_name).toBe('Varnum');
  });
  test('an existing linked customer is untouched', () => {
    expect(callerNameForWrites({ extracted, overrides, createdByThisPass: false, hasCustomer: true }))
      .toEqual({ first_name: 'Quentrell', last_name: 'Varnim' });
  });
  test('no decision: the extracted name', () => {
    expect(callerNameForWrites({ extracted, overrides: {}, createdByThisPass: true, hasCustomer: true })).toEqual(extracted);
  });
});

describe('processor wiring — downstream consumers read the resolved name', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../services/call-recording-processor.js'), 'utf8');
  test('the resolved name is computed once, right after the customer-create block, and before every downstream consumer', () => {
    const at = src.indexOf('callerNameForWrites({\n        extracted,');
    expect(at).toBeGreaterThan(0);
    const block = src.slice(at, at + 700);
    expect(block).toMatch(/overrides: spelledNameOverrides,/);
    expect(block).toMatch(/createdByThisPass: createdCustomerFromCall,/);
    expect(block).toMatch(/hasCustomer: Boolean\(customerId\),/);
    expect(block).toMatch(/extracted = \{ \.\.\.extracted, \.\.\.resolvedName \};/);
    // Consumers swept: each reads extracted names AFTER the resolved-name block.
    const after = (needle) => src.indexOf(needle, at);
    for (const needle of [
      "const [newLead] = await db('leads').insert({",                 // new lead
      'firstName: custRow.first_name || (extracted.first_name',      // booking SMS first name
      'AutomationRunner.enrollCustomer(',                            // automation enrollment
      'first_name: capitalizeName(extracted.first_name),',           // enrollment payload
      "const callerName = [capitalizeName(extracted.first_name)",    // lead alert / summary text
    ]) {
      expect(after(needle)).toBeGreaterThan(at);
    }
  });
});

