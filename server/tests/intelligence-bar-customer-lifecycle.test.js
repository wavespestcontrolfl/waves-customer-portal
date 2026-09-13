/**
 * merge_customers — the confirmed customer-lifecycle write added so the
 * Intelligence Bar can merge a duplicate ("Unknown" website stub sharing a
 * phone with a real customer). A #1568 preview→confirmed two-step tool
 * (write-gates.js WRITE_TWO_STEP_TOOL_NAMES): an unconfirmed call is
 * mutation-free and returns the rich preview the confirmation card is built
 * from; only a server-derived confirmed:true (never a model-supplied one)
 * runs the write.
 *
 * db is a small hand-rolled chainable query-builder mock (not the real-knex
 * SQL-capture transport from intelligence-bar-operational-reads.test.js —
 * that transport does not support db.transaction(): knex's postgres
 * transaction dialect calls connection.query() directly, bypassing the
 * overridden _query hook). This mirrors the transaction-friendly db mock
 * established in intelligence-bar-update-customer-address.test.js: `qb`
 * chains, `.first`/`.select`/`.update` are mockable terminals, and
 * `db.transaction` just invokes its callback with the same object as `trx`.
 * customer-dedupe.js (the merge engine + the canonical eligibility check +
 * FK discovery) is mocked per the assignment.
 */

