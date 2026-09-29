import { afterEach, describe, expect, it, vi } from 'vitest';
import { confirmLeaveIfGuarded, registerLeaveGuard } from './navigation-guard';

describe('navigation-guard', () => {
  const unregisterAll = [];
  afterEach(() => {
    while (unregisterAll.length) unregisterAll.pop()();
  });

  it('proceeds with no registered guard', () => {
    expect(confirmLeaveIfGuarded()).toBe(true);
  });

  it('proceeds when the registered guard has nothing at stake', () => {
    unregisterAll.push(registerLeaveGuard(() => true));
    expect(confirmLeaveIfGuarded()).toBe(true);
  });

  it('blocks when a registered guard declines', () => {
    unregisterAll.push(registerLeaveGuard(() => false));
    expect(confirmLeaveIfGuarded()).toBe(false);
  });

  it('asks every registered guard, blocking if any one declines', () => {
    const first = vi.fn(() => true);
    const second = vi.fn(() => false);
    unregisterAll.push(registerLeaveGuard(first));
    unregisterAll.push(registerLeaveGuard(second));
    expect(confirmLeaveIfGuarded()).toBe(false);
    expect(first).toHaveBeenCalled();
    expect(second).toHaveBeenCalled();
  });

  it('stops unregistering from being asked again', () => {
    const confirmLeave = vi.fn(() => false);
    const unregister = registerLeaveGuard(confirmLeave);
    unregister();
    expect(confirmLeaveIfGuarded()).toBe(true);
    expect(confirmLeave).not.toHaveBeenCalled();
  });
});
