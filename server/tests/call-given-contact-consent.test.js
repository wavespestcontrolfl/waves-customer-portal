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
  callGivenConsentPersisted,
  holdCallGivenFallback,
} = _test;
const { optinRowAllowsCallGiven } = require('../services/call-given-consent');

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
  const writes = { updates: [], whereRaws: [] };
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
        whereRaw: jest.fn((sql, binds) => { collision = true; writes.whereRaws.push([sql, binds]); return b; }),
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
    // Per-phone provenance in the same UPDATE; the phone is NOT put on the unconsented list.
    expect(writes.updates[0].service_preferences.sql).toContain('call_given_phone_keys');
    expect(writes.updates[0].service_preferences.sql).not.toContain('unconsented_slot_phone_keys');
    // The same UPDATE drops the phone from login_attested_phone_keys (a stale holder attestation from a removed contact must not
    // grant login to a phone this call re-adds): the key binds twice, once per jsonb edit.
    expect(writes.updates[0].service_preferences.binds).toEqual(['5550100123', '5550100123']);
    expect(writes.updates[0].service_preferences.sql).toContain("jsonb_build_object('login_attested_phone_keys'");
    expect(writes.updates[0].service_preferences.sql).toContain('WHERE k <> to_jsonb(?::text)');
  });

  test('the UPDATE is pinned to the coverage the decision used: stamp absent + every contact phone as read', async () => {
    const writes = makeDb(bareCustomer);
    await persistCallSecondaryContact('cust-1', spouse, { callGivenConsent: true, consentAt });
    const sqls = writes.whereRaws.map(([sql]) => sql);
    expect(sqls).toContain('service_contacts_consent_at IS NULL');
    expect(sqls.filter((q) => q === '?? IS NOT DISTINCT FROM ?')).toHaveLength(3);
    const stamped = makeDb(stampedWithContact);
    await persistCallSecondaryContact('cust-1', spouse, { callGivenConsent: true, consentAt });
    expect(stamped.whereRaws.map(([sql]) => sql)).toContain('service_contacts_consent_at IS NOT NULL');
    const phoneBinds = stamped.whereRaws.filter(([sql]) => sql === '?? IS NOT DISTINCT FROM ?').map(([, b]) => b);
    expect(phoneBinds).toContainEqual(['service_contact_phone', '+15550100777']);
  });

  test('without the option the UPDATE carries no coverage pin (gate off)', async () => {
    const writes = makeDb(bareCustomer);
    await persistCallSecondaryContact('cust-1', spouse);
    expect(writes.whereRaws.map(([sql]) => sql)).not.toContain('service_contacts_consent_at IS NULL');
  });

  test('beats the explicit-consent path: no call_pipeline_request stamp, same new source', async () => {
    const writes = makeDb(bareCustomer);
    await persistCallSecondaryContact('cust-1', spouse, { smsConsentExplicit: true, callGivenConsent: true, consentAt });
    expect(writes.updates[0].service_contacts_consent_source).toBe('call_caller_provided');
  });

  test('an existing stamp stays exactly as it is: not cleared, not rewritten, phone not held', async () => {
    const writes = makeDb(stampedWithContact);
    expect(await persistCallSecondaryContact('cust-1', spouse, { callGivenConsent: true, consentAt })).toBe('written');
    for (const key of ['service_contacts_consent_at', 'service_contacts_consent_source', 'service_contacts_consent_text_version']) {
      expect(writes.updates[0]).not.toHaveProperty(key);
    }
    // ...but the phone's call-given provenance is recorded (login stays refused for it) and it is not held.
    expect(writes.updates[0].service_preferences.sql).toContain('call_given_phone_keys');
    expect(writes.updates[0].service_preferences.sql).not.toContain('unconsented_slot_phone_keys');
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
    expect(writes.updates[0]).not.toHaveProperty('service_preferences');
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
    // The intent must sit on the V2 entry that carries the phone, not on a merge with a V1 contact.
    expect(src).toContain('phoneFromV2: v2GivenIntentPhoneKeys.has(lastTen(secondaryEntry.phone)),');
    expect(src).toContain('.filter((c) => c && (c.wants_notifications === true || onSiteOptinAskTrigger(c)))');
    // Original V2 entries mapped one by one, never merged by canonicalV2Secondary.
    expect(src).toContain('new Set([mapSecondaryContactToLegacy(v2CanonicalExtraction?.secondary_contact), ...mapSecondaryContactsToLegacy(v2CanonicalExtraction?.secondary_contacts)]');
    expect(src).not.toContain('v2SecondaryPhoneKeys');
    expect(src).toContain('heldPhoneKeys: callGivenHeldPhoneKeys,');
    expect(src).toContain('const callGivenHeldPhoneKeys = (callbackNumberNeededHoldActive || callAniCannotText)');
  });

  test('a new phone only: a phone already on the account keeps its own standing', () => {
    expect(src).toContain('callGivenConsent = !givenOnRecord && callGivenConsentRowCovered(givenRow, givenSlots)');
    // A non-confirmed opt-in row for the phone keeps today's path and ask.
    expect(src).toContain('&& await optinRowAllowsCallGiven(customerId, secondaryEntry.phone);');
  });

  test('consented phone: no blocking opt-in row, no queued on-site ask, no explicit-consent Reply-YES claim, card says why', () => {
    expect(src).toContain('if (onSitePreAsk && !callGivenConsent) {');
    expect(src).toContain('const callGivenConsentApplied = (callGivenConsent || callGivenRetained)');
    expect(src).toContain('&& await callGivenConsentPersisted(customerId, secondaryEntry.phone);');
    expect(src).toContain("if (callGivenConsent && result === 'written' && !callGivenConsentApplied) await holdCallGivenFallback(customerId, secondaryEntry.phone);");
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

  test('a retry reads the persisted provenance of a phone already on record, and the save does not need a live opt-in rail for it', () => {
    expect(src).toContain('callGivenRetained = givenOnRecord;');
    expect(src).toContain('onSiteAskEligible: onSitePreAsk || callGivenConsent || callGivenRetained,');
  });

  test('gate off keeps the old call-site behavior: callGivenConsent is false, so the block above it is the old one', () => {
    process.env[GATE] = '';
    expect(callGivenConsentApplies(spouse, { phoneFromV2: true })).toBe(false);
  });
});

