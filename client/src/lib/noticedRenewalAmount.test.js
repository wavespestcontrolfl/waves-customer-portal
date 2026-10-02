import { describe, expect, it, vi } from 'vitest';
import {
  NOTICED_AMOUNT_DECLINED,
  noticedRenewalAmountPrompt,
  noticedRenewalAmountRefusal,
  sendWithNoticedAmountConfirm,
} from './noticedRenewalAmount';

function noticed409(body = {}, where = 'body') {
  const err = new Error('This customer was noticed a renewal amount of $484.00 ...');
  err.status = 409;
  err[where] = { code: 'RENEWAL_AMOUNT_NOTICED', noticedAmount: 484, chargedAmount: 468, termId: 't1', ...body };
  return err;
}

describe('noticedRenewalAmountRefusal', () => {
  it('reads the 409 body from err.body or err.details', () => {
    expect(noticedRenewalAmountRefusal(noticed409())).toEqual({ noticedAmount: 484, chargedAmount: 468 });
    expect(noticedRenewalAmountRefusal(noticed409({}, 'details'))).toEqual({ noticedAmount: 484, chargedAmount: 468 });
  });
  it('accepts a $0 charged amount (zero is a price, not a missing one)', () => {
    expect(noticedRenewalAmountRefusal(noticed409({ chargedAmount: 0 }))).toEqual({ noticedAmount: 484, chargedAmount: 0 });
    expect(noticedRenewalAmountPrompt({ noticedAmount: 484, chargedAmount: 0 })).toBe('The customer was told $484.00. Charge $0.00 instead?');
  });
  it('ignores other refusals and a body missing either amount', () => {
    const other = new Error('x'); other.status = 409; other.body = { setupFeeRequired: true };
    expect(noticedRenewalAmountRefusal(other)).toBeNull();
    expect(noticedRenewalAmountRefusal(noticed409({ chargedAmount: undefined }))).toBeNull();
    const notConflict = noticed409(); notConflict.status = 500;
    expect(noticedRenewalAmountRefusal(notConflict)).toBeNull();
  });
});

describe('noticedRenewalAmountPrompt', () => {
  it('states the noticed amount against the amount being charged, in plain words', () => {
    expect(noticedRenewalAmountPrompt({ noticedAmount: 484, chargedAmount: 468 }))
      .toBe('The customer was told $484.00. Charge $468.00 instead?');
  });
});

describe('sendWithNoticedAmountConfirm', () => {
  it('sends once with no acknowledgement when the server accepts', async () => {
    const send = vi.fn(async () => ({ ok: true }));
    const confirmFn = vi.fn();
    await expect(sendWithNoticedAmountConfirm(send, confirmFn)).resolves.toEqual({ ok: true });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({});
    expect(confirmFn).not.toHaveBeenCalled();
  });
  it('on the noticed-amount 409 asks, and on confirm resends with acknowledgeNoticedAmount: true', async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(noticed409())
      .mockResolvedValueOnce({ ok: true });
    const confirmFn = vi.fn(() => true);
    await expect(sendWithNoticedAmountConfirm(send, confirmFn)).resolves.toEqual({ ok: true });
    expect(confirmFn).toHaveBeenCalledWith('The customer was told $484.00. Charge $468.00 instead?');
    expect(send).toHaveBeenNthCalledWith(2, { acknowledgeNoticedAmount: true });
  });
  it('on cancel makes no second request and throws a plain, tagged error', async () => {
    const send = vi.fn().mockRejectedValueOnce(noticed409());
    const err = await sendWithNoticedAmountConfirm(send, () => false).catch((e) => e);
    expect(send).toHaveBeenCalledTimes(1);
    expect(err.code).toBe(NOTICED_AMOUNT_DECLINED);
    expect(err.message).toBe('Not saved. The customer was told $484.00 for this renewal.');
  });
  it('passes any other error through untouched, without asking', async () => {
    const other = new Error('boom');
    const confirmFn = vi.fn();
    await expect(sendWithNoticedAmountConfirm(vi.fn().mockRejectedValueOnce(other), confirmFn)).rejects.toBe(other);
    expect(confirmFn).not.toHaveBeenCalled();
  });
});
