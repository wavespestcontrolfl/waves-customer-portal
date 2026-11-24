/**
 * GATE_CALL_GIVEN_CONTACT_CONSENT (owner ruling 2026-10-29): a phone a caller gives on a call for another person
 * counts as consent to text that person. Gate off = today's hold + Reply-YES ask, byte for byte.
 * Gate on = row stamp (call_caller_provided), no unconsented hold, no Reply-YES ask, never clears a stamp.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/twilio-numbers', () => ({
  getOutboundNumber: jest.fn(() => '+15550000000'),
  getNumberByType: jest.fn(() => '+15550000000'),
  LOCATIONS: {},
}));

const fs = require('fs');
const db = require('../models/db');
const featureGates = require('../config/feature-gates');
const { _test } = require('../services/call-recording-processor');

const {
  persistCallSecondaryContact,
  callGivenConsentApplies,
  callGivenConsentRowCovered,
  callGivenConsentAt,
} = _test;

const GATE = 'GATE_CALL_GIVEN_CONTACT_CONSENT';
let savedGate;
beforeEach(() => { savedGate = process.env[GATE]; delete process.env[GATE]; });
afterEach(() => {
  if (savedGate === undefined) delete process.env[GATE]; else process.env[GATE] = savedGate;
});

const spouse = {
  first_name: 'Sample', last_name: 'Spouse', phone: '+15550100123', email: null,
  role: 'spouse_partner', wants_notifications: true, wants_appointment_texts: true, on_site: true,
};

function makeDb(customer) {
  const writes = { updates: [] };
  db.raw = jest.fn((sql, binds) => ({ sql, binds }));
  db.mockImplementation((table) => {
    if (table === 'customers') {
      let collision = false;
      const b = {
        where: jest.fn((arg) => {
          if (typeof arg === 'function') { const sub = { whereNull: () => sub, orWhere: () => sub }; arg(sub); }
          return b;
        }),
        whereNull: jest.fn(() => b),
        whereNot: jest.fn(() => b),
        whereRaw: jest.fn(() => { collision = true; return b; }),
        first: jest.fn(async () => (collision ? null : customer)),
        update: jest.fn(async (payload) => { writes.updates.push(payload); return 1; }),
      };
      return b;
    }
    if (table === 'notification_prefs') {
      const b = { where: () => b, first: async () => undefined, insert: () => ({ onConflict: () => ({ merge: async () => 1 }) }) };
      return b;
    }
    throw new Error(`unexpected table ${table}`);
  });
  return writes;
}

const bareCustomer = {
  id: 'cust-1', phone: '+15550100999', email: null,
  service_contact_name: null, service_contact_phone: null, service_contact_email: null,
  service_contact2_name: null, service_contact2_phone: null, service_contact2_email: null,
  service_contact3_name: null, service_contact3_phone: null, service_contact3_email: null,
};
const stampedWithContact = {
  ...bareCustomer,
  service_contact_name: 'Property Manager',
  service_contact_phone: '+15550100777',
  service_contacts_consent_at: '2026-07-22T00:00:00Z',
  service_contacts_consent_source: 'portal_account_holder',
};
const unstampedWithContact = {
  ...bareCustomer,
  service_contact_name: 'Property Manager',
  service_contact_phone: '+15550100777',
};

describe('gate reader', () => {
  test('dark unless exactly true, read at call time', () => {
    expect(featureGates.callGivenContactConsentLive()).toBe(false);
    process.env[GATE] = '1';
    expect(featureGates.callGivenContactConsentLive()).toBe(false);
    process.env[GATE] = 'true';
    expect(featureGates.callGivenContactConsentLive()).toBe(true);
  });
});

describe('callGivenConsentApplies', () => {
  const ok = { doNotContact: false, phoneFromV2: true, heldPhoneKeys: [] };

  test('gate off: never', () => {
    expect(callGivenConsentApplies(spouse, ok)).toBe(false);
  });

  test('gate on: a V2-captured phone the caller asked notifications for, or an on-site contact', () => {
    process.env[GATE] = 'true';
    expect(callGivenConsentApplies(spouse, ok)).toBe(true);
    expect(callGivenConsentApplies({ ...spouse, wants_notifications: false }, ok)).toBe(true); // on-site trigger
    expect(callGivenConsentApplies({ ...spouse, wants_notifications: false, on_site: false, wants_appointment_texts: false }, ok)).toBe(false);
  });

  test('gate on: do-not-contact, a legacy-only phone, an impossible number and a held/disclaimed number still block', () => {
    process.env[GATE] = 'true';
    expect(callGivenConsentApplies(spouse, { ...ok, doNotContact: true })).toBe(false);
    expect(callGivenConsentApplies(spouse, { ...ok, phoneFromV2: false })).toBe(false);
    expect(callGivenConsentApplies({ ...spouse, phone: '+11735550123' }, ok)).toBe(false);
    expect(callGivenConsentApplies({ ...spouse, phone: null }, ok)).toBe(false);
    expect(callGivenConsentApplies(spouse, { ...ok, heldPhoneKeys: ['(555) 010-0123'] })).toBe(false);
    expect(callGivenConsentApplies(spouse, { ...ok, heldPhoneKeys: ['5550100000', null] })).toBe(true);
  });
});

describe('callGivenConsentRowCovered', () => {
  const { SERVICE_CONTACT_SLOTS } = require('../services/customer-contact');
  test('covered only when the row has no contact phones or is already stamped', () => {
    expect(callGivenConsentRowCovered(bareCustomer, SERVICE_CONTACT_SLOTS)).toBe(true);
    expect(callGivenConsentRowCovered(stampedWithContact, SERVICE_CONTACT_SLOTS)).toBe(true);
    expect(callGivenConsentRowCovered(unstampedWithContact, SERVICE_CONTACT_SLOTS)).toBe(false);
  });
});

describe('callGivenConsentAt', () => {
  test('call end = start + duration; falls back to now', () => {
    const start = new Date(Date.now() - 3600 * 1000);
    expect(callGivenConsentAt({ created_at: start.toISOString(), duration_seconds: 120 }).getTime()).toBe(start.getTime() + 120000);
    const now = Date.now();
    expect(Math.abs(callGivenConsentAt({}).getTime() - now)).toBeLessThan(5000);
  });
});

describe('persistCallSecondaryContact with callGivenConsent', () => {
  const consentAt = new Date('2026-10-29T15:14:28Z');

  test('stamps a row that has none: call end, call_caller_provided, owner ruling version; phone is NOT held', async () => {
    const writes = makeDb(bareCustomer);
    expect(await persistCallSecondaryContact('cust-1', spouse, { callGivenConsent: true, consentAt })).toBe('written');
    expect(writes.updates).toHaveLength(1);
    expect(writes.updates[0]).toMatchObject({
      service_contact_phone: '+15550100123',
      service_contacts_consent_at: consentAt,
      service_contacts_consent_source: 'call_caller_provided',
      service_contacts_consent_text_version: 'owner-ruling-2026-10-29',
    });
    expect(writes.updates[0]).not.toHaveProperty('service_preferences');
  });

  test('beats the explicit-consent path: no call_pipeline_request stamp, same new source', async () => {
    const writes = makeDb(bareCustomer);
    await persistCallSecondaryContact('cust-1', spouse, { smsConsentExplicit: true, callGivenConsent: true, consentAt });
    expect(writes.updates[0].service_contacts_consent_source).toBe('call_caller_provided');
  });

  test('an existing stamp stays exactly as it is: not cleared, not rewritten, phone not held', async () => {
    const writes = makeDb(stampedWithContact);
    expect(await persistCallSecondaryContact('cust-1', spouse, { callGivenConsent: true, consentAt })).toBe('written');
    for (const key of ['service_contacts_consent_at', 'service_contacts_consent_source', 'service_contacts_consent_text_version', 'service_preferences']) {
      expect(writes.updates[0]).not.toHaveProperty(key);
    }
    expect(writes.updates[0]).toMatchObject({ service_contact2_phone: '+15550100123' });
  });

  test('an on-site-only contact (no notification ask) is saved and stamped (the call site passes onSiteAskEligible: onSitePreAsk || callGivenConsent, so a dark opt-in rail does not drop it)', async () => {
    const writes = makeDb(bareCustomer);
    const onSiteOnly = { ...spouse, wants_notifications: false };
    expect(await persistCallSecondaryContact('cust-1', onSiteOnly, { onSiteAskEligible: true, callGivenConsent: true, consentAt })).toBe('written');
    expect(writes.updates[0].service_contacts_consent_source).toBe('call_caller_provided');
    expect(writes.updates[0].service_contact_email).toBeNull();
  });

  test('a row with another UNSTAMPED contact phone is not covered: today\'s rules apply (no stamp, hold stays available)', async () => {
    const writes = makeDb(unstampedWithContact);
    expect(await persistCallSecondaryContact('cust-1', spouse, { callGivenConsent: true, consentAt })).toBe('written');
    expect(writes.updates[0]).not.toHaveProperty('service_contacts_consent_at');
    expect(writes.updates[0]).not.toHaveProperty('service_contacts_consent_source');
  });

  test('without the option the write is today\'s: an unconsented phone on a stamped row still clears the stamp', async () => {
    const writes = makeDb(stampedWithContact);
    expect(await persistCallSecondaryContact('cust-1', spouse)).toBe('written');
    expect(writes.updates[0].service_contacts_consent_at).toBeNull();
    expect(writes.updates[0].service_contacts_consent_source).toBeNull();
  });

  test('without the option a held on-site phone is still held (gate off path)', async () => {
    const writes = makeDb(stampedWithContact);
    await persistCallSecondaryContact('cust-1', spouse, { onSiteAskEligible: true, keepConsentStamp: true });
    expect(writes.updates[0].service_preferences.sql).toContain('unconsented_slot_phone_keys');
  });
});

describe('call-site wiring (source contract)', () => {
  const src = fs.readFileSync(require.resolve('../services/call-recording-processor'), 'utf8');

  test('the decision reads the gate, the do-not-contact request, V2 provenance and the held-number list', () => {
    expect(src).toContain('let callGivenConsent = callGivenConsentApplies(secondaryEntry, {');
    expect(src).toContain('doNotContact: v2DoNotContact,');
    expect(src).toContain('phoneFromV2: v2SecondaryPhoneKeys.has(lastTen(secondaryEntry.phone)),');
    expect(src).toContain('heldPhoneKeys: callGivenHeldPhoneKeys,');
    expect(src).toContain('const callGivenHeldPhoneKeys = (callbackNumberNeededHoldActive || callAniCannotText)');
  });

  test('a new phone only: a phone already on the account keeps its own standing', () => {
    expect(src).toContain('callGivenConsent = !onRecordKeys.includes(lastTen(secondaryEntry.phone)) && callGivenConsentRowCovered(givenRow, givenSlots);');
  });

  test('consented phone: no blocking opt-in row, no queued on-site ask, no explicit-consent Reply-YES claim, card says why', () => {
    expect(src).toContain('if (onSitePreAsk && !callGivenConsent) {');
    expect(src).toContain('const callGivenConsentApplied = callGivenConsent && result === \'written\';');
    expect(src).toContain('if (onSiteDecision.ask && secondaryEntry?.phone && !callGivenConsentApplied) {');
    expect(src).toContain("&& onSiteDecision.reason !== 'phone_not_from_v2' && !callGivenConsentApplied) {");
    expect(src).toContain("callGivenConsentApplied ? 'not_sent:call_given_consent' : optinAskState");
  });

  test('same-call confirmation reaches a caller-given phone without the caller\'s own explicit consent; nobody else', () => {
    expect(src).toContain('const extraContacts = (!v2SmsConsentExplicit && !callGivenConsentPhones.size) ? [] : (await filterRecipientsByOptin(');
    expect(src).toContain('&& (v2SmsConsentExplicit || callGivenConsentPhones.has(fanLast10(c.phone)))');
    // Opt-in holds and claim failures still filter the fan-out.
    expect(src).toContain('&& !optinClaimFailedPhones.has(fanLast10(c.phone)));');
  });

  test('gate off keeps the old call-site behavior: callGivenConsent is false, so the block above it is the old one', () => {
    process.env[GATE] = '';
    expect(callGivenConsentApplies(spouse, { phoneFromV2: true })).toBe(false);
  });
});
