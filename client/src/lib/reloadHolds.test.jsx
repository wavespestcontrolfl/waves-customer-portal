// @vitest-environment jsdom
// Work that a reload would lose holds the automatic reload of an out-of-date
// staff tab. These pin the registry rules and the holds whose modules have no
// test file of their own: dictation still on its way, a locked visit step,
// and an estimate text sent from this tab.
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { registerReloadHold, reloadHoldName } from './reloadHolds';
import { setDictationPending } from '../hooks/dictationPending';
import TechNavigationLock, { useTechNavigationLock } from '../components/tech/TechNavigationLock';

afterEach(cleanup);

describe('reloadHolds', () => {
  it('names the first held work, and a check that throws counts as held', () => {
    let on = false;
    registerReloadHold('test-a', () => on);
    expect(reloadHoldName()).toBeNull();
    on = true;
    expect(reloadHoldName()).toBe('test-a');
    on = false;
    registerReloadHold('test-b', () => { throw new Error('broken check'); });
    expect(reloadHoldName()).toBe('test-b');
    registerReloadHold('test-b', () => false);
    expect(reloadHoldName()).toBeNull();
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

  // Last: a send lock lasts until the page loads again.
  it('an estimate text sent from this tab holds it for the life of the page', async () => {
    const { lockSend } = await import('../components/tech/useTechEstimates');
    expect(reloadHoldName()).toBeNull();
    lockSend('est-1', { text: 'Sent.', ok: true });
    expect(reloadHoldName()).toBe('estimate-send');
  });
});
