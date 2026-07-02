/**
 * Call-transcription email hygiene.
 *
 * Real case this encodes: a caller spelled her email on the phone, the
 * transcription misheard "A-L-L-E-N-S" as "K-L-L-E-N-S", the newsletter
 * confirmation fired within a minute of intake and hard-bounced (550 recipient
 * rejected), the suppression was created silently, and the dead address was
 * only discovered hours later when the estimate send hit it ("Suppressed:
 * bounce"). Two fixes under test:
 *
 *  1. deriveCallReviewBridge flags every call-captured email for read-back
 *     (email_unverified / email_invalid, ADVISORY — never routing) and adopts
 *     a high-confidence domain-typo correction before any writes/sends.
 *  2. alertBouncedContactAddress: a hard bounce on an email sent OUTSIDE the
 *     email_messages ledger still reaches a human when the address is on file
 *     for a customer or open lead — deduped notification + lead stamp.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/sendgrid-mail', () => ({
  sendOne: jest.fn(),
  newsletterGroupId: jest.fn(() => 111),
  serviceGroupId: jest.fn(() => 222),
}));
jest.mock('../services/email-template-library', () => ({
  loadTemplateByKey: jest.fn(),
  activeSuppressionFor: jest.fn(),
}));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn() }));

const db = require('../models/db');
const NotificationService = require('../services/notification-service');
const { deriveCallReviewBridge, deriveEmailReview } = require('../services/call-triage-flags');
const { alertBouncedContactAddress } = require('../services/email-bounce-recovery');

describe('deriveCallReviewBridge — email', () => {
  test('a call-captured email is flagged for read-back (advisory)', () => {
    const out = deriveCallReviewBridge({ extracted: { email: 'karrenkllens@kc.rr.com' } });
    expect(out.needsConfirmation).toContain('email_unverified');
    expect(out.normalizedEmail).toBeNull(); // kc.rr.com is a real domain — nothing to fix
  });

  test('a high-confidence domain typo is corrected up front AND still flagged', () => {
    const out = deriveCallReviewBridge({ extracted: { email: 'jane@gmial.com' } });
    expect(out.normalizedEmail).toBe('jane@gmail.com');
    expect(out.needsConfirmation).toContain('email_unverified');
  });

  test('transcription garbage that is not email-shaped → email_invalid, no correction', () => {
    const out = deriveCallReviewBridge({ extracted: { email: 'karen allen at kc dot rr' } });
    expect(out.needsConfirmation).toContain('email_invalid');
    expect(out.needsConfirmation).not.toContain('email_unverified');
    expect(out.normalizedEmail).toBeNull();
  });

  test('a missing-dot domain is corrected, not classified invalid', () => {
    // "jane@gmailcom" fails the basic shape (no dot in domain) but is exactly
    // what the missing-dot correction rule repairs — correction runs first.
    const out = deriveCallReviewBridge({ extracted: { email: 'jane@gmailcom' } });
    expect(out.normalizedEmail).toBe('jane@gmail.com');
    expect(out.needsConfirmation).toContain('email_unverified');
    expect(out.needsConfirmation).not.toContain('email_invalid');
  });

  test('an email the intake normalizer rejected still reaches the bridge via email_raw', () => {
    // normalizeCallExtraction nulls non-regex emails but preserves the raw
    // capture — the bridge must still emit its reason from that.
    const out = deriveCallReviewBridge({ extracted: { email: null, email_raw: 'karen allen at kc dot rr' } });
    expect(out.needsConfirmation).toContain('email_invalid');

    const fixed = deriveCallReviewBridge({ extracted: { email: null, email_raw: 'jane@gmailcom' } });
    expect(fixed.normalizedEmail).toBe('jane@gmail.com');
  });

  test('no email captured → no email reasons', () => {
    const out = deriveCallReviewBridge({ extracted: { first_name: 'Karen' } });
    expect(out.needsConfirmation).not.toContain('email_unverified');
    expect(out.needsConfirmation).not.toContain('email_invalid');
    expect(out.normalizedEmail).toBeNull();
  });

  test('email reasons stack with the existing address reasons', () => {
    const out = deriveCallReviewBridge({
      addressValidation: { status: 'confirm_needed' },
      extracted: { address_line1: '4867 Tober Morey Way', email: 'karrenkllens@kc.rr.com' },
    });
    expect(out.needsConfirmation).toEqual(expect.arrayContaining(['address_unverified', 'email_unverified']));
  });
});

describe('deriveEmailReview (mode-independent — enforce/V2-off fallback uses it directly)', () => {
  test('same semantics as the bridge path', () => {
    expect(deriveEmailReview({ email: 'jane@gmial.com' }))
      .toEqual({ normalizedEmail: 'jane@gmail.com', needsConfirmation: ['email_unverified'] });
    expect(deriveEmailReview({ email: null, email_raw: 'karen allen at kc dot rr' }))
      .toEqual({ normalizedEmail: null, needsConfirmation: ['email_invalid'] });
    expect(deriveEmailReview({}))
      .toEqual({ normalizedEmail: null, needsConfirmation: [] });
  });
});

describe('alertBouncedContactAddress', () => {
  // Table-keyed knex stub: first()/select() resolve per-table fixtures;
  // update() records its patch for assertions.
  function mockTables(map) {
    const updates = [];
    db.raw = jest.fn(() => 'raw');
    db.mockImplementation((table) => {
      const cfg = map[table] || {};
      const chain = {};
      for (const m of ['where', 'whereRaw', 'whereNot', 'whereIn', 'whereNull', 'orWhereNotIn']) {
        chain[m] = jest.fn(() => chain);
      }
      chain.first = jest.fn(() => Promise.resolve(cfg.first ?? null));
      chain.select = jest.fn(() => Promise.resolve(cfg.select ?? []));
      chain.update = jest.fn((patch) => { updates.push({ table, patch }); return Promise.resolve(1); });
      chain.insert = jest.fn((row) => { updates.push({ table, insert: row }); return Promise.resolve([1]); });
      return chain;
    });
    return updates;
  }

  beforeEach(() => jest.clearAllMocks());

  test('customer + open-lead match → notification with phone hint, lead stamped', async () => {
    const updates = mockTables({
      customers: { first: { id: 'cust-1', first_name: 'Karen', last_name: 'Allen', phone: '+18165906664' } },
      leads: { select: [{ id: 'lead-1', first_name: 'Karen', last_name: 'Allen', extracted_data: { needs_confirmation: ['address_unverified'] } }] },
      notifications: { first: null }, // no prior alert in the dedupe window
    });

    const out = await alertBouncedContactAddress('KarrenKllens@kc.rr.com', { reason: '550 5.1.1 recipient rejected' });

    expect(out).toMatchObject({ alerted: true, customerId: 'cust-1', leadsStamped: 1 });
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    const [category, title, body] = NotificationService.notifyAdmin.mock.calls[0];
    expect(category).toBe('alert');
    expect(title).toBe('Email bounced — needs a correct address');
    expect(body).toContain('karrenkllens@kc.rr.com');
    expect(body).toContain('Karen Allen');
    expect(body).toContain('+18165906664');
    // Lead stamped with email_bounced, existing reasons preserved, and a
    // visible timeline row written (the lead card renders warnings from
    // lead_activities, not extracted_data)
    const leadUpdate = updates.find((u) => u.table === 'leads');
    expect(JSON.parse(leadUpdate.patch.extracted_data).needs_confirmation)
      .toEqual(['address_unverified', 'email_bounced']);
    const activity = updates.find((u) => u.table === 'lead_activities');
    expect(activity.insert.lead_id).toBe('lead-1');
    expect(activity.insert.description).toContain('hard-bounced');
  });

  test('a lead-only match still gets a callback phone from the lead row', async () => {
    mockTables({
      customers: { first: null },
      leads: { select: [{ id: 'lead-1', first_name: 'Karen', last_name: 'Allen', phone: '+18165906664', extracted_data: {} }] },
      notifications: { first: null },
    });

    await alertBouncedContactAddress('karrenkllens@kc.rr.com', {});

    const [, , body] = NotificationService.notifyAdmin.mock.calls[0];
    expect(body).toContain('+18165906664');
  });

  test('no customer or open lead on file → skipped, no notification', async () => {
    mockTables({ customers: { first: null }, leads: { select: [] } });

    const out = await alertBouncedContactAddress('randomlistcruft@example.com', {});

    expect(out).toEqual({ skipped: 'no_contact_match' });
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('lead already stamped email_bounced → no duplicate stamp or activity row', async () => {
    const updates = mockTables({
      customers: { first: null },
      leads: { select: [{ id: 'lead-1', first_name: 'Karen', extracted_data: { needs_confirmation: ['email_bounced'] } }] },
      notifications: { first: null },
    });

    const out = await alertBouncedContactAddress('karrenkllens@kc.rr.com', {});

    expect(out).toMatchObject({ alerted: true });
    expect(updates.filter((u) => u.table === 'leads' || u.table === 'lead_activities')).toHaveLength(0);
  });

  test('a prior alert inside the dedupe window suppresses the notification', async () => {
    mockTables({
      customers: { first: { id: 'cust-1', first_name: 'Karen', last_name: 'Allen', phone: null } },
      leads: { select: [] },
      notifications: { first: { id: 'existing-notif' } },
    });

    await alertBouncedContactAddress('karrenkllens@kc.rr.com', {});

    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('empty email is a safe no-op', async () => {
    mockTables({});
    expect(await alertBouncedContactAddress('', {})).toEqual({ skipped: 'no_email' });
  });
});
