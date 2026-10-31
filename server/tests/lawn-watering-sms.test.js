const fs = require('fs');
const path = require('path');

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const logger = require('../services/logger');
const {
  lawnWateringSmsPlan,
  lawnWateringSmsAlreadyHandled,
  sendLawnWateringSms,
} = require('../services/service-report/lawn-watering-sms');
const policy = require('../services/messaging/policy');
const { lawnWateringSmsLive } = require('../config/feature-gates');
const { REQUIRED_TEMPLATE_PLACEHOLDERS } = require('../routes/admin-sms-templates');
const { mapPurposeToMessageType } = require('../services/messaging/providers/twilio-sms');

const HOLD = { state: 'hold', lines: ['Skip watering until 8:00 PM tonight.', 'Water normally after that.'] };

function planArgs(over = {}) {
  return {
    instruction: HOLD,
    isBackfill: false,
    deliveryMode: 'auto_send',
    phone: '+19415550100',
    internalOnly: false,
    alreadySent: false,
    gateOn: true,
    ruleGateOn: true,
    completedAt: new Date().toISOString(),
    completionTextRequested: true,
    nowMs: Date.now(),
    ...over,
  };
}

describe('lawnWateringSmsPlan', () => {
  test.each(['hold', 'water_in', 'hold_then_water_in'])('sends for state %s', (state) => {
    const plan = lawnWateringSmsPlan(planArgs({ instruction: { state, lines: ['One.'] } }));
    expect(plan).toEqual({ send: true, vars: { watering_lines: 'One.' } });
  });

  test('a label mow hold on the frozen instruction never reaches the text body', () => {
    const mowHold = { days: 2, untilAt: '2026-10-02T19:00:00.000Z', untilDate: '2026-10-02', untilLabel: 'Fri 3 PM', line: 'Mowing: hold off until Fri 3 PM, 2 days after today\'s treatment.' };
    const plain = lawnWateringSmsPlan(planArgs({ instruction: HOLD }));
    const withMow = lawnWateringSmsPlan(planArgs({ instruction: { ...HOLD, mowHold } }));
    expect(withMow).toEqual(plain);
    expect(withMow.vars.watering_lines).not.toMatch(/mow/i);
    // A mow hold with no watering claim sends nothing.
    expect(lawnWateringSmsPlan(planArgs({ instruction: { state: null, lines: [], mowHold } }))).toEqual({ send: false, reason: 'no_instruction' });
  });

  test('joins the lines with a single space, verbatim', () => {
    const plan = lawnWateringSmsPlan(planArgs({ instruction: { state: 'hold_then_water_in', lines: ['A b.', 'C: 8:15 PM.', 'D "q".'] } }));
    expect(plan.vars.watering_lines).toBe('A b. C: 8:15 PM. D "q".');
  });

  test.each([
    ['state none', { state: 'none', lines: ['x.'] }],
    ['null instruction', null],
    ['unknown state', { state: 'bogus', lines: ['x.'] }],
    ['null state', { state: null, lines: ['x.'] }],
  ])('skips %s', (_name, instruction) => {
    expect(lawnWateringSmsPlan(planArgs({ instruction }))).toEqual({ send: false, reason: 'no_instruction' });
  });

  test.each([
    ['empty lines', []],
    ['blank lines only', ['', '   ']],
    ['non-array lines', 'x.'],
  ])('skips a sendable state with %s', (_name, lines) => {
    expect(lawnWateringSmsPlan(planArgs({ instruction: { state: 'hold', lines } }))).toEqual({ send: false, reason: 'no_lines' });
  });

  test.each([
    ['backfill', { isBackfill: true }, 'backfill'],
    ['manual delivery mode', { deliveryMode: 'manual' }, 'not_auto_send'],
    ['no delivery mode', { deliveryMode: null }, 'not_auto_send'],
    ['no phone', { phone: '' }, 'no_phone'],
    ['internal-only completion', { internalOnly: true }, 'internal_only'],
    ['already sent', { alreadySent: true }, 'already_sent'],
    ['watering SMS gate off', { gateOn: false }, 'gate_off'],
    ['watering rule gate off', { ruleGateOn: false }, 'rule_gate_off'],
  ])('skips for %s', (_name, over, reason) => {
    expect(lawnWateringSmsPlan(planArgs(over))).toEqual({ send: false, reason });
  });

  test('does not look at whether the completion text went out', () => {
    // Only whether it was REQUESTED matters: a withheld, failed or
    // already-handled completion text cannot suppress the watering text.
    expect(lawnWateringSmsPlan(planArgs())).toMatchObject({ send: true });
  });
});

describe('lawnWateringSmsAlreadyHandled', () => {
  test('empty notes are not handled', () => {
    expect(lawnWateringSmsAlreadyHandled({})).toBe(false);
    expect(lawnWateringSmsAlreadyHandled(null)).toBe(false);
  });
  test.each(['sent', 'failed', 'skipped_quiet_hours', 'skipped_blocked', 'skipped_anything'])('%s is final', (status) => {
    expect(lawnWateringSmsAlreadyHandled({ lawnWateringSmsStatus: status })).toBe(true);
  });
  test('an uncertainty fence is final too', () => {
    expect(lawnWateringSmsAlreadyHandled({ lawnWateringSmsStatus: 'sending', lawnWateringSmsDeliveryUnverifiedAt: 'x' })).toBe(true);
  });
});

