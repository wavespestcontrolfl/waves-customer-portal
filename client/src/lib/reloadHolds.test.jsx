// @vitest-environment jsdom
// Work that a reload would lose holds the automatic reload of an out-of-date
// staff tab. These pin the registry rules, the hold for a send that prepares
// its data first, and the holds whose modules have no test file of their own:
// dictation still on its way, a locked visit step, and an estimate text sent
// from this tab.
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { holdReloadWhileSending, registerReloadHold, reloadHoldName, reloadHoldNames } from './reloadHolds';
import { setDictationPending } from '../hooks/dictationPending';
import TechNavigationLock, { useTechNavigationLock } from '../components/tech/TechNavigationLock';

afterEach(cleanup);

describe('reloadHolds', () => {
  it('names held work in registration order, and a check that throws counts as held', () => {
    let on = false;
    registerReloadHold('test-a', () => on);
    expect(reloadHoldName()).toBeNull();
    on = true;
    expect(reloadHoldName()).toBe('test-a');
    registerReloadHold('test-b', () => { throw new Error('broken check'); });
    expect(reloadHoldNames()).toEqual(['test-a', 'test-b']);
    on = false;
    expect(reloadHoldName()).toBe('test-b');
    registerReloadHold('test-b', () => false);
    expect(reloadHoldName()).toBeNull();
    expect(reloadHoldNames()).toEqual([]);
  });

  it('dictation still turning into text holds it', () => {
    setDictationPending('mic-1', true);
    expect(reloadHoldName()).toBe('dictation');
    setDictationPending('mic-1', false);
    expect(reloadHoldName()).toBeNull();
  });

  it('a locked visit step holds it until the lock ends', () => {
    let lock;
    function Probe() {
      lock = useTechNavigationLock();
      return null;
    }
    render(<TechNavigationLock><Probe /></TechNavigationLock>);
    expect(reloadHoldName()).toBeNull();
    act(() => lock.setNavigationBusy(true));
    expect(reloadHoldName()).toBe('visit-step');
    act(() => lock.setNavigationBusy(false));
    expect(reloadHoldName()).toBeNull();
  });

  it('a send that prepares its data first holds it by name from its start until it settles, failed or not', async () => {
    let finish;
    let fail;
    const sent = holdReloadWhileSending('test-send', () => new Promise((resolve) => { finish = resolve; }));
    const failed = holdReloadWhileSending('test-send', () => new Promise((_resolve, reject) => { fail = reject; }));
    expect(reloadHoldNames()).toContain('test-send');
    finish('created');
    await expect(sent).resolves.toBe('created');
    expect(reloadHoldNames()).toContain('test-send');
    fail(new Error('Create failed (502)'));
    await expect(failed).rejects.toThrow('Create failed (502)');
    expect(reloadHoldNames()).not.toContain('test-send');
  });

  // Last: a send lock lasts until the page loads again.
  it('an estimate text sent from this tab holds it for the life of the page', async () => {
    const { lockSend } = await import('../components/tech/useTechEstimates');
    expect(reloadHoldName()).toBeNull();
    lockSend('est-1', { text: 'Sent.', ok: true });
    expect(reloadHoldName()).toBe('estimate-send');
  });
});
