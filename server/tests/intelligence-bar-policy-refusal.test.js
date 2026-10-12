'use strict';

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { isToolFailure, isPolicyRefusal, recordToolOutcome } = require('../services/intelligence-bar/outcomes');
const { CircuitBreaker } = require('../services/intelligence-bar/circuit-breaker');

const REFUSAL_CODES = [
  'target_clarification_required', 'customer_scope_required', 'permission_denied', 'capability_unimplemented',
  'capability_not_loaded', 'dependency_unresolved', 'approval_required', 'invalid_input', 'owner_direct_bulk_limit',
  'requires_existing_owner_workflow',
];

describe('isPolicyRefusal', () => {
  test.each(REFUSAL_CODES)('a failure with code %s is a refusal', (code) => {
    expect(isPolicyRefusal({ error: 'x', code })).toBe(true);
  });

  test('a business failure with any other code is a refusal too (gate off, not found, a blocked write)', () => {
    expect(isPolicyRefusal({ error: 'x', code: 'gate_off' })).toBe(true);
    expect(isPolicyRefusal({ error: 'x', code: 'charge_limit', blocked: true })).toBe(true);
    expect(isPolicyRefusal({ success: false, code: 'invoice_not_found' })).toBe(true);
  });

  test('an explicit refused or refusal marker is a refusal, with or without an error field', () => {
    expect(isPolicyRefusal({ refused: 'the receipt was sent in the meantime' })).toBe(true);
    expect(isPolicyRefusal({ refusal: { error: 'x', code: 'invalid_target' } })).toBe(true);
  });

  test('faults are not refusals: uncoded failures, interrupted writes, failed safety checks, the open circuit', () => {
    expect(isPolicyRefusal({ error: 'Database unavailable' })).toBe(false);
    expect(isPolicyRefusal({ failed: true })).toBe(false);
    expect(isPolicyRefusal({ error: 'interrupted', code: 'execution_interrupted', outcome_unknown: true })).toBe(false);
    expect(isPolicyRefusal({ error: 'x', code: 'verify_failed' })).toBe(false);
    expect(isPolicyRefusal({ error: 'circuit_open', message: 'Systems are having issues' })).toBe(false);
  });

  test('a code on a result that did not fail is not a refusal; nothing and non-objects are not either', () => {
    expect(isPolicyRefusal({ success: true, code: 'already_set' })).toBe(false);
    for (const value of [null, undefined, 'error', 42, [], {}]) expect(isPolicyRefusal(value)).toBe(false);
  });

  test('a refusal is still a tool failure for everything else (activity line, ledger, model view)', () => {
    expect(isToolFailure({ error: 'x', code: 'permission_denied' })).toBe(true);
  });
});

describe('recordToolOutcome against a real breaker', () => {
  const refusal = { error: 'x', code: 'target_clarification_required' };
  const fault = { error: 'Database unavailable' };

  test('five coded refusals never trip it', () => {
    const breaker = new CircuitBreaker('t');
    for (let i = 0; i < 5; i += 1) expect(recordToolOutcome(breaker, refusal)).toBe('refusal');
    expect(breaker.isTripped()).toBe(false);
    expect(breaker.failures).toHaveLength(0);
  });

  test('five uncoded failures trip it', () => {
    const breaker = new CircuitBreaker('t');
    for (let i = 0; i < 5; i += 1) expect(recordToolOutcome(breaker, fault)).toBe('failure');
    expect(breaker.isTripped()).toBe(true);
  });

  test('a refusal between failures neither adds to the count nor resets it', () => {
    const breaker = new CircuitBreaker('t');
    for (let i = 0; i < 4; i += 1) {
      recordToolOutcome(breaker, fault);
      recordToolOutcome(breaker, refusal);
    }
    expect(breaker.failures).toHaveLength(4);
    expect(breaker.isTripped()).toBe(false);
    recordToolOutcome(breaker, fault);
    expect(breaker.isTripped()).toBe(true);
  });

  test('a success still resets the count', () => {
    const breaker = new CircuitBreaker('t');
    for (let i = 0; i < 4; i += 1) recordToolOutcome(breaker, fault);
    expect(recordToolOutcome(breaker, { customers: [] })).toBe('success');
    expect(breaker.failures).toHaveLength(0);
  });
});
