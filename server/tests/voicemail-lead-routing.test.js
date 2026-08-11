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

const { hasWorkableLeadSignal, findReusableCallLead, shouldStampCallLeadLinkage } = CallRecordingProcessor._test;

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
      extracted: { matched_service: 'pest control', email: 'pat@example.com' },
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
      extracted: { matched_service: 'pest control', email: 'pat at example' },
      phone: null,
    })).toBe(false);
  });

  test('email without service intent is still not workable', () => {
    expect(hasWorkableLeadSignal({
      extracted: { email: 'pat@example.com' },
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
      extracted: { matched_service: 'pest control', email: 'pat@example.com' },
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
    const db = makeDb({ id: 'lead-2', first_name: 'Pat', last_name: 'Sample' });
    const found = await findReusableCallLead(db, {
      phone: null,
      email: '  PSample00005@Example.com ',
      firstName: 'Pat',
      lastName: 'Sample',
      workableUnnamedLead: true,
    });
    expect(found).toEqual({ id: 'lead-2', first_name: 'Pat', last_name: 'Sample' });
    const raw = db.calls.find(([m]) => m === 'whereRaw');
    expect(raw[1][1]).toEqual(['psample00005@example.com']);
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
      firstName: 'Pat',
      lastName: 'Sample',
      workableUnnamedLead: true,
    });
    expect(found).toBeNull();
  });

  test('email match with a POSITIVELY corroborated first name is reusable (case-insensitive)', async () => {
    const sameName = makeDb({ id: 'lead-5', first_name: 'Pat', last_name: 'Sample' });
    expect(await findReusableCallLead(sameName, {
      phone: null,
      email: 'shared@example.com',
      firstName: 'pat',
      lastName: 'SAMPLE',
      workableUnnamedLead: true,
    })).toEqual({ id: 'lead-5', first_name: 'Pat', last_name: 'Sample' });

    // A missing last name on either side does not block a first-name match.
    const noLastName = makeDb({ id: 'lead-5b', first_name: 'Pat', last_name: null });
    expect(await findReusableCallLead(noLastName, {
      phone: null,
      email: 'shared@example.com',
      firstName: 'Pat',
      lastName: 'Sample',
      workableUnnamedLead: true,
    })).toEqual({ id: 'lead-5b', first_name: 'Pat', last_name: null });
  });

  test('email match WITHOUT positive name corroboration forces a fresh lead — missing names never merge', async () => {
    // Shared inbox: a name-less candidate (or a name-less caller) could be a
    // DIFFERENT prospect — reusing would overwrite the first prospect's
    // extraction and swallow the second's new-lead surfacing.
    const namelessCandidate = makeDb({ id: 'lead-6', first_name: null, last_name: null });
    expect(await findReusableCallLead(namelessCandidate, {
      phone: null,
      email: 'shared@example.com',
      firstName: 'Pat',
      lastName: 'Sample',
      workableUnnamedLead: true,
    })).toBeNull();

    const namelessCaller = makeDb({ id: 'lead-6b', first_name: 'Pat', last_name: 'Sample' });
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
    // older one to Pat. Pat calling back must reuse HIS row, not mint a
    // duplicate because Maria's happens to be newest.
    const db = makeDb([
      { id: 'lead-maria', first_name: 'Maria', last_name: 'Lopez' },
      { id: 'lead-pat', first_name: 'Pat', last_name: 'Sample' },
    ]);
    expect(await findReusableCallLead(db, {
      phone: null,
      email: 'shared@example.com',
      firstName: 'Pat',
      lastName: 'Sample',
      workableUnnamedLead: true,
    })).toEqual({ id: 'lead-pat', first_name: 'Pat', last_name: 'Sample' });
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

  test('a retry reuses the lead the earlier attempt STAMPED (metadata lead_id) — reused leads keep the original sid', async () => {
    // Attempt 1 reused an older email-matched lead (different sid) and
    // stamped call_log.metadata.lead_id. The retry must treat that stamp as
    // same-call identity even though contact fields may have changed.
    const own = { id: 'lead-stamped', first_name: 'Pat', last_name: 'Sample', twilio_call_sid: 'CA-original-call' };
    const db = makeDb(own);
    expect(await findReusableCallLead(db, {
      phone: null,
      email: 'different-now@example.com',
      firstName: null,
      lastName: null,
      workableUnnamedLead: true,
      callSid: 'CA-retry-2',
      stampedLeadId: 'lead-stamped',
    })).toEqual(own);
  });

  test('name conflict never blocks a PHONE match — corroboration is email-path only', async () => {
    const db = makeDb({ id: 'lead-7', first_name: 'Maria', last_name: 'Lopez' });
    expect(await findReusableCallLead(db, {
      phone: '+19415550101',
      firstName: 'Pat',
      lastName: 'Sample',
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

describe('applySameCallLeadEligibility — one definition for lookup AND write (PR #3291)', () => {
  const { applySameCallLeadEligibility } = CallRecordingProcessor._test;
  // Three consecutive review rounds each named a DIFFERENT predicate the
  // guarded same-call write had omitted, because the lookup built eligibility
  // in findReusableCallLead and the write rebuilt a subset ~400 lines away.
  // These pin the shared function so the two sites cannot drift again.
  const spy = () => {
    const calls = [];
    const q = {};
    for (const m of ['where', 'whereNull', 'whereNotIn', 'orderBy', 'first']) {
      q[m] = (...a) => { calls.push([m, a]); return q; };
    }
    q.calls = calls;
    return q;
  };

  test('always excludes soft-deleted rows', () => {
    const q = spy();
    applySameCallLeadEligibility(q, { customerId: 'c1', unclaimedOnly: false, workableUnnamedLead: false });
    expect(q.calls.some(([m, a]) => m === 'whereNull' && a[0] === 'deleted_at')).toBe(true);
  });

  test('workableUnnamedLead adds the lifecycle trio (terminal status + converted_at)', () => {
    const q = spy();
    applySameCallLeadEligibility(q, { customerId: null, unclaimedOnly: false, workableUnnamedLead: true });
    expect(q.calls.some(([m, a]) => m === 'whereNotIn' && a[0] === 'status')).toBe(true);
    expect(q.calls.some(([m, a]) => m === 'whereNull' && a[0] === 'converted_at')).toBe(true);
  });

  test('a customer-LESS caller requires an unclaimed row even when unclaimedOnly is false', () => {
    // unclaimedOnly is derived from shared-phone candidates, so it is false
    // for an anonymous retry — the !customerId arm is what protects a lead
    // claimed between attempts.
    const q = spy();
    applySameCallLeadEligibility(q, { customerId: null, unclaimedOnly: false, workableUnnamedLead: false });
    expect(q.calls.some(([m, a]) => m === 'whereNull' && a[0] === 'customer_id')).toBe(true);
  });

  test('shared-phone ambiguity requires unclaimed even with a resolved customer', () => {
    const q = spy();
    applySameCallLeadEligibility(q, { customerId: 'c1', unclaimedOnly: true, workableUnnamedLead: false });
    expect(q.calls.some(([m, a]) => m === 'whereNull' && a[0] === 'customer_id')).toBe(true);
  });

  test('a resolved customer scopes ownership to unclaimed-or-mine', () => {
    const q = spy();
    applySameCallLeadEligibility(q, { customerId: 'c1', unclaimedOnly: false, workableUnnamedLead: false });
    // Grouped callback arm rather than a bare whereNull.
    expect(q.calls.some(([m, a]) => m === 'where' && typeof a[0] === 'function')).toBe(true);
    expect(q.calls.some(([m, a]) => m === 'whereNull' && a[0] === 'customer_id')).toBe(false);
  });
});

describe('dropFilledLeadColumns — fill-only re-decision under the row lock', () => {
  const { dropFilledLeadColumns, FILL_ONLY_LEAD_FIELDS } = CallRecordingProcessor._test;

  test('drops a fill-only column an admin filled between the pre-lock read and the lock', () => {
    // `current` (pre-lock) saw first_name empty, so the pass queued a fill.
    // The LOCKED row already carries the admin's entry — re-applying the
    // stale fill would overwrite it despite fill-only semantics.
    const leadUpdates = { first_name: 'Bob', address: '12 Palm Ct', transcript_summary: 'called about ants' };
    const out = dropFilledLeadColumns(leadUpdates, { first_name: 'Robert', address: null });

    expect(out).not.toHaveProperty('first_name');
    expect(out.address).toBe('12 Palm Ct');           // still empty under the lock → fill stands
    expect(out.transcript_summary).toBe('called about ants'); // not fill-only → untouched
  });

  test('does not mutate the caller\'s payload (the loop reuses it on a race re-run)', () => {
    const leadUpdates = { first_name: 'Bob', is_qualified: true };
    const out = dropFilledLeadColumns(leadUpdates, { first_name: 'Robert' });

    expect(leadUpdates.first_name).toBe('Bob');
    expect(out).not.toBe(leadUpdates);
    expect(out.is_qualified).toBe(true);
  });

  test('returns the payload untouched when nothing was filled in the gap', () => {
    const leadUpdates = { email: 'a@b.com', city: 'Bradenton' };
    const out = dropFilledLeadColumns(leadUpdates, { email: '', city: null, zip: '34205' });

    expect(out).toBe(leadUpdates);
  });

  test('a missing locked row leaves the payload alone (no lock, no re-decision)', () => {
    const leadUpdates = { first_name: 'Bob' };
    expect(dropFilledLeadColumns(leadUpdates, null)).toBe(leadUpdates);
  });

  test('covers exactly the fill-if-empty identity columns Step 4b writes', () => {
    // Guards against drift: a new fill-if-empty assignment that is not in
    // this list silently keeps the stale pre-lock decision.
    expect(FILL_ONLY_LEAD_FIELDS).toEqual(
      ['phone', 'first_name', 'last_name', 'email', 'address', 'city', 'zip'],
    );
  });
});

describe('reconcileConditionalLeadFieldsUnderLock — conditional re-decision under the row lock', () => {
  const { reconcileConditionalLeadFieldsUnderLock } = CallRecordingProcessor._test;

  test('drops the service_interest fill when the locked row already carries one, and says so', () => {
    // Pre-lock `current` had service_interest empty; the office filled it in
    // the gap. The stale fill must not clobber it, and the call site needs
    // the flag to null the persisted-label pair the V2 reassert consumes.
    const { updates, serviceInterestDropped } = reconcileConditionalLeadFieldsUnderLock(
      { service_interest: 'Pest Control', transcript_summary: 'ants' },
      { service_interest: 'Termite Inspection' },
    );

    expect(updates).not.toHaveProperty('service_interest');
    expect(serviceInterestDropped).toBe(true);
    expect(updates.transcript_summary).toBe('ants'); // rolling field → untouched
  });

  test("keeps the 'urgent' upgrade but drops a 'normal' fill against a locked urgency", () => {
    const urgent = reconcileConditionalLeadFieldsUnderLock(
      { urgency: 'urgent' },
      { urgency: 'normal' },
    );
    expect(urgent.updates.urgency).toBe('urgent'); // upgrade-only always applies

    const normalFill = reconcileConditionalLeadFieldsUnderLock(
      { urgency: 'normal' },
      { urgency: 'urgent' },
    );
    expect(normalFill.updates).not.toHaveProperty('urgency'); // fill decided pre-lock, row no longer empty
  });

  test('drops the unresponsive→new reopen when the office moved the lead in the gap', () => {
    const { updates } = reconcileConditionalLeadFieldsUnderLock(
      { status: 'new' },
      { status: 'contacted' },
    );
    expect(updates).not.toHaveProperty('status');
  });

  test('keeps the reopen while the locked row is still unresponsive', () => {
    const { updates } = reconcileConditionalLeadFieldsUnderLock(
      { status: 'new' },
      { status: 'unresponsive' },
    );
    expect(updates.status).toBe('new');
  });

  test('quote-due follow-up stays pull-in-only vs the locked row', () => {
    const due = new Date('2026-08-08T21:00:00Z');
    const pulledIn = reconcileConditionalLeadFieldsUnderLock(
      { next_follow_up_at: due },
      { next_follow_up_at: '2026-08-10T14:00:00Z' }, // later → pull in stands
    );
    expect(pulledIn.updates.next_follow_up_at).toBe(due);

    const alreadyEarlier = reconcileConditionalLeadFieldsUnderLock(
      { next_follow_up_at: due },
      { next_follow_up_at: '2026-08-08T15:00:00Z' }, // earlier under the lock → stays put
    );
    expect(alreadyEarlier.updates).not.toHaveProperty('next_follow_up_at');
  });

  test('re-unions needs_confirmation with the LOCKED row and re-judges qualification', () => {
    // Pre-lock merge saw no standing reasons; a concurrent call added one.
    // Staff also CLEARED the email in the gap — qualification must be
    // re-judged against the locked identity, not the pre-lock snapshot.
    const stalePayload = JSON.stringify({ sentiment: 'positive', needs_confirmation: ['email_unverified'] });
    const { updates, contact } = reconcileConditionalLeadFieldsUnderLock(
      { extracted_data: stalePayload, is_qualified: true },
      {
        extracted_data: JSON.stringify({ needs_confirmation: ['address_unverified'] }),
        first_name: 'Pat', last_name: 'Sample', address: '1 Palm Ct', email: '',
      },
      { bridgeNeedsConfirmation: ['email_unverified'], leadQuality: 'hot' },
    );

    const payload = JSON.parse(updates.extracted_data);
    expect(payload.needs_confirmation).toEqual(expect.arrayContaining(['address_unverified', 'email_unverified']));
    expect(payload.needs_confirmation).toHaveLength(2);
    expect(payload.missing_for_qualification).toEqual(['email']);
    expect(updates.is_qualified).toBe(false); // hot, but contact incomplete under the lock
    expect(contact.complete).toBe(false);
    expect(payload.sentiment).toBe('positive'); // this call's own payload survives
  });

  test('this pass\'s effective fills count toward qualification', () => {
    const { updates } = reconcileConditionalLeadFieldsUnderLock(
      { email: 'j@example.com', extracted_data: JSON.stringify({}), is_qualified: false },
      { first_name: 'Pat', last_name: 'Sample', address: '1 Palm Ct', email: null },
      { bridgeNeedsConfirmation: [], leadQuality: 'warm' },
    );
    expect(updates.is_qualified).toBe(true);
    expect(JSON.parse(updates.extracted_data)).not.toHaveProperty('missing_for_qualification');
  });

  test('a missing locked row passes through untouched', () => {
    const leadUpdates = { service_interest: 'Pest Control' };
    const out = reconcileConditionalLeadFieldsUnderLock(leadUpdates, null);
    expect(out.updates).toBe(leadUpdates);
    expect(out.serviceInterestDropped).toBe(false);
  });
});

describe('reaffirmedFilledLeadFields — successor ownership of restated fills', () => {
  const { reaffirmedFilledLeadFields } = CallRecordingProcessor._test;

  test('claims a fill the caller restated with the value the lead already carries', () => {
    // The fill-only drop removed email from the payload, so without the
    // claim this call's written ledger never owned it — and a predecessor
    // later reprocessed as spam would restore it to null.
    const out = reaffirmedFilledLeadFields(
      { email: 'PSample00005@Example.com ', first_name: 'Pat' },
      { email: 'psample00005@example.com', first_name: 'Pat' },
    );
    expect(out).toEqual({ email: 'psample00005@example.com', first_name: 'Pat' });
  });

  test('a DIFFERING supplied value is not a reaffirmation and claims nothing', () => {
    const out = reaffirmedFilledLeadFields(
      { email: 'other@example.com' },
      { email: 'psample00005@example.com' },
    );
    expect(out).toEqual({});
  });

  test('phone compares on the last 10 digits across formats', () => {
    const out = reaffirmedFilledLeadFields(
      { phone: '(202) 555-0134' },
      { phone: '+12025550134' },
    );
    expect(out).toEqual({ phone: '+12025550134' });
  });

  test('empty lead values and unsupplied fields claim nothing', () => {
    expect(reaffirmedFilledLeadFields({ email: 'a@b.com' }, { email: null })).toEqual({});
    expect(reaffirmedFilledLeadFields({}, { email: 'a@b.com' })).toEqual({});
    expect(reaffirmedFilledLeadFields({ email: 'a@b.com' }, null)).toEqual({});
  });
});

describe('reaffirmedFilledLeadFields — sequential restatement (raw extraction contract)', () => {
  const { reaffirmedFilledLeadFields } = CallRecordingProcessor._test;

  test('claims a field the fill-only payload never contained (predecessor filled it on an earlier call)', () => {
    // The call site passes RAW extracted identity values — leadUpdates
    // would have omitted email entirely because `current` already carried
    // it, which is the normal sequential restatement the claim exists for.
    const rawExtractionShaped = {
      phone: null, first_name: 'pat', last_name: 'sample',
      email: 'psample00005@example.com', address: undefined, city: undefined, zip: undefined,
    };
    const out = reaffirmedFilledLeadFields(rawExtractionShaped, {
      email: 'PSample00005@example.com', first_name: 'Pat', last_name: 'Sample',
      phone: '+12025550134', address: '123 Sample St',
    });
    expect(out).toEqual({
      email: 'PSample00005@example.com',
      first_name: 'Pat',
      last_name: 'Sample',
    });
    // null/undefined supplied values (phone, address) claim nothing even
    // though the lead carries values there.
    expect(out).not.toHaveProperty('phone');
    expect(out).not.toHaveProperty('address');
  });
});

describe('shouldStampCallLeadLinkage — durable stamp on EVERY different-sid reuse (root fix)', () => {
  // Before the 2026-08-11 root fix the fresh-stamp arm required !phone:
  // a phone-bearing call reusing an existing lead left NO durable
  // call→lead record (findReusableCallLead does not touch the lead's
  // sid), and every consumer reconstructed the association by phone
  // matching — the approximation behind five #3347-era findings.
  const REUSED = { id: 'lead-r', twilio_call_sid: 'CA-original' };

  test('phone-bearing reuse of a different-sid lead STAMPS (the root fix)', () => {
    expect(shouldStampCallLeadLinkage({
      existingLead: REUSED,
      raceRecovered: false,
      callTwilioSid: 'CA-this-call',
      leadId: 'lead-r',
      currentStampedLeadId: null,
    })).toBe(true);
  });

  test('phone-less reuse of a different-sid lead still stamps (unchanged)', () => {
    expect(shouldStampCallLeadLinkage({
      existingLead: REUSED,
      raceRecovered: false,
      callTwilioSid: 'CA-this-call',
      leadId: 'lead-r',
      currentStampedLeadId: null,
    })).toBe(true);
  });

  test('same-sid reuse never stamps — the sid IS the durable linkage', () => {
    expect(shouldStampCallLeadLinkage({
      existingLead: { id: 'lead-own', twilio_call_sid: 'CA-this-call' },
      raceRecovered: false,
      callTwilioSid: 'CA-this-call',
      leadId: 'lead-own',
      currentStampedLeadId: null,
    })).toBe(false);
  });

  test('a race-recovered mint never takes a fresh stamp — it self-links via its own sid', () => {
    expect(shouldStampCallLeadLinkage({
      existingLead: REUSED,
      raceRecovered: true,
      callTwilioSid: 'CA-this-call',
      leadId: 'lead-fresh-mint',
      currentStampedLeadId: null,
    })).toBe(false);
  });

  test('a fresh insert (no reuse, no prior stamp) never stamps', () => {
    expect(shouldStampCallLeadLinkage({
      existingLead: null,
      raceRecovered: false,
      callTwilioSid: 'CA-this-call',
      leadId: 'lead-new',
      currentStampedLeadId: null,
    })).toBe(false);
  });

  test('re-stamp arm: a retry whose stamp already points at the final lead refreshes the ledgers', () => {
    // Including a retry that GAINED a phone (codex P1 r22) — existingLead
    // may be the SAME-SID row here and the fresh arm stays false, but the
    // re-stamp arm must still fire so this pass's writes enter the fenced
    // ledgers and a later rejection can CAS-restore them.
    expect(shouldStampCallLeadLinkage({
      existingLead: { id: 'lead-own', twilio_call_sid: 'CA-this-call' },
      raceRecovered: false,
      callTwilioSid: 'CA-this-call',
      leadId: 'lead-own',
      currentStampedLeadId: 'lead-own',
    })).toBe(true);
  });

  test('a stale stamp pointing at a DIFFERENT lead does not trigger the re-stamp arm', () => {
    // The pre-settle path owns that case: the old stamp settles first, then
    // the fresh arm (different-sid reuse) decides the replacement.
    expect(shouldStampCallLeadLinkage({
      existingLead: null,
      raceRecovered: false,
      callTwilioSid: 'CA-this-call',
      leadId: 'lead-new',
      currentStampedLeadId: 'lead-elsewhere',
    })).toBe(false);
  });
});
