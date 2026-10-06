/**
 * Spoken caller-data guard (audit 2026-10-05): spelled names win, impossible
 * NANP phones are never saved, and "you can't text this one" reaches the
 * existing callback_number_needed hold. Synthetic names and 555-01xx style
 * numbers only.
 */
const {
  applyCallerDataGuards,
  decideOnFileNameCorrection,
  detectTextRefusalQuote,
  findSpelledNameRuns,
} = require('../services/call-spoken-data-guard');
const { isImpossibleNanpPhone } = require('../utils/phone');
const {
  computeDeterministicTriageFlags,
  callerIdDisclaimedNeedsCallback,
  callbackNumberNeededBlocksSms,
  isDialablePhone,
} = require('../services/call-triage-flags');
const { sameSpokenFirstName } = require('../utils/name-match');
const processor = require('../services/call-recording-processor');

const ANI = '+19415550100';

const v2 = (caller = {}, over = {}) => ({
  meta: { schema_version: '1.22.0', is_voicemail: false, is_spam: false, call_summary: 's' },
  caller: { relationship_to_property: 'owner', on_site_authorization: true, phone_source: 'caller_id', ...caller },
  property: { service_address: {} },
  scheduling: { status: 'confirmed', confirmed_start_at: '2026-09-11T10:00:00-04:00' },
  confidence: { overall: 0.9 },
  consent: {},
  triage_flags: [],
  ...over,
});

describe('isImpossibleNanpPhone', () => {
  test('area or exchange code starting 0 or 1 is impossible', () => {
    expect(isImpossibleNanpPhone('+11733038616')).toBe(true);
    expect(isImpossibleNanpPhone('173-303-8616')).toBe(true);
    expect(isImpossibleNanpPhone('(941) 155-0123')).toBe(true);
    expect(isImpossibleNanpPhone('+19410550123')).toBe(true);
    expect(isImpossibleNanpPhone('1 073 555 0123')).toBe(true);
  });

  test('real NANP numbers, international numbers and fragments are not flagged', () => {
    expect(isImpossibleNanpPhone('+19415550123')).toBe(false);
    expect(isImpossibleNanpPhone('941-555-0123')).toBe(false);
    expect(isImpossibleNanpPhone('+442079460958')).toBe(false);
    expect(isImpossibleNanpPhone('555-0123')).toBe(false);
    expect(isImpossibleNanpPhone('anonymous')).toBe(false);
    expect(isImpossibleNanpPhone(null)).toBe(false);
  });
});

