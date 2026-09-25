// callback_number_needed CSR coaching rule (schema 1.14.0, live miss
// 2026-09-25, call 6fee5f34: "this is our office line... they don't pick
// up, I pick up, and then text"). The 15-point LLM rubric scores what it
// can infer from a transcript alone — it has no reliable way to know the
// extracted caller_id_disclaimed signal was ever raised, so this specific,
// checkable miss is coached deterministically instead: callbackNumberCoachingNote
// is the pure, exported decision; scoreCall appends its text to
// score.coaching_notes (verified indirectly here via the pure function,
// same pattern as csrScoringApplies). All data here is synthetic.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { callbackNumberCoachingNote, CALLBACK_NUMBER_COACHING_NOTE } = require('../services/csr/csr-coach');

describe('callbackNumberCoachingNote — deterministic CSR coaching addendum', () => {
  test('fires when caller_id_disclaimed is true and no phone_e164 was captured', () => {
    for (const phone_source of ['caller_id', 'unknown']) {
      const note = callbackNumberCoachingNote({ caller: { caller_id_disclaimed: true, phone_source, phone_e164: null } });
      expect(note).toBe(CALLBACK_NUMBER_COACHING_NOTE);
      expect(note).toBe("Caller said this number isn't theirs — ask for a cell before ending the call.");
    }
  });

  test('does not fire when a real cell was captured (phone_e164 present)', () => {
    for (const phone_source of ['spoken', 'both']) {
      expect(callbackNumberCoachingNote({ caller: { caller_id_disclaimed: true, phone_source, phone_e164: '+19415551234' } })).toBeNull();
    }
  });

  // Pre-push review P1: phone_source alone ("spoken"/"both") is the
  // model's claim, not proof — a garbled spoken number normalizes
  // phone_e164 to null. The coaching addendum must still fire in that
  // case, same as callback_number_needed.
  test('fires when phone_source claims spoken/both but phone_e164 never validated', () => {
    for (const phone_source of ['spoken', 'both']) {
      expect(callbackNumberCoachingNote({ caller: { caller_id_disclaimed: true, phone_source, phone_e164: null } })).toBe(CALLBACK_NUMBER_COACHING_NOTE);
    }
  });

  test('does not fire when caller_id_disclaimed is null, false, or absent', () => {
    expect(callbackNumberCoachingNote({ caller: { caller_id_disclaimed: null, phone_e164: null } })).toBeNull();
    expect(callbackNumberCoachingNote({ caller: { caller_id_disclaimed: false, phone_e164: null } })).toBeNull();
    expect(callbackNumberCoachingNote({ caller: { phone_e164: null } })).toBeNull();
  });

  test('handles a missing extraction or caller gracefully', () => {
    expect(callbackNumberCoachingNote(null)).toBeNull();
    expect(callbackNumberCoachingNote(undefined)).toBeNull();
    expect(callbackNumberCoachingNote({})).toBeNull();
  });
});
