// The review bell's Save to profile / One visit only buttons (owner 2026-11-02 "C"): what Save would write for
// each held-back fact, and when it refuses. The tap itself (lock, shared writer, audit, fenced close) runs on
// PostgreSQL in sms-operations-postgres.test.js.
const { buttonViolations } = require('../services/admin-alert-compose');
const { textNoteButtons, _private: { planSave } } = require('../services/sms-text-note-buttons');

const SOURCE_AT = '2040-03-10T15:00:00Z'; // 11:00 AM ET on Mar 10
const source = (facts) => ({ id: 's1', customer_id: 'c1', created_at: SOURCE_AT, operational_analysis: { facts } });
const meta = (fields) => ({ customerId: 'c1', sms_log_id: 's1', fields });
const held = (extra) => ({ field: 'special_instructions', value: 'Skip the shed please', outcome: 'temporary_instruction',
  duration: 'uncertain', property_id: 'p1', ...extra });
const plan = (facts, prefs = {}, properties = ['p1']) => planSave({
  meta: meta([...new Set(facts.map((f) => f.field))]), source: source(facts), prefs, properties });
const writes = (result) => (result.writes || []).map((w) => [w.field, w.value]);

describe('text-note bell buttons (owner 2026-11-02 "C")', () => {
  test('the stored buttons pass the admin-alert button rules', () => {
    expect(buttonViolations(textNoteButtons())).toEqual([]);
    expect(textNoteButtons().items.map((i) => i.label)).toEqual(['Save to profile', 'One visit only']);
  });

  test('a long-text note gets the text as a dated line under what is on file, or alone in an empty field', () => {
    expect(writes(plan([held()], { special_instructions: 'Text me first ' })))
      .toEqual([['special_instructions', 'Text me first\n[text 2040-03-10] Skip the shed please']]);
    expect(writes(plan([held({ field: 'pet_details' })], { pet_details: null })))
      .toEqual([['pet_details', '[text 2040-03-10] Skip the shed please']]);
  });

  test('a note the profile already holds as a whole line writes nothing; a line that only contains it is not a match', () => {
    expect(plan([held()], { special_instructions: 'Text me first\n[text 2040-03-01] Skip the shed please' })).toEqual({ writes: [] });
    expect(plan([held()], { special_instructions: 'skip the shed please.' })).toEqual({ writes: [] });
    // Pre-push P1: the opposite instruction contains the new one; it is still saved.
    expect(writes(plan([held({ value: 'Skip the shed' })], { special_instructions: 'Do not skip the shed' })))
      .toEqual([['special_instructions', 'Do not skip the shed\n[text 2040-03-10] Skip the shed']]);
    // A text written over two lines is saved as one, so the next Save finds it.
    expect(writes(plan([held({ value: 'Skip the\nshed please' })]))).toEqual([['special_instructions', '[text 2040-03-10] Skip the shed please']]);
  });

  test('a code fills only an empty field: the same code writes nothing, a different one refuses', () => {
    const code = held({ field: 'lockbox_code', value: '#4567' });
    expect(writes(plan([code], { lockbox_code: '' }))).toEqual([['lockbox_code', '#4567']]);
    expect(plan([code], { lockbox_code: '#4567' })).toEqual({ writes: [] });
    expect(plan([code], { lockbox_code: '#0123' })).toEqual({ refusal: 'on_file', field: 'lockbox_code' });
    expect(plan([held({ field: 'contact_preference', value: 'call' })], { contact_preference: 'text' }))
      .toEqual({ refusal: 'on_file', field: 'contact_preference' });
  });

  test.each(['conflicting_facts', 'mixed_topics', 'value_too_long', 'changed_during_extraction'])(
    'a fact the reader could not pin down (%s) is left for the profile', (outcome) => {
      expect(plan([held({ outcome })])).toEqual({ refusal: 'open_profile' });
    });

  test('a "no" or "not sure" pet or irrigation report held for a person is left for the profile (pre-push P1)', () => {
    // Saving "We no longer have sprinklers" would also turn irrigation_system on (applyPropertyPreferenceValue).
    expect(plan([held({ field: 'irrigation_issues', value: 'We no longer have sprinklers', outcome: 'irrigation_needs_review' })]))
      .toEqual({ refusal: 'open_profile' });
    expect(plan([held({ field: 'pet_details', value: 'Not sure the dog is still here', outcome: 'pet_needs_review' })]))
      .toEqual({ refusal: 'open_profile' });
  });

  test('Save needs the customer\'s one active property, whatever the outcome; a note naming another property is left', () => {
    const loose = held({ outcome: 'property_ambiguous', property_id: null });
    expect(writes(plan([loose], {}, ['p1']))).toHaveLength(1);
    expect(writes(plan([held()], {}, ['p1']))).toHaveLength(1);
    expect(plan([loose], {}, ['p1', 'p2'])).toEqual({ refusal: 'property' });
    // Pre-push P1: a fact with no property, whatever its outcome, on a two-property customer, is not saved either.
    expect(plan([held({ field: 'pet_details', property_id: null })], {}, ['p1', 'p2'])).toEqual({ refusal: 'property' });
    expect(plan([held({ property_id: 'p9' })], {}, ['p1'])).toEqual({ refusal: 'property' });
    expect(plan([held()], {}, [])).toEqual({ refusal: 'property' });
  });

  test('only the held-back facts in the fields the bell names are saved', () => {
    const facts = [held(), held({ field: 'parking_notes', outcome: 'applied' }),
      held({ field: 'access_notes', outcome: 'temporary_instruction' }), held({ field: 'irrigation_issues' })];
    const result = planSave({ meta: meta(['special_instructions', 'parking_notes', 'access_notes']), source: source(facts), prefs: {}, properties: ['p1'] });
    expect(writes(result).map(([field]) => field)).toEqual(['special_instructions']);
  });

  test('a replay\'s facts are the ones its bell rang for', () => {
    const replayed = { ...source([held({ field: 'pet_details' })]),
      operational_analysis: { facts: [held({ field: 'pet_details', outcome: 'applied' })], replay: { facts: [held({ field: 'pet_details' })] } } };
    expect(writes(planSave({ meta: meta(['pet_details']), source: replayed, prefs: {}, properties: ['p1'] })).map(([f]) => f)).toEqual(['pet_details']);
  });

  test('a value the field cannot take refuses; a missing source text or fact is not saved', () => {
    expect(plan([held({ field: 'lockbox_code', value: 'x'.repeat(101) })])).toEqual({ refusal: 'invalid', field: 'lockbox_code' });
    expect(plan([held({ field: 'contact_preference', value: 'pigeon' })])).toEqual({ refusal: 'invalid', field: 'contact_preference' });
    expect(planSave({ meta: meta(['special_instructions']), source: null, prefs: {}, properties: ['p1'] })).toEqual({ refusal: 'gone' });
    expect(planSave({ meta: meta(['special_instructions']), source: source([]), prefs: {}, properties: ['p1'] })).toEqual({ refusal: 'nothing_to_save' });
  });
});
