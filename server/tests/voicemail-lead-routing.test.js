/**
 * Voicemail → workable-lead routing contracts.
 *
 * Three registries have to agree for the voicemail lead path to work, and a
 * miss in any of them fails silently in prod:
 *   1. hasWorkableLeadSignal's voicemail reachback waiver (the callback number
 *      IS the reachback for a voicemail) — call-recording-processor.js.
 *   2. The messaging policy registry: missed_call_followup must be a known
 *      purpose (MESSAGE_PURPOSES — a miss means CONTRACT_VIOLATION on every
 *      send) and resolvable for the lead audience.
 *   3. The scheduled-SMS rail's purpose map: a deferred
 *      voicemail_quote_link row must re-send under missed_call_followup, not
 *      fall through to conversational.
 */

jest.mock('node-cron', () => ({ schedule: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/twilio', () => ({}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => true),
  logGateStatus: jest.fn(),
}));

const CallRecordingProcessor = require('../services/call-recording-processor');
const { purposeForScheduledMessageType } = require('../services/scheduler');
const policy = require('../services/messaging/policy');

const { hasWorkableLeadSignal, findReusableCallLead } = CallRecordingProcessor._test;

describe('hasWorkableLeadSignal voicemail waiver', () => {
  const PHONE = '+19415550101';

  test('a live call still requires an email/address reachback', () => {
    expect(hasWorkableLeadSignal({
      extracted: { matched_service: 'pest control' },
      phone: PHONE,
    })).toBe(false);

    expect(hasWorkableLeadSignal({
      extracted: { matched_service: 'pest control', email: 'dana@example.com' },
      phone: PHONE,
    })).toBe(true);

    expect(hasWorkableLeadSignal({
      extracted: { requested_service: 'rodent', address_line1: '123 Palm Ave' },
      phone: PHONE,
    })).toBe(true);
  });

  test('a voicemail waives the reachback — the callback number IS the reachback', () => {
    expect(hasWorkableLeadSignal({
      extracted: { matched_service: 'pest control' },
      phone: PHONE,
      voicemail: true,
    })).toBe(true);

    expect(hasWorkableLeadSignal({
      extracted: { requested_service: 'termite treatment' },
      phone: PHONE,
      voicemail: true,
    })).toBe(true);
  });

  test('a voicemail with no concrete service intent is still not workable', () => {
    expect(hasWorkableLeadSignal({ extracted: {}, phone: PHONE, voicemail: true })).toBe(false);
    expect(hasWorkableLeadSignal({
      extracted: { call_summary: 'call me back' },
      phone: PHONE,
      voicemail: true,
    })).toBe(false);
  });

  test('no callback number and no email, no lead — voicemail or not', () => {
    expect(hasWorkableLeadSignal({
      extracted: { matched_service: 'pest control' },
      phone: null,
      voicemail: true,
    })).toBe(false);
  });

  test('the waiver only engages on the exact boolean, not truthy junk', () => {
    expect(hasWorkableLeadSignal({
      extracted: { matched_service: 'pest control' },
      phone: PHONE,
      voicemail: 'yes',
    })).toBe(false);
  });
});

describe('hasWorkableLeadSignal anonymous-caller (no phone) path', () => {
  test('valid spoken email + service intent is workable with no phone at all', () => {
    expect(hasWorkableLeadSignal({
      extracted: { matched_service: 'pest control', email: 'jeff@example.com' },
      phone: null,
    })).toBe(true);
  });

  test('an address alone is not a reachback when there is no callback number', () => {
    expect(hasWorkableLeadSignal({
      extracted: { matched_service: 'pest control', address_line1: '123 Palm Ave' },
      phone: null,
    })).toBe(false);
  });

  test('a garbled email does not qualify', () => {
    expect(hasWorkableLeadSignal({
      extracted: { matched_service: 'pest control', email: 'jeff at gmail' },
      phone: null,
    })).toBe(false);
  });

  test('email without service intent is still not workable', () => {
    expect(hasWorkableLeadSignal({
      extracted: { email: 'jeff@example.com' },
      phone: null,
    })).toBe(false);
  });

  test('the voicemail waiver never substitutes for the email when phone-less', () => {
    expect(hasWorkableLeadSignal({
      extracted: { matched_service: 'pest control', address_line1: '123 Palm Ave' },
      phone: null,
      voicemail: true,
    })).toBe(false);
  });

  test('a phone-less voicemail with a valid spoken email IS workable (same branch as live calls)', () => {
    expect(hasWorkableLeadSignal({
      extracted: { matched_service: 'pest control', email: 'jeff@example.com' },
      phone: null,
      voicemail: true,
    })).toBe(true);
  });
});

