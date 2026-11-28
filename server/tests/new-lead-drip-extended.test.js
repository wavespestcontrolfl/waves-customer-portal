'use strict';

/**
 * GATE_NEW_LEAD_DRIP_EXTENDED (owner 2026-11-27 "ok go", Decision 2):
 *   1. Email Steps 3 (Day 10) & 4 (Day 21) in new_lead sequence (requires BOTH base & extended gates,
 *      stored enabled=false, gate-controlled in Admin, guarded by all 7 stops).
 *   2. Phone-only residential lead SMS drip (Day 2 & Day 5, 8 AM-8 PM ET, recorded consent required,
 *      durable send claims, provider handoff recheck, fail-closed suppression, paginated batching).
 * Ships 100% DARK. Synthetic test records only.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/sendgrid-mail', () => ({ isConfigured: jest.fn(() => true), sendOne: jest.fn() }));

const stepsMigration = require('../models/migrations/20261128031000_new_lead_drip_extended_steps');
const claimsMigration = require('../models/migrations/20261128032000_new_lead_phone_drip_sends');
const { newLeadDripExtendedLive } = require('../config/feature-gates');
const {
  NEW_LEAD_DRIP_STEP_IDS,
  NEW_LEAD_EXTENDED_STEP_IDS,
  isNewLeadDripStep,
  isGateControlledNewLeadStepId,
} = require('../services/new-lead-drip-stops');
const {
  STEP_1_ACTIVITY,
  DRIP_ENTRY_POINT,
  buildPhoneDripCopy,
  isWithinSendHoursET,
  pickDueStep,
  verifyLeadSmsConsent,
  leadShouldStop,
  processPhoneOnlyLeadSmsDrip,
} = require('../services/new-lead-phone-sms-drip');

function chain({ result = [], first = null, returning = [], firstError = null } = {}) {
  const q = {};
  [
    'where', 'whereRaw', 'whereIn', 'whereNotIn', 'whereNull', 'whereNotNull',
    'whereNotExists', 'orWhere', 'andWhere', 'orderBy', 'offset', 'limit', 'select',
    'onConflict', 'ignore',
  ].forEach((m) => { q[m] = jest.fn(() => q); });
  q.first = jest.fn(async () => { if (firstError) throw firstError; return first; });
  q.insert = jest.fn(() => q);
  q.returning = jest.fn(async () => returning);
  q.update = jest.fn(async () => 1);
  q.del = jest.fn(async () => 1);
  q.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  q.catch = (reject) => Promise.resolve(result).catch(reject);
  return q;
}

function makeDb(queues) {
  const map = new Map(Object.entries(queues).map(([k, v]) => [k, [...v]]));
  const fn = jest.fn((table) => {
    const q = map.get(table);
    if (!q || !q.length) throw new Error(`Unexpected db table: ${table}`);
    return q.shift();
  });
  fn.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  return fn;
}

describe('GATE_NEW_LEAD_DRIP_EXTENDED gate reader', () => {
  let saved;
  beforeEach(() => { saved = process.env.GATE_NEW_LEAD_DRIP_EXTENDED; delete process.env.GATE_NEW_LEAD_DRIP_EXTENDED; });
  afterEach(() => {
    if (saved === undefined) delete process.env.GATE_NEW_LEAD_DRIP_EXTENDED;
    else process.env.GATE_NEW_LEAD_DRIP_EXTENDED = saved;
  });

  test('is strict === "true" and dark by default', () => {
    expect(newLeadDripExtendedLive()).toBe(false);
    process.env.GATE_NEW_LEAD_DRIP_EXTENDED = '1';
    expect(newLeadDripExtendedLive()).toBe(false);
    process.env.GATE_NEW_LEAD_DRIP_EXTENDED = 'true';
    expect(newLeadDripExtendedLive()).toBe(true);
  });
});

describe('migrations & stop recognition', () => {
  test('extended email steps migration seeds Steps 3 & 4 stored enabled=false with Waves copy', async () => {
    const inserts = [];
    const knex = jest.fn((table) => {
      const q = {};
      q.where = jest.fn(() => q);
      if (table === 'automation_templates') {
        q.first = jest.fn(async () => ({ key: 'new_lead' }));
        return q;
      }
      q.insert = jest.fn((row) => { inserts.push(row); return q; });
      q.onConflict = jest.fn(() => q);
      q.ignore = jest.fn(async () => undefined);
      return q;
    });
    knex.schema = { hasTable: jest.fn(async () => true) };

    await stepsMigration.up(knex);
    expect(inserts.map((r) => [r.id, r.step_order, r.delay_hours, r.enabled])).toEqual([
      [NEW_LEAD_EXTENDED_STEP_IDS[0], 3, 120, false],
      [NEW_LEAD_EXTENDED_STEP_IDS[1], 4, 264, false],
    ]);
    expect(inserts[0].text_body).not.toMatch(/covers inside and outside/i);
    expect(inserts[0].text_body + inserts[1].text_body).not.toMatch(/Adam|Lawn Care/i);
    await expect(stepsMigration.down()).resolves.toBeUndefined();
  });

  test('durable send claims migration creates and drops new_lead_phone_drip_sends', async () => {
    const created = [];
    const dropped = [];
    const knex = {
      fn: { now: () => 'NOW' },
      raw: (s) => s,
      schema: {
        hasTable: jest.fn(async () => false),
        createTable: jest.fn(async (name, fn) => {
          created.push(name);
          const col = () => ({ primary: col, defaultTo: col, notNullable: col, nullable: col, references: col, inTable: col, onDelete: col });
          fn({ uuid: col, smallint: col, string: col, text: col, timestamp: col, unique: jest.fn(), index: jest.fn() });
        }),
        dropTableIfExists: jest.fn(async (name) => { dropped.push(name); }),
      },
    };
    await claimsMigration.up(knex);
    await claimsMigration.down(knex);
    expect(created).toEqual(['new_lead_phone_drip_sends']);
    expect(dropped).toEqual(['new_lead_phone_drip_sends']);
  });

  test('isNewLeadDripStep & isGateControlledNewLeadStepId cover Steps 1-4 without mutating NEW_LEAD_DRIP_STEP_IDS', () => {
    expect(NEW_LEAD_DRIP_STEP_IDS).toHaveLength(2);
    expect(NEW_LEAD_EXTENDED_STEP_IDS).toHaveLength(2);
    expect(isNewLeadDripStep('new_lead', { id: NEW_LEAD_EXTENDED_STEP_IDS[0] })).toBe(true);
    expect(isNewLeadDripStep('new_lead', { id: NEW_LEAD_EXTENDED_STEP_IDS[1] })).toBe(true);
    expect(isGateControlledNewLeadStepId(NEW_LEAD_EXTENDED_STEP_IDS[0])).toBe(true);
    expect(isGateControlledNewLeadStepId('hand-added')).toBe(false);
  });

  test('automation-runner never loads Steps 3-4 when base GATE_NEW_LEAD_DRIP_STEPS is off (preserves Day 10/21 delays)', async () => {
    const savedBase = process.env.GATE_NEW_LEAD_DRIP_STEPS;
    const savedExt = process.env.GATE_NEW_LEAD_DRIP_EXTENDED;
    delete process.env.GATE_NEW_LEAD_DRIP_STEPS;
    process.env.GATE_NEW_LEAD_DRIP_EXTENDED = 'true';
    try {
      const db = require('../models/db');
      const stepsQ = chain({ result: [] });
      db.mockImplementation((table) => {
        if (table === 'automation_steps') return stepsQ;
        return chain({ first: { key: 'new_lead', asm_group: 'newsletter' } });
      });
      const { hasLocalContent } = require('../services/automation-runner');
      await hasLocalContent('new_lead');
      expect(stepsQ.whereNotIn).toHaveBeenCalledWith('id', NEW_LEAD_EXTENDED_STEP_IDS);
    } finally {
      if (savedBase === undefined) delete process.env.GATE_NEW_LEAD_DRIP_STEPS;
      else process.env.GATE_NEW_LEAD_DRIP_STEPS = savedBase;
      if (savedExt === undefined) delete process.env.GATE_NEW_LEAD_DRIP_EXTENDED;
      else process.env.GATE_NEW_LEAD_DRIP_EXTENDED = savedExt;
    }
  });
});

describe('phone-only residential SMS drip pure helpers', () => {
  test('buildPhoneDripCopy uses Waves-only brand (no owner name) and STOP opt-out on Touch 1', () => {
    const s1 = buildPhoneDripCopy(1, { first_name: 'Jordan' });
    const s2 = buildPhoneDripCopy(2, { first_name: 'Jordan' });
    expect(s1).toContain("Hi Jordan, it's Waves.");
    expect(s1).toContain('Reply STOP to opt out.');
    expect(s1).not.toMatch(/Adam|Lawn/i);
    expect(s2).toContain("Hi Jordan, it's Waves.");
    expect(s2).not.toMatch(/Adam/i);
  });

  test('isWithinSendHoursET enforces 8 AM - 8 PM ET strictly', () => {
    expect(isWithinSendHoursET(new Date('2026-11-27T12:59:00Z'))).toBe(false);
    expect(isWithinSendHoursET(new Date('2026-11-27T13:00:00Z'))).toBe(true);
    expect(isWithinSendHoursET(new Date('2026-11-28T00:59:00Z'))).toBe(true);
    expect(isWithinSendHoursET(new Date('2026-11-28T01:00:00Z'))).toBe(false);
  });

  test('pickDueStep excludes estimate_sent/estimate_viewed, email leads, commercial leads, and enforces windows', () => {
    const now = new Date('2026-11-27T17:00:00Z');
    const base = {
      id: 'lead-1', phone: '+19415550111', email: null, status: 'new',
      deleted_at: null, converted_at: null, estimate_id: null, is_commercial: false,
    };
    const hoursAgo = (h) => new Date(now.getTime() - h * 3600 * 1000).toISOString();

    expect(pickDueStep({ ...base, created_at: hoursAgo(60) }, [], now)).toBe(1);
    expect(pickDueStep({ ...base, status: 'estimate_sent', created_at: hoursAgo(60) }, [], now)).toBeNull();
    expect(pickDueStep({ ...base, status: 'estimate_viewed', created_at: hoursAgo(60) }, [], now)).toBeNull();
    expect(pickDueStep({ ...base, created_at: hoursAgo(60), email: 'a@example.com' }, [], now)).toBeNull();
    expect(pickDueStep({ ...base, created_at: hoursAgo(130) }, [{ step: 1, status: 'sent', sent_at: hoursAgo(70) }], now)).toBe(2);
    expect(pickDueStep({ ...base, created_at: hoursAgo(130) }, [{ step: 1, status: 'uncertain', claimed_at: hoursAgo(70) }], now)).toBeNull();
  });
});

describe('recorded SMS consent verification', () => {
  test('rejects manually entered lead with no inbound call/SMS or web opt-in', async () => {
    const dbh = makeDb({});
    const manualLead = { id: 'lead-m', phone: '+19415550101', customer_id: null, twilio_call_sid: null, twilio_message_sid: null, lead_type: 'manual' };
    await expect(verifyLeadSmsConsent(dbh, manualLead, '9415550101')).resolves.toBeNull();
  });

  test('accepts carrier-verified inbound call ANI inquiry', async () => {
    const dbh = makeDb({ call_log: [chain({ first: { id: 'call-1' } })] });
    const callLead = { id: 'lead-c', phone: '+19415550102', customer_id: null, twilio_call_sid: 'CA123' };
    await expect(verifyLeadSmsConsent(dbh, callLead, '9415550102')).resolves.toEqual({
      status: 'transactional_allowed',
      source: 'inbound_call_inquiry',
    });
  });

  test('rejects customer who turned sms_enabled off even if call SID exists', async () => {
    const dbh = makeDb({ notification_prefs: [chain({ first: { sms_enabled: false, marketing_offers: true } })] });
    const lead = { id: 'lead-x', phone: '+19415550103', customer_id: 'cust-1', twilio_call_sid: 'CA999' };
    await expect(verifyLeadSmsConsent(dbh, lead, '9415550103')).resolves.toBeNull();
  });
});

describe('processPhoneOnlyLeadSmsDrip durability, handoff recheck, and pagination', () => {
  const NOW_DAYTIME = new Date('2026-11-27T17:00:00Z');
  const CALL_LEAD = {
    id: 'lead-10', first_name: 'Taylor', phone: '(941) 555-0144', email: null,
    customer_id: null, estimate_id: null, converted_at: null, is_commercial: false,
    status: 'new', deleted_at: null, created_at: new Date('2026-11-25T15:00:00Z'),
    twilio_call_sid: 'CA1010', twilio_message_sid: null, lead_type: 'phone_call', extracted_data: null,
  };

  test('gate off returns immediately with zero queries and zero sends', async () => {
    const dbh = jest.fn();
    const sendMessage = jest.fn();
    const res = await processPhoneOnlyLeadSmsDrip({
      now: NOW_DAYTIME, dbh, gates: { newLeadDripExtendedLive: () => false }, sendMessage,
    });
    expect(res).toEqual({ skipped: 'gate_off', checked: 0, sent: 0, stopped: 0, deferred: 0 });
    expect(dbh).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test('claims durably before dispatch, passes providerPreSendCheck, and settles claim to sent', async () => {
    const claimInsert = chain({ returning: [{ id: 'claim-1' }] });
    const claimUpdate = chain();
    const actInsert = chain();
    const dbh = makeDb({
      leads: [chain({ result: [CALL_LEAD] })],
      new_lead_phone_drip_sends: [chain({ result: [] }), claimInsert, claimUpdate],
      call_log: [chain({ first: { id: 'call-10' } })],
      estimates: [chain({ first: null })],
      sms_log: [chain({ first: null })],
      messaging_suppression: [chain({ first: null })],
      lead_activities: [actInsert],
    });
    const sendMessage = jest.fn(async () => ({ sent: true, blocked: false, deliveryOutcome: 'accepted', providerMessageId: 'SM123' }));

    const res = await processPhoneOnlyLeadSmsDrip({
      now: NOW_DAYTIME, dbh, gates: { newLeadDripExtendedLive: () => true }, sendMessage,
    });

    expect(res).toEqual({ skipped: null, checked: 1, sent: 1, stopped: 0, deferred: 0 });
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      to: '+19415550144',
      audience: 'lead',
      purpose: 'missed_call_followup',
      entryPoint: DRIP_ENTRY_POINT,
      consentBasis: { status: 'transactional_allowed', source: 'inbound_call_inquiry' },
      providerPreSendCheck: expect.any(Function),
    }));
    expect(claimUpdate.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'sent', provider_message_id: 'SM123' }));
    expect(actInsert.insert).toHaveBeenCalledWith(expect.objectContaining({ lead_id: 'lead-10', activity_type: STEP_1_ACTIVITY }));
  });

  test('providerPreSendCheck refuses send if lead phone changed before handoff', async () => {
    const claimInsert = chain({ returning: [{ id: 'claim-2' }] });
    const claimDelete = chain();
    const dbh = makeDb({
      leads: [
        chain({ result: [CALL_LEAD] }),
        chain({ first: { ...CALL_LEAD, phone: '+19415559999' } }), // live phone changed!
      ],
      new_lead_phone_drip_sends: [chain({ result: [] }), claimInsert, claimDelete],
      call_log: [chain({ first: { id: 'call-10' } })],
      estimates: [chain({ first: null })],
      sms_log: [chain({ first: null })],
      messaging_suppression: [chain({ first: null })],
    });
    const sendMessage = jest.fn(async (input) => {
      const check = await input.providerPreSendCheck({ database: dbh });
      expect(check).toEqual(expect.objectContaining({ ok: false, code: 'LEAD_PHONE_CHANGED' }));
      return { sent: false, blocked: true, deliveryOutcome: 'not_sent' };
    });

    const res = await processPhoneOnlyLeadSmsDrip({
      now: NOW_DAYTIME, dbh, gates: { newLeadDripExtendedLive: () => true }, sendMessage,
    });
    expect(res).toEqual({ skipped: null, checked: 1, sent: 0, stopped: 1, deferred: 0 });
    expect(claimDelete.del).toHaveBeenCalled();
  });

  test('marks claim uncertain on uncertain provider outcome and never deletes claim', async () => {
    const claimInsert = chain({ returning: [{ id: 'claim-3' }] });
    const claimUpdate = chain();
    const dbh = makeDb({
      leads: [chain({ result: [CALL_LEAD] })],
      new_lead_phone_drip_sends: [chain({ result: [] }), claimInsert, claimUpdate],
      call_log: [chain({ first: { id: 'call-10' } })],
      estimates: [chain({ first: null })],
      sms_log: [chain({ first: null })],
      messaging_suppression: [chain({ first: null })],
    });
    const sendMessage = jest.fn(async () => ({ sent: false, blocked: false, deliveryOutcome: 'uncertain' }));

    const res = await processPhoneOnlyLeadSmsDrip({
      now: NOW_DAYTIME, dbh, gates: { newLeadDripExtendedLive: () => true }, sendMessage,
    });
    expect(res).toEqual({ skipped: null, checked: 1, sent: 0, stopped: 0, deferred: 1 });
    expect(claimUpdate.update).toHaveBeenCalledWith({ status: 'uncertain' });
  });

  test('paginates past ineligible/stopped leads to reach newer due leads', async () => {
    const manualLead = { ...CALL_LEAD, id: 'lead-manual', twilio_call_sid: null, lead_type: 'manual' };
    const claimInsert = chain({ returning: [{ id: 'claim-4' }] });
    const claimUpdate = chain();
    const actInsert = chain();
    const dbh = makeDb({
      leads: [
        chain({ result: [manualLead] }), // page 1 full (pageSize=1), stopped for no consent
        chain({ result: [CALL_LEAD] }),  // page 2 eligible!
      ],
      new_lead_phone_drip_sends: [
        chain({ result: [] }),
        chain({ result: [] }),
        claimInsert,
        claimUpdate,
      ],
      call_log: [chain({ first: { id: 'call-10' } })],
      estimates: [chain({ first: null })],
      sms_log: [chain({ first: null })],
      messaging_suppression: [chain({ first: null })],
      lead_activities: [actInsert],
    });
    const sendMessage = jest.fn(async () => ({ sent: true, blocked: false, deliveryOutcome: 'accepted' }));

    const res = await processPhoneOnlyLeadSmsDrip({
      now: NOW_DAYTIME, limit: 1, pageSize: 1, dbh,
      gates: { newLeadDripExtendedLive: () => true }, sendMessage,
    });
    expect(res).toEqual({ skipped: null, checked: 2, sent: 1, stopped: 1, deferred: 0 });
  });

  test('fails closed and defers when messaging_suppression throws', async () => {
    const dbh = makeDb({
      leads: [chain({ result: [CALL_LEAD] })],
      new_lead_phone_drip_sends: [chain({ result: [] })],
      call_log: [chain({ first: { id: 'call-10' } })],
      estimates: [chain({ first: null })],
      sms_log: [chain({ first: null })],
      messaging_suppression: [chain({ firstError: Object.assign(new Error('db down'), { code: '57014' }) })],
    });
    const sendMessage = jest.fn();
    const res = await processPhoneOnlyLeadSmsDrip({
      now: NOW_DAYTIME, dbh, gates: { newLeadDripExtendedLive: () => true }, sendMessage,
    });
    expect(res).toEqual({ skipped: null, checked: 1, sent: 0, stopped: 0, deferred: 1 });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test('leadShouldStop checks estimate sent_at as well as created_at', async () => {
    const estQ = chain({ first: { id: 'est-1' } });
    const dbh = makeDb({
      notification_prefs: [chain({ first: null })],
      call_log: [chain({ first: { id: 'call-10' } })],
      estimates: [estQ],
    });
    const res = await leadShouldStop(dbh, { ...CALL_LEAD, customer_id: 'cust-1' });
    expect(res).toEqual({ stop: 'has_estimate', consentBasis: null });
  });
});
