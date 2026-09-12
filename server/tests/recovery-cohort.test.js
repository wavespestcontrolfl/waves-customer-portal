/**
 * Which calls' recovery evidence counts as current. The rule has been wrong in
 * BOTH directions on PR #4437 — first too strict (a resolved historical card
 * disqualified a call forever), then too permissive (any card matching the
 * current version admitted the call, so a model rollback could admit one whose
 * latest attempt ran elsewhere) — so both directions are pinned here.
 */

const { classifyRecoveryCohort } = require('../services/address-validation/recovery-cohort');

const CURRENT = 'recovery-r2-ordinal@gemini-2.5-pro';
const OLD = 'recovery-r1@gemini-2.5-pro';
const OTHER_MODEL = 'recovery-r2-ordinal@gemini-9.9-experimental';

const card = (call_log_id, payload, { status = 'open', updated_at = '2026-09-12T00:00:00Z' } = {}) => ({
  call_log_id, payload, status, updated_at, created_at: updated_at,
});
const attempt = (version, extra = {}) => ({ recovery_prompt_version: version, address_candidates: ['x'], ...extra });

describe('classifyRecoveryCohort', () => {
  test('a current attempt is kept', () => {
    const out = classifyRecoveryCohort([card('c1', attempt(CURRENT))], CURRENT);

    expect([...out.stale, ...out.unattributable]).toEqual([]);
  });

  test('an attempt from another prompt or model is dropped as stale', () => {
    expect([...classifyRecoveryCohort([card('c1', attempt(OLD))], CURRENT).stale]).toEqual(['c1']);
    expect([...classifyRecoveryCohort([card('c2', attempt(OTHER_MODEL))], CURRENT).stale]).toEqual(['c2']);
  });

  test('a pre-stamp attempt is dropped as unattributable', () => {
    const out = classifyRecoveryCohort([card('c1', { address_candidates: ['x'] })], CURRENT);

    expect([...out.unattributable]).toEqual(['c1']);
    expect([...out.stale]).toEqual([]);
  });

  test('a card with no recovery evidence is not an attempt and never drops the call', () => {
    const out = classifyRecoveryCohort([card('c1', { flag: 'address_unverified' })], CURRENT);

    expect([...out.stale, ...out.unattributable]).toEqual([]);
  });

  // Direction 1 (r4 P1): reprocessed under the current contract, old card kept.
  test('an active current card outranks a resolved historical one', () => {
    const out = classifyRecoveryCohort([
      card('c1', attempt(OLD), { status: 'resolved', updated_at: '2026-09-01T00:00:00Z' }),
      card('c1', attempt(CURRENT), { status: 'open', updated_at: '2026-09-12T00:00:00Z' }),
    ], CURRENT);

    expect([...out.stale, ...out.unattributable]).toEqual([]);
  });

  // Direction 2 (r6 pre-push P1): after a model rollback a resolved card can
  // match the current version again while the LATEST attempt ran elsewhere.
  test('a resolved card matching the current version does NOT rescue a stale active one', () => {
    const out = classifyRecoveryCohort([
      card('c1', attempt(CURRENT), { status: 'resolved', updated_at: '2026-09-01T00:00:00Z' }),
      card('c1', attempt(OTHER_MODEL), { status: 'open', updated_at: '2026-09-12T00:00:00Z' }),
    ], CURRENT);

    expect([...out.stale]).toEqual(['c1']);
  });

  test('among cards of equal activity the most recently updated wins', () => {
    const out = classifyRecoveryCohort([
      card('c1', attempt(CURRENT), { status: 'resolved', updated_at: '2026-09-12T00:00:00Z' }),
      card('c1', attempt(OLD), { status: 'resolved', updated_at: '2026-09-01T00:00:00Z' }),
    ], CURRENT);

    expect([...out.stale, ...out.unattributable]).toEqual([]);
  });

  // A superseded card describes a pass that is gone.
  test('a superseded card neither attributes nor disqualifies', () => {
    const supersededOnly = classifyRecoveryCohort(
      [card('c1', { ...attempt(OLD), recovery_superseded_at: '2026-09-12T01:00:00Z' })], CURRENT,
    );
    expect([...supersededOnly.stale, ...supersededOnly.unattributable]).toEqual([]);

    // ...and it cannot outvote the live attempt either.
    const beside = classifyRecoveryCohort([
      card('c1', { ...attempt(CURRENT), recovery_superseded_at: '2026-09-12T02:00:00Z' }, { updated_at: '2026-09-12T02:00:00Z' }),
      card('c1', attempt(OTHER_MODEL), { updated_at: '2026-09-12T01:00:00Z' }),
    ], CURRENT);
    expect([...beside.stale]).toEqual(['c1']);
  });

  // Failed recovery under an old version, then a later pass that validates
  // directly: the processor retires the stale evidence with the same
  // recovery_superseded_at marker, so the freshly processed call is admitted
  // rather than excluded for a recovery that no longer runs (pre-push P1).
  test('retired failed-attempt evidence stops excluding the call', () => {
    const stillStale = classifyRecoveryCohort([card('c1', attempt(OLD))], CURRENT);
    expect([...stillStale.stale]).toEqual(['c1']);

    const retired = classifyRecoveryCohort(
      [card('c1', { address_candidates: ['x'], recovery_superseded_at: '2026-09-12T03:00:00Z' })], CURRENT,
    );
    expect([...retired.stale, ...retired.unattributable]).toEqual([]);
  });

  test('a malformed payload fails to prove its pass instead of throwing', () => {
    const parse = (v) => JSON.parse(v);
    expect(() => classifyRecoveryCohort([card('c1', 'not json')], CURRENT, parse)).not.toThrow();
    expect(classifyRecoveryCohort([card('c1', JSON.stringify(attempt(OLD)))], CURRENT, parse).stale.has('c1')).toBe(true);
  });

  test('no cards, or junk input, classify nothing', () => {
    expect(classifyRecoveryCohort([], CURRENT).stale.size).toBe(0);
    expect(classifyRecoveryCohort(null, CURRENT).unattributable.size).toBe(0);
  });
});