describe('callGivenConsentPersisted: the committed outcome, read from the row', () => {
  function rowDb(row, optin = null) {
    db.mockImplementation((table) => {
      if (table === 'recipient_optin') {
        const b = { where: () => b, first: async () => { if (optin instanceof Error) throw optin; return optin; } };
        return b;
      }
      expect(table).toBe('customers');
      const b = { where: () => b, first: async () => row };
      return b;
    });
  }
  const stamp = '2026-10-29T15:14:28Z';
  const prefs = (o) => JSON.stringify(o);

  test('true only when the row is stamped, lists the phone as call-given, and no hold names it', async () => {
    rowDb({ service_contacts_consent_at: stamp, service_preferences: prefs({ call_given_phone_keys: ['5550100123'] }) });
    expect(await callGivenConsentPersisted('c', '+15550100123')).toBe(true);
    rowDb({ service_contacts_consent_at: stamp, service_preferences: prefs({ call_given_phone_keys: ['5550100123'], unconsented_slot_phone_keys: ['5550100123'] }) });
    expect(await callGivenConsentPersisted('c', '+15550100123')).toBe(false); // a later hold wins
    rowDb({ service_contacts_consent_at: null, service_preferences: prefs({ call_given_phone_keys: ['5550100123'] }) });
    expect(await callGivenConsentPersisted('c', '+15550100123')).toBe(false); // stamp gone (admin edit / STOP path)
    rowDb({ service_contacts_consent_at: stamp, service_preferences: prefs({}) });
    expect(await callGivenConsentPersisted('c', '+15550100123')).toBe(false); // writer declined: no provenance
    rowDb(undefined);
    expect(await callGivenConsentPersisted('c', '+15550100123')).toBe(false);
  });

  test('an existing opt-in row: confirmed stands; declined, pending and ask_failed do not (the old ask path keeps them recoverable)', async () => {
    const row = { service_contacts_consent_at: stamp, service_preferences: prefs({ call_given_phone_keys: ['5550100123'] }) };
    rowDb(row, { status: 'confirmed' });
    expect(await callGivenConsentPersisted('c', '+15550100123')).toBe(true);
    for (const status of ['declined', 'pending', 'ask_failed']) {
      rowDb(row, { status });
      expect(await callGivenConsentPersisted('c', '+15550100123')).toBe(false);
      expect(await optinRowAllowsCallGiven('c', '+15550100123')).toBe(false);
    }
    rowDb(row, null);
    expect(await optinRowAllowsCallGiven('c', '+15550100123')).toBe(true);
    // Fail closed on an unreadable table; a missing table (un-migrated env) is no row.
    rowDb(row, Object.assign(new Error('boom'), { code: '57014' }));
    expect(await optinRowAllowsCallGiven('c', '+15550100123')).toBe(false);
    rowDb(row, Object.assign(new Error('missing'), { code: '42P01' }));
    expect(await optinRowAllowsCallGiven('c', '+15550100123')).toBe(true);
  });
});