describe('findReusableCallLead identity keys', () => {
  const makeDb = (row = null) => {
    const calls = [];
    const builder = {};
    for (const m of ['where', 'whereNull', 'whereRaw', 'whereNotIn', 'orderBy']) {
      builder[m] = (...a) => { calls.push([m, a]); return builder; };
    }
    builder.first = async () => { calls.push(['first', []]); return row; };
    const db = (table) => { calls.push(['table', [table]]); return builder; };
    db.calls = calls;
    return db;
  };

  test('phone present: matches by phone only — email never becomes an identity key', async () => {
    const db = makeDb({ id: 'lead-1' });
    const found = await findReusableCallLead(db, {
      phone: '+19415550101',
      email: 'shared@example.com',
      workableUnnamedLead: false,
    });
    expect(found).toEqual({ id: 'lead-1' });
    expect(db.calls.some(([m, a]) => m === 'where' && a[0] === 'phone')).toBe(true);
    expect(db.calls.some(([m]) => m === 'whereRaw')).toBe(false);
  });

  test('no phone: matches by lowercased trimmed email, unclaimed leads only', async () => {
    const db = makeDb({ id: 'lead-2' });
    const found = await findReusableCallLead(db, {
      phone: null,
      email: '  JBrooks00005@Gmail.com ',
      workableUnnamedLead: true,
    });
    expect(found).toEqual({ id: 'lead-2' });
    const raw = db.calls.find(([m]) => m === 'whereRaw');
    expect(raw[1][1]).toEqual(['jbrooks00005@gmail.com']);
    expect(db.calls.some(([m, a]) => m === 'where' && a[0] === 'phone')).toBe(false);
    // Weak identity: an email match must never land on a customer-owned lead.
    expect(db.calls.some(([m, a]) => m === 'whereNull' && a[0] === 'customer_id')).toBe(true);
  });

  test('no phone and no email: returns null without querying', async () => {
    const db = makeDb({ id: 'lead-3' });
    const found = await findReusableCallLead(db, { phone: null, email: null });
    expect(found).toBeNull();
    expect(db.calls.length).toBe(0);
  });
});

describe('missed_call_followup policy registry', () => {
  test('is a registered purpose (a miss = CONTRACT_VIOLATION on every send)', () => {
    expect(policy.MESSAGE_PURPOSES).toContain('missed_call_followup');
  });

  test('resolves for the lead audience with the transactional/anonymous-lead shape', () => {
    const resolved = policy.resolvePolicy('lead', 'missed_call_followup');
    expect(resolved).toEqual(expect.objectContaining({
      requireConsent: 'transactional',
      minIdentityTrust: 'phone_provided_unverified',
      allowExactPrice: false,
    }));
  });

});

describe('scheduled-SMS rail purpose map', () => {
  test('a deferred voicemail_quote_link re-sends under missed_call_followup', () => {
    expect(purposeForScheduledMessageType('voicemail_quote_link')).toBe('missed_call_followup');
    expect(purposeForScheduledMessageType('missed_call_followup')).toBe('missed_call_followup');
  });

  test('existing mappings are unchanged', () => {
    expect(purposeForScheduledMessageType('review_request')).toBe('review_request');
    expect(purposeForScheduledMessageType('appointment_reminder')).toBe('appointment');
    expect(purposeForScheduledMessageType('manual')).toBe('conversational');
    expect(purposeForScheduledMessageType(null)).toBe('conversational');
  });
});