describe('impossible phones never reach a contact number', () => {
  test('isDialablePhone refuses an impossible number', () => {
    expect(isDialablePhone('+11733038616')).toBe(false);
    expect(isDialablePhone('+19415550123')).toBe(true);
  });

  test('isUsableContactPhone / resolveCallContactPhone fall back to the ANI', () => {
    expect(processor._test.isUsableContactPhone('+11733038616')).toBe(false);
    expect(processor._test.isUsableContactPhone('+19415550123')).toBe(true);
    expect(processor.resolveCallContactPhone({ direction: 'inbound', from_phone: ANI, to_phone: '+19415550199' }, '+11733038616')).toBe(ANI);
  });

  test('a spoken impossible phone with no usable ANI files caller_phone_missing (a person asks again)', () => {
    const flags = computeDeterministicTriageFlags(v2({ phone_e164: '+11733038616', phone_source: 'spoken' }), { contactPhone: null });
    expect(flags).toContain('caller_phone_missing');
    const ok = computeDeterministicTriageFlags(v2({ phone_e164: '+19415550123', phone_source: 'spoken' }), { contactPhone: null });
    expect(ok).not.toContain('caller_phone_missing');
  });

  test('a disclaimed caller whose only spoken number is impossible still needs a callback', () => {
    expect(callerIdDisclaimedNeedsCallback(
      { caller_id_disclaimed: true, phone_source: 'spoken', phone_e164: '+11733038616' },
      { ani: ANI },
    )).toBe(true);
    expect(callerIdDisclaimedNeedsCallback(
      { caller_id_disclaimed: true, phone_source: 'spoken', phone_e164: '+19415557781' },
      { ani: ANI },
    )).toBe(false);
  });

  test('the guard nulls an impossible secondary phone in the V1 view and in V2, keeps a real one', () => {
    const extracted = {
      first_name: 'Joyce',
      last_name: null,
      secondary_contact: { first_name: 'Quentrell', last_name: 'Varnum', phone: '+11733038616', email: null },
    };
    const v2Extraction = v2({}, {
      secondary_contact: { first_name: 'Quentrell', last_name: 'Varnum', phone_e164: '+11733038616' },
      secondary_contacts: [
        { first_name: 'Quentrell', last_name: 'Varnum', phone_e164: '+11733038616' },
        { first_name: 'Lorna', last_name: 'Varnum', phone_e164: '+19415550123' },
      ],
    });
    const result = applyCallerDataGuards({ extracted, v2Extraction, transcripts: [] });
    expect(extracted.secondary_contact.phone).toBeNull();
    expect(v2Extraction.secondary_contact.phone_e164).toBeNull();
    expect(v2Extraction.secondary_contacts[0].phone_e164).toBeNull();
    expect(v2Extraction.secondary_contacts[1].phone_e164).toBe('+19415550123');
    expect(result.rejectedSecondaryPhones).toBe(3);
    expect(extracted.secondary_contact.first_name).toBe('Quentrell');
  });

  test('an impossible CALLER phone is nulled and the V2 source stops claiming "spoken"', () => {
    const extracted = { first_name: 'Joyce', phone: '+11733038616' };
    const v2Extraction = v2({ phone_e164: '+11733038616', phone_source: 'spoken' });
    const result = applyCallerDataGuards({ extracted, v2Extraction, transcripts: [] });
    expect(extracted.phone).toBeNull();
    expect(v2Extraction.caller.phone_e164).toBeNull();
    expect(v2Extraction.caller.phone_source).toBe('unknown');
    expect(result.rejectedCallerPhone).toBe(true);
  });
});

