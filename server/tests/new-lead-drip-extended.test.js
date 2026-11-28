'use strict';

/**
 * GATE_NEW_LEAD_DRIP_EXTENDED (owner 2026-11-27 "ok go", Decision 2):
 *   1. Email Steps 3 (Day 10) & 4 (Day 21) in new_lead sequence (requires BOTH base & extended gates,
 *      stored enabled=false, gate-controlled in Admin, guarded by all 7 stops).
 *   2. Phone-only residential lead SMS drip (Day 2 & Day 5, 8 AM-8 PM ET including live handoff
 *      clock recheck, canonical E.164 phone binding, stored notification_prefs.marketing_offers=true
 *      with explicit 'sms'/'both' marketing_channel [null defaults to email; unverified web-form
 *      extracted_data rejected], phone-matched customer conversion & standalone customer_phone
 *      estimate stops, consentingCustomerId forwarded to sendCustomerMessage, lockCustomerComms->
 *      lockSmsPhone handoff, lead_outreach + lead_response stops, retryable handoff read errors,
 *      durable claims, created_at::text keyset pagination, real sendCustomerMessage integration check).
 * Ships 100% DARK. Synthetic test records only.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/sendgrid-mail', () => ({ isConfigured: jest.fn(() => true), sendOne: jest.fn() }));

const stepsMigration = require('../models/migrations/20261128031000_new_lead_drip_extended_steps');
const claimsMigration = require('../models/migrations/20261128032000_new_lead_phone_drip_sends');
const consentPhoneMigration = require('../models/migrations/20261128033000_notification_prefs_marketing_sms_consent_phone');
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
  canonicalE164,
  phonesShareIdentity,
  isSmsCapableMarketingChannel,
  pickDueStep,
  verifyLeadSmsConsent,
  leadShouldStop,
  buildPhoneDripHandoff,
  processPhoneOnlyLeadSmsDrip,
} = require('../services/new-lead-phone-sms-drip');

function chain({ result = [], first = null, returning = [], firstError = null } = {}) {
  const q = {};
  [
    'where', 'whereNot', 'whereRaw', 'whereIn', 'whereNotIn', 'whereNull', 'whereNotNull',
    'whereNotExists', 'orWhere', 'orWhereRaw', 'andWhere', 'join', 'leftJoin',
    'orderBy', 'offset', 'limit', 'select', 'onConflict', 'ignore', 'forNoKeyUpdate',
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

    const addedCols = [];
    const droppedCols = [];
    const altKnex = {
      schema: {
        hasTable: jest.fn(async () => true),
        hasColumn: jest.fn(async () => false),
        alterTable: jest.fn(async (_t, fn) => fn({
          string: (c) => { addedCols.push(c); return { nullable: () => {} }; },
          dropColumn: (c) => droppedCols.push(c),
        })),
      },
    };
    await consentPhoneMigration.up(altKnex);
    altKnex.schema.hasColumn.mockResolvedValue(true);
    await consentPhoneMigration.down(altKnex);
    expect(addedCols).toEqual(['marketing_sms_consent_phone']);
    expect(droppedCols).toEqual(['marketing_sms_consent_phone']);
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
      const filter = stepsQ.where.mock.calls.map(([arg]) => arg).find((arg) => typeof arg === 'function');
      const rest = { whereNotIn: jest.fn() };
      filter(rest);
      expect(rest.whereNotIn).toHaveBeenCalledWith('id', NEW_LEAD_DRIP_STEP_IDS);
      expect(rest.whereNotIn).toHaveBeenCalledWith('id', NEW_LEAD_EXTENDED_STEP_IDS);
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

  test('ENGAGEMENT_OUTBOUND_TYPES includes Leads-page manual lead_outreach, lead_response, auto_reply, and call follow-up texts', () => {
    expect(ENGAGEMENT_OUTBOUND_TYPES).toEqual(expect.arrayContaining([
      'lead_outreach', 'lead_response', 'auto_reply', 'voicemail_quote_link', 'missed_call_text_back', 'call_booking_link_text',
    ]));
  });

  test('phonesShareIdentity compares canonical E.164 strictly so 10-digit international never matches NANP', () => {
    expect(canonicalE164('(941) 555-0144')).toBe('+19415550144');
    expect(phonesShareIdentity('(941) 555-0144', '+19415550144')).toBe(true);
    expect(phonesShareIdentity('+442079460958', '+12079460958')).toBe(false);
    expect(phonesShareIdentity('+9415550144', '+19415550144')).toBe(false);
    expect(phonesShareIdentity('+442079460958', '+44 20 7946 0958')).toBe(true);
  });

  test('isSmsCapableMarketingChannel requires explicit sms or both (blank/null defaults to email)', () => {
    expect(isSmsCapableMarketingChannel(null)).toBe(false);
    expect(isSmsCapableMarketingChannel('')).toBe(false);
    expect(isSmsCapableMarketingChannel('email')).toBe(false);
    expect(isSmsCapableMarketingChannel('sms')).toBe(true);
    expect(isSmsCapableMarketingChannel('both')).toBe(true);
  });

  test('lead_promotional_followup policy requires stored marketing_offers consent centrally with no no-prefs bypass', async () => {
    const policy = resolvePolicy('lead', DRIP_PURPOSE);
    expect(policy.requireConsent).toBe('marketing');
    expect(policy.prefsColumn).toBe('marketing_offers');
    expect(policy.requireIds).toEqual(['customerId', 'leadId']);

    const baseInput = {
      to: '+19415550144',
      channel: 'sms',
      audience: 'lead',
      purpose: DRIP_PURPOSE,
      customerId: 'c1',
      leadId: 'lead-1',
      consentBasis: { status: 'opted_in', source: 'customer_notification_prefs', phoneBound: true },
    };

    await expect(checkConsentForPurpose(baseInput, policy, {
      customer: { id: 'c1' }, prefs: { sms_enabled: true, marketing_offers: false }, suppressionLoaded: true,
    })).resolves.toMatchObject({ ok: false, code: 'PURPOSE_OPTED_OUT' });

    await expect(checkConsentForPurpose(baseInput, policy, {
      customer: { id: 'c1' }, prefs: { sms_enabled: true, marketing_offers: null }, suppressionLoaded: true,
    })).resolves.toMatchObject({ ok: false, code: 'NO_MARKETING_CONSENT' });

    await expect(checkConsentForPurpose(baseInput, policy, {
      customer: { id: 'c1' }, prefs: { sms_enabled: true, marketing_offers: true }, suppressionLoaded: true,
    })).resolves.toEqual({ ok: true });

    await expect(checkConsentForPurpose(baseInput, policy, {
      customer: null, prefs: null, suppressionLoaded: true,
    })).resolves.toMatchObject({ ok: false, code: 'NO_CONSENT_RECORD' });
  });

  test('real sendCustomerMessage accepts lead_promotional_followup with stored notification_prefs and withSmsHandoff', async () => {
    const audit = require('../services/messaging/audit');
    const twilioSms = require('../services/messaging/providers/twilio-sms');
    const db = require('../models/db');
    const auditSpy = jest.spyOn(audit, 'persistAudit').mockResolvedValue({ id: 'audit-1' });
    const sendSpy = jest.spyOn(twilioSms, 'sendViaTwilio').mockResolvedValue({
      sent: true,
      deliveryOutcome: 'accepted',
      providerMessageId: 'SM_REAL_1',
    });
    const prevImpl = db.getMockImplementation();
    db.mockImplementation((table) => {
      if (table === 'customers') return chain({ first: { id: 'cust-opt-1', phone: '(941) 555-0144', first_name: 'Taylor' } });
      if (table === 'notification_prefs') {
        return chain({ first: { customer_id: 'cust-opt-1', sms_enabled: true, marketing_offers: true, marketing_channel: 'sms' } });
      }
      if (table === 'messaging_suppression') return chain({ first: null });
      if (table === 'disclaimed_number_holds') return chain({ first: null });
      if (table === 'callback_number_holds') return chain({ first: null });
      return chain({ first: null, result: [] });
    });
    try {
      const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
      const res = await sendCustomerMessage({
        to: '+19415550144',
        body: buildPhoneDripCopy(1, { first_name: 'Taylor' }),
        channel: 'sms',
        audience: 'lead',
        purpose: DRIP_PURPOSE,
        customerId: 'cust-opt-1',
        leadId: 'lead-10',
        identityTrustLevel: 'phone_matches_customer',
        consentBasis: { status: 'opted_in', source: 'customer_notification_prefs', phoneBound: true },
        entryPoint: DRIP_ENTRY_POINT,
        withSmsHandoff: (dispatch) => dispatch(db),
        providerPreSendCheck: async () => ({ ok: true }),
      });
      expect(res.code).not.toBe('UNSUPPORTED_SMS_HANDOFF');
      expect(res.sent).toBe(true);
      expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({ to: '+19415550144' }), expect.any(Object));
    } finally {
      auditSpy.mockRestore();
      sendSpy.mockRestore();
      db.mockImplementation(prevImpl);
    }
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
    expect(pickDueStep({ ...base, is_residential: false, created_at: hoursAgo(60) }, [], now)).toBeNull();
    expect(pickDueStep({ ...base, status: 'estimate_sent', created_at: hoursAgo(60) }, [], now)).toBeNull();
    expect(pickDueStep({ ...base, status: 'estimate_viewed', created_at: hoursAgo(60) }, [], now)).toBeNull();
    expect(pickDueStep({ ...base, created_at: hoursAgo(60), email: 'a@example.com' }, [], now)).toBeNull();
    expect(pickDueStep({ ...base, created_at: hoursAgo(130) }, [{ step: 1, status: 'sent', sent_at: hoursAgo(70), destination_phone: '+19415550111' }], now)).toBe(2);
    expect(pickDueStep({ ...base, created_at: hoursAgo(130) }, [{ step: 1, status: 'sent', sent_at: hoursAgo(70), destination_phone: '+19415559999' }], now)).toBeNull();
    expect(pickDueStep({ ...base, created_at: hoursAgo(130) }, [{ step: 1, status: 'uncertain', claimed_at: hoursAgo(70) }], now)).toBeNull();
  });
});

describe('promotional SMS consent binding, marketing_channel default, phone-matched customers, and standalone estimates', () => {
  const NO_CALL_VETO = async () => ({ doNotContact: false, smsDeclined: false });
  const OPTED_IN_CUSTOMER = {
    id: 'cust-opt-1',
    phone: '(941) 555-0144',
    sms_enabled: true,
    marketing_offers: true,
    marketing_channel: 'sms',
    marketing_sms_consent_phone: '+19415550144',
  };

  test('rejects inbound-call-only, unverified web-form extracted_data, replaced phone numbers, and legacy null marketing_channel rows', async () => {
    const callLead = {
      id: 'lead-call', phone: '+19415550101', customer_id: null,
      twilio_call_sid: 'CA123', lead_type: 'phone_call',
    };
    await expect(verifyLeadSmsConsent(makeDb({ customers: [chain({ result: [] })] }), callLead)).resolves.toBeNull();

    // Unverified model/form extracted_data flag without stored notification_prefs MUST be rejected (TCPA)
    const unverifiedWebLead = {
      id: 'lead-web-unverified', phone: '+19415550144', customer_id: null, lead_type: 'form_submission',
      extracted_data: { marketing_sms_opt_in: true, sms_consent_phone: '+19415550144' },
    };
    await expect(verifyLeadSmsConsent(makeDb({ customers: [chain({ result: [] })] }), unverifiedWebLead)).resolves.toBeNull();

    // Customer 360 replaced phone to +19415550144 while consent was captured for +19415550100 -> rejected!
    const replacedPhoneDb = makeDb({
      customers: [chain({
        result: [{
          id: 'cust-replaced', phone: '+19415550144', sms_enabled: true,
          marketing_offers: true, marketing_channel: 'sms', marketing_sms_consent_phone: '+19415550100',
        }],
      })],
    });
    const replacedLead = { id: 'lead-rep', phone: '+19415550144', customer_id: 'cust-replaced', lead_type: 'phone_call' };
    await expect(verifyLeadSmsConsent(replacedPhoneDb, replacedLead)).resolves.toBeNull();

    // Legacy customer row with marketing_offers=true but marketing_channel=null (defaults to email!) -> rejected
    const nullChannelDb = makeDb({
      customers: [chain({ result: [{ id: 'cust-legacy', phone: '+19415550144', sms_enabled: true, marketing_offers: true, marketing_channel: null, marketing_sms_consent_phone: '+19415550144' }] })],
    });
    const lead = { id: 'lead-null-ch', phone: '+19415550144', customer_id: 'cust-legacy', lead_type: 'phone_call' };
    await expect(verifyLeadSmsConsent(nullChannelDb, lead)).resolves.toBeNull();
  });

  test('rejects marketing_channel=email or mismatched phone; accepts explicit sms/both on canonical phone match', async () => {
    const emailOnlyDb = makeDb({
      customers: [chain({ result: [{ id: 'cust-1', phone: '+19415550144', sms_enabled: true, marketing_offers: true, marketing_channel: 'email', marketing_sms_consent_phone: '+19415550144' }] })],
    });
    const lead = { id: 'lead-ch', phone: '+19415550144', customer_id: 'cust-1', lead_type: 'phone_call' };
    await expect(verifyLeadSmsConsent(emailOnlyDb, lead)).resolves.toBeNull();

    const okDb = makeDb({
      customers: [chain({ result: [OPTED_IN_CUSTOMER] })],
    });
    await expect(verifyLeadSmsConsent(okDb, lead)).resolves.toEqual({
      status: 'opted_in',
      source: 'customer_notification_prefs',
      phoneBound: true,
    });
  });

  test('stops on standalone office estimate quoting customer_phone (even with no customer_id or lead_id)', async () => {
    const webLead = {
      id: 'lead-standalone', phone: '(941) 555-0144', customer_id: null,
      created_at: new Date('2026-11-25T15:00:00Z'), lead_type: 'form_submission',
    };
    const dbh = makeDb({
      customers: [chain({ result: [OPTED_IN_CUSTOMER] })],
      estimates: [chain({ result: [{ id: 'est-phone-1', customer_id: null, customer_phone: '+19415550144', estimate_data: {} }] })],
    });
    const res = await leadShouldStop(dbh, webLead, { checkCallVetoes: NO_CALL_VETO });
    expect(res.stop).toBe('has_estimate');
  });

  test('carries phone-matched customer IDs into estimate/conversion checks when lead.customer_id is null', async () => {
    const unlinkedLead = {
      id: 'lead-unlinked', phone: '+19415550144', customer_id: null,
      created_at: new Date('2026-11-25T15:00:00Z'), lead_type: 'phone_call',
    };
    const bookedQ = chain({ first: { id: 'svc-booked-1' } });
    const dbh = makeDb({
      customers: [chain({ result: [{ id: 'cust-phone-match', phone: '+19415550144', sms_enabled: true, marketing_offers: true, marketing_channel: 'both', marketing_sms_consent_phone: '+19415550144' }] })],
      estimates: [chain({ result: [] })],
      scheduled_services: [bookedQ],
    });
    const res = await leadShouldStop(dbh, unlinkedLead, { checkCallVetoes: NO_CALL_VETO });
    expect(bookedQ.whereIn).toHaveBeenCalledWith('customer_id', ['cust-phone-match']);
    expect(res.stop).toBe('visit_booked');
  });

  test('stops on overlapping drip sequence for another open lead on the same phone and on spoken call vetoes', async () => {
    const lead = {
      id: 'lead-dup', phone: '+19415550144', customer_id: null,
      created_at: new Date('2026-11-25T15:00:00Z'), lead_type: 'phone_call',
    };
    const overlapQ = chain({ result: [{ id: 'other-claim', destination_phone: '(941) 555-0144' }] });
    const overlapDb = makeDb({
      customers: [chain({ result: [OPTED_IN_CUSTOMER] }), chain({ first: null })],
      estimates: [chain({ result: [] })],
      scheduled_services: [chain({ first: null })],
      invoices: [chain({ first: null })],
      new_lead_phone_drip_sends: [overlapQ],
    });
    expect((await leadShouldStop(overlapDb, lead, { checkCallVetoes: NO_CALL_VETO })).stop).toBe('phone_already_in_drip');
    expect(overlapQ.join).toHaveBeenCalledWith('leads as l', 'l.id', 's.lead_id');

    // Non-US 10-digit E.164 (e.g. +9415550144) is rejected so normalizeRecipient never rewrites destination to +1
    const intlRes = await leadShouldStop(makeDb({}), {
      id: 'lead-intl', phone: '+9415550144', customer_id: null,
      created_at: new Date('2026-11-25T15:00:00Z'), lead_type: 'phone_call',
    }, { checkCallVetoes: NO_CALL_VETO });
    expect(intlRes.stop).toBe('invalid_phone');

    // Closed / expired prior sends return zero rows from the active-window join, so future inquiries are not blocked
    const closedClearedDb = makeDb({
      customers: [chain({ result: [OPTED_IN_CUSTOMER] }), chain({ first: null })],
      estimates: [chain({ result: [] })],
      scheduled_services: [chain({ first: null })],
      invoices: [chain({ first: null })],
      new_lead_phone_drip_sends: [chain({ result: [] })],
      sms_log: [chain({ first: null })],
      messaging_suppression: [chain({ first: null })],
    });
    expect((await leadShouldStop(closedClearedDb, lead, { checkCallVetoes: NO_CALL_VETO })).stop).toBeNull();

    const vetoDb = makeDb({
      customers: [chain({ result: [OPTED_IN_CUSTOMER] }), chain({ first: null })],
      estimates: [chain({ result: [] })],
      scheduled_services: [chain({ first: null })],
      invoices: [chain({ first: null })],
      new_lead_phone_drip_sends: [chain({ result: [] })],
      sms_log: [chain({ first: null })],
      messaging_suppression: [chain({ first: null })],
    });
    const vetoRes = await leadShouldStop(vetoDb, lead, {
      checkCallVetoes: async () => ({ doNotContact: false, smsDeclined: true }),
    });
    expect(vetoRes.stop).toBe('call_veto');
  });

  test('notification-prefs stampMarketingSmsConsentPhone preserves old stamp on unchanged saves after phone change', async () => {
    const { stampMarketingSmsConsentPhone } = require('../routes/notification-prefs')._private;
    const mkTrx = (phone) => {
      const fn = jest.fn((table) => {
        if (table === 'notification_prefs') return { columnInfo: async () => ({ marketing_sms_consent_phone: {} }) };
        if (table === 'customers') return chain({ first: { phone } });
        throw new Error(`Unexpected table: ${table}`);
      });
      return fn;
    };

    // Unchanged full-object save echoing SMS after Customer 360 replaced phone -> MUST NOT overwrite stamp!
    const unchangedUpdates = { marketing_channel: 'sms' };
    await stampMarketingSmsConsentPhone(mkTrx('+19415559999'), 'cust-1', unchangedUpdates, {
      marketing_offers: true,
      marketing_channel: 'sms',
      marketing_sms_consent_phone: '+19415550144',
    });
    expect(unchangedUpdates).not.toHaveProperty('marketing_sms_consent_phone');

    // Explicit opt-in transition (!wasEnabled -> nowEnabled) -> stamps current phone
    const optInUpdates = { marketing_offers: true, marketing_channel: 'sms' };
    await stampMarketingSmsConsentPhone(mkTrx('(941) 555-9999'), 'cust-1', optInUpdates, {
      marketing_offers: null,
      marketing_channel: 'email',
      marketing_sms_consent_phone: null,
    });
    expect(optInUpdates.marketing_sms_consent_phone).toBe('+19415559999');

    // Switching off marketing_offers or back to email -> clears stamp to null
    const optOutUpdates = { marketing_channel: 'email' };
    await stampMarketingSmsConsentPhone(mkTrx('(941) 555-9999'), 'cust-1', optOutUpdates, {
      marketing_offers: true,
      marketing_channel: 'sms',
      marketing_sms_consent_phone: '+19415559999',
    });
    expect(optOutUpdates.marketing_sms_consent_phone).toBeNull();
  });

  test('buildPhoneDripHandoff acquires sorted customer-comms locks BEFORE lockSmsPhone', async () => {
    const rawCalls = [];
    const trx = { raw: jest.fn(async (sql, bindings) => { rawCalls.push([sql, bindings]); }) };
    const dbh = { transaction: jest.fn(async (fn) => fn(trx)) };
    const handoff = buildPhoneDripHandoff(dbh, { customerIds: ['cust-b', 'cust-a', 'cust-b'], phone: '+19415550144' });
    const out = await handoff(async (conn) => ({ ok: true, sameTrx: conn === trx }));
    expect(out).toEqual({ ok: true, sameTrx: true });
    expect(rawCalls.map((c) => c[1])).toEqual([
      ['customer-comms:cust-a'],
      ['customer-comms:cust-b'],
      ['+19415550144'],
    ]);
  });
});

describe('processPhoneOnlyLeadSmsDrip durability, consentingCustomerId forwarding, 8 PM recheck, and cursor precision', () => {
  const NOW_DAYTIME = new Date('2026-11-27T17:00:00Z');
  const NO_CALL_VETO = async () => ({ doNotContact: false, smsDeclined: false });
  const OPTED_IN_CUST = {
    id: 'cust-punct-1',
    phone: '(941) 555-0144',
    sms_enabled: true,
    marketing_offers: true,
    marketing_channel: 'both',
    marketing_sms_consent_phone: '+19415550144',
  };
  const OPTED_IN_LEAD = {
    id: 'lead-10', first_name: 'Taylor', phone: '(941) 555-0144', email: null,
    customer_id: null, estimate_id: null, converted_at: null, is_commercial: false,
    status: 'new', deleted_at: null, created_at: new Date('2026-11-25T15:00:00.123456Z'),
    cursor_created_at: '2026-11-25 15:00:00.123456+00',
    twilio_call_sid: null, twilio_message_sid: null, lead_type: 'phone_call',
  };

  function makeEligibleLeadQueues(overrides = {}) {
    return {
      leads: [chain({ result: [OPTED_IN_LEAD] })],
      new_lead_phone_drip_sends: [chain({ result: [] }), chain({ result: [] })],
      customers: [chain({ result: [OPTED_IN_CUST] }), chain({ first: null })],
      estimates: [chain({ result: [] })],
      scheduled_services: [chain({ first: null })],
      invoices: [chain({ first: null })],
      sms_log: [chain({ first: null })],
      messaging_suppression: [chain({ first: null })],
      ...overrides,
    };
  }

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

  test('claims durably, forwards consentingCustomerId + withSmsHandoff + providerPreSendCheck, and settles claim', async () => {
    const claimInsert = chain({ returning: [{ id: 'claim-1' }] });
    const claimUpdate = chain();
    const actInsert = chain();
    const dbh = makeDb(makeEligibleLeadQueues({
      new_lead_phone_drip_sends: [chain({ result: [] }), chain({ result: [] }), claimInsert, claimUpdate],
      lead_activities: [actInsert],
    }));
    const sendMessage = jest.fn(async () => ({ sent: true, blocked: false, deliveryOutcome: 'accepted', providerMessageId: 'SM123' }));

    const res = await processPhoneOnlyLeadSmsDrip({
      now: NOW_DAYTIME, clock: () => NOW_DAYTIME, dbh, gates: { newLeadDripExtendedLive: () => true }, sendMessage, checkCallVetoes: NO_CALL_VETO,
    });

    expect(res).toEqual({ skipped: null, checked: 1, sent: 1, stopped: 0, deferred: 0 });
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      to: '+19415550144',
      audience: 'lead',
      purpose: DRIP_PURPOSE,
      customerId: 'cust-punct-1',
      identityTrustLevel: 'phone_matches_customer',
      entryPoint: DRIP_ENTRY_POINT,
      consentBasis: { status: 'opted_in', source: 'customer_notification_prefs', phoneBound: true },
      withSmsHandoff: expect.any(Function),
      providerPreSendCheck: expect.any(Function),
    }));
    expect(claimUpdate.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'sent', provider_message_id: 'SM123' }));
    expect(actInsert.insert).toHaveBeenCalledWith(expect.objectContaining({ lead_id: 'lead-10', activity_type: STEP_1_ACTIVITY }));
  });

  test('persists terminal status=stopped on permanent provider refusal (e.g. landline) instead of retrying', async () => {
    const claimInsert = chain({ returning: [{ id: 'claim-term' }] });
    const claimUpdate = chain();
    const dbh = makeDb(makeEligibleLeadQueues({
      new_lead_phone_drip_sends: [chain({ result: [] }), chain({ result: [] }), claimInsert, claimUpdate],
    }));
    const sendMessage = jest.fn(async () => ({ sent: false, blocked: true, deliveryOutcome: 'not_sent', retryable: false }));

    const res = await processPhoneOnlyLeadSmsDrip({
      now: NOW_DAYTIME, clock: () => NOW_DAYTIME, dbh, gates: { newLeadDripExtendedLive: () => true }, sendMessage, checkCallVetoes: NO_CALL_VETO,
    });
    expect(res).toEqual({ skipped: null, checked: 1, sent: 0, stopped: 1, deferred: 0 });
    expect(claimUpdate.update).toHaveBeenCalledWith({ status: 'stopped' });
    expect(claimUpdate.del).not.toHaveBeenCalled();
  });

  test('treats sent:true with uncertain deliveryOutcome as uncertain (never marks sent)', async () => {
    const claimInsert = chain({ returning: [{ id: 'claim-unc' }] });
    const claimUpdate = chain();
    const dbh = makeDb(makeEligibleLeadQueues({
      new_lead_phone_drip_sends: [chain({ result: [] }), chain({ result: [] }), claimInsert, claimUpdate],
    }));
    const sendMessage = jest.fn(async () => ({ sent: true, blocked: false, deliveryOutcome: 'uncertain' }));

    const res = await processPhoneOnlyLeadSmsDrip({
      now: NOW_DAYTIME, clock: () => NOW_DAYTIME, dbh, gates: { newLeadDripExtendedLive: () => true }, sendMessage, checkCallVetoes: NO_CALL_VETO,
    });
    expect(res).toEqual({ skipped: null, checked: 1, sent: 0, stopped: 0, deferred: 1 });
    expect(claimUpdate.update).toHaveBeenCalledWith({ status: 'uncertain' });
  });

  test('providerPreSendCheck rechecks live clock after lock/DB reads and requires exact claimed row', async () => {
    const claimInsert = chain({ returning: [{ id: 'claim-2' }] });
    const claimDelete = chain();
    const dbh = makeDb(makeEligibleLeadQueues({
      new_lead_phone_drip_sends: [chain({ result: [] }), chain({ result: [] }), claimInsert, claimDelete],
    }));
    let calls = 0;
    const clock = () => {
      calls += 1;
      return calls <= 2 ? new Date('2026-11-28T00:59:00Z') : new Date('2026-11-28T01:00:05Z');
    };
    const sendMessage = jest.fn(async (input) => {
      const check = await input.providerPreSendCheck({ channel: 'sms', dbi: dbh });
      expect(check).toEqual(expect.objectContaining({ ok: false, code: 'OUTSIDE_DRIP_SEND_HOURS', retryable: true }));
      return { sent: false, blocked: true, deliveryOutcome: 'not_sent', retryable: true };
    });

    const res = await processPhoneOnlyLeadSmsDrip({
      now: new Date('2026-11-28T00:58:00Z'), clock, dbh,
      gates: { newLeadDripExtendedLive: () => true }, sendMessage, checkCallVetoes: NO_CALL_VETO,
    });
    expect(res).toEqual({ skipped: null, checked: 1, sent: 0, stopped: 0, deferred: 1 });
    expect(claimDelete.del).toHaveBeenCalled();

    // Missing/replaced claim row inside handoff -> LEAD_DRIP_CLAIM_NOT_OWNED
    const claimInsertMissing = chain({ returning: [{ id: 'claim-owned' }] });
    const claimUpdateMissing = chain();
    const missingCustLockQ = chain({ result: [{ id: 'cust-punct-1' }] });
    const missingClaimTrx = makeDb({
      leads: [chain({ first: OPTED_IN_LEAD })],
      customers: [missingCustLockQ, chain({ result: [OPTED_IN_CUST] }), chain({ first: null })],
      estimates: [chain({ result: [] })],
      scheduled_services: [chain({ first: null })],
      invoices: [chain({ first: null })],
      new_lead_phone_drip_sends: [chain({ result: [] }), chain({ first: null })],
      sms_log: [chain({ first: null })],
      messaging_suppression: [chain({ first: null })],
    });
    const dbhMissing = makeDb(makeEligibleLeadQueues({
      new_lead_phone_drip_sends: [chain({ result: [] }), chain({ result: [] }), claimInsertMissing, claimUpdateMissing],
    }));
    const sendMessageMissing = jest.fn(async (input) => {
      const check = await input.providerPreSendCheck({ channel: 'sms', dbi: missingClaimTrx });
      expect(missingCustLockQ.forNoKeyUpdate).toHaveBeenCalled();
      expect(check).toEqual(expect.objectContaining({ ok: false, code: 'LEAD_DRIP_CLAIM_NOT_OWNED' }));
      return { sent: false, blocked: true, deliveryOutcome: 'not_sent', retryable: false };
    });
    const resMissing = await processPhoneOnlyLeadSmsDrip({
      now: NOW_DAYTIME, clock: () => NOW_DAYTIME, dbh: dbhMissing,
      gates: { newLeadDripExtendedLive: () => true }, sendMessage: sendMessageMissing, checkCallVetoes: NO_CALL_VETO,
    });
    expect(resMissing.stopped).toBe(1);
  });

  test('providerPreSendCheck locks customers & lead FOR NO KEY UPDATE and returns retryable:true on transient DB error', async () => {
    const claimInsert = chain({ returning: [{ id: 'claim-timeout' }] });
    const claimDelete = chain();
    const custLockQ = chain({ result: [{ id: 'cust-punct-1' }] });
    const leadLockQ = chain({ firstError: Object.assign(new Error('statement timeout'), { code: '57014' }) });
    const failingTrx = makeDb({ customers: [custLockQ], leads: [leadLockQ] });
    const dbh = makeDb(makeEligibleLeadQueues({
      new_lead_phone_drip_sends: [chain({ result: [] }), chain({ result: [] }), claimInsert, claimDelete],
    }));
    const sendMessage = jest.fn(async (input) => {
      const check = await input.providerPreSendCheck({ channel: 'sms', dbi: failingTrx });
      expect(custLockQ.forNoKeyUpdate).toHaveBeenCalled();
      expect(leadLockQ.forNoKeyUpdate).toHaveBeenCalled();
      expect(check).toEqual(expect.objectContaining({
        ok: false,
        code: 'LEAD_DRIP_HANDOFF_READ_FAILED',
        retryable: true,
      }));
      return { sent: false, blocked: true, deliveryOutcome: 'not_sent', retryable: check.retryable === true };
    });

    const res = await processPhoneOnlyLeadSmsDrip({
      now: NOW_DAYTIME, clock: () => NOW_DAYTIME, dbh,
      gates: { newLeadDripExtendedLive: () => true }, sendMessage, checkCallVetoes: NO_CALL_VETO,
    });
    expect(res).toEqual({ skipped: null, checked: 1, sent: 0, stopped: 0, deferred: 1 });
    expect(claimDelete.del).toHaveBeenCalled();
    expect(claimDelete.update).not.toHaveBeenCalled();
  });

  test('stops drip after staff or Lead Response Agent texts the lead (lead_outreach / lead_response)', async () => {
    const smsLogQ = chain({ first: { id: 'sms-staff-outreach-1' } });
    const dbh = makeDb({
      customers: [chain({ result: [OPTED_IN_CUST] }), chain({ first: null })],
      estimates: [chain({ result: [] })],
      scheduled_services: [chain({ first: null })],
      invoices: [chain({ first: null })],
      new_lead_phone_drip_sends: [chain({ result: [] })],
      sms_log: [smsLogQ],
    });
    const res = await leadShouldStop(dbh, OPTED_IN_LEAD, { checkCallVetoes: NO_CALL_VETO });
    expect(res.stop).toBe('already_engaged');
    expect(smsLogQ.whereRaw).toHaveBeenCalledWith(expect.stringContaining('review_ask_reservation'));
  });

  test('keyset-paginates using created_at::text without OFFSET so PostgreSQL microsecond precision is preserved', async () => {
    const manualLead = {
      ...OPTED_IN_LEAD,
      id: 'lead-01-manual',
      created_at: new Date('2026-11-25T14:00:00.654321Z'),
      cursor_created_at: '2026-11-25 14:00:00.654321+00',
      lead_type: 'manual',
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
        chain({ result: [] }),
        claimInsert,
        claimUpdate,
      ],
      customers: [
        chain({ result: [] }),
        chain({ result: [OPTED_IN_CUST] }),
        chain({ first: null }),
      ],
      estimates: [chain({ result: [] })],
      scheduled_services: [chain({ first: null })],
      invoices: [chain({ first: null })],
      sms_log: [chain({ first: null })],
      messaging_suppression: [chain({ first: null })],
      lead_activities: [actInsert],
    });
    const sendMessage = jest.fn(async () => ({ sent: true, blocked: false, deliveryOutcome: 'accepted' }));

    const res = await processPhoneOnlyLeadSmsDrip({
      now: NOW_DAYTIME, clock: () => NOW_DAYTIME, limit: 1, pageSize: 1, dbh,
      gates: { newLeadDripExtendedLive: () => true }, sendMessage, checkCallVetoes: NO_CALL_VETO,
    });
    expect(page1.offset).not.toHaveBeenCalled();
    expect(page2.offset).not.toHaveBeenCalled();
    expect(page2.whereRaw).toHaveBeenCalledWith(
      '(created_at, id) > (?::timestamptz, ?)',
      ['2026-11-25 14:00:00.654321+00', manualLead.id],
    );
    expect(res).toEqual({ skipped: null, checked: 2, sent: 1, stopped: 1, deferred: 0 });
  });

  test('releases claim on CONSENT_LOOKUP_FAILED (retryable even without retryable:true flag) and defers when lock customer set grows', async () => {
    const claimInsert = chain({ returning: [{ id: 'claim-retry-consent' }] });
    const claimDelete = chain();
    const dbh = makeDb(makeEligibleLeadQueues({
      new_lead_phone_drip_sends: [chain({ result: [] }), chain({ result: [] }), claimInsert, claimDelete],
    }));
    const sendMessage = jest.fn(async () => ({
      sent: false, blocked: true, deliveryOutcome: 'not_sent', code: 'CONSENT_LOOKUP_FAILED',
    }));

    const res = await processPhoneOnlyLeadSmsDrip({
      now: NOW_DAYTIME, clock: () => NOW_DAYTIME, dbh,
      gates: { newLeadDripExtendedLive: () => true }, sendMessage, checkCallVetoes: NO_CALL_VETO,
    });
    expect(res).toEqual({ skipped: null, checked: 1, sent: 0, stopped: 0, deferred: 1 });
    expect(claimDelete.del).toHaveBeenCalled();

    // New customer acquires phone between preflight and handoff -> LEAD_DRIP_LOCK_SET_CHANGED with retryable:true
    const claimInsertLock = chain({ returning: [{ id: 'claim-lock-drift' }] });
    const claimDeleteLock = chain();
    const handoffTrx = makeDb({
      leads: [chain({ first: OPTED_IN_LEAD })],
      customers: [
        chain({ result: [{ id: 'cust-punct-1' }] }),
        chain({
          result: [
            OPTED_IN_CUST,
            { id: 'cust-new-shared', phone: '(941) 555-0144', sms_enabled: true, marketing_offers: true, marketing_channel: 'sms', marketing_sms_consent_phone: '+19415550144' },
          ],
        }),
        chain({ first: null }),
      ],
      estimates: [chain({ result: [] })],
      scheduled_services: [chain({ first: null })],
      invoices: [chain({ first: null })],
      new_lead_phone_drip_sends: [chain({ result: [] })],
      sms_log: [chain({ first: null })],
      messaging_suppression: [chain({ first: null })],
    });
    const dbh2 = makeDb(makeEligibleLeadQueues({
      new_lead_phone_drip_sends: [chain({ result: [] }), chain({ result: [] }), claimInsertLock, claimDeleteLock],
    }));
    const sendMessage2 = jest.fn(async (input) => {
      const check = await input.providerPreSendCheck({ channel: 'sms', dbi: handoffTrx });
      expect(check).toEqual(expect.objectContaining({
        ok: false, code: 'LEAD_DRIP_LOCK_SET_CHANGED', retryable: true,
      }));
      return { sent: false, blocked: true, deliveryOutcome: 'not_sent', retryable: true };
    });
    const res2 = await processPhoneOnlyLeadSmsDrip({
      now: NOW_DAYTIME, clock: () => NOW_DAYTIME, dbh: dbh2,
      gates: { newLeadDripExtendedLive: () => true }, sendMessage: sendMessage2, checkCallVetoes: NO_CALL_VETO,
    });
    expect(res2).toEqual({ skipped: null, checked: 1, sent: 0, stopped: 0, deferred: 1 });
    expect(claimDeleteLock.del).toHaveBeenCalled();
  });

  test('fails closed and defers when messaging_suppression or callVetoesForNumber throws', async () => {
    const dbh = makeDb(makeEligibleLeadQueues({
      messaging_suppression: [chain({ firstError: Object.assign(new Error('db down'), { code: '57014' }) })],
    }));
    const sendMessage = jest.fn();
    const res = await processPhoneOnlyLeadSmsDrip({
      now: NOW_DAYTIME, clock: () => NOW_DAYTIME, dbh, gates: { newLeadDripExtendedLive: () => true }, sendMessage, checkCallVetoes: NO_CALL_VETO,
    });
    expect(res).toEqual({ skipped: null, checked: 1, sent: 0, stopped: 0, deferred: 1 });
    expect(sendMessage).not.toHaveBeenCalled();

    const vetoThrowDb = makeDb(makeEligibleLeadQueues());
    const vetoErrRes = await processPhoneOnlyLeadSmsDrip({
      now: NOW_DAYTIME, clock: () => NOW_DAYTIME, dbh: vetoThrowDb, gates: { newLeadDripExtendedLive: () => true }, sendMessage,
      checkCallVetoes: async () => { throw Object.assign(new Error('call_log timeout'), { code: '57014' }); },
    });
    expect(vetoErrRes).toEqual({ skipped: null, checked: 1, sent: 0, stopped: 0, deferred: 1 });
  });
});
