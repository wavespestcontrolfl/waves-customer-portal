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
  const makeDb = (rowOrRows = null) => {
    const rows = Array.isArray(rowOrRows) ? rowOrRows : (rowOrRows ? [rowOrRows] : []);
    const calls = [];
    // The corroboration predicates live in SQL now — interpret the two name
    // whereRaw shapes so these tests stay behavioral (a mock that returns
    // rows regardless of WHERE would trivially pass every identity test).
    const filtered = () => {
      let out = rows;
      for (const [m, a] of calls) {
        if (m !== 'whereRaw') continue;
        const [sql, binds] = a;
        if (String(sql).includes('LOWER(TRIM(first_name))')) {
          out = out.filter((r) => String(r.first_name || '').trim().toLowerCase() === binds[0]);
        } else if (String(sql).includes('last_name IS NULL')) {
          out = out.filter((r) => {
            const ln = String(r.last_name || '').trim().toLowerCase();
            return !ln || ln === binds[0];
          });
        }
      }
      return out;
    };
    const builder = {};
    for (const m of ['where', 'whereNull', 'whereRaw', 'whereNotIn', 'orderBy', 'limit']) {
      builder[m] = (...a) => { calls.push([m, a]); return builder; };
    }
    builder.first = async () => { calls.push(['first', []]); return filtered()[0] || null; };
    // Some paths await the builder itself (knex builders are thenable).
    builder.then = (resolve) => resolve(filtered());
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
    const db = makeDb({ id: 'lead-2', first_name: 'Jeff', last_name: 'Brooks' });
    const found = await findReusableCallLead(db, {
      phone: null,
      email: '  JBrooks00005@Example.com ',
      firstName: 'Jeff',
      lastName: 'Brooks',
      workableUnnamedLead: true,
    });
    expect(found).toEqual({ id: 'lead-2', first_name: 'Jeff', last_name: 'Brooks' });
    const raw = db.calls.find(([m]) => m === 'whereRaw');
    expect(raw[1][1]).toEqual(['jbrooks00005@example.com']);
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

  test('no phone with a NON-email capture ("unknown"): never an identity key, no query', async () => {
    // Customer-attached calls reach this lookup without the workable-signal
    // EMAIL_RE gate — the function itself must refuse a malformed capture, or
    // two calls both storing "unknown" would reuse each other's leads.
    const db = makeDb({ id: 'lead-junk' });
    const found = await findReusableCallLead(db, { phone: null, email: 'unknown' });
    expect(found).toBeNull();
    expect(db.calls.length).toBe(0);
  });

  test('email match with a CONFLICTING stated name forces a fresh lead', async () => {
    const db = makeDb({ id: 'lead-4', first_name: 'Maria', last_name: 'Lopez' });
    const found = await findReusableCallLead(db, {
      phone: null,
      email: 'shared@example.com',
      firstName: 'Jeff',
      lastName: 'Brooks',
      workableUnnamedLead: true,
    });
    expect(found).toBeNull();
  });

  test('email match with a POSITIVELY corroborated first name is reusable (case-insensitive)', async () => {
    const sameName = makeDb({ id: 'lead-5', first_name: 'Jeff', last_name: 'Brooks' });
    expect(await findReusableCallLead(sameName, {
      phone: null,
      email: 'shared@example.com',
      firstName: 'jeff',
      lastName: 'BROOKS',
      workableUnnamedLead: true,
    })).toEqual({ id: 'lead-5', first_name: 'Jeff', last_name: 'Brooks' });

    // A missing last name on either side does not block a first-name match.
    const noLastName = makeDb({ id: 'lead-5b', first_name: 'Jeff', last_name: null });
    expect(await findReusableCallLead(noLastName, {
      phone: null,
      email: 'shared@example.com',
      firstName: 'Jeff',
      lastName: 'Brooks',
      workableUnnamedLead: true,
    })).toEqual({ id: 'lead-5b', first_name: 'Jeff', last_name: null });
  });

  test('email match WITHOUT positive name corroboration forces a fresh lead — missing names never merge', async () => {
    // Shared inbox: a name-less candidate (or a name-less caller) could be a
    // DIFFERENT prospect — reusing would overwrite the first prospect's
    // extraction and swallow the second's new-lead surfacing.
    const namelessCandidate = makeDb({ id: 'lead-6', first_name: null, last_name: null });
    expect(await findReusableCallLead(namelessCandidate, {
      phone: null,
      email: 'shared@example.com',
      firstName: 'Jeff',
      lastName: 'Brooks',
      workableUnnamedLead: true,
    })).toBeNull();

    const namelessCaller = makeDb({ id: 'lead-6b', first_name: 'Jeff', last_name: 'Brooks' });
    expect(await findReusableCallLead(namelessCaller, {
      phone: null,
      email: 'shared@example.com',
      firstName: null,
      lastName: null,
      workableUnnamedLead: true,
    })).toBeNull();
  });

  test('email match scans past a housemate\'s newer lead to the caller\'s own row', async () => {
    // Shared inbox with two active unclaimed leads: newest belongs to Maria,
    // older one to Jeff. Jeff calling back must reuse HIS row, not mint a
    // duplicate because Maria's happens to be newest.
    const db = makeDb([
      { id: 'lead-maria', first_name: 'Maria', last_name: 'Lopez' },
      { id: 'lead-jeff', first_name: 'Jeff', last_name: 'Brooks' },
    ]);
    expect(await findReusableCallLead(db, {
      phone: null,
      email: 'shared@example.com',
      firstName: 'Jeff',
      lastName: 'Brooks',
      workableUnnamedLead: true,
    })).toEqual({ id: 'lead-jeff', first_name: 'Jeff', last_name: 'Brooks' });
  });

  test('a retry of the SAME call reuses its own lead by call SID — no name corroboration needed', async () => {
    // extraction_failed reprocessing: the earlier attempt already inserted
    // this call's lead. Same-SID reuse is the strongest identity there is —
    // without it, a phone-less name-less caller minted (and notified) a new
    // duplicate on every retry.
    const own = { id: 'lead-own', first_name: null, last_name: null, twilio_call_sid: 'CA-retry-1' };
    const db = makeDb(own);
    expect(await findReusableCallLead(db, {
      phone: null,
      email: 'shared@example.com',
      firstName: null,
      lastName: null,
      workableUnnamedLead: true,
      callSid: 'CA-retry-1',
    })).toEqual(own);
    expect(db.calls.some(([m, a]) => m === 'where' && a[0] === 'twilio_call_sid' && a[1] === 'CA-retry-1')).toBe(true);
  });

  test('name conflict never blocks a PHONE match — corroboration is email-path only', async () => {
    const db = makeDb({ id: 'lead-7', first_name: 'Maria', last_name: 'Lopez' });
    expect(await findReusableCallLead(db, {
      phone: '+19415550101',
      firstName: 'Jeff',
      lastName: 'Brooks',
      workableUnnamedLead: true,
    })).toEqual({ id: 'lead-7', first_name: 'Maria', last_name: 'Lopez' });
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

describe('findReusableCallLead same-call SID branch applies ownership + lifecycle filters', () => {
  // The SID fast path returned its row BEFORE the ownership/lifecycle
  // filters, so a retry that now resolves to a different customer could
  // adopt a lead another customer owns, and a force-reprocess could select a
  // won/converted row on the active-only path. An ineligible SID row must
  // fall through to contact reuse or a fresh mint like any other rejected
  // candidate (audit P1 r17).
  const makeDb = () => {
    const calls = [];
    const builder = {};
    for (const m of ['where', 'whereNull', 'whereRaw', 'whereNotIn', 'orderBy', 'limit']) {
      builder[m] = (...a) => { calls.push([m, a]); return builder; };
    }
    builder.first = async () => { calls.push(['first', []]); return null; };
    builder.then = (resolve) => resolve([]);
    const db = (table) => { calls.push(['table', [table]]); return builder; };
    db.calls = calls;
    return db;
  };
  // Predicates recorded before the SID lookup resolves (its `first` call).
  const beforeFirstFetch = (db) => db.calls.slice(0, db.calls.findIndex(([m]) => m === 'first'));

  test('anonymous retry (unclaimedOnly) requires an UNCLAIMED sid row', async () => {
    const db = makeDb();
    await findReusableCallLead(db, {
      phone: null, email: 'a@b.com', firstName: 'Pat', callSid: 'CA-retry',
      unclaimedOnly: true, workableUnnamedLead: false,
    });
    const pre = beforeFirstFetch(db);
    expect(pre.some(([m, a]) => m === 'where' && a[0] === 'twilio_call_sid')).toBe(true);
    expect(pre.some(([m, a]) => m === 'whereNull' && a[0] === 'customer_id')).toBe(true);
  });

  test('workableUnnamedLead retry excludes terminal + converted sid rows', async () => {
    const db = makeDb();
    await findReusableCallLead(db, {
      phone: null, email: 'a@b.com', firstName: 'Pat', callSid: 'CA-retry',
      workableUnnamedLead: true,
    });
    const pre = beforeFirstFetch(db);
    expect(pre.some(([m, a]) => m === 'whereNotIn' && a[0] === 'status')).toBe(true);
    expect(pre.some(([m, a]) => m === 'whereNull' && a[0] === 'converted_at')).toBe(true);
  });

  test('a customer-attached retry scopes the sid row to that customer', async () => {
    const db = makeDb();
    await findReusableCallLead(db, {
      phone: '+19415550101', callSid: 'CA-retry',
      customerId: 'cust-1', workableUnnamedLead: false,
    });
    // The customer arm is a grouped callback — assert the group was applied
    // to the sid query rather than the row returning unconditionally.
    const pre = beforeFirstFetch(db);
    expect(pre.some(([m, a]) => m === 'where' && typeof a[0] === 'function')).toBe(true);
  });
});