describe('holdCallGivenFallback: a write that fell back takes the fail-closed path', () => {
  test('blocking ask_failed row + unconsented list', async () => {
    const inserted = [];
    const updated = [];
    const guards = [];
    db.raw = jest.fn((sql, binds) => ({ sql, binds }));
    db.mockImplementation((table) => {
      if (table === 'recipient_optin') {
        return { insert: (row) => { inserted.push(row); return { onConflict: () => ({ ignore: async () => 1 }) }; } };
      }
      const b = { where: () => b, whereRaw: (sql, binds) => { guards.push([sql, binds]); return b; }, update: async (p) => { updated.push(p); return 1; } };
      return b;
    });
    await holdCallGivenFallback('cust-1', '+15550100123');
    expect(inserted[0]).toMatchObject({ phone_key: '5550100123', status: 'ask_failed', customer_id: 'cust-1' });
    expect(updated[0].service_preferences.sql).toContain('unconsented_slot_phone_keys');
    expect(updated[0].service_preferences.binds).toEqual(['5550100123']);
    // Single-statement guard: a YES that landed since the read (a confirmed row) means the phone is not put back on the list.
    expect(guards).toEqual([["NOT EXISTS (SELECT 1 FROM recipient_optin WHERE customer_id = ? AND phone_key = ? AND status = 'confirmed')", ['cust-1', '5550100123']]]);
  });
});

describe('contact login (contactSlotMayLogIn): caller-given consent covers texts, never sign-in', () => {
  const { contactSlotMayLogIn, getAppointmentContacts } = require('../services/customer-contact');
  const KEY = '5552220000';
  const stamped = (prefs) => ({
    id: 'c', phone: '+15550100999', service_contact_phone: '+15552220000', service_contact_name: 'Sample',
    service_contacts_consent_at: new Date('2026-10-29T15:14:28Z'),
    service_contacts_consent_source: 'call_caller_provided',
    service_preferences: prefs,
  });
  afterEach(() => { delete process.env.GATE_CONTACT_LOGIN_HOLDER_ONLY; });

  test('a call-given phone is refused, with the holder-only gate off or on', () => {
    const row = stamped(JSON.stringify({ call_given_phone_keys: [KEY] }));
    expect(contactSlotMayLogIn(row, KEY)).toBe(false);
    process.env.GATE_CONTACT_LOGIN_HOLDER_ONLY = 'true';
    expect(contactSlotMayLogIn(row, KEY)).toBe(false);
  });

  test('...unless the holder\'s own portal save attested that phone', () => {
    const row = stamped({ call_given_phone_keys: [KEY], login_attested_phone_keys: [KEY] });
    expect(contactSlotMayLogIn(row, KEY)).toBe(true);
    process.env.GATE_CONTACT_LOGIN_HOLDER_ONLY = 'true';
    expect(contactSlotMayLogIn(row, KEY)).toBe(true);
  });

  test('other stamped phones, and a phone added under an existing stamp, behave as before', () => {
    expect(contactSlotMayLogIn(stamped(null), KEY)).toBe(true);
    expect(contactSlotMayLogIn(stamped({ call_given_phone_keys: ['5559990000'] }), KEY)).toBe(true);
    // Another phone's provenance does not touch this one, and this one's provenance does not touch another phone.
    expect(contactSlotMayLogIn(stamped({ call_given_phone_keys: [KEY] }), '5559990000')).toBe(true);
  });

  test('texts are unaffected: the call-given phone still receives appointment texts', () => {
    const row = stamped(JSON.stringify({ call_given_phone_keys: [KEY] }));
    expect(getAppointmentContacts(row, { appointment_notify_primary: false })).toEqual([
      expect.objectContaining({ phone: '+15552220000' }),
    ]);
  });

  test('call_given_phone_keys is a server-owned preference key that portal rewrites carry over and a merge carries along', () => {
    const { SERVER_OWNED_PREF_KEYS, withServerOwnedPrefs } = require('../utils/service-preferences-server-keys');
    expect(SERVER_OWNED_PREF_KEYS).toContain('call_given_phone_keys');
    expect(withServerOwnedPrefs({ call_given_phone_keys: [KEY] }, { interior_spray: true }).call_given_phone_keys).toEqual([KEY]);
    const dedupe = fs.readFileSync(require.resolve('../services/customer-dedupe'), 'utf8');
    expect(dedupe).toContain("for (const key of ['unconsented_slot_phone_keys', 'consent_covered_phone_keys', 'call_given_phone_keys']) {");
  });
});

