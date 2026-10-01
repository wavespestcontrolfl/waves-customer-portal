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
  test.each(['sent', 'skipped_quiet_hours', 'skipped_blocked', 'skipped_anything'])('%s is final', (status) => {
    expect(lawnWateringSmsAlreadyHandled({ lawnWateringSmsStatus: status })).toBe(true);
  });
  test('a definite failure stays retryable, an uncertainty fence does not', () => {
    expect(lawnWateringSmsAlreadyHandled({ lawnWateringSmsStatus: 'failed' })).toBe(false);
    expect(lawnWateringSmsAlreadyHandled({ lawnWateringSmsStatus: 'failed', lawnWateringSmsDeliveryUnverifiedAt: 'x' })).toBe(true);
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

  test('a definitely-rejected earlier attempt may try again on a resumed completion', async () => {
    const h = harness({ notes: { lawnWateringSmsStatus: 'failed', lawnWateringSmsError: 'PROVIDER_FAILURE' } });
    expect(await sendLawnWateringSms(h.state, h.deps)).toEqual({ status: 'sent' });
    expect(h.sendCustomerMessage).toHaveBeenCalledTimes(1);
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

  test('a policy block is final: skipped_blocked, never retried', async () => {
    const h = harness({ sendResult: { sent: false, blocked: true, code: 'OPTED_OUT' } });
    expect(await sendLawnWateringSms(h.state, h.deps)).toEqual({ status: 'skipped_blocked' });
    expect(h.state.notes).toMatchObject({ lawnWateringSmsStatus: 'skipped_blocked', lawnWateringSmsBlockCode: 'OPTED_OUT', lawnWateringSmsDeliveryUnverifiedAt: null });
    expect(lawnWateringSmsAlreadyHandled(h.state.notes)).toBe(true);
  });

  test('a definite provider rejection lifts the fence and stays retryable', async () => {
    const h = harness({ sendResult: { sent: false, code: 'PROVIDER_FAILURE' } });
    expect(await sendLawnWateringSms(h.state, h.deps)).toEqual({ status: 'failed' });
    expect(h.state.notes.lawnWateringSmsStatus).toBe('failed');
    expect(h.state.notes.lawnWateringSmsDeliveryUnverifiedAt).toBeNull();
    expect(lawnWateringSmsAlreadyHandled(h.state.notes)).toBe(false);
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

  test('a throw that carries a definite not_sent outcome lifts the fence, so a resumed completion retries', async () => {
    const h = harness();
    h.sendCustomerMessage.mockRejectedValueOnce(Object.assign(new Error('audit failed after reject'), { providerOutcome: { sent: false, deliveryOutcome: 'not_sent' } }));
    expect(await sendLawnWateringSms(h.state, h.deps)).toEqual({ status: 'failed' });
    expect(h.state.notes).toMatchObject({ lawnWateringSmsStatus: 'failed', lawnWateringSmsDeliveryUnverifiedAt: null });
    expect(lawnWateringSmsAlreadyHandled(h.state.notes)).toBe(false);
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

  test('the watering text is attempted on all three exits of the completion text lane', () => {
    const calls = source.match(/await sendLawnWateringSmsOnce\(\);/g) || [];
    expect(calls).toHaveLength(3);
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
