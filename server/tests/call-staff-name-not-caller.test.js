/**
 * A staff member's first name must not be saved as the caller's name.
 * 2026-10-12 call audit: the speaker-label pass swapped the greeting lines of two calls
 * (a staff self-introduction was labelled Caller) and the extraction saved the caller under the staff name,
 * with a missing_last_name card each. The guard reads the words, never the speaker labels.
 */
const { staffNameSavedAsCaller } = require('../services/call-triage-flags');
const { _test } = require('../services/call-recording-processor');

const { answeringStaffName, callerNameIsStaffName, clearV2CallerFirstName, v2CallerNameParts } = _test;

// Synthetic names only (AGENTS.md): "Riley" is the staff member, "Morgan" the customer.
const base = { firstName: 'Riley', lastName: null, staffName: 'Riley' };

describe('staffNameSavedAsCaller', () => {
  test('staff self-introduction labelled as the caller', () => {
    expect(staffNameSavedAsCaller({
      ...base,
      transcript: "Caller: Hey Morgan, it's Riley.\nAgent: Hey bud.\nCaller: Hey, are you coming here today?",
    })).toBe(true);
  });

  test('the caller greets the staff member by name and never names themselves', () => {
    expect(staffNameSavedAsCaller({
      ...base, firstName: 'riley', lastName: '',
      transcript: 'Agent: Waves Pest Control.\nCaller: Hey Riley, are you coming today?',
    })).toBe(true);
  });

  test('a caller with the same first name who introduces themselves keeps the name', () => {
    // Staff greets the caller back by the shared name: the self-introduction wins.
    expect(staffNameSavedAsCaller({
      ...base,
      transcript: 'Agent: Waves Pest Control.\nCaller: Hi, this is Riley, I need a quote.\nAgent: Hi Riley, what is the address?',
    })).toBe(false);
    expect(staffNameSavedAsCaller({
      ...base,
      transcript: 'Agent: Waves Pest Control.\nCaller: Yes, my name is Riley.',
    })).toBe(false);
  });

  test('a filler word after the greeting is not another name', () => {
    // An unlinked caller who shares the staff first name and says "Hi there, it is Riley".
    expect(staffNameSavedAsCaller({ ...base, transcript: 'Agent: Waves Pest Control.\nCaller: Hi there, it is Riley.' })).toBe(false);
    expect(staffNameSavedAsCaller({ ...base, transcript: "Caller: Hey guys, it's Riley." })).toBe(false);
  });

  test('a caller who gives a last name keeps the name', () => {
    expect(staffNameSavedAsCaller({
      ...base, lastName: 'Example',
      transcript: 'Agent: Waves Pest Control.\nCaller: Hey Riley.',
    })).toBe(false);
  });

  test('a name that is not the answering staff member is never touched', () => {
    expect(staffNameSavedAsCaller({ ...base, firstName: 'Morgan', transcript: "Agent: Hey Morgan, it's Riley." })).toBe(false);
    expect(staffNameSavedAsCaller({ ...base, staffName: null, transcript: 'Caller: Hey Riley.' })).toBe(false);
  });

  test('a role label from the staff number map is not a name', () => {
    expect(staffNameSavedAsCaller({ firstName: 'Waves', lastName: null, staffName: 'Waves', transcript: 'Caller: Hi Waves.' })).toBe(false);
  });
});

describe('answeringStaffName', () => {
  test('inbound: the person who answered; outbound: nobody (the placing person is not recorded)', () => {
    const metadata = { forward_acceptance: { csr_name: 'Riley' } };
    expect(answeringStaffName({ direction: 'inbound', metadata })).toBe('Riley');
    expect(answeringStaffName({ direction: 'inbound', metadata: JSON.stringify(metadata) })).toBe('Riley');
    expect(answeringStaffName({ direction: 'inbound', metadata: {} })).toBeNull();
    expect(answeringStaffName({ direction: 'outbound-api', metadata })).toBeNull();
  });
});

describe('callerNameIsStaffName', () => {
  const transcript = 'Agent: Waves Pest Control.\nCaller: Hey Riley, are you coming today?';
  const extracted = { first_name: 'Riley', last_name: null };
  const inbound = { direction: 'inbound', metadata: { forward_acceptance: { csr_name: 'Riley' } } };
  const connFor = (row, fail = false) => () => ({ where: () => ({ first: async () => { if (fail) throw new Error('db'); return row; } }) });

  test('an unlinked call drops the staff name on the words alone', async () => {
    await expect(callerNameIsStaffName(connFor(null), { call: inbound, extracted, transcript })).resolves.toBe(true);
  });

  test('a linked customer with a different first name drops it; the same first name keeps it', async () => {
    const call = { ...inbound, customer_id: 'c1' };
    await expect(callerNameIsStaffName(connFor({ first_name: 'Morgan' }), { call, extracted, transcript })).resolves.toBe(true);
    await expect(callerNameIsStaffName(connFor({ first_name: 'riley' }), { call, extracted, transcript })).resolves.toBe(false);
  });

  test('a failed customer read keeps the name; an outbound call is never judged', async () => {
    await expect(callerNameIsStaffName(connFor(null, true), { call: { ...inbound, customer_id: 'c1' }, extracted, transcript })).resolves.toBe(false);
    await expect(callerNameIsStaffName(connFor(null), { call: { ...inbound, direction: 'outbound-api' }, extracted, transcript })).resolves.toBe(false);
  });
});

describe('clearV2CallerFirstName', () => {
  test('drops the first name and a name_full that is only that name', () => {
    const v2 = { status: 'valid', extraction: { caller: { first_name: 'Riley', name_full: 'Riley' } } };
    clearV2CallerFirstName(v2);
    expect(v2.extraction.caller).toEqual({ first_name: null, name_full: null });
  });

  test('a V2 record that carries only a one-word name_full is read and cleared too', () => {
    expect(v2CallerNameParts({ name_full: 'Riley', first_name: null, last_name: null })).toEqual({ first_name: 'Riley', last_name: null });
    // A full name is not a first name: nothing to judge.
    expect(v2CallerNameParts({ name_full: 'Riley Example' })).toEqual({ first_name: null, last_name: null });
    const v2 = { status: 'valid', extraction: { caller: { first_name: null, name_full: 'Riley' } } };
    clearV2CallerFirstName(v2);
    expect(v2.extraction.caller).toEqual({ first_name: null, name_full: null });
  });

  test('tolerates a missing result', () => {
    expect(() => clearV2CallerFirstName(null)).not.toThrow();
  });
});

describe('the stored V2 record', () => {
  test('the V2 guard runs before ai_extraction_enriched is serialized', () => {
    // The enriched blob is written once, right after the V2 pass; a guard after that write
    // would leave the staff name in the stored record that call-intelligence displays.
    const src = require('fs').readFileSync(require.resolve('../services/call-recording-processor'), 'utf8');
    const guard = src.indexOf('staff-name guard (V2) skipped');
    const store = src.indexOf('ai_extraction_enriched: v2Result.extraction ? JSON.stringify(v2Result.extraction) : null');
    expect(guard).toBeGreaterThan(-1);
    expect(store).toBeGreaterThan(guard);
  });
});