describe('sendLawnWateringSms (completion path wiring, mocked IO)', () => {
  const ENV_KEYS = ['GATE_LAWN_WATERING_SMS', 'GATE_LAWN_WATERING_RULE'];
  let saved;
  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    process.env.GATE_LAWN_WATERING_SMS = 'true';
    process.env.GATE_LAWN_WATERING_RULE = 'true';
    jest.clearAllMocks();
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  });

  function harness({ notes = {}, sendResult = { sent: true }, template = "Watering after today's visit: {watering_lines}" } = {}) {
    const merged = [];
    const sendCustomerMessage = jest.fn(async () => sendResult);
    const getTemplate = jest.fn(async (key, vars) => (template ? template.replace('{watering_lines}', vars.watering_lines) : null));
    const mergeNotes = jest.fn(async (id, delta) => { merged.push({ id, delta }); });
    const state = {
      record: { id: 'rec-1', structured_notes: {} },
      svc: { id: 'svc-1', customer_id: 'cust-1', cust_phone: '+19415550100' },
      notes: { lawnWateringFreeze: { wateringInstruction: { ...HOLD, completedAt: new Date().toISOString() } }, ...notes },
      isBackfill: false,
      deliveryMode: 'auto_send',
      internalOnly: false,
      completionTextRequested: true,
    };
    const deps = { db: {}, sendCustomerMessage, getTemplate, mergeNotes, throwIfDeliveryUnverified: (r) => r };
    return { state, deps, sendCustomerMessage, getTemplate, mergeNotes, merged };
  }

  test('gate on + hold instruction sends one watering text through the canonical sender', async () => {
    const h = harness();
    const out = await sendLawnWateringSms(h.state, h.deps);
    expect(out).toEqual({ status: 'sent' });
    expect(h.sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(h.sendCustomerMessage.mock.calls[0][0]).toEqual({
      preSendCheck: expect.any(Function),
      to: '+19415550100',
      body: "Watering after today's visit: Skip watering until 8:00 PM tonight. Water normally after that.",
      channel: 'sms',
      audience: 'customer',
      purpose: 'lawn_watering_instruction',
      customerId: 'cust-1',
      appointmentId: 'svc-1',
      identityTrustLevel: 'phone_matches_customer',
      metadata: {
        original_message_type: 'lawn_watering_instruction',
        service_record_id: 'rec-1',
        notificationEventKey: 'scheduled-service:svc-1:lawn-watering',
        useCustomerChannel: true,
        templateKey: 'lawn_watering_instruction',
      },
    });
    // The template is rendered with the joined lines and must keep the slot.
    expect(h.getTemplate).toHaveBeenCalledWith(
      'lawn_watering_instruction',
      { watering_lines: 'Skip watering until 8:00 PM tonight. Water normally after that.' },
      expect.any(Object),
      { requiredVars: ['watering_lines'] },
    );
  });

  test('claims before the provider call, then stamps sent and keeps the in-memory notes in sync', async () => {
    const h = harness();
    let claimedBeforeSend = false;
    h.sendCustomerMessage.mockImplementationOnce(async () => {
      claimedBeforeSend = h.merged.length === 1 && h.merged[0].delta.lawnWateringSmsStatus === 'sending'
        && !!h.merged[0].delta.lawnWateringSmsDeliveryUnverifiedAt;
      return { sent: true };
    });
    await sendLawnWateringSms(h.state, h.deps);
    expect(claimedBeforeSend).toBe(true);
    expect(h.merged[1].delta).toMatchObject({ lawnWateringSmsStatus: 'sent', lawnWateringSmsDeliveryUnverifiedAt: null });
    expect(h.merged[1].delta.lawnWateringSmsAt).toEqual(expect.any(String));
    expect(h.state.notes.lawnWateringSmsStatus).toBe('sent');
    expect(h.state.record.structured_notes.lawnWateringSmsStatus).toBe('sent');
  });

  test('gate off: no template read, no send, no notes write', async () => {
    delete process.env.GATE_LAWN_WATERING_SMS;
    const h = harness();
    expect(await sendLawnWateringSms(h.state, h.deps)).toEqual({ status: 'gate_off' });
    expect(h.getTemplate).not.toHaveBeenCalled();
    expect(h.sendCustomerMessage).not.toHaveBeenCalled();
    expect(h.mergeNotes).not.toHaveBeenCalled();
  });

  test('only the exact string true opens the gate', async () => {
    for (const value of ['1', 'on', 'TRUE', 'yes']) {
      process.env.GATE_LAWN_WATERING_SMS = value;
      expect(lawnWateringSmsLive()).toBe(false);
    }
    process.env.GATE_LAWN_WATERING_SMS = 'true';
    expect(lawnWateringSmsLive()).toBe(true);
  });

  test('rule gate off: no send', async () => {
    delete process.env.GATE_LAWN_WATERING_RULE;
    const h = harness();
    expect(await sendLawnWateringSms(h.state, h.deps)).toEqual({ status: 'gate_off' });
    expect(h.sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a retried completion with the marker set never sends again', async () => {
    for (const notes of [
      { lawnWateringSmsStatus: 'sent' },
      { lawnWateringSmsStatus: 'skipped_quiet_hours' },
      { lawnWateringSmsStatus: 'skipped_blocked' },
      { lawnWateringSmsStatus: 'failed', lawnWateringSmsDeliveryUnverifiedAt: '2026-09-30T12:00:00Z' },
    ]) {
      const h = harness({ notes });
      expect(await sendLawnWateringSms(h.state, h.deps)).toEqual({ status: 'skip_already_sent' });
      expect(h.sendCustomerMessage).not.toHaveBeenCalled();
      expect(h.mergeNotes).not.toHaveBeenCalled();
    }
  });

  test('a definitely-rejected earlier attempt is never retried on a resumed completion (one try, then stop)', async () => {
    const h = harness({ notes: { lawnWateringSmsStatus: 'failed', lawnWateringSmsError: 'PROVIDER_FAILURE' } });
    expect(await sendLawnWateringSms(h.state, h.deps)).toEqual({ status: 'skip_already_sent' });
    expect(h.sendCustomerMessage).not.toHaveBeenCalled();
  });

  test.each([
    ['completion text withheld (no report token)', { completionSmsStatus: 'failed', completionSmsError: 'report token unavailable — completion text withheld' }],
    ['completion text failed', { completionSmsStatus: 'failed', completionSmsError: 'provider down' }],
    ['completion text already sent on an earlier attempt', { completionSmsStatus: 'sent', sentSmsBody: 'Your report is ready' }],
    ['completion text deferred to the send window', { completionSmsStatus: 'deferred' }],
  ])('still sends when the %s', async (_name, notes) => {
    const h = harness({ notes });
    expect(await sendLawnWateringSms(h.state, h.deps)).toEqual({ status: 'sent' });
    expect(h.sendCustomerMessage).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['backfill', { isBackfill: true }],
    ['manual delivery', { deliveryMode: 'manual' }],
    ['internal-only', { internalOnly: true }],
    ['no phone', { svc: { id: 'svc-1', customer_id: 'cust-1', cust_phone: null } }],
  ])('skips for %s without any read or write', async (_name, over) => {
    const h = harness();
    const out = await sendLawnWateringSms({ ...h.state, ...over }, h.deps);
    expect(out.status).toMatch(/^skip_/);
    expect(h.getTemplate).not.toHaveBeenCalled();
    expect(h.sendCustomerMessage).not.toHaveBeenCalled();
    expect(h.mergeNotes).not.toHaveBeenCalled();
  });

  test('a none or missing frozen instruction sends nothing', async () => {
    for (const notes of [
      { lawnWateringFreeze: { wateringInstruction: { state: 'none', lines: ['x.'] } } },
      { lawnWateringFreeze: null },
    ]) {
      const h = harness({ notes });
      expect((await sendLawnWateringSms(h.state, h.deps)).status).toBe('skip_no_instruction');
      expect(h.sendCustomerMessage).not.toHaveBeenCalled();
    }
  });

  test('fails closed with a warning when the template is missing or inactive (no claim written)', async () => {
    const h = harness({ template: null });
    expect(await sendLawnWateringSms(h.state, h.deps)).toEqual({ status: 'skip_no_template' });
    expect(h.sendCustomerMessage).not.toHaveBeenCalled();
    expect(h.mergeNotes).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('lawn_watering_instruction'));
  });

  test('does not send when the claim write fails', async () => {
    const h = harness();
    h.mergeNotes.mockRejectedValueOnce(new Error('db down'));
    expect(await sendLawnWateringSms(h.state, h.deps)).toEqual({ status: 'skip_claim_failed' });
    expect(h.sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a retryable block (lookup failed) is recorded as failed and never retried', async () => {
    const h = harness({ sendResult: { sent: false, blocked: true, retryable: true, deferred: true, code: 'CONSENT_LOOKUP_FAILED' } });
    expect(await sendLawnWateringSms(h.state, h.deps)).toEqual({ status: 'failed' });
    expect(h.sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(h.state.notes).toMatchObject({ lawnWateringSmsStatus: 'failed', lawnWateringSmsError: 'CONSENT_LOOKUP_FAILED', lawnWateringSmsDeliveryUnverifiedAt: null });
    expect(lawnWateringSmsAlreadyHandled(h.state.notes)).toBe(true);
  });

  test('the handoff recheck passes a fresh instruction and refuses a stale one; a stale refusal is final', async () => {
    const h = harness();
    await sendLawnWateringSms(h.state, h.deps);
    const { preSendCheck } = h.sendCustomerMessage.mock.calls[0][0];
    expect(await preSendCheck({ channel: 'sms' })).toEqual({ ok: true });
    h.state.notes.lawnWateringFreeze.wateringInstruction.waterInBy = new Date(Date.now() - 1000).toISOString();
    expect(await preSendCheck({ channel: 'sms' })).toMatchObject({ ok: false, code: 'LAWN_WATERING_STALE', retryable: false });

    const s = harness({ sendResult: { sent: false, blocked: true, code: 'LAWN_WATERING_STALE' } });
    expect(await sendLawnWateringSms(s.state, s.deps)).toEqual({ status: 'skipped_stale' });
    expect(s.state.notes).toMatchObject({ lawnWateringSmsStatus: 'skipped_stale', lawnWateringSmsDeliveryUnverifiedAt: null });
    expect(lawnWateringSmsAlreadyHandled(s.state.notes)).toBe(true);
  });

  test('a policy block is final: skipped_blocked, never retried', async () => {
    const h = harness({ sendResult: { sent: false, blocked: true, code: 'OPTED_OUT' } });
    expect(await sendLawnWateringSms(h.state, h.deps)).toEqual({ status: 'skipped_blocked' });
    expect(h.state.notes).toMatchObject({ lawnWateringSmsStatus: 'skipped_blocked', lawnWateringSmsBlockCode: 'OPTED_OUT', lawnWateringSmsDeliveryUnverifiedAt: null });
    expect(lawnWateringSmsAlreadyHandled(h.state.notes)).toBe(true);
  });

  test('a definite provider rejection is final: one try, then stop', async () => {
    const h = harness({ sendResult: { sent: false, code: 'PROVIDER_FAILURE' } });
    expect(await sendLawnWateringSms(h.state, h.deps)).toEqual({ status: 'failed' });
    expect(h.sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(h.state.notes).toMatchObject({ lawnWateringSmsStatus: 'failed', lawnWateringSmsDeliveryUnverifiedAt: null });
    expect(lawnWateringSmsAlreadyHandled(h.state.notes)).toBe(true);
  });

  test('a throw after the provider handoff keeps the fence so a retry never double-texts', async () => {
    const h = harness();
    h.sendCustomerMessage.mockRejectedValueOnce(Object.assign(new Error('audit insert failed'), { code: 'AUDIT_FAILED' }));
    expect(await sendLawnWateringSms(h.state, h.deps)).toEqual({ status: 'unverified' });
    expect(lawnWateringSmsAlreadyHandled(h.state.notes)).toBe(true);
    const retry = harness({ notes: h.state.notes });
    expect((await sendLawnWateringSms(retry.state, retry.deps)).status).toBe('skip_already_sent');
    expect(retry.sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a throw that carries an accepted provider outcome is stamped sent', async () => {
    const h = harness();
    h.sendCustomerMessage.mockRejectedValueOnce(Object.assign(new Error('audit failed after accept'), { providerOutcome: { sent: true } }));
    expect(await sendLawnWateringSms(h.state, h.deps)).toEqual({ status: 'sent' });
    expect(h.state.notes.lawnWateringSmsStatus).toBe('sent');
  });

  test('a throw that carries a definite not_sent outcome is recorded as failed (final)', async () => {
    const h = harness();
    h.sendCustomerMessage.mockRejectedValueOnce(Object.assign(new Error('audit failed after reject'), { providerOutcome: { sent: false, deliveryOutcome: 'not_sent' } }));
    expect(await sendLawnWateringSms(h.state, h.deps)).toEqual({ status: 'failed' });
    expect(h.sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(h.state.notes).toMatchObject({ lawnWateringSmsStatus: 'failed', lawnWateringSmsDeliveryUnverifiedAt: null });
    // ...whereas an uncertain throw keeps the fence.
    const u = harness();
    u.sendCustomerMessage.mockRejectedValueOnce(Object.assign(new Error('timeout'), { providerOutcome: { sent: false, deliveryOutcome: 'uncertain' } }));
    expect(await sendLawnWateringSms(u.state, u.deps)).toEqual({ status: 'unverified' });
    expect(lawnWateringSmsAlreadyHandled(u.state.notes)).toBe(true);
  });

  test('never throws, even when the notes writer and sender both blow up', async () => {
    const h = harness();
    h.deps.throwIfDeliveryUnverified = () => { throw new Error('boom'); };
    h.mergeNotes.mockRejectedValue(new Error('db down'));
    h.mergeNotes.mockResolvedValueOnce(undefined); // claim succeeds
    await expect(sendLawnWateringSms(h.state, h.deps)).resolves.toEqual({ status: 'unverified' });
  });

  test('warnings carry no phone number and no message body', async () => {
    const h = harness({ sendResult: { sent: false, code: 'PROVIDER_FAILURE' } });
    await sendLawnWateringSms(h.state, h.deps);
    const logged = logger.warn.mock.calls.map((c) => c[0]).join('\n');
    expect(logged).not.toContain('+19415550100');
    expect(logged).not.toContain('Skip watering');
  });

  describe('quiet-hours hold', () => {
    function txHarness() {
      const inserts = [];
      const updates = [];
      const trx = jest.fn((table) => ({
        insert: async (row) => { inserts.push({ table, row }); },
        where: () => ({ update: async (patch) => { updates.push({ table, patch }); } }),
      }));
      trx.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
      const db = { transaction: jest.fn(async (fn) => fn(trx)) };
      return { db, inserts, updates };
    }

    test('a quiet-hours hold is a final skip, never requeued (the clock times are anchored to the visit day)', async () => {
      const h = harness({ sendResult: { sent: false, blocked: true, deferred: true, code: 'QUIET_HOURS_HOLD', nextAllowedAt: '2026-10-01T12:00:00.000Z' } });
      const tx = txHarness();
      h.deps.db = tx.db;
      expect(await sendLawnWateringSms(h.state, h.deps)).toEqual({ status: 'skipped_quiet_hours' });
      expect(tx.inserts).toHaveLength(0);
      expect(h.state.notes).toMatchObject({ lawnWateringSmsStatus: 'skipped_quiet_hours', lawnWateringSmsDeliveryUnverifiedAt: null });
      expect(lawnWateringSmsAlreadyHandled(h.state.notes)).toBe(true);
    });
  });
});

describe('freshness: never yesterday\'s instruction', () => {
  // 2:40 PM ET on Sep 30.
  const FROZEN = '2026-09-30T18:40:00Z';
  const at = (iso) => Date.parse(iso);
  test('same ET day before the deadline sends', () => {
    expect(lawnWateringSmsPlan(planArgs({ completedAt: FROZEN, nowMs: at('2026-09-30T19:00:00Z') })).send).toBe(true);
  });
  test('a completion resumed the next ET day is stale', () => {
    // 12:30 AM ET Oct 1.
    expect(lawnWateringSmsPlan(planArgs({ completedAt: FROZEN, nowMs: at('2026-10-01T04:30:00Z') }))).toEqual({ send: false, reason: 'stale' });
  });
  test('past the instruction deadline is stale, even the same day', () => {
    const instruction = { ...HOLD, expiresAt: '2026-09-30T22:00:00.000Z' };
    expect(lawnWateringSmsPlan(planArgs({ instruction, completedAt: FROZEN, nowMs: at('2026-09-30T22:00:00Z') }))).toEqual({ send: false, reason: 'stale' });
    expect(lawnWateringSmsPlan(planArgs({ instruction, completedAt: FROZEN, nowMs: at('2026-09-30T21:59:00Z') })).send).toBe(true);
  });
  test('a drying hold then water-in (expiresAt null) is stale at the water-in deadline', () => {
    const instruction = { ...HOLD, state: 'hold_then_water_in', expiresAt: null, waterInBy: '2026-09-30T20:00:00.000Z' };
    expect(lawnWateringSmsPlan(planArgs({ instruction, completedAt: FROZEN, nowMs: at('2026-09-30T19:59:00Z') })).send).toBe(true);
    expect(lawnWateringSmsPlan(planArgs({ instruction, completedAt: FROZEN, nowMs: at('2026-09-30T20:00:00Z') }))).toEqual({ send: false, reason: 'stale' });
  });
  test('an unknown completion time fails closed', () => {
    expect(lawnWateringSmsPlan(planArgs({ completedAt: null }))).toEqual({ send: false, reason: 'stale' });
  });
});

describe('round 1 fixes', () => {
  test('a flow that requested no completion text (operator toggle, Fast Complete, a grouped stop) sends no watering text', () => {
    expect(lawnWateringSmsPlan(planArgs({ completionTextRequested: false }))).toEqual({ send: false, reason: 'completion_text_not_requested' });
  });
  test('the text uses the ASCII apostrophe so it stays GSM-7', () => {
    const instruction = { ...HOLD, lines: ['Hold off watering until after today\u2019s treatment dries.'] };
    const plan = lawnWateringSmsPlan(planArgs({ instruction }));
    expect(plan.vars.watering_lines).toBe("Hold off watering until after today's treatment dries.");
  });
  test('the inch fractions are written 1/2, 1/4, 3/4 so the text stays GSM-7', () => {
    const instruction = { ...HOLD, lines: ['Today\u2019s treatment needs about ½ inch of water by Wed, Oct 14 at 2 PM.', 'Water in with about ¼ inch, or ¾ inch.'] };
    const plan = lawnWateringSmsPlan(planArgs({ instruction }));
    expect(plan.vars.watering_lines).toBe("Today's treatment needs about 1/2 inch of water by Wed, Oct 14 at 2 PM. Water in with about 1/4 inch, or 3/4 inch.");
  });
  test('freshness is judged against the completion instant, not a later freeze', () => {
    // Completed yesterday 2:40 PM ET; resumed (and frozen) today 10 AM ET.
    expect(lawnWateringSmsPlan(planArgs({ completedAt: '2026-09-30T18:40:00Z', nowMs: Date.parse('2026-10-01T14:00:00Z') })))
      .toEqual({ send: false, reason: 'stale' });
  });
});

describe('purpose, policy and template registry', () => {
  test('lawn_watering_instruction is a registered purpose with the completion text policy', () => {
    expect(policy.MESSAGE_PURPOSES).toContain('lawn_watering_instruction');
    expect(policy.PURPOSE_POLICY.lawn_watering_instruction).toEqual(policy.PURPOSE_POLICY.service_completion);
  });
  test('fits the audit table purpose column (varchar 32)', () => {
    expect('lawn_watering_instruction'.length).toBeLessThanOrEqual(32);
  });
  test('maps to its own template key for the per-template kill switch', () => {
    expect(mapPurposeToMessageType('lawn_watering_instruction')).toBe('lawn_watering_instruction');
  });
  test('the admin editor refuses a body that drops {watering_lines}', () => {
    expect(REQUIRED_TEMPLATE_PLACEHOLDERS.lawn_watering_instruction).toEqual(['watering_lines']);
  });
});

describe('completion route wiring', () => {
  const source = fs.readFileSync(path.join(__dirname, '../services/complete-scheduled-service.js'), 'utf8');

  test('the watering text is attempted on every exit of the completion text lane', () => {
    const calls = source.match(/await sendLawnWateringSmsOnce\(\);/g) || [];
    expect(calls).toHaveLength(4);
    // dispute-hold hand-over failure, before its release-for-resume 503
    expect(source).toMatch(/await sendLawnWateringSmsOnce\(\);\s*\n\s*await queueServiceReportEmailIfEligible\(\);\s*\n\s*await sendPayerInvoiceToApIfEligible\(\);\s*\n\s*const released = await CompletionAttempts\.releaseCompletionAttemptForResume\(completionAttempt, handOverErr\)/);
    // token-withheld early exit, before the release-for-resume 503
    expect(source).toMatch(/await sendLawnWateringSmsOnce\(\);\s*\n\s*\/\/ The payer AP channel[\s\S]*?const withheldErr/);
    // completion-text resume exit
    expect(source).toMatch(/const exitForCompletionSmsResume = async \(sendErr\) => \{\s*\n\s*await queueServiceReportEmailIfEligible\(\);\s*\n[^\n]*\n\s*await sendLawnWateringSmsOnce\(\);/);
    // end of the completion text chain, before the email queue
    expect(source).toMatch(/skipping retry send`\);\s*\n\s*\}\s*\n\s*\/\/ After the completion text[^\n]*\n\s*await sendLawnWateringSmsOnce\(\);\s*\n\s*\n\s*await queueServiceReportEmailIfEligible\(\);/);
  });

  test('the closure hands the sender the live delivery posture and the shared notes object', () => {
    const closure = source.slice(source.indexOf('const sendLawnWateringSmsOnce'), source.indexOf('const sendLawnWateringSmsOnce') + 900);
    expect(closure).toContain('notes: recordStructuredNotes');
    expect(closure).toContain('isBackfill: isBackfillCompletion');
    expect(closure).toContain('deliveryMode: typedDeliveryMode');
    expect(closure).toContain('internalOnly: isInternalOnlyCompletion');
    expect(closure).toContain('mergeNotes: mergeRecordNotesKeys');
  });
});

// GATE_LAWN_WATERING_EVERY_VISIT (owner 2026-10-22: "for all combinations, a text goes out, but the text is accurate").
describe('every lawn visit gets a watering text or an office alert', () => {
  const { composeAdminAlert } = require('../services/admin-alert-compose');
  const ENV_KEYS = ['GATE_LAWN_WATERING_SMS', 'GATE_LAWN_WATERING_RULE', 'GATE_LAWN_WATERING_EVERY_VISIT'];
  let saved;
  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    process.env.GATE_LAWN_WATERING_SMS = 'true';
    process.env.GATE_LAWN_WATERING_RULE = 'true';
    process.env.GATE_LAWN_WATERING_EVERY_VISIT = 'true';
    jest.clearAllMocks();
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  });

  const NONE = { state: 'none', lines: ['No watering change from today’s treatment.'] };
  const LONG_NAME = 'LESCO T-Storm Flowable Thiophanate-Methyl 46.2 Systemic Liquid Fungicide';

  function harness({ notes = {}, noClaim = null } = {}) {
    const sendCustomerMessage = jest.fn(async () => ({ sent: true }));
    const getTemplate = jest.fn(async (key, vars) => `Watering after today's visit: ${vars.watering_lines}`);
    const mergeNotes = jest.fn(async () => {});
    // The real composer: an alert that breaks the notification rules throws here.
    const raiseAdminAlert = jest.fn(async (category, spec) => ({ id: 'n-1', composed: composeAdminAlert(spec) }));
    const state = {
      record: { id: 'rec-1', structured_notes: {} },
      svc: { id: 'svc-1', customer_id: 'cust-1', cust_phone: '+19415550100' },
      notes,
      isBackfill: false,
      deliveryMode: 'auto_send',
      internalOnly: false,
      completionTextRequested: true,
      noClaim,
    };
    const deps = { db: {}, sendCustomerMessage, getTemplate, mergeNotes, raiseAdminAlert, throwIfDeliveryUnverified: (r) => r };
    return { state, deps, sendCustomerMessage, mergeNotes, raiseAdminAlert };
  }

  test('the plan sends a "no watering change" visit only under the gate', () => {
    expect(lawnWateringSmsPlan(planArgs({ instruction: NONE, everyVisit: true }))).toMatchObject({ send: true });
    expect(lawnWateringSmsPlan(planArgs({ instruction: NONE }))).toEqual({ send: false, reason: 'no_instruction' });
  });

  test('a frozen "none" instruction goes out as its own text', async () => {
    const h = harness({ notes: { lawnWateringFreeze: { wateringInstruction: { ...NONE, completedAt: new Date().toISOString() } } } });
    expect(await sendLawnWateringSms(h.state, h.deps)).toEqual({ status: 'sent' });
    expect(h.sendCustomerMessage.mock.calls[0][0].body).toBe("Watering after today's visit: No watering change from today's treatment.");
  });

  test.each([
    ['unruled_product', [LONG_NAME], /T-Storm.*has no watering rule/],
    // A guessed rule (label first): the alert names the guessed product.
    ['unchecked_rules', ['LESCO 24-0-10 Turfgrass Granular Fertilizer'], /LESCO 24-0-10.*has no checked watering rule/],
    ['water_in_conflict', ['Dylox 6.2 G Granular Insecticide', 'LESCO Three-Way Selective Herbicide'], /Dylox.*and LESCO Three-Way.*need opposite watering/],
    ['same_day_too_late', ['Dylox 6.2 G Granular Insecticide'], /Dylox.*must be watered in today/],
    ['inputs_unreadable', [], /watering settings could not be read/],
    // The report was built, with no tech-confirmed photo read: the alert says that, not that the report failed.
    ['no_lawn_read', [], /No lawn photo read was confirmed for this visit/],
    ['report_not_built', [], /lawn report for this visit could not be built/],
  ])('no instruction (%s): one marker, one office alert that meets the notification rules', async (reason, products, why) => {
    const h = harness({ noClaim: { reason, products } });
    expect(await sendLawnWateringSms(h.state, h.deps)).toEqual({ status: 'alerted_no_instruction' });
    expect(h.sendCustomerMessage).not.toHaveBeenCalled();
    expect(h.mergeNotes).toHaveBeenCalledWith('rec-1', { lawnWateringSmsStatus: 'skipped_no_instruction', lawnWateringNoClaimReason: reason });
    expect(h.raiseAdminAlert).toHaveBeenCalledTimes(1);
    const [category, spec, opts] = h.raiseAdminAlert.mock.calls[0];
    expect(category).toBe('service');
    expect(spec).toMatchObject({ area: 'Comms', severity: 'needs-you', subject: { type: 'visit', id: 'svc-1' } });
    expect(spec.why).toMatch(why);
    expect(spec.why.length).toBeLessThanOrEqual(110);
    expect(opts).toMatchObject({ dedupeKey: 'lawn-watering-no-instruction:rec-1', metadata: { reason, products } });
    expect(opts.detail).toContain(products[0] || (reason === 'no_lawn_read' ? 'No lawn photo read was confirmed' : 'could not be'));
    const fix = {
      inputs_unreadable: /check the products logged on this visit\.$/,
      report_not_built: /check the products logged on this visit\.$/,
      no_lawn_read: /customer got no watering text\. Text the customer the watering steps from the product labels\.$/,
    }[reason] || /fix the product's watering rule\.$/;
    expect(opts.detail).toMatch(fix);
  });

  // Owner 2026-10-27: a visit closed on a later day than it was worked gets no text, no alert and no
  // technician note; the marker records why and ends the obligation for a resume.
  test('a late close: the marker only, no text, no office alert, no technician note', async () => {
    const h = harness({ noClaim: { reason: 'late_close', products: [] } });
    const sendTechNotification = jest.fn(async () => ({ id: 'tn-1' }));
    const out = await sendLawnWateringSms(h.state, { ...h.deps, sendTechNotification });
    expect(out).toEqual({ status: 'skipped_late_close' });
    expect(h.mergeNotes).toHaveBeenCalledTimes(1);
    expect(h.mergeNotes).toHaveBeenCalledWith('rec-1', { lawnWateringSmsStatus: 'skipped_late_close', lawnWateringNoClaimReason: 'late_close' });
    expect(h.state.notes).toMatchObject({ lawnWateringSmsStatus: 'skipped_late_close' });
    expect(h.raiseAdminAlert).not.toHaveBeenCalled();
    expect(sendTechNotification).not.toHaveBeenCalled();
    expect(h.sendCustomerMessage).not.toHaveBeenCalled();
    // The marker ends the obligation: a resumed completion does nothing more.
    expect(lawnWateringSmsAlreadyHandled(h.state.notes)).toBe(true);
  });

  test('a late close whose marker write fails still sends and raises nothing', async () => {
    const h = harness({ noClaim: { reason: 'late_close', products: [] } });
    h.deps.mergeNotes = jest.fn(async () => { throw new Error('db down'); });
    expect(await sendLawnWateringSms(h.state, h.deps)).toEqual({ status: 'skipped_late_close' });
    expect(h.raiseAdminAlert).not.toHaveBeenCalled();
    expect(h.sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a visit that logged no product, or had no text due, raises nothing', async () => {
    const empty = harness({ noClaim: { reason: 'no_products', products: [] } });
    expect(await sendLawnWateringSms(empty.state, empty.deps)).toEqual({ status: 'skip_no_instruction' });
    const noPhone = harness({ noClaim: { reason: 'unruled_product', products: ['X'] } });
    noPhone.state.svc.cust_phone = null;
    expect(await sendLawnWateringSms(noPhone.state, noPhone.deps)).toEqual({ status: 'skip_no_phone' });
    for (const h of [empty, noPhone]) {
      expect(h.raiseAdminAlert).not.toHaveBeenCalled();
      expect(h.mergeNotes).not.toHaveBeenCalled();
    }
  });

  test('gate off: no alert and a "none" instruction still sends nothing', async () => {
    delete process.env.GATE_LAWN_WATERING_EVERY_VISIT;
    const h = harness({ noClaim: { reason: 'unruled_product', products: ['X'] } });
    expect(await sendLawnWateringSms(h.state, h.deps)).toEqual({ status: 'skip_no_instruction' });
    expect(h.raiseAdminAlert).not.toHaveBeenCalled();
  });
});

describe('the no-instruction alert is on record before the visit is marked handled', () => {
  const saved = Object.fromEntries(['GATE_LAWN_WATERING_SMS', 'GATE_LAWN_WATERING_RULE', 'GATE_LAWN_WATERING_EVERY_VISIT'].map((k) => [k, process.env[k]]));
  beforeEach(() => {
    process.env.GATE_LAWN_WATERING_SMS = 'true';
    process.env.GATE_LAWN_WATERING_RULE = 'true';
    process.env.GATE_LAWN_WATERING_EVERY_VISIT = 'true';
  });
  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
  const state = () => ({
    record: { id: 'rec-2', structured_notes: {} },
    svc: { id: 'svc-2', customer_id: 'cust-2', cust_phone: '+19415550100' },
    notes: {},
    deliveryMode: 'auto_send',
    completionTextRequested: true,
    noClaim: { reason: 'unruled_product', products: ['Medallion SC'] },
  });

  test.each([
    ['returns null', async () => null],
    ['throws', async () => { throw new Error('insert failed'); }],
  ])('an alert that %s leaves the visit unmarked, so a retry raises it', async (_, raiseAdminAlert) => {
    const mergeNotes = jest.fn(async () => {});
    const out = await sendLawnWateringSms(state(), { mergeNotes, raiseAdminAlert, sendCustomerMessage: jest.fn(), getTemplate: jest.fn() });
    expect(out).toEqual({ status: 'skip_no_instruction' });
    expect(mergeNotes).not.toHaveBeenCalled();
  });

  test('the marker follows a recorded alert', async () => {
    const calls = [];
    const raiseAdminAlert = jest.fn(async () => { calls.push('alert'); return { id: 'n-2' }; });
    const mergeNotes = jest.fn(async () => { calls.push('marker'); });
    const out = await sendLawnWateringSms(state(), { mergeNotes, raiseAdminAlert, sendCustomerMessage: jest.fn(), getTemplate: jest.fn() });
    expect(out).toEqual({ status: 'alerted_no_instruction' });
    expect(calls).toEqual(['alert', 'marker']);
  });
});

describe('GATE_LAWN_WATERING_TEXT_FORECAST: the rain sentence closes the text', () => {
  const ENV_KEYS = ['GATE_LAWN_WATERING_SMS', 'GATE_LAWN_WATERING_RULE', 'GATE_LAWN_WATERING_FORECAST', 'GATE_LAWN_WATERING_TEXT_FORECAST'];
  let saved;
  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) process.env[k] = 'true';
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  });
  const LINE = 'About ½ inch of rain is forecast by Thu 8 AM. If at least ¼ inch has fallen by then, it counts as watering in today’s treatment. If it has not, run the watering above right away.';
  const frozen = () => ({
    state: 'water_in',
    lines: ['Water in today’s treatment with about ¼ inch by Thu 2 PM.', 'Run it even if it is not your usual day.'],
    completedAt: new Date().toISOString(),
    waterInBy: new Date(Date.now() + 3600000).toISOString(),
    waterInInches: 0.25,
    forecast: { line: LINE, inches: 0.5, source: 'open_meteo', agreement: { source: 'nws', peakChance: 70, hours: 3 } },
  });
  const run = async () => {
    const getTemplate = jest.fn(async (key, vars) => `Watering after today's visit: ${vars.watering_lines}`);
    const state = {
      record: { id: 'rec-f', structured_notes: {} },
      svc: { id: 'svc-f', customer_id: 'cust-f', cust_phone: '+19415550100' },
      notes: { lawnWateringFreeze: { wateringInstruction: frozen() } },
      isBackfill: false,
      deliveryMode: 'auto_send',
      internalOnly: false,
      completionTextRequested: true,
    };
    await sendLawnWateringSms(state, { db: {}, sendCustomerMessage: jest.fn(async () => ({ sent: true })), getTemplate, mergeNotes: jest.fn(async () => {}), throwIfDeliveryUnverified: (r) => r });
    return getTemplate.mock.calls[0][1].watering_lines;
  };

  test('the plan appends the sentence after the steps, in GSM-7 characters', () => {
    const plan = lawnWateringSmsPlan(planArgs({ instruction: { state: 'water_in', lines: ['One.'] }, forecastLine: LINE }));
    expect(plan.vars.watering_lines).toBe("One. About 1/2 inch of rain is forecast by Thu 8 AM. If at least 1/4 inch has fallen by then, it counts as watering in today's treatment. If it has not, run the watering above right away.");
    expect(lawnWateringSmsPlan(planArgs({ instruction: { state: 'water_in', lines: ['One.'] } })).vars.watering_lines).toBe('One.');
  });

  test('both forecast gates on: the frozen sentence is in the text', async () => {
    expect(await run()).toBe("Water in today's treatment with about 1/4 inch by Thu 2 PM. Run it even if it is not your usual day. About 1/2 inch of rain is forecast by Thu 8 AM. If at least 1/4 inch has fallen by then, it counts as watering in today's treatment. If it has not, run the watering above right away.");
  });

  test('a short water-in beside a long one (instruction.later) never carries the sentence', () => {
    const { textForecastLine } = require('../services/service-report/lawn-watering-forecast');
    expect(textForecastLine(frozen())).toBe(LINE);
    expect(textForecastLine({ ...frozen(), later: { waterInInches: 0.5, waterInBy: new Date(Date.now() + 7 * 86400000).toISOString() } })).toBeNull();
  });

  test('a sentence frozen from Open-Meteo alone (no NWS agreement) never reaches the text', async () => {
    const steps = "Water in today's treatment with about 1/4 inch by Thu 2 PM. Run it even if it is not your usual day.";
    for (const agreement of [undefined, { source: 'nws', peakChance: 50, hours: 2 }, { source: 'open_meteo', peakChance: 90, hours: 2 }]) {
      const getTemplate = jest.fn(async (key, vars) => vars.watering_lines);
      const instruction = frozen();
      if (agreement) instruction.forecast.agreement = agreement; else delete instruction.forecast.agreement;
      const state = {
        record: { id: 'rec-l', structured_notes: {} },
        svc: { id: 'svc-l', customer_id: 'cust-l', cust_phone: '+19415550100' },
        notes: { lawnWateringFreeze: { wateringInstruction: instruction } },
        isBackfill: false,
        deliveryMode: 'auto_send',
        internalOnly: false,
        completionTextRequested: true,
      };
      await sendLawnWateringSms(state, { db: {}, sendCustomerMessage: jest.fn(async () => ({ sent: true })), getTemplate, mergeNotes: jest.fn(async () => {}), throwIfDeliveryUnverified: (r) => r });
      expect(getTemplate.mock.calls[0][1].watering_lines).toBe(steps);
    }
  });

  test.each(['GATE_LAWN_WATERING_TEXT_FORECAST', 'GATE_LAWN_WATERING_FORECAST'])('%s off: the text is the steps only, as today', async (key) => {
    delete process.env[key];
    expect(await run()).toBe("Water in today's treatment with about 1/4 inch by Thu 2 PM. Run it even if it is not your usual day.");
  });
});

describe('GATE_LAWN_WATERING_SHORT_TEXT', () => {
  const { buildWateringInstruction } = require('../services/service-report/lawn-watering-instruction');
  const ENV_KEYS = ['GATE_LAWN_WATERING_SMS', 'GATE_LAWN_WATERING_RULE', 'GATE_LAWN_WATERING_SHORT_TEXT'];
  let saved;
  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    process.env.GATE_LAWN_WATERING_SMS = 'true';
    process.env.GATE_LAWN_WATERING_RULE = 'true';
    jest.clearAllMocks();
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  });

  const DRY = { mode: 'hold', hold_until: 'dry', source: 'label' };
  const WATER = { mode: 'water_in', water_in_inches: 0.25, water_in_by_hours: 24, source: 'label' };
  const fresh = () => buildWateringInstruction({ rules: [DRY, WATER], completedAt: new Date().toISOString(), plainWhenNoSetup: true, labelFirst: true });

  test('plan: short steps under the short template; off keeps the plan shape byte for byte', () => {
    const instruction = fresh();
    const off = lawnWateringSmsPlan(planArgs({ instruction, completedAt: instruction.completedAt }));
    expect(Object.keys(off)).toEqual(['send', 'vars']);
    expect(off.vars.watering_lines).toMatch(/^Skip your turf watering until today's treatment has dried\./);
    const on = lawnWateringSmsPlan(planArgs({ instruction, completedAt: instruction.completedAt, shortText: true }));
    expect(on.templateKey).toBe('lawn_watering_instruction_short');
    expect(on.vars.watering_lines).toMatch(/^Let the treatment dry first\. Then water about 1\/4 inch by .+, even on an off day\.$/);
  });

  test('plan: an unknown shape sends the full lines', () => {
    const plan = lawnWateringSmsPlan(planArgs({ shortText: true }));
    expect(plan).toEqual({ send: true, vars: { watering_lines: 'Skip watering until 8:00 PM tonight. Water normally after that.' } });
  });

  test('plan: the forecast sentence goes short too', () => {
    const instruction = { ...fresh(), forecast: { inches: 0.4, checkpointLabel: 'Sat 1 PM' } };
    const plan = lawnWateringSmsPlan(planArgs({ instruction, completedAt: instruction.completedAt, shortText: true, forecastLine: 'About 0.4 inch of rain is forecast by Sat 1 PM. Long.' }));
    expect(plan.vars.watering_lines).toMatch(/Rain forecast: about 0\.4 inch by Sat 1 PM\. If 1\/4 inch falls by then, skip the run\. If not, run it\.$/);
  });

  function harness(templates) {
    const sendCustomerMessage = jest.fn(async () => ({ sent: true }));
    const getTemplate = jest.fn(async (key, vars) => (templates[key] ? templates[key].replace('{watering_lines}', vars.watering_lines) : null));
    const state = {
      record: { id: 'rec-1', structured_notes: {} },
      svc: { id: 'svc-1', customer_id: 'cust-1', cust_phone: '+19415550100' },
      notes: { lawnWateringFreeze: { wateringInstruction: fresh() } },
      isBackfill: false,
      deliveryMode: 'auto_send',
      internalOnly: false,
      completionTextRequested: true,
    };
    const deps = { db: {}, sendCustomerMessage, getTemplate, mergeNotes: jest.fn(async () => {}), throwIfDeliveryUnverified: (r) => r };
    return { state, deps, sendCustomerMessage, getTemplate };
  }
  const TEMPLATES = {
    lawn_watering_instruction: "Watering after today's visit: {watering_lines}",
    lawn_watering_instruction_short: 'Lawn watering: {watering_lines}',
  };

  test('gate on: sends the short text under the short template', async () => {
    process.env.GATE_LAWN_WATERING_SHORT_TEXT = 'true';
    const h = harness(TEMPLATES);
    expect(await sendLawnWateringSms(h.state, h.deps)).toEqual({ status: 'sent' });
    const sent = h.sendCustomerMessage.mock.calls[0][0];
    expect(sent.body).toMatch(/^Lawn watering: Let the treatment dry first\. Then water about 1\/4 inch by /);
    expect(sent.body.length).toBeLessThanOrEqual(160);
    expect(sent.purpose).toBe('lawn_watering_instruction');
    expect(sent.metadata.original_message_type).toBe('lawn_watering_instruction');
    expect(sent.metadata.templateKey).toBe('lawn_watering_instruction_short');
  });

  test('gate on, short row missing: sends the full text under the original row', async () => {
    process.env.GATE_LAWN_WATERING_SHORT_TEXT = 'true';
    const h = harness({ lawn_watering_instruction: TEMPLATES.lawn_watering_instruction });
    expect(await sendLawnWateringSms(h.state, h.deps)).toEqual({ status: 'sent' });
    const sent = h.sendCustomerMessage.mock.calls[0][0];
    expect(sent.body).toMatch(/^Watering after today's visit: Skip your turf watering until today's treatment has dried\./);
    expect(sent.metadata.templateKey).toBe('lawn_watering_instruction');
  });

  test('gate off: the full text, the original row, never the short one', async () => {
    delete process.env.GATE_LAWN_WATERING_SHORT_TEXT;
    const h = harness(TEMPLATES);
    expect(await sendLawnWateringSms(h.state, h.deps)).toEqual({ status: 'sent' });
    expect(h.getTemplate).toHaveBeenCalledTimes(1);
    expect(h.getTemplate.mock.calls[0][0]).toBe('lawn_watering_instruction');
  });
});
