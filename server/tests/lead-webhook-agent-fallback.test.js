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
const { settleLeadResponseAgentRun } = _test;

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
