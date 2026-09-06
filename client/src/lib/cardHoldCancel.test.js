// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./adminAuth', () => ({
  getAdminAuthToken: () => 'tok',
  getAdminUser: () => ({ role: 'admin' }),
}));

import { confirmCardHoldFeeChoice } from './cardHoldCancel';

// Undetermined verdicts (willCharge null) and the admin waiver — Codex #3806
// r2 / r5 P1s. The preview fetch is stubbed; window.confirm answers are
// queued in prompt order.
function stubPreview(rule) {
  global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ held: false, feeApplies: false, unresolved: true, rule }) }));
}
function queueConfirms(...answers) {
  const prompts = [];
  window.confirm = vi.fn((text) => { prompts.push(text); return answers.shift(); });
  return prompts;
}

describe('confirmCardHoldFeeChoice — undetermined verdicts', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { delete global.fetch; });

  it('charge already in flight, single visit: proceeds with no waiver prompt', async () => {
    stubPreview({ code: 'charge_in_flight', willCharge: null, text: 'A fee charge is already in progress.' });
    const prompts = queueConfirms(true);
    await expect(confirmCardHoldFeeChoice('svc-1')).resolves.toEqual({ proceed: true, waiveCardHoldFee: false });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatch(/^A fee charge is already in progress\./);
  });

  it('charge already in flight, series cancel: still offers the series-wide waiver for the siblings (r5 P1)', async () => {
    stubPreview({ code: 'charge_in_flight', willCharge: null, text: 'A fee charge is already in progress.' });
    const prompts = queueConfirms(true, true);
    await expect(confirmCardHoldFeeChoice('svc-1', { scope: 'following' })).resolves.toEqual({ proceed: true, waiveCardHoldFee: true });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toMatch(/other appointments in this series/);
  });

  it('card capture mid-completion: offers the "waive if it applies" prompt like a retryable verdict (r5 P1)', async () => {
    stubPreview({ code: 'capture_in_flight', willCharge: null, text: 'The customer is saving a card right now.' });
    const prompts = queueConfirms(true, true);
    await expect(confirmCardHoldFeeChoice('svc-1')).resolves.toEqual({ proceed: true, waiveCardHoldFee: true });
    expect(prompts[1]).toMatch(/^If the fee turns out to apply when you confirm, waive it\?/);
  });

  it('retryable unresolved verdict: backing out of the waiver prompt charges (never silently waives)', async () => {
    stubPreview({ code: 'unresolved', willCharge: null, text: "Couldn't verify the fee terms right now." });
    queueConfirms(true, false);
    await expect(confirmCardHoldFeeChoice('svc-1')).resolves.toEqual({ proceed: true, waiveCardHoldFee: false });
  });

  it('declining the neutral continue prompt aborts the cancel', async () => {
    stubPreview({ code: 'capture_in_flight', willCharge: null, text: 'The customer is saving a card right now.' });
    const prompts = queueConfirms(false);
    await expect(confirmCardHoldFeeChoice('svc-1', { scope: 'series' })).resolves.toEqual({ proceed: false, waiveCardHoldFee: false });
    expect(prompts).toHaveLength(1);
  });
});


describe('unavailable cancellation preview', () => {
  afterEach(() => { delete global.fetch; });

  it.each(['http', 'network'])('offers the warning and waiver after a %s failure', async (failure) => {
    global.fetch = vi.fn(async () => {
      if (failure === 'network') throw new Error('offline');
      return { ok: false, status: 500 };
    });
    const prompts = queueConfirms(true, true);
    await expect(confirmCardHoldFeeChoice('svc-1')).resolves.toEqual({ proceed: true, waiveCardHoldFee: true });
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("Couldn't check the saved card");
    expect(prompts[1]).toContain('waive it?');
  });

  it('lets the operator abort when the preview is unavailable', async () => {
    global.fetch = vi.fn(async () => ({ ok: false }));
    queueConfirms(false);
    await expect(confirmCardHoldFeeChoice('svc-1')).resolves.toEqual({ proceed: false, waiveCardHoldFee: false });
  });
});
