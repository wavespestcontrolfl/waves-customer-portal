// @vitest-environment jsdom

// The customer page's questions to the Waves Admin app (Tap to Pay card save): each is
// answered once by a window event with the same requestId.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { askHandoffCapabilities, requestTapSave } from './wavesCustomerHandoff';

const SAVE = { consentTextVersion: 'v12_2026-09-30', agreed: true, feeDisclosedAmount: 25, disclosureVersion: 'sticky_v1' };
let postMessage;

beforeEach(() => {
  postMessage = vi.fn();
  window.webkit = { messageHandlers: { wavesCustomer: { postMessage } } };
});
afterEach(() => { vi.useRealTimers(); delete window.webkit; });

const answer = (name, detail) => window.dispatchEvent(new CustomEvent(name, { detail }));

describe('askHandoffCapabilities', () => {
  it('returns the capabilities from the answer with the same requestId, ignoring another request\'s answer', async () => {
    const pending = askHandoffCapabilities();
    const { requestId, type } = postMessage.mock.calls[0][0];
    expect(type).toBe('capabilities');
    answer('waveshandoff:capabilities', { requestId: 'someone-else', capabilities: ['other'] });
    answer('waveshandoff:capabilities', { requestId, capabilities: ['saveCard'] });
    expect(await pending).toEqual(['saveCard']);
  });

  it('returns no capabilities when an older app never answers', async () => {
    vi.useFakeTimers();
    const pending = askHandoffCapabilities();
    await vi.advanceTimersByTimeAsync(2000);
    expect(await pending).toEqual([]);
  });

  it('returns no capabilities when there is no bridge', async () => {
    delete window.webkit;
    expect(await askHandoffCapabilities()).toEqual([]);
  });
});

describe('requestTapSave', () => {
  it('posts the consent fields and passes a succeeded or canceled answer through', async () => {
    const pending = requestTapSave(SAVE);
    expect(postMessage.mock.calls[0][0]).toMatchObject({ type: 'saveCard', ...SAVE });
    answer('waveshandoff:savecard', { requestId: postMessage.mock.calls[0][0].requestId, status: 'succeeded', card: { last4: '4242' } });
    expect(await pending).toEqual({ status: 'succeeded' });

    const canceled = requestTapSave(SAVE);
    answer('waveshandoff:savecard', { requestId: postMessage.mock.calls[1][0].requestId, status: 'canceled' });
    expect(await canceled).toEqual({ status: 'canceled' });
  });

  it('turns a failed answer, an odd answer and a missing bridge into a failure with a message', async () => {
    const failed = requestTapSave(SAVE);
    answer('waveshandoff:savecard', { requestId: postMessage.mock.calls[0][0].requestId, status: 'failed', message: 'Card declined.' });
    expect(await failed).toEqual({ status: 'failed', message: 'Card declined.' });

    const odd = requestTapSave(SAVE);
    answer('waveshandoff:savecard', { requestId: postMessage.mock.calls[1][0].requestId, status: 'weird' });
    expect(await odd).toEqual({ status: 'failed', message: expect.stringMatching(/try again/i) });

    delete window.webkit;
    expect(await requestTapSave(SAVE)).toEqual({ status: 'failed', message: expect.stringMatching(/try again/i) });
  });
});
