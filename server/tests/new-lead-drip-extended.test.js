'use strict';

/**
 * GATE_NEW_LEAD_DRIP_EXTENDED (owner 2026-11-27 "ok go", Decision 2):
 *   1. Email Steps 3 (Day 10) & 4 (Day 21) in new_lead sequence (requires BOTH base & extended gates,
 *      stored enabled=false, gate-controlled in Admin, guarded by all 7 stops).
 *   2. Phone-only residential lead SMS drip (Day 2 & Day 5, 8 AM-8 PM ET, promotional opt-in bound
 *      to exact destination phone via phoneMatchDigits, honors marketing_offers=false, lead_outreach
 *      stop, durable claims, locked withSmsHandoff + providerPreSendCheck on dbi, keyset pagination).
 * Ships 100% DARK. Synthetic test records only.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/sendgrid-mail', () => ({ isConfigured: jest.fn(() => true), sendOne: jest.fn() }));

const stepsMigration = require('../models/migrations/20261128031000_new_lead_drip_extended_steps');
const claimsMigration = require('../models/migrations/20261128032000_new_lead_phone_drip_sends');
const { newLeadDripExtendedLive } = require('../config/feature-gates');
const { resolvePolicy } = require('../services/messaging/policy');
const { checkConsentForPurpose } = require('../services/messaging/validators/consent');
const {
  NEW_LEAD_DRIP_STEP_IDS,
  NEW_LEAD_EXTENDED_STEP_IDS,
  isNewLeadDripStep,
  isGateControlledNewLeadStepId,
} = require('../services/new-lead-drip-stops');
const {
  STEP_1_ACTIVITY,
  DRIP_ENTRY_POINT,
  DRIP_PURPOSE,
  ENGAGEMENT_OUTBOUND_TYPES,
  buildPhoneDripCopy,
  isWithinSendHoursET,
  phonesShareIdentity,
  pickDueStep,
  verifyLeadSmsConsent,
  leadShouldStop,
  processPhoneOnlyLeadSmsDrip,
} = require('../services/new-lead-phone-sms-drip');

function chain({ result = [], first = null, returning = [], firstError = null } = {}) {
  const q = {};
  [
    'where', 'whereRaw', 'whereIn', 'whereNotIn', 'whereNull', 'whereNotNull',
    'whereNotExists', 'orWhere', 'orWhereRaw', 'andWhere', 'leftJoin',
    'orderBy', 'offset', 'limit', 'select', 'onConflict', 'ignore',
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
    const base = String(table).split(/\s+/)[0];
    const q = map.get(base);
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

describe('phone-only residential SMS drip pure helpers & central marketing consent policy', () => {
  test('buildPhoneDripCopy uses Waves-only brand, approved per application unit, and STOP opt-out on Touch 1', () => {
    const s1 = buildPhoneDripCopy(1, { first_name: 'Jordan' });
    const s2 = buildPhoneDripCopy(2, { first_name: 'Jordan' });
    expect(s1).toContain("Hi Jordan, it's Waves.");
    expect(s1).toContain('$105-$120 per application');
    expect(s1).not.toMatch(/per quarterly pest visit/i);
    expect(s1).toContain('Reply STOP to opt out.');
    expect(s1).not.toMatch(/Adam|Lawn/i);
    expect(s2).toContain("Hi Jordan, it's Waves.");
    expect(s2).not.toMatch(/Adam/i);
  });

  test('ENGAGEMENT_OUTBOUND_TYPES includes Leads-page manual lead_outreach texts', () => {
    expect(ENGAGEMENT_OUTBOUND_TYPES).toContain('lead_outreach');
  });

  test('phonesShareIdentity uses complete phoneMatchDigits so UK +44 never collides with domestic +1 sharing last 10 digits', () => {
    expect(phonesShareIdentity('(941) 555-0144', '+19415550144')).toBe(true);
    expect(phonesShareIdentity('+442079460958', '+12079460958')).toBe(false);
    expect(phonesShareIdentity('+442079460958', '+44 20 7946 0958')).toBe(true);
  });

  test('lead_promotional_followup policy requires marketing consent and enforces marketing_offers centrally', async () => {
    const policy = resolvePolicy('lead', DRIP_PURPOSE);
    expect(policy.requireConsent).toBe('marketing');
    expect(policy.prefsColumn).toBe('marketing_offers');

    const baseInput = {
      to: '+19415550144',
      channel: 'sms',
      audience: 'lead',
      purpose: DRIP_PURPOSE,
      leadId: 'lead-1',
      consentBasis: { status: 'opted_in', source: 'web_form_sms_opt_in', phoneBound: true },
    };

    // Known customer with marketing_offers=false -> PURPOSE_OPTED_OUT
    await expect(checkConsentForPurpose(baseInput, policy, {
      customer: { id: 'c1' }, prefs: { sms_enabled: true, marketing_offers: false }, suppressionLoaded: true,
    })).resolves.toMatchObject({ ok: false, code: 'PURPOSE_OPTED_OUT' });

    // Known customer with marketing_offers=null -> NO_MARKETING_CONSENT
    await expect(checkConsentForPurpose(baseInput, policy, {
      customer: { id: 'c1' }, prefs: { sms_enabled: true, marketing_offers: null }, suppressionLoaded: true,
    })).resolves.toMatchObject({ ok: false, code: 'NO_MARKETING_CONSENT' });

    // Known customer with marketing_offers=true -> allowed
    await expect(checkConsentForPurpose(baseInput, policy, {
      customer: { id: 'c1' }, prefs: { sms_enabled: true, marketing_offers: true }, suppressionLoaded: true,
    })).resolves.toEqual({ ok: true });

    // Customer-less web-form lead without loaded suppression -> CONSENT_LOOKUP_FAILED
    await expect(checkConsentForPurpose(baseInput, policy, {
      customer: null, prefs: null, suppressionLoaded: false,
    })).resolves.toMatchObject({ ok: false, code: 'CONSENT_LOOKUP_FAILED' });

    // Customer-less web-form lead with bound opt-in + loaded suppression -> allowed
    await expect(checkConsentForPurpose(baseInput, policy, {
      customer: null, prefs: null, suppressionLoaded: true,
    })).resolves.toEqual({ ok: true });
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

describe('promotional SMS consent binding to exact destination phone', () => {
  test('rejects inbound-call-only or manual lead without promotional opt-in', async () => {
    const dbh = makeDb({ customers: [chain({ result: [] })] });
    const callLead = {
      id: 'lead-call', phone: '+19415550101', customer_id: null,
      twilio_call_sid: 'CA123', twilio_message_sid: null, lead_type: 'phone_call', extracted_data: null,
    };
    await expect(verifyLeadSmsConsent(dbh, callLead)).resolves.toBeNull();
  });

  test('rejects linked customer marketing_offers=true when customer phone differs from edited lead phone', async () => {
    const dbh = makeDb({
      customers: [chain({ result: [{ id: 'cust-1', phone: '+19415550100', sms_enabled: true, marketing_offers: true }] })],
    });
    const lead = { id: 'lead-edit', phone: '+19415559999', customer_id: 'cust-1', lead_type: 'manual' };
    await expect(verifyLeadSmsConsent(dbh, lead)).resolves.toBeNull();
  });

  test('accepts linked customer marketing_offers=true when customer phone matches destination phone', async () => {
    const dbh = makeDb({
      customers: [chain({ result: [{ id: 'cust-1', phone: '(941) 555-0144', sms_enabled: true, marketing_offers: true }] })],
    });
    const lead = { id: 'lead-ok', phone: '+19415550144', customer_id: 'cust-1', lead_type: 'phone_call' };
    await expect(verifyLeadSmsConsent(dbh, lead)).resolves.toEqual({
      status: 'opted_in',
      source: 'customer_notification_prefs',
      phoneBound: true,
    });
  });

  test('requires web-form opt-in to bind original submitted phone AND honors explicit customer marketing opt-out', async () => {
    const webLeadEdited = {
      id: 'lead-web-1', phone: '+19415559999', customer_id: null, lead_type: 'form_submission',
      extracted_data: { sms_opt_in: true, sms_consent_phone: '+19415550144' },
    };
    await expect(verifyLeadSmsConsent(makeDb({ customers: [chain({ result: [] })] }), webLeadEdited)).resolves.toBeNull();

    const webLeadUnbound = {
      id: 'lead-web-2', phone: '+19415550144', customer_id: null, lead_type: 'form_submission',
      extracted_data: { sms_opt_in: true },
    };
    await expect(verifyLeadSmsConsent(makeDb({ customers: [chain({ result: [] })] }), webLeadUnbound)).resolves.toBeNull();

    const webLeadOptedOut = {
      id: 'lead-web-3', phone: '+19415550144', customer_id: null, lead_type: 'form_submission',
      extracted_data: { sms_opt_in: true, sms_consent_phone: '+19415550144' },
    };
    const optedOutDb = makeDb({
      customers: [chain({ result: [{ id: 'cust-2', phone: '+19415550144', sms_enabled: true, marketing_offers: false }] })],
    });
    await expect(verifyLeadSmsConsent(optedOutDb, webLeadOptedOut)).resolves.toBeNull();

    await expect(verifyLeadSmsConsent(makeDb({ customers: [chain({ result: [] })] }), webLeadOptedOut)).resolves.toEqual({
      status: 'opted_in',
      source: 'web_form_sms_opt_in',
      phoneBound: true,
    });
  });
});

describe('processPhoneOnlyLeadSmsDrip durability, locked handoff, engagement stop, and keyset pagination', () => {
  const NOW_DAYTIME = new Date('2026-11-27T17:00:00Z');
  const OPTED_IN_LEAD = {
    id: 'lead-10', first_name: 'Taylor', phone: '(941) 555-0144', email: null,
    customer_id: null, estimate_id: null, converted_at: null, is_commercial: false,
    status: 'new', deleted_at: null, created_at: new Date('2026-11-25T15:00:00Z'),
    twilio_call_sid: null, twilio_message_sid: null, lead_type: 'form_submission',
    extracted_data: { sms_opt_in: true, sms_consent_phone: '(941) 555-0144' },
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

  test('claims durably, passes lead_promotional_followup + withSmsHandoff + providerPreSendCheck, and settles claim', async () => {
    const claimInsert = chain({ returning: [{ id: 'claim-1' }] });
    const claimUpdate = chain();
    const actInsert = chain();
    const dbh = makeDb({
      leads: [chain({ result: [OPTED_IN_LEAD] })],
      new_lead_phone_drip_sends: [chain({ result: [] }), claimInsert, claimUpdate],
      customers: [chain({ result: [] })],
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
      purpose: DRIP_PURPOSE,
      entryPoint: DRIP_ENTRY_POINT,
      consentBasis: { status: 'opted_in', source: 'web_form_sms_opt_in', phoneBound: true },
      withSmsHandoff: expect.any(Function),
      providerPreSendCheck: expect.any(Function),
    }));
    expect(claimUpdate.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'sent', provider_message_id: 'SM123' }));
    expect(actInsert.insert).toHaveBeenCalledWith(expect.objectContaining({ lead_id: 'lead-10', activity_type: STEP_1_ACTIVITY }));
  });

  test('providerPreSendCheck reads through dbi inside handoff and refuses if lead phone changed', async () => {
    const claimInsert = chain({ returning: [{ id: 'claim-2' }] });
    const claimDelete = chain();
    const outerDb = makeDb({
      leads: [chain({ result: [OPTED_IN_LEAD] })],
      new_lead_phone_drip_sends: [chain({ result: [] }), claimInsert, claimDelete],
      customers: [chain({ result: [] })],
      estimates: [chain({ first: null })],
      sms_log: [chain({ first: null })],
      messaging_suppression: [chain({ first: null })],
    });
    const handoffTrx = makeDb({
      leads: [chain({ first: { ...OPTED_IN_LEAD, phone: '+19415559999' } })],
    });
    const sendMessage = jest.fn(async (input) => {
      const check = await input.providerPreSendCheck({ channel: 'sms', dbi: handoffTrx });
      expect(check).toEqual(expect.objectContaining({ ok: false, code: 'LEAD_PHONE_CHANGED' }));
      return { sent: false, blocked: true, deliveryOutcome: 'not_sent' };
    });

    const res = await processPhoneOnlyLeadSmsDrip({
      now: NOW_DAYTIME, dbh: outerDb, gates: { newLeadDripExtendedLive: () => true }, sendMessage,
    });
    expect(handoffTrx).toHaveBeenCalledWith('leads');
    expect(res).toEqual({ skipped: null, checked: 1, sent: 0, stopped: 1, deferred: 0 });
    expect(claimDelete.del).toHaveBeenCalled();
  });

  test('stops drip after staff texts the lead from Leads page (lead_outreach)', async () => {
    const dbh = makeDb({
      customers: [chain({ result: [] })],
      estimates: [chain({ first: null })],
      sms_log: [chain({ first: { id: 'sms-staff-outreach-1' } })],
    });
    const res = await leadShouldStop(dbh, OPTED_IN_LEAD);
    expect(res).toEqual({ stop: 'already_engaged', consentBasis: null });
  });

  test('marks claim uncertain on uncertain provider outcome and never deletes claim', async () => {
    const claimInsert = chain({ returning: [{ id: 'claim-3' }] });
    const claimUpdate = chain();
    const dbh = makeDb({
      leads: [chain({ result: [OPTED_IN_LEAD] })],
      new_lead_phone_drip_sends: [chain({ result: [] }), claimInsert, claimUpdate],
      customers: [chain({ result: [] })],
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

  test('keyset-paginates by (created_at, id) without OFFSET so completed step-2 sends never skip leads', async () => {
    const manualLead = {
      ...OPTED_IN_LEAD,
      id: 'lead-01-manual',
      created_at: new Date('2026-11-25T14:00:00Z'),
      lead_type: 'manual',
      extracted_data: null,
    };
    const page1 = chain({ result: [manualLead] });
    const page2 = chain({ result: [OPTED_IN_LEAD] });
    const claimInsert = chain({ returning: [{ id: 'claim-4' }] });
    const claimUpdate = chain();
    const actInsert = chain();
    const dbh = makeDb({
      leads: [page1, page2],
      new_lead_phone_drip_sends: [
        chain({ result: [] }),
        chain({ result: [] }),
        claimInsert,
        claimUpdate,
      ],
      customers: [chain({ result: [] }), chain({ result: [] })],
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
    expect(page1.offset).not.toHaveBeenCalled();
    expect(page2.offset).not.toHaveBeenCalled();
    expect(page2.whereRaw).toHaveBeenCalledWith('(created_at, id) > (?, ?)', [manualLead.created_at, manualLead.id]);
    expect(res).toEqual({ skipped: null, checked: 2, sent: 1, stopped: 1, deferred: 0 });
  });

  test('fails closed and defers when messaging_suppression throws', async () => {
    const dbh = makeDb({
      leads: [chain({ result: [OPTED_IN_LEAD] })],
      new_lead_phone_drip_sends: [chain({ result: [] })],
      customers: [chain({ result: [] })],
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
      customers: [chain({ result: [{ id: 'cust-1', phone: '+19415550144', sms_enabled: true, marketing_offers: true }] })],
      estimates: [estQ],
    });
    const res = await leadShouldStop(dbh, { ...OPTED_IN_LEAD, customer_id: 'cust-1' });
    expect(res).toEqual({ stop: 'has_estimate', consentBasis: null });
  });
});