jest.mock('../models/db', () => {
  const qb = {};
  qb.where = jest.fn(() => qb);
  qb.whereIn = jest.fn(() => qb);
  qb.whereNull = jest.fn(() => qb);
  qb.whereNotIn = jest.fn(() => qb);
  qb.whereRaw = jest.fn(() => qb);
  qb.forUpdate = jest.fn(() => qb);
  qb.count = jest.fn(() => qb);
  qb.select = jest.fn();
  qb.first = jest.fn();
  qb.update = jest.fn(() => Promise.resolve(1));
  const db = jest.fn(() => qb);
  db.transaction = jest.fn(async (cb) => cb(db));
  db.raw = jest.fn((sql) => sql);
  db.__qb = qb;
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const mockExecuteMerge = jest.fn();
const mockDuplicatePairEligibility = jest.fn();
const mockDescribeMergeEffects = jest.fn();
jest.mock('../services/customer-dedupe', () => ({
  executeMerge: (...args) => mockExecuteMerge(...args),
  duplicatePairEligibility: (...args) => mockDuplicatePairEligibility(...args),
  describeMergeEffects: (...args) => mockDescribeMergeEffects(...args),
  // The REAL rules: the preview must refuse exactly what the executor refuses.
  rowLevelMergeConflict: jest.requireActual('../services/customer-dedupe').rowLevelMergeConflict,
  dbLevelMergeConflict: jest.requireActual('../services/customer-dedupe').dbLevelMergeConflict,
}));

const db = require('../models/db');
const { executeCustomerLifecycleTool } = require('../services/intelligence-bar/customer-lifecycle-tools');

const WINNER_ID = '10000000-0000-4000-8000-000000000001';
const LOSER_ID = '10000000-0000-4000-8000-000000000002';

const winnerRow = { id: WINNER_ID, first_name: 'Real', last_name: 'Customer', phone: '9415550101', email: 'real@example.com', deleted_at: null, version: '2026-09-10 20:00:00.000001+00', account_credits: '0' };
const loserRow = { id: LOSER_ID, first_name: 'Unknown', last_name: '', phone: '9415550101', email: null, deleted_at: null, version: '2026-09-10 20:05:00.000002+00', account_credits: '12.50', billing_mode: 'per_application', per_application_fee: '85.00' };

const ELIGIBLE = { eligible: true, code: 'eligible', reason: null, candidate: { tier: 'yellow', reasons: ['name_conflict'] } };

// The engine's effect disclosure (customer-dedupe.js describeMergeEffects)
// is mocked: the preview discloses whatever IT reports — moving counts,
// money effects, backfills, fold, restrictions — and pins ITS fingerprint;
// the tool never derives an effect of its own.
const NOT_ENROLLED = { loser_enrolled: false };
const FINANCIAL = {
  account_credits_moved_to_winner: 12.5, billing_mode_adopted_from_loser: 'per_application', per_application_fee_adopted_from_loser: 85,
  loser_plan_rate_rows_deleted: 0, referral_fold: NOT_ENROLLED, autopay_restrictions_inherited: {},
  winner_backfills: { email: 'stub@example.com' }, stripe_profile_from_saved_cards: null, saved_card_profile_conflict: false,
  saved_card_demotions: { winner_has_default: false, cards: [] },
  note_appends: {},
  combined_payment_sessions: { winner: [], loser: [] },
  collection_cases: { available: true, live: [], demoted_to_proposed: [], defers_on_dialing: false },
  predicted_collision_handlers: [], revertible_from_queue: 'unless the sweep has to fold colliding rows (journaled)',
};
const EFFECTS = { moving: { scheduled_services: 3, sms_log: 5, 'notifications.recipient_id': 2, total_rows: 10 }, financial_effects: FINANCIAL, fingerprint: 'fp-card-1' };

beforeEach(() => {
  jest.clearAllMocks();
  db.transaction.mockImplementation(async (cb) => cb(db));
  db.__qb.update.mockResolvedValue(1);
  mockDuplicatePairEligibility.mockResolvedValue(ELIGIBLE);
  mockDescribeMergeEffects.mockResolvedValue(EFFECTS);
  // Default-off capability gate (Codex r14 P1): on for every test below
  // except the one that proves it refuses.
  process.env.GATE_IB_MERGE_CUSTOMERS = 'true';
});
afterAll(() => { delete process.env.GATE_IB_MERGE_CUSTOMERS; });

describe('merge_customers', () => {
  test('GATE_IB_MERGE_CUSTOMERS off: the tool refuses before touching the database — preview and confirmed call alike (Codex r14 P1)', async () => {
    delete process.env.GATE_IB_MERGE_CUSTOMERS;
    const preview = await executeCustomerLifecycleTool('merge_customers', { winner_customer_id: WINNER_ID, loser_customer_id: LOSER_ID }, {});
    expect(preview).toEqual({ error: expect.stringMatching(/not enabled \(GATE_IB_MERGE_CUSTOMERS\)/), code: 'gate_off' });
    const commit = await executeCustomerLifecycleTool('merge_customers', { winner_customer_id: WINNER_ID, loser_customer_id: LOSER_ID }, { confirmed: true, technicianId: 'admin-1' });
    expect(commit).toMatchObject({ code: 'gate_off' });
    expect(db.__qb.select).not.toHaveBeenCalled();
    expect(mockExecuteMerge).not.toHaveBeenCalled();
    process.env.GATE_IB_MERGE_CUSTOMERS = 'false';
    expect(await executeCustomerLifecycleTool('merge_customers', { winner_customer_id: WINNER_ID, loser_customer_id: LOSER_ID }, {})).toMatchObject({ code: 'gate_off' });
  });

  test('the card states the loser state the merge discards — the rate both sides, the survivor\'s billing from now on, the login — and every predicted fold (Codex r14 P1 + P2)', async () => {
    db.__qb.select.mockResolvedValueOnce([winnerRow, loserRow]);
    mockDescribeMergeEffects.mockResolvedValueOnce({ ...EFFECTS, financial_effects: { ...FINANCIAL,
      loser_state_discarded: { monthly_rate: { loser: 122, winner: 98 }, membership_tier: { loser: 'gold', winner: null }, portal_login: { loser: true, winner: false } },
      predicted_collision_handlers: ['customer_tags', 'notification_prefs'],
      predicted_collision_folds: { notification_prefs: 'both records have a row: the fields merge into the surviving row and the archived record\'s row is dropped', customer_tags: { shared: ['vip'] } },
      revertible_from_queue: false } });
    const card = await executeCustomerLifecycleTool('merge_customers', { winner_customer_id: WINNER_ID, loser_customer_id: LOSER_ID }, {});
    expect(card.note_to_operator).toMatch(/DISCARDED with the archived record — the merge never copies these onto the survivor: the monthly rate \$122\.00 \(the surviving record's rate is \$98\.00 — every moved visit bills at the survivor's rate from now on\); the membership tier gold \(survivor: none\); its portal login \(the survivor has none — the customer must be re-invited\)\./);
    expect(card.note_to_operator).toMatch(/Folds the undo cannot split apart: notification_prefs: both records have a row.*; tags shared by both records \(vip\) are dropped from the archived side\./);
    expect(card.note_to_operator).toMatch(/EXCEPT that this merge folds customer_tags, notification_prefs/);
    // The snapshot the card shows carries the never-copied columns both-sided, and never the hash.
    expect(card.billing_and_contacts.loser).toEqual(expect.objectContaining({ monthly_rate: null, waveguard_tier: null, pipeline_stage: null, has_portal_login: false }));
    expect(card.billing_and_contacts.loser.password_hash).toBeUndefined();
  });

  test('a model-supplied confirmed:true CANNOT commit — only the server-derived action context can (pre-push audit P0)', async () => {
    db.__qb.select.mockResolvedValueOnce([winnerRow, loserRow]);
    // The model puts confirmed:true (and forged pins) in its own tool input
    // and the action context says otherwise: this is a PREVIEW, nothing runs.
    const result = await executeCustomerLifecycleTool(
      'merge_customers',
      { winner_customer_id: WINNER_ID, loser_customer_id: LOSER_ID, confirmed: true, _approved_versions: { winner: 'forged-w', loser: 'forged-l' }, _approved_effects: 'forged-fp' },
      {},
    );
    expect(result.preview).toBe(true);
    expect(mockExecuteMerge).not.toHaveBeenCalled();
    // And the tool schema refuses the extra field outright.
    const { CUSTOMER_LIFECYCLE_TOOLS } = require('../services/intelligence-bar/customer-lifecycle-tools');
    expect(CUSTOMER_LIFECYCLE_TOOLS.find((t) => t.name === 'merge_customers').input_schema.additionalProperties).toBe(false);
  });

  test('same id refuses without touching the database', async () => {
    const result = await executeCustomerLifecycleTool('merge_customers', { winner_customer_id: WINNER_ID, loser_customer_id: WINNER_ID }, {});
    expect(result.error).toMatch(/different customers/);
    expect(db).not.toHaveBeenCalled();
  });

  test('preview names both customers, discloses full moving counts, billing/contacts, pair, and versions, and mutates nothing', async () => {
    db.__qb.select.mockResolvedValueOnce([winnerRow, loserRow]); // loadMergePair

    const result = await executeCustomerLifecycleTool('merge_customers', { winner_customer_id: WINNER_ID, loser_customer_id: LOSER_ID }, {});

    expect(result.error).toBeUndefined();
    expect(mockDuplicatePairEligibility).toHaveBeenCalledWith(WINNER_ID, LOSER_ID);
    expect(result).toMatchObject({
      preview: true,
      winner_customer_id: WINNER_ID, winner_name: 'Real Customer', winner_phone: '9415550101', winner_email: 'real@example.com', winner_version: winnerRow.version,
      loser_customer_id: LOSER_ID, loser_name: 'Unknown', loser_phone: '9415550101', loser_email: null, loser_version: loserRow.version,
      pair: { tier: 'yellow', reasons: ['name_conflict'] },
      moving: EFFECTS.moving,
    });
    expect(mockDescribeMergeEffects).toHaveBeenCalledWith(db, winnerRow, loserRow);
    expect(db.__qb.select).toHaveBeenCalledWith('*', expect.anything()); // whole rows: the engine's rule reads what its own locked select(*) sees
    expect(result.billing_and_contacts).toEqual({
      winner: expect.objectContaining({ stripe_customer_id: null, billing_mode: null, per_application_fee: null, account_credits: '0' }),
      loser: expect.objectContaining({ stripe_customer_id: null, billing_mode: 'per_application', per_application_fee: '85.00', account_credits: '12.50' }),
    });
    // The engine's disclosure rides verbatim, and its fingerprint is what the route pins.
    expect(result.financial_effects).toEqual(FINANCIAL);
    expect(result.effects_fingerprint).toBe('fp-card-1');
    expect(result.billing_and_contacts.loser).toEqual(expect.objectContaining({ autopay_paused_until: null, auto_apply_account_credit: null, address_line1: null }));
    expect(result.note_to_operator).toMatch(/archived/);
    expect(result.note_to_operator).toMatch(/revertible from there unless the sweep has to fold colliding rows/);
    expect(db.__qb.update).not.toHaveBeenCalled();
    expect(mockExecuteMerge).not.toHaveBeenCalled();
  });

  test('a predicted collision fold (referral enrollment) is named in the operator note as the undo exception', async () => {
    db.__qb.select.mockResolvedValueOnce([winnerRow, loserRow]);
    mockDescribeMergeEffects.mockResolvedValueOnce({ ...EFFECTS, financial_effects: { ...FINANCIAL, predicted_collision_handlers: ['referral_promoters'], revertible_from_queue: false } });
    const result = await executeCustomerLifecycleTool('merge_customers', { winner_customer_id: WINNER_ID, loser_customer_id: LOSER_ID }, {});
    expect(result.financial_effects).toMatchObject({ predicted_collision_handlers: ['referral_promoters'], revertible_from_queue: false });
    expect(result.note_to_operator).toMatch(/EXCEPT that this merge folds referral_promoters/);
  });

  test('ids are normalized to lowercase at the tool boundary (Postgres returns canonical lowercase uuids)', async () => {
    db.__qb.select.mockResolvedValueOnce([winnerRow, loserRow]);
    const result = await executeCustomerLifecycleTool('merge_customers', { winner_customer_id: WINNER_ID.toUpperCase(), loser_customer_id: ` ${LOSER_ID.toUpperCase()} ` }, {});
    expect(result.error).toBeUndefined();
    expect(result.winner_customer_id).toBe(WINNER_ID);
    expect(db.__qb.whereIn).toHaveBeenCalledWith('id', [WINNER_ID, LOSER_ID]);
    expect(mockDuplicatePairEligibility).toHaveBeenCalledWith(WINNER_ID, LOSER_ID);
  });

  test('a pair the executor would unconditionally refuse (two Stripe profiles / payers / billing modes / fees, inactive winner) refuses the PREVIEW with the executor\'s reason — never a card that cannot succeed (Codex r6 P2)', async () => {
    const cases = [
      [{ stripe_customer_id: 'cus_w' }, { stripe_customer_id: 'cus_l' }, 'stripe_profile_conflict', /both customers have Stripe profiles/],
      [{ payer_id: 'payer-1' }, { payer_id: 'payer-2' }, 'payer_conflict', /different third-party payers/],
      [{ billing_mode: 'annual_prepay' }, { billing_mode: 'per_application' }, 'billing_mode_conflict', /different billing modes/],
      [{ billing_mode: 'per_application', per_application_fee: '85.00' }, { billing_mode: 'per_application', per_application_fee: '95.00' }, 'per_application_fee_conflict', /different per-application fees/],
      [{ active: false }, {}, 'winner_inactive', /winner is inactive/],
    ];
    for (const [w, l, code, message] of cases) {
      db.__qb.select.mockResolvedValueOnce([{ ...winnerRow, ...w }, { ...loserRow, ...l }]);
      const refused = await executeCustomerLifecycleTool('merge_customers', { winner_customer_id: WINNER_ID, loser_customer_id: LOSER_ID }, {});
      expect(refused).toMatchObject({ code, error: message });
      expect(refused.preview).toBeUndefined();
    }
    // The refusal is decided BEFORE any effect is computed — no card, no engine call.
    expect(mockDescribeMergeEffects).not.toHaveBeenCalled();
    expect(mockExecuteMerge).not.toHaveBeenCalled();
    // A loser-only value is a backfill, not a conflict: the card is built.
    db.__qb.select.mockResolvedValueOnce([winnerRow, { ...loserRow, stripe_customer_id: 'cus_l', payer_id: 'payer-1', billing_mode: 'per_application' }]);
    const card = await executeCustomerLifecycleTool('merge_customers', { winner_customer_id: WINNER_ID, loser_customer_id: LOSER_ID }, {});
    expect(card.preview).toBe(true);
  });

  test('a pair the executor would refuse after a QUERY (billing-mode history, multi-property siblings) refuses the preview too (Codex r7 P2)', async () => {
    // winnerRow has no billing_mode and loserRow is per_application, so the
    // winner is the flipping side: one live invoice or scheduled service on
    // it and the executor refuses. The preview must refuse identically
    // instead of spending an approval on it.
    db.__qb.select.mockResolvedValueOnce([winnerRow, loserRow]);
    db.__qb.first.mockResolvedValueOnce({ id: 'ss-1' });
    const history = await executeCustomerLifecycleTool('merge_customers', { winner_customer_id: WINNER_ID, loser_customer_id: LOSER_ID }, {});
    expect(history).toMatchObject({ code: 'billing_mode_history_conflict', error: /legacy and special billing modes/ });
    expect(history.preview).toBeUndefined();
    // A loser in a multi-property account whose group still has other live
    // members: merging would strand the siblings.
    db.__qb.select.mockResolvedValueOnce([{ ...winnerRow, billing_mode: 'per_application', per_application_fee: '85.00' }, { ...loserRow, account_id: 'acct-9' }]);
    db.__qb.first.mockResolvedValueOnce({ id: 'sibling-1' });
    const stranded = await executeCustomerLifecycleTool('merge_customers', { winner_customer_id: WINNER_ID, loser_customer_id: LOSER_ID }, {});
    expect(stranded).toMatchObject({ code: 'multi_property_account_conflict', error: /multi-property account/ });
    // Both refusals land before any effect is computed — no card, no engine.
    expect(mockDescribeMergeEffects).not.toHaveBeenCalled();
    expect(mockExecuteMerge).not.toHaveBeenCalled();
  });

  test('the card names the notes the merge appends onto the survivor (Codex r7 P2)', async () => {
    db.__qb.select.mockResolvedValueOnce([winnerRow, loserRow]);
    mockDescribeMergeEffects.mockResolvedValueOnce({ ...EFFECTS, financial_effects: { ...FINANCIAL, note_appends: { crm_notes: 'a\n\nb', technician_notes: 'Dog in the back yard' } } });
    const card = await executeCustomerLifecycleTool('merge_customers', { winner_customer_id: WINNER_ID, loser_customer_id: LOSER_ID }, {});
    expect(card.note_to_operator).toMatch(/Notes: the archived record's CRM notes and technician notes \(technician-facing instructions\) are appended to the surviving record's/);
    // Nothing to append → nothing claimed.
    db.__qb.select.mockResolvedValueOnce([winnerRow, loserRow]);
    const quiet = await executeCustomerLifecycleTool('merge_customers', { winner_customer_id: WINNER_ID, loser_customer_id: LOSER_ID }, {});
    expect(quiet.note_to_operator).not.toMatch(/Notes:/);
  });

  test('an already-cancelled session is described as stamp cleanup, not as a cancellation the merge performs (Codex r7 P2)', async () => {
    db.__qb.select.mockResolvedValueOnce([winnerRow, loserRow]);
    mockDescribeMergeEffects.mockResolvedValueOnce({ ...EFFECTS, financial_effects: { ...FINANCIAL, combined_payment_sessions: {
      winner: [{ invoice_id: 'inv-w', payment_intent_id: 'pi_w', outcome: 'cancel_single_invoice' }],
      loser: [{ invoice_id: 'inv-1', payment_intent_id: 'pi_a', outcome: 'cancel' }, { invoice_id: 'inv-2', payment_intent_id: 'pi_b', outcome: 'stamps_cleared' }],
    } } });
    const card = await executeCustomerLifecycleTool('merge_customers', { winner_customer_id: WINNER_ID, loser_customer_id: LOSER_ID }, {});
    // Three distinct sentences: one Stripe cancellation of a combined
    // session, one of an invalidated single-invoice checkout, and one that
    // cancels NOTHING in Stripe.
    expect(card.note_to_operator).toMatch(/1 unconfirmed combined payment session\(s\) will be cancelled in Stripe first/);
    expect(card.note_to_operator).toMatch(/1 single-invoice checkout session\(s\) will be cancelled in Stripe because this merge invalidates them/);
    expect(card.note_to_operator).toMatch(/1 already-cancelled session\(s\) only have their invoice stamps cleared — nothing is cancelled in Stripe for these/);
    // The old wording counted the already-cancelled one as a cancellation.
    expect(card.note_to_operator).not.toMatch(/2 unconfirmed combined payment session/);
  });

  test('session counts are per PaymentIntent, not per stamped invoice (Codex r10 P2)', async () => {
    // One combined intent stamped onto three invoices: the release cancels
    // it ONCE, so the card must not promise three cancellations.
    db.__qb.select.mockResolvedValueOnce([winnerRow, loserRow]);
    mockDescribeMergeEffects.mockResolvedValueOnce({ ...EFFECTS, financial_effects: { ...FINANCIAL, combined_payment_sessions: { winner: [], loser: [
      { invoice_id: 'inv-1', invoice_number: 'INV-1', payment_intent_id: 'pi_a', outcome: 'cancel' },
      { invoice_id: 'inv-2', invoice_number: 'INV-2', payment_intent_id: 'pi_a', outcome: 'cancel' },
      { invoice_id: 'inv-3', invoice_number: 'INV-3', payment_intent_id: 'pi_a', outcome: 'cancel' },
      { invoice_id: 'inv-4', invoice_number: 'INV-4', payment_intent_id: 'pi_b', outcome: 'cancel' },
    ] } } });
    const card = await executeCustomerLifecycleTool('merge_customers', { winner_customer_id: WINNER_ID, loser_customer_id: LOSER_ID }, {});
    expect(card.note_to_operator).toMatch(/2 unconfirmed combined payment session\(s\) will be cancelled in Stripe first/);
    expect(card.note_to_operator).toMatch(/counted per payment session, not per invoice/);
    // The per-invoice rows are still disclosed in full.
    expect(card.financial_effects.combined_payment_sessions.loser).toHaveLength(4);
  });

  test('the card puts the non-FK rewrites in words — an address stamp and a re-keyed delivery are not "rows listed above" (Codex r9 P2)', async () => {
    db.__qb.select.mockResolvedValueOnce([winnerRow, loserRow]);
    mockDescribeMergeEffects.mockResolvedValueOnce({
      ...EFFECTS,
      moving: { ...EFFECTS.moving, non_fk_rewrites: { 'scheduled_services.service_address_stamp': 3, 'call_log.customer_link_override': 2, 'email_messages.trigger_event_id': 1, 'property_preferences.irrigation_home_changed_at': 'stamped' } },
    });
    const card = await executeCustomerLifecycleTool('merge_customers', { winner_customer_id: WINNER_ID, loser_customer_id: LOSER_ID }, {});
    expect(card.note_to_operator).toMatch(/Beyond the row counts: 3 unaddressed visit\(s\).*own address first, so the schedule board cannot send a tech to the wrong house/);
    expect(card.note_to_operator).toMatch(/2 call\(s\) an operator linked by hand are re-linked/);
    expect(card.note_to_operator).toMatch(/1 weekly watering-plan delivery record\(s\) are re-keyed/);
    expect(card.note_to_operator).toMatch(/different homes, so the surviving sprinkler settings are marked moved/);
    // Nothing of the sort → the sentence is absent, not an empty clause.
    db.__qb.select.mockResolvedValueOnce([winnerRow, loserRow]);
    const quiet = await executeCustomerLifecycleTool('merge_customers', { winner_customer_id: WINNER_ID, loser_customer_id: LOSER_ID }, {});
    expect(quiet.note_to_operator).not.toMatch(/Beyond the row counts/);
  });

  test('the card names every loser card the merge strips of default/autopay, with its before-flags (Codex r6 P1)', async () => {
    db.__qb.select.mockResolvedValueOnce([winnerRow, loserRow]);
    mockDescribeMergeEffects.mockResolvedValueOnce({ ...EFFECTS, financial_effects: { ...FINANCIAL, saved_card_demotions: { winner_has_default: true, cards: [{ id: 'pm_l1', is_default: true, autopay_enabled: true }, { id: 'pm_l2', is_default: false, autopay_enabled: true }] } } });
    const card = await executeCustomerLifecycleTool('merge_customers', { winner_customer_id: WINNER_ID, loser_customer_id: LOSER_ID }, {});
    expect(card.financial_effects.saved_card_demotions.cards).toHaveLength(2);
    expect(card.note_to_operator).toMatch(/Saved cards: 2 card\(s\) moving from the archived record lose default\/autopay because the surviving record already has a default card — pm_l1 \(default\+autopay\), pm_l2 \(autopay\); the survivor's own default card stays the one autopay card\./);
    // No winner default → nothing to say.
    db.__qb.select.mockResolvedValueOnce([winnerRow, loserRow]);
    mockDescribeMergeEffects.mockResolvedValueOnce({ ...EFFECTS, financial_effects: { ...FINANCIAL, saved_card_demotions: { winner_has_default: false, cards: [] } } });
    const quiet = await executeCustomerLifecycleTool('merge_customers', { winner_customer_id: WINNER_ID, loser_customer_id: LOSER_ID }, {});
    expect(quiet.note_to_operator).not.toMatch(/Saved cards:/);
  });

  test('saved cards on a third Stripe profile refuse the preview (a card the executor would refuse is a tool failure, not a card); open combined sessions are named in the note', async () => {
    db.__qb.select.mockResolvedValueOnce([winnerRow, loserRow]);
    mockDescribeMergeEffects.mockResolvedValueOnce({ ...EFFECTS, financial_effects: { ...FINANCIAL, saved_card_profile_conflict: true } });
    const refused = await executeCustomerLifecycleTool('merge_customers', { winner_customer_id: WINNER_ID, loser_customer_id: LOSER_ID }, {});
    expect(refused).toMatchObject({ code: 'stripe_profile_conflict', error: expect.stringMatching(/different Stripe profile/) });
    expect(refused.preview).toBeUndefined();
    db.__qb.select.mockResolvedValueOnce([winnerRow, loserRow]);
    // Per-intent outcomes (Codex r5 P1): the note never promises to cancel a single-invoice checkout the release leaves alone.
    mockDescribeMergeEffects.mockResolvedValueOnce({ ...EFFECTS, financial_effects: { ...FINANCIAL, combined_payment_sessions: { winner: [{ invoice_id: 'inv-9', invoice_number: 'INV-9', payment_intent_id: 'pi_w', outcome: 'kept_single_invoice' }], loser: [{ invoice_id: 'inv-1', invoice_number: 'INV-1', payment_intent_id: 'pi_a', outcome: 'cancel' }, { invoice_id: 'inv-2', invoice_number: 'INV-2', payment_intent_id: 'pi_b', outcome: 'in_flight' }] } } });
    const withSession = await executeCustomerLifecycleTool('merge_customers', { winner_customer_id: WINNER_ID, loser_customer_id: LOSER_ID }, {});
    expect(withSession.note_to_operator).toMatch(/1 unconfirmed combined payment session\(s\) will be cancelled in Stripe first; 1 payment session\(s\) have money in flight \(a merged-away one defers the merge until it settles\); 1 single-invoice checkout session\(s\) stay open and are NOT cancelled\./);
    expect(withSession.note_to_operator).not.toMatch(/listed above will be cancelled/);
    // Collection-case reconcile on the card (Codex r5 P1): the approval the merge revokes is named; a dialing case says the merge defers.
    db.__qb.select.mockResolvedValueOnce([winnerRow, loserRow]);
    mockDescribeMergeEffects.mockResolvedValueOnce({ ...EFFECTS, financial_effects: { ...FINANCIAL, collection_cases: { available: true, live: [{ id: 'c-w', side: 'winner', state: 'approved', case_version: 4 }, { id: 'c-l', side: 'loser', state: 'approved', case_version: 2 }], demoted_to_proposed: ['c-l'], defers_on_dialing: false } } });
    const withCases = await executeCustomerLifecycleTool('merge_customers', { winner_customer_id: WINNER_ID, loser_customer_id: LOSER_ID }, {});
    expect(withCases.note_to_operator).toMatch(/Collection cases: 1 approved case\(s\) \(c-l\) revert to proposed/);
    db.__qb.select.mockResolvedValueOnce([winnerRow, loserRow]);
    mockDescribeMergeEffects.mockResolvedValueOnce({ ...EFFECTS, financial_effects: { ...FINANCIAL, collection_cases: { available: true, live: [{ id: 'd', side: 'loser', state: 'dialing', case_version: 1 }], demoted_to_proposed: [], defers_on_dialing: true } } });
    const dialing = await executeCustomerLifecycleTool('merge_customers', { winner_customer_id: WINNER_ID, loser_customer_id: LOSER_ID }, {});
    expect(dialing.note_to_operator).toMatch(/A collection call is in flight for one of these customers: the merge defers/);
  });

  test('preview refuses not_in_queue with the canonical message', async () => {
    db.__qb.select.mockResolvedValueOnce([winnerRow, loserRow]);
    mockDuplicatePairEligibility.mockResolvedValueOnce({ eligible: false, code: 'not_in_queue', reason: 'Pair is no longer in the duplicate queue', candidate: null });
    const result = await executeCustomerLifecycleTool('merge_customers', { winner_customer_id: WINNER_ID, loser_customer_id: LOSER_ID }, {});
    expect(result).toMatchObject({ code: 'not_in_queue', error: 'Pair is no longer in the duplicate queue' });
  });

  test('preview refuses red_pair with the canonical message', async () => {
    db.__qb.select.mockResolvedValueOnce([winnerRow, loserRow]);
    mockDuplicatePairEligibility.mockResolvedValueOnce({ eligible: false, code: 'red_pair', reason: 'This pair looks like two different people and cannot be merged from the queue', candidate: { tier: 'red', reasons: [] } });
    const result = await executeCustomerLifecycleTool('merge_customers', { winner_customer_id: WINNER_ID, loser_customer_id: LOSER_ID }, {});
    expect(result).toMatchObject({ code: 'red_pair', error: 'This pair looks like two different people and cannot be merged from the queue' });
  });

  test('preview refuses address_conflict pointing the operator at the admin duplicates queue, never offering link-as-property', async () => {
    db.__qb.select.mockResolvedValueOnce([winnerRow, loserRow]);
    mockDuplicatePairEligibility.mockResolvedValueOnce({ eligible: false, code: 'address_conflict', reason: "This duplicate has a different service address — use 'Merge + keep address' so the address isn't lost", candidate: { tier: 'yellow', reasons: ['address_different'] } });
    const result = await executeCustomerLifecycleTool('merge_customers', { winner_customer_id: WINNER_ID, loser_customer_id: LOSER_ID }, {});
    expect(result.code).toBe('address_conflict');
    // Refusals carry no PII: the route runs the preview before validateRecordTarget (Codex r3 P1).
    expect(result.error).not.toMatch(/Real|Unknown|Customer/);
    expect(result.error).toMatch(/Merge \+ keep address/);
    expect(result.error).toMatch(/admin duplicates queue/);
    expect(result.error).toMatch(/Merge \+ keep address/);
    expect(result.error).toMatch(/does not support/i);
  });

  test('refuses when the winner or loser does not resolve to a live customer', async () => {
    db.__qb.select.mockResolvedValueOnce([loserRow]); // winner missing
    let result = await executeCustomerLifecycleTool('merge_customers', { winner_customer_id: WINNER_ID, loser_customer_id: LOSER_ID }, {});
    expect(result).toMatchObject({ code: 'record_unavailable' });
    expect(result.error).toMatch(/winner_customer_id/);
    expect(mockDuplicatePairEligibility).not.toHaveBeenCalled();

    db.__qb.select.mockResolvedValueOnce([{ ...winnerRow }, { ...loserRow, deleted_at: new Date() }]); // loser archived
    result = await executeCustomerLifecycleTool('merge_customers', { winner_customer_id: WINNER_ID, loser_customer_id: LOSER_ID }, {});
    expect(result).toMatchObject({ code: 'record_unavailable' });
    expect(result.error).toMatch(/loser customer is already archived/);
  });

  test('confirmed call re-reads versions and eligibility once before executeMerge, then runs it with performedBy/mode from the action context', async () => {
    db.__qb.select.mockResolvedValue([winnerRow, loserRow]); // loadMergePair, called once
    mockExecuteMerge.mockResolvedValueOnce({ journalId: 'journal-1', repointed: { scheduled_services: 3 }, backfills: {} });

    const result = await executeCustomerLifecycleTool(
      'merge_customers',
      { winner_customer_id: WINNER_ID, loser_customer_id: LOSER_ID, confirmed: true },
      { confirmed: true, technicianId: 'tech-42' },
    );

    // One unlocked preflight — the executor re-validates under its locks
    // (ultrareview nit: each preflight is a full duplicate-queue scan).
    expect(mockDuplicatePairEligibility).toHaveBeenCalledTimes(1);
    expect(db.__qb.select).toHaveBeenCalledTimes(1);
    expect(mockExecuteMerge).toHaveBeenCalledWith({
      winnerId: WINNER_ID,
      loserId: LOSER_ID,
      performedBy: 'ib:tech-42',
      performedById: 'tech-42',
      mode: 'intelligence_bar',
      evidence: { via: 'intelligence_bar' },
      expectedVersions: { winner: winnerRow.version, loser: loserRow.version },
      expectedEffectsFingerprint: null, // no card pin on a direct call — the effects are not asserted
      requireQueueEligibility: true, // the final queue decision always runs inside the executor's transaction
    });
    expect(result).toMatchObject({ success: true, journal_id: 'journal-1' });
  });

  test('confirmed call refuses with preview_changed when the pair became ineligible since the card was shown', async () => {
    db.__qb.select.mockResolvedValue([winnerRow, loserRow]);
    mockDuplicatePairEligibility.mockResolvedValue({ eligible: false, code: 'red_pair', reason: 'This pair looks like two different people and cannot be merged from the queue', candidate: { tier: 'red', reasons: [] } });
    const result = await executeCustomerLifecycleTool(
      'merge_customers',
      { winner_customer_id: WINNER_ID, loser_customer_id: LOSER_ID, confirmed: true },
      { confirmed: true, technicianId: 'tech-42' },
    );
    expect(result.preview_changed).toBe(true);
    expect(mockExecuteMerge).not.toHaveBeenCalled();
  });

  test('a customer version that moved after the preflight is refused by the executor under its locks, not by a second unlocked sample', async () => {
    db.__qb.select.mockResolvedValue([winnerRow, loserRow]);
    const drift = new Error('Customer version changed since the card was shown');
    drift.previewChanged = true;
    mockExecuteMerge.mockRejectedValueOnce(drift);
    const result = await executeCustomerLifecycleTool(
      'merge_customers',
      { winner_customer_id: WINNER_ID, loser_customer_id: LOSER_ID, confirmed: true, _approved_versions: { winner: winnerRow.version, loser: loserRow.version } },
      { confirmed: true, technicianId: 'tech-42' },
    );
    expect(db.__qb.select).toHaveBeenCalledTimes(1);
    expect(mockExecuteMerge).toHaveBeenCalledWith(expect.objectContaining({ expectedVersions: { winner: winnerRow.version, loser: loserRow.version } }));
    expect(result).toMatchObject({ preview_changed: true });
  });

  test('confirmed call validates the APPROVED card versions (route pin), not freshly sampled ones (pre-push Codex P1)', async () => {
    db.__qb.select.mockResolvedValue([winnerRow, loserRow]);
    mockExecuteMerge.mockResolvedValueOnce({ journalId: 'journal-2', repointed: {}, backfills: {} });
    await executeCustomerLifecycleTool(
      'merge_customers',
      { winner_customer_id: WINNER_ID, loser_customer_id: LOSER_ID, confirmed: true, _approved_versions: { winner: 'approved-w', loser: 'approved-l' } },
      { confirmed: true, technicianId: 'tech-42' },
    );
    expect(mockExecuteMerge).toHaveBeenCalledWith(expect.objectContaining({ expectedVersions: { winner: 'approved-w', loser: 'approved-l' } }));
    // the executor's own under-lock refusal surfaces as preview_changed
    mockExecuteMerge.mockRejectedValueOnce(Object.assign(new Error('executeMerge: the loser customer changed since this merge was approved — review a fresh proposal'), { previewChanged: true }));
    const drift = await executeCustomerLifecycleTool(
      'merge_customers',
      { winner_customer_id: WINNER_ID, loser_customer_id: LOSER_ID, confirmed: true, _approved_versions: { winner: 'approved-w', loser: 'approved-l' } },
      { confirmed: true, technicianId: 'tech-42' },
    );
    expect(drift).toMatchObject({ preview_changed: true });
  });

  test('the preview never computes an effect of its own — moving, money effects and fingerprint are the engine\'s', async () => {
    db.__qb.select.mockResolvedValueOnce([winnerRow, loserRow]);
    mockDescribeMergeEffects.mockResolvedValueOnce({ moving: { sms_log: 1, total_rows: 1 }, financial_effects: { ...FINANCIAL, account_credits_moved_to_winner: 0 }, fingerprint: 'fp-x' });
    const result = await executeCustomerLifecycleTool('merge_customers', { winner_customer_id: WINNER_ID, loser_customer_id: LOSER_ID }, {});
    expect(result.moving).toEqual({ sms_log: 1, total_rows: 1 });
    expect(result.financial_effects.account_credits_moved_to_winner).toBe(0);
    expect(result.effects_fingerprint).toBe('fp-x');
    // The preview's ONLY own reads are the pair's customer rows and the
    // executor's DB-dependent refusal probes (billing-mode history,
    // multi-property siblings) — never a count of its own (codex #4348 r7
    // P2 shared those probes; moving/effects/fingerprint stay the engine's).
    expect([...new Set(db.mock.calls.map((c) => c[0]))].sort()).toEqual(['customers', 'invoices', 'scheduled_services']);
    expect(db.__qb.count).not.toHaveBeenCalled(); // no local counting
  });

  test('confirmed call hands the APPROVED fingerprint to the executor (validated under its locks, with the final queue decision) and relays its drift refusal', async () => {
    db.__qb.select.mockResolvedValue([winnerRow, loserRow]);
    mockExecuteMerge.mockResolvedValueOnce({ journalId: 'journal-3', repointed: {}, backfills: {} });
    const ok = await executeCustomerLifecycleTool(
      'merge_customers',
      { winner_customer_id: WINNER_ID, loser_customer_id: LOSER_ID, confirmed: true, _approved_versions: { winner: winnerRow.version, loser: loserRow.version }, _approved_effects: 'fp-card-1' },
      { confirmed: true, technicianId: 'tech-42' },
    );
    expect(ok).toMatchObject({ success: true, journal_id: 'journal-3' });
    expect(mockExecuteMerge).toHaveBeenCalledWith(expect.objectContaining({ expectedEffectsFingerprint: 'fp-card-1', requireQueueEligibility: true }));
    expect(mockDescribeMergeEffects).not.toHaveBeenCalled(); // the recount is the executor's, over ITS locked rows
    // The executor's under-lock refusals (effects drifted / pair adjudicated) surface as preview_changed, nothing committed.
    mockExecuteMerge.mockRejectedValueOnce(Object.assign(new Error('executeMerge: the rows that would move changed since this merge was approved — review a fresh proposal'), { previewChanged: true }));
    const drift = await executeCustomerLifecycleTool(
      'merge_customers',
      { winner_customer_id: WINNER_ID, loser_customer_id: LOSER_ID, confirmed: true, _approved_versions: { winner: winnerRow.version, loser: loserRow.version }, _approved_effects: 'fp-card-1' },
      { confirmed: true, technicianId: 'tech-42' },
    );
    expect(drift).toMatchObject({ preview_changed: true });
    expect(drift.error).toMatch(/rows that would move changed/);
    expect(drift.success).toBeUndefined();
    mockExecuteMerge.mockRejectedValueOnce(Object.assign(new Error('executeMerge: the pair is no longer mergeable (not_in_queue) — review a fresh proposal'), { previewChanged: true }));
    const adjudicated = await executeCustomerLifecycleTool(
      'merge_customers',
      { winner_customer_id: WINNER_ID, loser_customer_id: LOSER_ID, confirmed: true, _approved_effects: 'fp-card-1' },
      { confirmed: true, technicianId: 'tech-42' },
    );
    expect(adjudicated).toMatchObject({ preview_changed: true, error: expect.stringMatching(/no longer mergeable/) });
  });

  test('confirmed call relays an executeMerge refusal without a partial write', async () => {
    db.__qb.select.mockResolvedValue([winnerRow, loserRow]);
    mockExecuteMerge.mockRejectedValueOnce(new Error('executeMerge: both customers have Stripe profiles — resolve in Stripe first'));
    const result = await executeCustomerLifecycleTool(
      'merge_customers',
      { winner_customer_id: WINNER_ID, loser_customer_id: LOSER_ID, confirmed: true },
      { confirmed: true, technicianId: 'tech-42' },
    );
    expect(result.error).toMatch(/Stripe profiles/);
    expect(result.success).toBeUndefined();
  });
});