describe('spelled names win', () => {
  const wrap = (lines) => lines.join('\n\n');

  test('findSpelledNameRuns reads hyphen, spaced-capital and phonetic spelling from the caller only', () => {
    const t = wrap([
      'Agent: What is your last name?',
      'Caller: It is V-A-R-N-U-M, and the first is Q U E N T R E L L.',
      'Agent: So that is X-Y-Z-Z-Y?',
      'Caller: And the code word is Z as in zebra, Y as in yellow, X as in xylophone, W as in whiskey.',
    ]);
    expect(findSpelledNameRuns([t]).map((r) => r.letters)).toEqual(['varnum', 'quentrell', 'zyxw']);
  });

  test('prose with stray single letters is not a spelled run', () => {
    expect(findSpelledNameRuns(['Caller: I need a quote for A pest plan, I think I can do it.'])).toEqual([]);
  });

  test('a spelled surname replaces the heard near-spelling in V1 and V2, and fixes name_full', () => {
    const t = wrap(['Agent: Last name?', 'Caller: It is Varnom, V-A-R-N-U-M.']);
    const extracted = { first_name: 'Quentrell', last_name: 'Varnom', name_full: 'Quentrell Varnom' };
    const v2Extraction = v2({ first_name: 'Quentrell', last_name: 'Varnom', name_full: 'Quentrell Varnom' });
    const result = applyCallerDataGuards({ extracted, v2Extraction, transcripts: [t] });
    expect(extracted.last_name).toBe('Varnum');
    expect(extracted.name_full).toBe('Quentrell Varnum');
    expect(v2Extraction.caller.last_name).toBe('Varnum');
    expect(v2Extraction.caller.name_full).toBe('Quentrell Varnum');
    expect(result.spelledNameFields).toEqual({ first_name: false, last_name: true });
  });

  test('the spelled name beats a name the model took from the record on file', () => {
    // Extraction kept the on-file spelling although the caller spelled another.
    const t = 'Caller: It is Hallbrook. H-O-L-B-R-O-O-K.';
    const extracted = { first_name: 'Isaac', last_name: 'Hallbrook' };
    const { spelledNameFields } = applyCallerDataGuards({ extracted, v2Extraction: null, transcripts: [t] });
    expect(extracted.last_name).toBe('Holbrook');
    expect(spelledNameFields.last_name).toBe(true);
  });

  test('Mc names keep their capital letters', () => {
    const t = 'Caller: McGlaughlin, M-C-G-L-O-U-G-H-L-I-N.';
    const extracted = { first_name: 'Carol', last_name: 'McGlaughlin' };
    applyCallerDataGuards({ extracted, transcripts: [t] });
    expect(extracted.last_name).toBe('McGloughlin');
  });

  test('a spelled run that equals the heard name changes nothing and marks it spelled', () => {
    const t = 'Caller: Natasha, N-A-T-A-S-H-A, Serov, S-E-R-O-V.';
    const extracted = { first_name: 'Natasha', last_name: 'Serov' };
    const result = applyCallerDataGuards({ extracted, transcripts: [t] });
    expect(extracted).toMatchObject({ first_name: 'Natasha', last_name: 'Serov' });
    expect(result.spelledNameFields).toEqual({ first_name: true, last_name: true });
    expect(result.changes).toEqual([]);
  });

  test('first and last are matched to their own runs, not swapped', () => {
    const t = 'Caller: Natasha, N-A-T-A-S-H-A, Sirov, S-E-R-O-V.';
    const extracted = { first_name: 'Natasha', last_name: 'Sirov' };
    applyCallerDataGuards({ extracted, transcripts: [t] });
    expect(extracted).toMatchObject({ first_name: 'Natasha', last_name: 'Serov' });
  });

  test('a spelled email local part never rewrites a name', () => {
    const t = 'Caller: My email is S-H-E-V-E-R, 238 at gmail dot com.';
    const extracted = { first_name: 'Nat', last_name: 'Shiver' };
    applyCallerDataGuards({ extracted, transcripts: [t] });
    expect(extracted.last_name).toBe('Shiver');
  });

  test('a spelled street name never rewrites a name', () => {
    const t = 'Caller: The street is B-R-A-N-T-W-O-O-D and I am Brantley.';
    const extracted = { first_name: 'Dana', last_name: 'Brantley' };
    applyCallerDataGuards({ extracted, transcripts: [t] });
    expect(extracted.last_name).toBe('Brantley');
  });

  test('staff read-backs are ignored', () => {
    const t = wrap(['Agent: So that is H-O-L-B-R-O-O-K?', 'Caller: Yes.']);
    const extracted = { first_name: 'Isaac', last_name: 'Hallbrook' };
    applyCallerDataGuards({ extracted, transcripts: [t] });
    expect(extracted.last_name).toBe('Hallbrook');
  });

  test('a run that is far from every extracted name is ignored (no invention)', () => {
    const t = 'Caller: The code is B-L-U-E-F-I-S-H.';
    const extracted = { first_name: 'Dana', last_name: 'Brantley' };
    const result = applyCallerDataGuards({ extracted, transcripts: [t] });
    expect(extracted).toMatchObject({ first_name: 'Dana', last_name: 'Brantley' });
    expect(result.changes).toEqual([]);
  });

  test('a spelled secondary-contact name is applied to that person', () => {
    const t = 'Caller: His name is Lorn, L-O-R-N-E, and his last name is Varnum, V-A-R-N-U-M.';
    const extracted = { first_name: 'Joyce', last_name: null, secondary_contact: { first_name: 'Lorne', last_name: 'Varnim' } };
    applyCallerDataGuards({ extracted, transcripts: [t] });
    expect(extracted.secondary_contact.last_name).toBe('Varnum');
    expect(extracted.secondary_contact.first_name).toBe('Lorne');
  });
});

