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
const { deriveCallReviewBridge, deriveEmailReview, applyEmailDisagreementHold } = require('../services/call-triage-flags');
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

  test('a dropped TLD ("…@gmail") is reconstructed via email_raw and PROPOSED, never pre-adopted', () => {
    // The intake normalizers stay strict, so the bare-SLD capture arrives here
    // as email_raw; the missing_tld rule proposes the repair as normalizedEmail,
    // which the processor only adopts after the correctedAddressOwnedByOther
    // ownership gate clears. extracted.email must NOT already hold the repair.
    const out = deriveCallReviewBridge({ extracted: { email: null, email_raw: 'brandon.post00@gmail' } });
    expect(out.normalizedEmail).toBe('brandon.post00@gmail.com');
    expect(out.needsConfirmation).toContain('email_unverified');
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

// V1/V2 email disagreement hold (owner ruling, 2026-09-25). Gillett call
// 78798d5c: caller spelled "G-I-L-L-E-T-T, no E at the end, Cole at gmail" —
// V2 heard it correctly (gillettcole@gmail.com), V1 misheard an extra E
// (gillettecole@gmail.com), and the OLD fill-gap merge let V1's wrong
// spelling win onto customer 2234d8e1. Same day, call 6fee5f34 had the
// reverse (V1 right, V2 wrong) — walshjamie96@ vs jamiewalsh96@gmail.com.
// adoptV2PrimaryFields (extraction-compat.js) is what detects the
// disagreement and stamps extracted.email_candidates; this function is the
// processor-side hold that runs after the transcript dictation decoder.
describe('applyEmailDisagreementHold', () => {
  test('no-op when there are fewer than two candidates', () => {
    expect(applyEmailDisagreementHold({ email: 'a@x.com' }, null))
      .toEqual({ extracted: { email: 'a@x.com' }, dictationEmailPayload: null });
    expect(applyEmailDisagreementHold({ email: 'a@x.com', email_candidates: ['a@x.com'] }, null).extracted.email)
      .toBe('a@x.com');
  });

  test('Gillett case: nulls extracted.email and files both candidates on a fresh card', () => {
    const extracted = { email: null, email_candidates: ['gillettecole@gmail.com', 'gillettcole@gmail.com'] };
    const { extracted: out, dictationEmailPayload } = applyEmailDisagreementHold(extracted, null);
    expect(out.email).toBeNull();
    expect(dictationEmailPayload.email_candidates).toEqual([
      { value: 'gillettecole@gmail.com' },
      { value: 'gillettcole@gmail.com' },
    ]);
    expect(dictationEmailPayload.email_as_heard).toBe('gillettecole@gmail.com');
    expect(dictationEmailPayload.confirmation_question).toEqual(expect.stringContaining('gillettecole@gmail.com'));
    expect(dictationEmailPayload.email_disagreement).toEqual({ v1: 'gillettecole@gmail.com', v2: 'gillettcole@gmail.com' });
  });

  test('Jamie case (reverse): same hold shape regardless of which leg was right', () => {
    const extracted = { email: null, email_candidates: ['walshjamie96@gmail.com', 'jamiewalsh96@gmail.com'] };
    const { extracted: out, dictationEmailPayload } = applyEmailDisagreementHold(extracted, null);
    expect(out.email).toBeNull();
    expect(dictationEmailPayload.email_candidates.map((c) => c.value))
      .toEqual(['walshjamie96@gmail.com', 'jamiewalsh96@gmail.com']);
  });

  test('re-nulls extracted.email even when the dictation decoder already adopted one of the two candidates', () => {
    // The decoder ran on the transcript and confidently adopted the V1
    // spelling BEFORE this guard runs — the owner rule still applies: no
    // heuristic gets to pick when the two extractors disagreed.
    const extracted = {
      email: 'gillettecole@gmail.com', // decoder's adopt
      email_candidates: ['gillettecole@gmail.com', 'gillettcole@gmail.com'],
    };
    const priorPayload = { email_candidates: [{ value: 'gillettecole@gmail.com', confidence: 0.9 }] };
    const { extracted: out, dictationEmailPayload } = applyEmailDisagreementHold(extracted, priorPayload);
    expect(out.email).toBeNull();
    // The decoder's own candidate is kept and the V2 candidate is added
    // (deduped, not duplicated).
    expect(dictationEmailPayload.email_candidates).toEqual([
      { value: 'gillettecole@gmail.com', confidence: 0.9 },
      { value: 'gillettcole@gmail.com' },
    ]);
  });

  test('a decisive arbiter verdict is demoted to review, evidence kept', () => {
    const extracted = { email: null, email_candidates: ['gillettecole@gmail.com', 'gillettcole@gmail.com'] };
    const priorPayload = { arbiter: { verdict: 'adopt', chosen_value: 'gillettecole@gmail.com', confidence: 0.95 } };
    const { dictationEmailPayload } = applyEmailDisagreementHold(extracted, priorPayload);
    expect(dictationEmailPayload.arbiter.verdict).toBe('review');
    expect(dictationEmailPayload.arbiter.chosen_value).toBe('gillettecole@gmail.com');

    const priorPayload2 = { arbiter: { verdict: 'adopt_with_confirmation', chosen_value: 'gillettecole@gmail.com' } };
    expect(applyEmailDisagreementHold(extracted, priorPayload2).dictationEmailPayload.arbiter.verdict).toBe('review');

    // A non-decisive verdict (already 'review') is left as-is.
    const priorPayload3 = { arbiter: { verdict: 'review', chosen_value: null } };
    expect(applyEmailDisagreementHold(extracted, priorPayload3).dictationEmailPayload.arbiter.verdict).toBe('review');
  });

  test('does not overwrite an existing email_as_heard / confirmation_question from the decoder', () => {
    const extracted = { email: null, email_candidates: ['gillettecole@gmail.com', 'gillettcole@gmail.com'] };
    const priorPayload = { email_as_heard: 'decoder-heard@example.com', confirmation_question: 'Already asking something?' };
    const { dictationEmailPayload } = applyEmailDisagreementHold(extracted, priorPayload);
    expect(dictationEmailPayload.email_as_heard).toBe('decoder-heard@example.com');
    expect(dictationEmailPayload.confirmation_question).toBe('Already asking something?');
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
      for (const m of ['where', 'whereRaw', 'whereNot', 'whereIn', 'whereNull', 'orWhereNotIn', 'orderBy']) {
        chain[m] = jest.fn(() => chain);
      }
      chain.first = jest.fn(() => Promise.resolve(typeof cfg.first === 'function' ? cfg.first() : (cfg.first ?? null)));
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

  test('an estimate-recipient bounce resolves through customer_id for the alert', async () => {
    // The bounced address lives only on estimates.customer_email (service
    // outline send) — not on the customer row or any lead.
    let customerCalls = 0;
    mockTables({
      customers: { first: () => (customerCalls++ === 0 ? null : { id: 'cust-9', first_name: 'Pat', last_name: 'Roe', phone: '+19415550000' }) },
      leads: { select: [] },
      estimates: { first: { id: 'est-9', customer_id: 'cust-9', customer_name: 'Pat Roe' } },
      notifications: { first: null },
    });

    const out = await alertBouncedContactAddress('outline-recipient@example.com', {});

    expect(out).toMatchObject({ alerted: true, customerId: 'cust-9' });
    const [, , body, opts] = NotificationService.notifyAdmin.mock.calls[0];
    expect(body).toContain('Pat Roe');
    expect(body).toContain('+19415550000');
    expect(opts.link).toBe('/admin/customers/cust-9');
  });

  test('a shared inbox on both a customer and an estimate surfaces BOTH accounts', async () => {
    // The direct customer match stays primary, but the estimate row is the
    // send-specific evidence — its (different) owner must be mentioned.
    let customerCalls = 0;
    mockTables({
      customers: { first: () => (customerCalls++ === 0
        ? { id: 'cust-a', first_name: 'Prop', last_name: 'Manager', phone: '+19415551111' }
        : { id: 'cust-b', first_name: 'Owner', last_name: 'Two', phone: '+19415552222' }) },
      leads: { select: [] },
      estimates: { first: { id: 'est-b', customer_id: 'cust-b', customer_name: 'Owner Two' } },
      notifications: { first: null },
    });

    const out = await alertBouncedContactAddress('manager@example.com', {});

    expect(out).toMatchObject({ alerted: true, customerId: 'cust-a' });
    const [, , body, opts] = NotificationService.notifyAdmin.mock.calls[0];
    expect(body).toContain('Prop Manager');
    expect(body).toContain('Owner Two');
    expect(opts.metadata.record_links).toEqual([{ type: 'estimate', customer_id: 'cust-b' }]);
  });

  test('empty email is a safe no-op', async () => {
    mockTables({});
    expect(await alertBouncedContactAddress('', {})).toEqual({ skipped: 'no_email' });
  });
});
