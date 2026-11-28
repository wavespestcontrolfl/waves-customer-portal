'use strict';

/**
 * GATE_NEW_LEAD_DRIP_EXTENDED (owner 2026-11-27 "ok go", Decision 2):
 *   1. Email Steps 3 (Day 10) & 4 (Day 21) in new_lead sequence (stored enabled=false, guarded by all 7 stops).
 *   2. Phone-only residential lead SMS drip (Day 2 & Day 5, 8 AM-8 PM ET, fail-closed suppression).
 * Ships 100% DARK. Synthetic test records only.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/sendgrid-mail', () => ({ isConfigured: jest.fn(() => true), sendOne: jest.fn() }));

const migration = require('../models/migrations/20261128031000_new_lead_drip_extended_steps');
const { newLeadDripExtendedLive } = require('../config/feature-gates');
const {
  NEW_LEAD_DRIP_STEP_IDS,
  NEW_LEAD_EXTENDED_STEP_IDS,
  isNewLeadDripStep,
  isGateControlledNewLeadStepId,
} = require('../services/new-lead-drip-stops');
const {
  STEP_1_ACTIVITY,
  STEP_2_ACTIVITY,
  DRIP_ENTRY_POINT,
  buildPhoneDripCopy,
  isWithinSendHoursET,
  pickDueStep,
  leadShouldStop,
  processPhoneOnlyLeadSmsDrip,
} = require('../services/new-lead-phone-sms-drip');

function chain({ result = [], first = null, firstError = null } = {}) {
  const q = {};
  ['where', 'whereRaw', 'whereIn', 'whereNotIn', 'whereNull', 'whereNotNull', 'orWhere', 'orderBy', 'limit', 'select']
    .forEach((m) => { q[m] = jest.fn(() => q); });
  q.first = jest.fn(async () => { if (firstError) throw firstError; return first; });
  q.insert = jest.fn(async () => [1]);
  q.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  return q;
}

function makeDb(queues) {
  const map = new Map(Object.entries(queues).map(([k, v]) => [k, [...v]]));
  return jest.fn((table) => {
    const q = map.get(table);
    if (!q || !q.length) throw new Error(`Unexpected db table: ${table}`);
    return q.shift();
  });
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
    process.env.GATE_NEW_LEAD_DRIP_EXTENDED = 'TRUE';
    expect(newLeadDripExtendedLive()).toBe(false);
    process.env.GATE_NEW_LEAD_DRIP_EXTENDED = 'true';
    expect(newLeadDripExtendedLive()).toBe(true);
  });
});

describe('extended email steps migration & stop recognition', () => {
  test('seeds Steps 3 (120h) and 4 (264h) stored enabled=false with fixed IDs and accurate Waves copy', async () => {
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

    await migration.up(knex);
    expect(inserts).toHaveLength(2);
    expect(inserts.map((r) => [r.id, r.step_order, r.delay_hours, r.enabled])).toEqual([
      [NEW_LEAD_EXTENDED_STEP_IDS[0], 3, 120, false],
      [NEW_LEAD_EXTENDED_STEP_IDS[1], 4, 264, false],
    ]);
    // Must follow Waves interior-spray ruling (outside every visit + inside first visit / on request)
    expect(inserts[0].text_body).toContain('outside');
    expect(inserts[0].text_body).not.toMatch(/covers inside and outside/i);
    expect(inserts[0].text_body + inserts[1].text_body).not.toMatch(/Adam|Lawn Care/i);
    await expect(migration.down()).resolves.toBeUndefined();
  });

  test('isNewLeadDripStep matches Steps 1-4 without mutating NEW_LEAD_DRIP_STEP_IDS', () => {
    expect(NEW_LEAD_DRIP_STEP_IDS).toHaveLength(2);
    expect(NEW_LEAD_EXTENDED_STEP_IDS).toHaveLength(2);
    expect(isNewLeadDripStep('new_lead', { id: NEW_LEAD_EXTENDED_STEP_IDS[0] })).toBe(true);
    expect(isNewLeadDripStep('new_lead', { id: NEW_LEAD_EXTENDED_STEP_IDS[1] })).toBe(true);
    expect(isNewLeadDripStep('cold_lead', { id: NEW_LEAD_EXTENDED_STEP_IDS[0] })).toBe(false);
    expect(isGateControlledNewLeadStepId(NEW_LEAD_EXTENDED_STEP_IDS[0])).toBe(true);
    expect(isGateControlledNewLeadStepId('hand-added-step')).toBe(false);
  });
});

describe('phone-only residential SMS drip pure helpers', () => {
  test('buildPhoneDripCopy uses Waves-only brand (no owner name) and STOP opt-out on Touch 1', () => {
    const s1 = buildPhoneDripCopy(1, { first_name: 'Jordan' });
    const s2 = buildPhoneDripCopy(2, { first_name: 'Jordan' });
    const anon = buildPhoneDripCopy(1, { first_name: '12345' });
    expect(s1).toContain("Hi Jordan, it's Waves.");
    expect(s1).toContain('Reply STOP to opt out.');
    expect(s1).not.toMatch(/Adam|Lawn/i);
    expect(s2).toContain("Hi Jordan, it's Waves.");
    expect(s2).not.toMatch(/Adam/i);
    expect(anon).toContain("Hi, it's Waves.");
  });

  test('isWithinSendHoursET enforces 8 AM - 8 PM ET strictly', () => {
    // Nov 27 is EST (UTC-5)
    expect(isWithinSendHoursET(new Date('2026-11-27T12:59:00Z'))).toBe(false); // 7:59 AM ET
    expect(isWithinSendHoursET(new Date('2026-11-27T13:00:00Z'))).toBe(true);  // 8:00 AM ET
    expect(isWithinSendHoursET(new Date('2026-11-28T00:59:00Z'))).toBe(true);  // 7:59 PM ET
    expect(isWithinSendHoursET(new Date('2026-11-28T01:00:00Z'))).toBe(false); // 8:00 PM ET
  });

  test('pickDueStep enforces Day 2 (48-96h), Day 5 (120-168h & >=48h post Step 1), residential & phone-only', () => {
    const now = new Date('2026-11-27T17:00:00Z');
    const base = {
      id: 'lead-1', phone: '+19415550111', email: null, status: 'new',
      deleted_at: null, converted_at: null, estimate_id: null, is_commercial: false,
    };
    const hoursAgo = (h) => new Date(now.getTime() - h * 3600 * 1000).toISOString();

    expect(pickDueStep({ ...base, created_at: hoursAgo(24) }, [], now)).toBeNull();
    expect(pickDueStep({ ...base, created_at: hoursAgo(60) }, [], now)).toBe(1);
    expect(pickDueStep({ ...base, created_at: hoursAgo(60), email: 'a@example.com' }, [], now)).toBeNull();
    expect(pickDueStep({ ...base, created_at: hoursAgo(60), is_commercial: true }, [], now)).toBeNull();
    expect(pickDueStep({ ...base, created_at: hoursAgo(130) }, [{ activity_type: STEP_1_ACTIVITY, created_at: hoursAgo(70) }], now)).toBe(2);
    expect(pickDueStep({ ...base, created_at: hoursAgo(130) }, [{ activity_type: STEP_1_ACTIVITY, created_at: hoursAgo(20) }], now)).toBeNull();
    expect(pickDueStep({ ...base, created_at: hoursAgo(130) }, [
      { activity_type: STEP_1_ACTIVITY, created_at: hoursAgo(70) },
      { activity_type: STEP_2_ACTIVITY, created_at: hoursAgo(1) },
    ], now)).toBeNull();
  });
});

describe('processPhoneOnlyLeadSmsDrip safety & orchestration', () => {
  const NOW_DAYTIME = new Date('2026-11-27T17:00:00Z'); // 12:00 PM ET
  const LEAD = {
    id: 'lead-10', first_name: 'Taylor', phone: '(941) 555-0144', email: null,
    customer_id: null, estimate_id: null, converted_at: null, is_commercial: false,
    status: 'new', deleted_at: null, created_at: new Date('2026-11-25T15:00:00Z'), // 50h old
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

  test('quiet hours returns skipped=quiet_hours with zero queries', async () => {
    const dbh = jest.fn();
    const res = await processPhoneOnlyLeadSmsDrip({
      now: new Date('2026-11-28T02:00:00Z'), // 9 PM ET
      dbh,
      gates: { newLeadDripExtendedLive: () => true },
      sendMessage: jest.fn(),
    });
    expect(res.skipped).toBe('quiet_hours');
    expect(dbh).not.toHaveBeenCalled();
  });

  test('sends Touch 1 through canonical sendCustomerMessage and records lead_activity', async () => {
    const actInsert = chain();
    const dbh = makeDb({
      leads: [chain({ result: [LEAD] })],
      lead_activities: [chain({ result: [] }), actInsert],
      sms_log: [chain({ first: null }), chain({ first: null })],
      estimates: [chain({ first: null })],
      messaging_suppression: [chain({ first: null })],
    });
    const sendMessage = jest.fn(async () => ({ sent: true, blocked: false, deliveryOutcome: 'accepted' }));

    const res = await processPhoneOnlyLeadSmsDrip({
      now: NOW_DAYTIME,
      dbh,
      gates: { newLeadDripExtendedLive: () => true },
      sendMessage,
    });

    expect(res).toEqual({ skipped: null, checked: 1, sent: 1, stopped: 0, deferred: 0 });
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      to: '(941) 555-0144',
      channel: 'sms',
      audience: 'lead',
      purpose: 'missed_call_followup',
      leadId: 'lead-10',
      entryPoint: DRIP_ENTRY_POINT,
      consentBasis: { status: 'transactional_allowed', source: DRIP_ENTRY_POINT },
    }));
    expect(actInsert.insert).toHaveBeenCalledWith(expect.objectContaining({
      lead_id: 'lead-10',
      activity_type: STEP_1_ACTIVITY,
    }));
  });

  test('fails closed and defers when messaging_suppression read throws (never sends)', async () => {
    const dbh = makeDb({
      leads: [chain({ result: [LEAD] })],
      lead_activities: [chain({ result: [] })],
      sms_log: [chain({ first: null }), chain({ first: null })],
      estimates: [chain({ first: null })],
      messaging_suppression: [chain({ firstError: Object.assign(new Error('db down'), { code: '57014' }) })],
    });
    const sendMessage = jest.fn();

    const res = await processPhoneOnlyLeadSmsDrip({
      now: NOW_DAYTIME,
      dbh,
      gates: { newLeadDripExtendedLive: () => true },
      sendMessage,
    });
    expect(res).toEqual({ skipped: null, checked: 1, sent: 0, stopped: 0, deferred: 1 });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test('stops without sending when recipient is actively suppressed in messaging_suppression', async () => {
    const dbh = makeDb({
      sms_log: [chain({ first: null }), chain({ first: null })],
      estimates: [chain({ first: null })],
      messaging_suppression: [chain({ first: { phone: '+19415550144' } })],
    });
    await expect(leadShouldStop(dbh, LEAD, 1)).resolves.toBe('opted_out');
  });

  test('records activity on uncertain provider outcome so a later tick never double-texts', async () => {
    const actInsert = chain();
    const dbh = makeDb({
      leads: [chain({ result: [LEAD] })],
      lead_activities: [chain({ result: [] }), actInsert],
      sms_log: [chain({ first: null }), chain({ first: null })],
      estimates: [chain({ first: null })],
      messaging_suppression: [chain({ first: null })],
    });
    const sendMessage = jest.fn(async () => ({ sent: false, blocked: false, deliveryOutcome: 'uncertain' }));

    const res = await processPhoneOnlyLeadSmsDrip({
      now: NOW_DAYTIME,
      dbh,
      gates: { newLeadDripExtendedLive: () => true },
      sendMessage,
    });
    expect(res).toEqual({ skipped: null, checked: 1, sent: 0, stopped: 0, deferred: 1 });
    expect(actInsert.insert).toHaveBeenCalledWith(expect.objectContaining({
      lead_id: 'lead-10',
      activity_type: STEP_1_ACTIVITY,
    }));
  });
});