describe('a surname glued to "over at" is split', () => {
  const t = 'Caller: Hi, this is Sally Hartwellover at 12 Palm Court with John.';

  test('splits the stem off in V1, V2 and name_full', () => {
    const extracted = { first_name: 'Sally', last_name: 'Hartwellover', name_full: 'Sally Hartwellover' };
    const v2Extraction = v2({ first_name: 'Sally', last_name: 'Hartwellover', name_full: 'Sally Hartwellover' });
    applyCallerDataGuards({ extracted, v2Extraction, transcripts: [t] });
    expect(extracted.last_name).toBe('Hartwell');
    expect(extracted.name_full).toBe('Sally Hartwell');
    expect(v2Extraction.caller.last_name).toBe('Hartwell');
  });

  test('real "-over" surnames and unrelated usage stay', () => {
    for (const last of ['Hanover', 'Glover', 'Hoover', 'Vanover']) {
      const extracted = { first_name: 'Sam', last_name: last };
      applyCallerDataGuards({ extracted, transcripts: [`Caller: This is Sam ${last} at 12 Palm Court.`] });
      expect(extracted.last_name).toBe(last);
    }
    // Same token but never said right before a preposition: not a merge.
    const extracted = { first_name: 'Sally', last_name: 'Hartwellover' };
    applyCallerDataGuards({ extracted, transcripts: ['Caller: Hi, this is Sally Hartwellover.'] });
    expect(extracted.last_name).toBe('Hartwellover');
  });

  test('a spelled surname takes precedence over the split', () => {
    const extracted = { first_name: 'Sally', last_name: 'Hartwellover' };
    applyCallerDataGuards({ extracted, transcripts: ['Caller: This is Sally Hartwellover at 12 Palm Court. H-A-R-T-W-E-L-L-O-V-E-R.'] });
    expect(extracted.last_name).toBe('Hartwellover');
  });
});