describe('review asks: caller-given consent covers appointment and service texts only', () => {
  const { getServiceContactSmsRecipient } = require('../services/customer-contact');
  const row = (prefs) => ({
    id: 'c', phone: '+15550100999', first_name: 'Holder', service_contact_phone: '+15552220000', service_contact_name: 'Sample',
    service_contacts_consent_at: new Date('2026-10-29T15:14:28Z'), service_preferences: prefs,
  });

  test('a call-given phone is the service text recipient, but a review ask falls back to the account holder', () => {
    const r = row(JSON.stringify({ call_given_phone_keys: ['5552220000'] }));
    expect(getServiceContactSmsRecipient(r).phone).toBe('+15552220000');
    expect(getServiceContactSmsRecipient(r, { excludeCallGiven: true })).toMatchObject({ phone: '+15550100999', role: 'primary' });
  });

  test('any other stamped contact still receives the review ask', () => {
    expect(getServiceContactSmsRecipient(row(null), { excludeCallGiven: true }).phone).toBe('+15552220000');
    expect(getServiceContactSmsRecipient(row({ call_given_phone_keys: ['5559990000'] }), { excludeCallGiven: true }).phone).toBe('+15552220000');
  });

  test('every review sender asks with excludeCallGiven; the visit-complete service text does not', () => {
    const read = (f) => fs.readFileSync(require.resolve(f), 'utf8');
    const review = read('../services/review-request');
    const calls = review.match(/resolveServiceContactSmsRecipient\(customer[^)]*\)/g) || [];
    expect(calls.length).toBeGreaterThanOrEqual(5);
    for (const call of calls) expect(call).toContain('excludeCallGiven: true');
    // The past-destinations list (where an earlier ask could have gone) stays the broad one: it is history, not a send.
    expect(review).toContain('getServiceContactSmsRecipient(owner).phone');
    expect(read('../services/intelligence-bar/review-tools')).toContain('resolveServiceContactSmsRecipient(customer, { excludeCallGiven: true })');
    expect(read('../routes/admin-reviews')).toContain('excludeCallGiven: true');
    expect(read('../routes/admin-intelligence-bar').match(/resolveServiceContactSmsRecipient\([a-z]+, \{ excludeCallGiven: true \}/g)).toHaveLength(2);
    expect(read('../services/visit-completion-summary')).not.toContain('excludeCallGiven');
  });
});

describe('intent must sit on the V2 entry that carries the phone', () => {
  const { mapSecondaryContactToLegacy, mapSecondaryContactsToLegacy } = require('../utils/extraction-compat');
  const { onSiteOptinAskTrigger } = _test;
  const keysFor = (extraction) => new Set([mapSecondaryContactToLegacy(extraction.secondary_contact), ...mapSecondaryContactsToLegacy(extraction.secondary_contacts)]
    .filter((c) => c && (c.wants_notifications === true || onSiteOptinAskTrigger(c)))
    .map((c) => String(c.phone || '').replace(/\D/g, '').slice(-10)).filter(Boolean));

  test('a V2 phone-only party with no ask or on-site role gets no key, even when another party wants notifications', () => {
    const v2 = { secondary_contacts: [
      { first_name: 'Pat', phone_e164: '+15550100123', role: 'other', wants_notifications: false },
      { first_name: 'Sam', email: 'sam@example.com', role: 'spouse_partner', wants_notifications: true },
    ] };
    expect(keysFor(v2).has('5550100123')).toBe(false);
  });

  test('a name-only singleton that wants notifications is NOT merged with a phone-only array entry of the same first name', () => {
    const v2 = {
      secondary_contact: { first_name: 'Pat', role: 'spouse_partner', wants_notifications: true },
      secondary_contacts: [{ first_name: 'Pat', last_name: 'Smith', phone_e164: '+15550100123', role: 'other', wants_notifications: false }],
    };
    expect(keysFor(v2).has('5550100123')).toBe(false);
  });

  test('the party that carries the number AND the ask, or an on-site role, gets the key', () => {
    expect(keysFor({ secondary_contacts: [{ first_name: 'Pat', phone_e164: '+15550100123', role: 'tenant', wants_notifications: true }] }).has('5550100123')).toBe(true);
    expect(keysFor({ secondary_contacts: [{ first_name: 'Pat', phone_e164: '+15550100123', role: 'tenant', on_site: true }] }).has('5550100123')).toBe(true);
  });
});
