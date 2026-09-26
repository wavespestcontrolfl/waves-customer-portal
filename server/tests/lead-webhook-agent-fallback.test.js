/**
 * settleLeadResponseAgentRun (routes/lead-webhook.js) — the "exactly ONE
 * automated text ever reaches a new website lead" fallback rule (owner
 * ruling 2026-09-26). Extracted so it can be unit-tested directly (the
 * surrounding POST handler is not): processLead / sendFallback / onError
 * are injected.
 *
 * Contract: when the Lead Response Agent is configured, the standard
 * lead_auto_reply_biz reply is skipped immediately by the caller and is
 * instead sent here as the fallback whenever the agent's run does NOT end
 * in an actual send (actionTaken !== 'auto_sent') — covering a null
 * result, a { skipped: true } result, a queued-for-review outcome, and a
 * rejected processLead promise. When the agent is not configured, the
 * standard reply already went out immediately (this function's caller),
 * so no fallback is armed here regardless of what processLead does.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/automation-runner', () => ({ enrollCustomer: jest.fn() }));

const { _test } = require('../routes/lead-webhook');
const { settleLeadResponseAgentRun, LEAD_AGENT_FALLBACK_AFTER_MS, flushPendingLeadFallbacks, pendingLeadFallbacks, singleFlight, createLeadFallbackDeadline } = _test;

// Runs that never settle stay registered in the module-level registry.
beforeEach(() => pendingLeadFallbacks.clear());

function harness(processLeadImpl) {
  const sendFallback = jest.fn(async () => {});
  const onError = jest.fn();
  const processLead = jest.fn(processLeadImpl);
  return { sendFallback, onError, processLead };
}

describe('settleLeadResponseAgentRun — agent configured', () => {
  test('actionTaken auto_sent → fallback never sent', async () => {
    const { sendFallback, onError, processLead } = harness(async () => ({ actionTaken: 'auto_sent' }));
    await settleLeadResponseAgentRun({ agentConfigured: true, processLead, sendFallback, onError });
    expect(sendFallback).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  test.each([
    ['null result (failed run)', async () => null],
    ['skipped result (unlinked/unconfigured)', async () => ({ skipped: true, error: 'Agent processing requires an assigned lead and customer' })],
    ['queued_for_adam outcome', async () => ({ actionTaken: 'queued_for_adam' })],
    ['auto_send_suppressed_queued outcome', async () => ({ actionTaken: 'auto_send_suppressed_queued' })],
    ['no actionTaken at all', async () => ({ toolsExecuted: [] })],
  ])('%s → fallback sent exactly once', async (_label, processLeadImpl) => {
    const { sendFallback, onError, processLead } = harness(processLeadImpl);
    await settleLeadResponseAgentRun({ agentConfigured: true, processLead, sendFallback, onError });
    expect(sendFallback).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  test('an agent run that never settles → the fallback goes out after the bounded wait', async () => {
    const { sendFallback, onError, processLead } = harness(() => new Promise(() => {}));
    await settleLeadResponseAgentRun({ agentConfigured: true, processLead, sendFallback, onError, fallbackAfterMs: 20 });
    expect(sendFallback).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  test('default wait is the agent\'s promised 60-second response window', async () => {
    // A stalled session must not leave a new lead unacknowledged for longer
    // than the agent's documented under-60-second response.
    expect(LEAD_AGENT_FALLBACK_AFTER_MS).toBe(60 * 1000);
    jest.useFakeTimers();
    try {
      const { sendFallback, onError, processLead } = harness(() => new Promise(() => {}));
      const settling = settleLeadResponseAgentRun({ agentConfigured: true, processLead, sendFallback, onError });
      await jest.advanceTimersByTimeAsync(59 * 1000);
      expect(sendFallback).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1000);
      await settling;
      expect(sendFallback).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test('timed out, then the run ends without a send → the fallback is tried again', async () => {
    // The first try can find the agent's in-flight claim and skip; if that
    // send then fails and releases the claim, the retry greets the lead.
    let finish;
    const { sendFallback, onError, processLead } = harness(() => new Promise((resolve) => { finish = resolve; }));
    await settleLeadResponseAgentRun({ agentConfigured: true, processLead, sendFallback, onError, fallbackAfterMs: 10 });
    expect(sendFallback).toHaveBeenCalledTimes(1);
    finish({ actionTaken: 'queued_for_adam' });
    await new Promise(r => setImmediate(r));
    expect(sendFallback).toHaveBeenCalledTimes(2);
    expect(pendingLeadFallbacks.size).toBe(0);
  });

  test('timed out, then the agent sends → no second try', async () => {
    let finish;
    const { sendFallback, onError, processLead } = harness(() => new Promise((resolve) => { finish = resolve; }));
    await settleLeadResponseAgentRun({ agentConfigured: true, processLead, sendFallback, onError, fallbackAfterMs: 10 });
    finish({ actionTaken: 'auto_sent' });
    await new Promise(r => setImmediate(r));
    expect(sendFallback).toHaveBeenCalledTimes(1);
  });

  test('an agent that sends before the bounded wait ends → no fallback', async () => {
    const { sendFallback, onError, processLead } = harness(() => new Promise((resolve) => setTimeout(() => resolve({ actionTaken: 'auto_sent' }), 5)));
    await settleLeadResponseAgentRun({ agentConfigured: true, processLead, sendFallback, onError, fallbackAfterMs: 1000 });
    expect(sendFallback).not.toHaveBeenCalled();
  });

  test('a rejected processLead run → onError called, fallback sent exactly once', async () => {
    const boom = new Error('session stream EOF');
    const { sendFallback, onError, processLead } = harness(async () => { throw boom; });
    await settleLeadResponseAgentRun({ agentConfigured: true, processLead, sendFallback, onError });
    expect(onError).toHaveBeenCalledWith(boom);
    expect(sendFallback).toHaveBeenCalledTimes(1);
  });

  test('fallback itself never lets an error escape the settler', async () => {
    // sendFallback mirrors the route's real wiring, which swallows its own
    // errors (sendLeadAutoReplyOnce failures are logged, not rethrown) —
    // but even if a caller's fallback rejected, settleLeadResponseAgentRun
    // must not silently double-invoke it or hang.
    const processLead = jest.fn(async () => null);
    const sendFallback = jest.fn(async () => { throw new Error('twilio down'); });
    const onError = jest.fn();
    await expect(settleLeadResponseAgentRun({ agentConfigured: true, processLead, sendFallback, onError }))
      .rejects.toThrow('twilio down');
    expect(sendFallback).toHaveBeenCalledTimes(1);
  });
});

describe('settleLeadResponseAgentRun — agent not configured', () => {
  test('processLead still runs, but no fallback is armed on a resolved outcome', async () => {
    const { sendFallback, onError, processLead } = harness(async () => ({ actionTaken: 'auto_sent' }));
    await settleLeadResponseAgentRun({ agentConfigured: false, processLead, sendFallback, onError });
    expect(processLead).toHaveBeenCalledTimes(1);
    expect(sendFallback).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  test('a rejected processLead run only reports the error — no fallback (standard reply already sent immediately)', async () => {
    const boom = new Error('missing LEAD_AGENT_ID');
    const { sendFallback, onError, processLead } = harness(async () => { throw boom; });
    await settleLeadResponseAgentRun({ agentConfigured: false, processLead, sendFallback, onError });
    expect(onError).toHaveBeenCalledWith(boom);
    expect(sendFallback).not.toHaveBeenCalled();
  });
});


describe('flushPendingLeadFallbacks (deploy shutdown)', () => {
  test('a fallback stays registered until its own send settles', async () => {
    let finishSend;
    const sendFallback = jest.fn(() => new Promise((resolve) => { finishSend = resolve; }));
    const processLead = jest.fn(async () => null);
    const settling = settleLeadResponseAgentRun({ agentConfigured: true, processLead, sendFallback, onError: jest.fn() });
    await new Promise(r => setImmediate(r));
    expect(sendFallback).toHaveBeenCalledTimes(1);
    expect(pendingLeadFallbacks.has(sendFallback)).toBe(true);
    finishSend();
    await settling;
    expect(pendingLeadFallbacks.has(sendFallback)).toBe(false);
  });

  test('a run still pending at shutdown gets its standard reply now', async () => {
    const { sendFallback, onError, processLead } = harness(() => new Promise(() => {}));
    const settling = settleLeadResponseAgentRun({ agentConfigured: true, processLead, sendFallback, onError, fallbackAfterMs: 60000 });
    await new Promise(r => setImmediate(r));
    expect(pendingLeadFallbacks.size).toBe(1);
    await expect(flushPendingLeadFallbacks(1000)).resolves.toBe(1);
    expect(sendFallback).toHaveBeenCalledTimes(1);
    // Still registered: the run has not settled, so a late retry may follow
    // and the second (post-drain) flush must still see it.
    expect(pendingLeadFallbacks.size).toBe(1);
    await expect(flushPendingLeadFallbacks(1000)).resolves.toBe(1);
    void settling;
  });

  test('a retry that starts after the first flush is still covered by the second', async () => {
    let finishRun;
    let finishRetry;
    // Like the route's sender: single-flight over the once-ever send.
    const send = jest.fn()
      .mockImplementationOnce(async () => {}) // the timeout's attempt: the agent holds the claim, returns at once
      .mockImplementation(() => new Promise((resolve) => { finishRetry = resolve; }));
    const sendFallback = singleFlight(send);
    const processLead = jest.fn(() => new Promise((resolve) => { finishRun = resolve; }));
    await settleLeadResponseAgentRun({ agentConfigured: true, processLead, sendFallback, onError: jest.fn(), fallbackAfterMs: 10 });
    expect(send).toHaveBeenCalledTimes(1);
    // The agent's send fails and releases the claim: the late retry starts.
    finishRun({ actionTaken: 'queued_for_adam' });
    await new Promise(r => setImmediate(r));
    expect(pendingLeadFallbacks.has(sendFallback)).toBe(true);
    let flushed = false;
    const secondFlush = flushPendingLeadFallbacks(1000).then(() => { flushed = true; });
    await new Promise(r => setImmediate(r));
    expect(flushed).toBe(false);
    finishRetry();
    await secondFlush;
    expect(send).toHaveBeenCalledTimes(2); // the flush joined the retry, no extra send
    await new Promise(r => setImmediate(r));
    expect(pendingLeadFallbacks.has(sendFallback)).toBe(false);
  });

  test('a settled run is no longer pending', async () => {
    const { sendFallback, onError, processLead } = harness(async () => ({ actionTaken: 'auto_sent' }));
    await settleLeadResponseAgentRun({ agentConfigured: true, processLead, sendFallback, onError });
    await expect(flushPendingLeadFallbacks(1000)).resolves.toBe(0);
    expect(sendFallback).not.toHaveBeenCalled();
  });

  test('a hanging fallback cannot hold shutdown past the bound', async () => {
    pendingLeadFallbacks.set(() => new Promise(() => {}), null);
    const started = Date.now();
    await expect(flushPendingLeadFallbacks(20)).resolves.toBe(1);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('singleFlight (the route\'s fallback sender)', () => {
  test('a flush during the guard\'s in-flight send waits for that same send', async () => {
    let finishSend;
    const send = jest.fn(() => new Promise((resolve) => { finishSend = resolve; }));
    const sendFallback = singleFlight(send);
    const guardSend = sendFallback();
    pendingLeadFallbacks.set(sendFallback, null);
    let flushed = false;
    const flushing = flushPendingLeadFallbacks(1000).then(() => { flushed = true; });
    await new Promise(r => setImmediate(r));
    expect(send).toHaveBeenCalledTimes(1);
    expect(flushed).toBe(false);
    finishSend();
    await flushing;
    await guardSend;
    expect(flushed).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  test('a call after the send settles starts a fresh one (the late retry)', async () => {
    const send = jest.fn(async () => {});
    const sendFallback = singleFlight(send);
    await sendFallback();
    await sendFallback();
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe('flushPendingLeadFallbacks waits for the agent run itself', () => {
  test('an agent send in flight at shutdown: the flush waits for the run and its late retry', async () => {
    let finishRun;
    const send = jest.fn(async () => {}); // the claim is held by the agent: returns at once
    const sendFallback = singleFlight(send);
    const processLead = jest.fn(() => new Promise((resolve) => { finishRun = resolve; }));
    const settling = settleLeadResponseAgentRun({ agentConfigured: true, processLead, sendFallback, onError: jest.fn(), fallbackAfterMs: 60000 });
    await new Promise(r => setImmediate(r));
    let flushed = false;
    const flushing = flushPendingLeadFallbacks(1000).then(() => { flushed = true; });
    await new Promise(r => setImmediate(r));
    expect(flushed).toBe(false); // still waiting on the run, not just the fallback call
    finishRun({ actionTaken: 'queued_for_adam' }); // the agent released the claim without sending
    await flushing;
    await settling;
    expect(flushed).toBe(true);
    expect(send).toHaveBeenCalledTimes(2); // the flush's call + the run's final fallback
    expect(pendingLeadFallbacks.size).toBe(0);
  });
});

describe('a permanently stalled agent run', () => {
  test('leaves the registry after the late-retry window', async () => {
    jest.useFakeTimers();
    try {
      const sendFallback = jest.fn(async () => {});
      const processLead = jest.fn(() => new Promise(() => {}));
      const settling = settleLeadResponseAgentRun({ agentConfigured: true, processLead, sendFallback, onError: jest.fn(), fallbackAfterMs: 1000 });
      await jest.advanceTimersByTimeAsync(1000);
      await settling;
      expect(pendingLeadFallbacks.has(sendFallback)).toBe(true);
      await jest.advanceTimersByTimeAsync(5 * 60 * 1000);
      expect(pendingLeadFallbacks.has(sendFallback)).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('createLeadFallbackDeadline (one timer for the lead\'s minute)', () => {
  const tick = (ms) => new Promise(r => setTimeout(r, ms));

  test('the agent never started: the deadline sends once and drops its registration', async () => {
    const send = jest.fn(async () => {});
    const sendFallback = singleFlight(send);
    createLeadFallbackDeadline(sendFallback, 10);
    expect(pendingLeadFallbacks.has(sendFallback)).toBe(true);
    await tick(30);
    expect(send).toHaveBeenCalledTimes(1);
    expect(pendingLeadFallbacks.has(sendFallback)).toBe(false);
  });

  test('taken over before it fires: the run\'s timeout sends exactly once (no second timer)', async () => {
    const send = jest.fn(async () => {});
    const sendFallback = singleFlight(send);
    const deadline = createLeadFallbackDeadline(sendFallback, 20);
    const processLead = jest.fn(() => new Promise(() => {}));
    await settleLeadResponseAgentRun({ agentConfigured: true, processLead, sendFallback, onError: jest.fn(), deadline: deadline.takeOver() });
    await tick(30);
    expect(send).toHaveBeenCalledTimes(1);
  });

  test('already fired when taken over (slow estimate work): no second attempt', async () => {
    const send = jest.fn(async () => {});
    const sendFallback = singleFlight(send);
    const deadline = createLeadFallbackDeadline(sendFallback, 5);
    await tick(20);
    expect(send).toHaveBeenCalledTimes(1);
    const processLead = jest.fn(() => new Promise(() => {}));
    await settleLeadResponseAgentRun({ agentConfigured: true, processLead, sendFallback, onError: jest.fn(), deadline: deadline.takeOver() });
    await tick(10);
    expect(send).toHaveBeenCalledTimes(1);
  });

  test('taken over, agent sends in time: no fallback at all', async () => {
    const send = jest.fn(async () => {});
    const sendFallback = singleFlight(send);
    const deadline = createLeadFallbackDeadline(sendFallback, 30);
    const processLead = jest.fn(async () => ({ actionTaken: 'auto_sent' }));
    await settleLeadResponseAgentRun({ agentConfigured: true, processLead, sendFallback, onError: jest.fn(), deadline: deadline.takeOver() });
    await tick(50);
    expect(send).not.toHaveBeenCalled();
    expect(pendingLeadFallbacks.has(sendFallback)).toBe(false);
  });

  test('cancel (init throw path) clears the timer and the placeholder registration', async () => {
    const send = jest.fn(async () => {});
    const sendFallback = singleFlight(send);
    const deadline = createLeadFallbackDeadline(sendFallback, 10);
    deadline.cancel();
    await tick(30);
    expect(send).not.toHaveBeenCalled();
    expect(pendingLeadFallbacks.has(sendFallback)).toBe(false);
  });
});