describe('"you can\'t text this one" and relay callers', () => {
  test('explicit refusals are caught from the caller\'s own words', () => {
    for (const line of [
      "I have a different number that's a text number only. You can't text this one.",
      "Please don't text this number.",
      'This number cannot receive texts.',
      "This one doesn't text.",
      "You can't text my landline.",
    ]) {
      expect(detectTextRefusalQuote([`Caller: ${line}`])).toBeTruthy();
    }
  });

  test('ordinary talk about texting is not a refusal', () => {
    for (const line of [
      'Feel free to text me.',
      "I can't text while I'm driving, call me.",
      'You can text this number any time.',
      'Can you text me the quote?',
    ]) {
      expect(detectTextRefusalQuote([`Caller: ${line}`])).toBeNull();
    }
    expect(detectTextRefusalQuote(['Caller: I prefer texts only, call me never.'])).toBeNull();
    expect(detectTextRefusalQuote(["Agent: You can't text this one? Okay."])).toBeNull();
  });

  test('a video relay service call is caught, an explicit refusal is quoted over it', () => {
    const relay = 'Caller: A caller using sign language is calling you through the video relay service.';
    expect(detectTextRefusalQuote([relay])).toMatch(/video relay/i);
    const both = `${relay}\n\nCaller: You can't text this one.`;
    expect(detectTextRefusalQuote([both])).toBe("You can't text this one.");
  });

  test('the guard sets caller_id_disclaimed with the quote, and the existing hold fires', () => {
    const t = "Caller: I have a different number that's a text number only. You can't text this one.";
    const v2Extraction = v2({ phone_e164: null, phone_source: 'caller_id' });
    const result = applyCallerDataGuards({ extracted: { first_name: 'Miranda' }, v2Extraction, transcripts: [t] });
    expect(v2Extraction.caller.caller_id_disclaimed).toBe(true);
    expect(v2Extraction.caller.phone_note).toMatch(/can't text this one/);
    expect(result.textRefusalQuote).toBeTruthy();
    const flags = computeDeterministicTriageFlags(v2Extraction, { contactPhone: ANI });
    expect(flags).toContain('callback_number_needed');
    expect(callbackNumberNeededBlocksSms(flags)).toBe(true);
  });

  test('a separate spoken text number replaces the ANI: no card, and the processor texts the spoken number', () => {
    const t = "Caller: You can't text this one. Text me at 941-555-7781.";
    const v2Extraction = v2({ phone_e164: '+19415557781', phone_source: 'spoken' });
    applyCallerDataGuards({ extracted: { first_name: 'Miranda', phone: '+19415557781' }, v2Extraction, transcripts: [t] });
    expect(v2Extraction.caller.caller_id_disclaimed).toBe(true);
    const flags = computeDeterministicTriageFlags(v2Extraction, { contactPhone: ANI });
    expect(flags).not.toContain('callback_number_needed');
    expect(processor.resolveCallContactPhone({ direction: 'inbound', from_phone: ANI, to_phone: '+19415550199' }, '+19415557781')).toBe('+19415557781');
  });

  test('an already-disclaimed caller keeps the model\'s own note', () => {
    const v2Extraction = v2({ caller_id_disclaimed: true, phone_note: 'office line' });
    applyCallerDataGuards({ extracted: {}, v2Extraction, transcripts: ["Caller: You can't text this one."] });
    expect(v2Extraction.caller.phone_note).toBe('office line');
  });

  test('without a V2 extraction the guard is a no-op for texting', () => {
    const result = applyCallerDataGuards({ extracted: {}, v2Extraction: null, transcripts: ["Caller: You can't text this one."] });
    expect(result.textRefusalQuote).toBeNull();
  });
});

describe('decideOnFileNameCorrection', () => {
  const spelled = { first_name: false, last_name: true };
  const same = sameSpokenFirstName;

  test('corrects a near-misspelled record when the first name agrees', () => {
    expect(decideOnFileNameCorrection({
      onFile: { first_name: 'Isaac', last_name: 'Hallbrook' },
      extracted: { first_name: 'Isaac', last_name: 'Holbrook' },
      spelledNameFields: spelled,
      sameFirst: same,
    })).toEqual({ last_name: 'Holbrook' });
  });

  test('never overwrites a wholesale different name (a spouse on a shared line)', () => {
    expect(decideOnFileNameCorrection({
      onFile: { first_name: 'Isaac', last_name: 'Smith' },
      extracted: { first_name: 'Isaac', last_name: 'Holbrook' },
      spelledNameFields: spelled,
      sameFirst: same,
    })).toBeNull();
  });

  test('never corrects when the first names disagree', () => {
    expect(decideOnFileNameCorrection({
      onFile: { first_name: 'Lorna', last_name: 'Hallbrook' },
      extracted: { first_name: 'Isaac', last_name: 'Holbrook' },
      spelledNameFields: spelled,
      sameFirst: same,
    })).toBeNull();
  });

  test('never corrects from a name that was not spelled', () => {
    expect(decideOnFileNameCorrection({
      onFile: { first_name: 'Isaac', last_name: 'Hallbrook' },
      extracted: { first_name: 'Isaac', last_name: 'Holbrook' },
      spelledNameFields: { first_name: false, last_name: false },
      sameFirst: same,
    })).toBeNull();
  });

  test('a nickname is not a misspelling: a spelled "Bob" never rewrites "Robert"', () => {
    expect(decideOnFileNameCorrection({
      onFile: { first_name: 'Robert', last_name: 'Holbrook' },
      extracted: { first_name: 'Bob', last_name: 'Holbrook' },
      spelledNameFields: { first_name: true, last_name: false },
      sameFirst: same,
    })).toBeNull();
  });
});
