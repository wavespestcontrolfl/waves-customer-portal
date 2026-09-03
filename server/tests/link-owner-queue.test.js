/**
 * Backlink Manager v2 step 4 (PR 2b) — the Owner queue: Approve / Reject /
 * Watch / Acquire-anyway against the REAL nightly bridge over the shared
 * in-memory store (which emulates the approvals / waivers CHECKs).
 * Behavior pinned: approve freezes the §3.6b snapshot, attaches, releases
 * the park and the domain reads ready_to_acquire; an approval survives an
 * unchanged nightly run; stale hash / revision / level, already approved,
 * non-approvable levels and communication rows refuse and write nothing;
 * payment amounts + max_payable; one approval per account-wide group;
 * reject / watch are domain actions that end no row and move no placement,
 * the nightly leaves the domain alone, Reopen brings the same cards back;
 * acquire anyway waives only failing floors, never INVALID, lifts the DENY
 * and parks cards without a bell; a skipped / gated inline run still leaves
 * the nightly something to pick up.
 */
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn() }));
const { notifyAdmin } = require('../services/notification-service');
const { isEnabled } = require('../config/feature-gates');
const { WAVES_LOCATIONS } = require('../config/locations');
const P = require('../services/seo/link-authority-policy');
const R = require('../services/seo/link-registry');
const bridge = require('../services/seo/link-authority-bridge');
const Q = require('../services/seo/link-owner-queue');
const { makeDb, uid } = require('./helpers/link-authority-store');

const NOW = new Date('2026-09-03T07:35:00Z');
const LATER = new Date('2026-09-04T07:35:00Z');
const EARLIER = new Date('2026-09-01T00:00:00Z');
const HASH = 'b'.repeat(64);
const policyRow = (over = {}) => ({ id: 1, ...P.normalizePolicyRow(null), updated_at: EARLIER, ...over });
const domainRow = (over = {}) => ({ id: uid(), domain: 'example.org', source: 'competitor_gap', agent_state: 'qualified', score: 75, spam_score: 2, domain_rating: 40, organic_traffic: 1200, competitors_linked: 2, best_path_id: null, rejected_by: null, updated_at: EARLIER, ...over });
const pathRow = (domain, over = {}) => ({
  id: uid(), domain_id: domain.id, acquisition_type: 'self_service_free', link_type: 'directory', submission_url: 'https://example.org/add',
  estimated_cost_cents: null, renewal_cost_cents: null, renewal_period: null, currency: 'unknown', fee_scope: null, merchant_binding: null,
  account_required: false, email_verification: false, payment_required: false, legal_attestation: false, legal_terms_hash: null,
  agent_completable: true, terms_accepted_by_send: false, execution_after_send: true, baseline: false, confidence: '0.80',
  expected_rel: 'dofollow', revision: 1, revision_payment: 1, revision_communication: 1, revision_execution: 1,
  last_investigated_at: EARLIER, superseded_by: null, authority_last_decided: null, investigation: null, updated_at: EARLIER, ...over,
});
const paidPath = (domain, over = {}) => pathRow(domain, {
  acquisition_type: 'paid_listing', payment_required: true, estimated_cost_cents: 4500, currency: 'USD', fee_scope: 'per_location',
  merchant_binding: { checkout_origin: 'https://example.org', processor: { host: 'checkout.stripe.com', merchant_account_id: 'acct_1' } }, ...over,
});
const outreachPath = (domain, over = {}) => pathRow(domain, { acquisition_type: 'resource_outreach', link_type: 'resource', submission_url: null, ...over });

function scenario({ make = pathRow, domain: dOver = {}, path: pOver = {}, policy = {}, extra = {} } = {}) {
  const d = domainRow(dOver);
  const p = make(d, pOver);
  d.best_path_id = p.id;
  const db = makeDb({ seo_link_domains: [d], seo_link_acquisition_paths: [p], seo_link_policy: [policyRow(policy)], ...extra });
  return { db, d, p };
}
const nightly = (db, opts = {}) => bridge.runAuthorityBridge(db, { now: NOW, exclusive: (k, fn) => fn(), notify: opts.notify || jest.fn(), ...opts });
// the inline run the service performs — same real bridge, the lock replaced (the cron lock needs Postgres)
const inline = (db, opts) => bridge.runAuthorityBridge(db, { ...opts, exclusive: (k, fn) => fn() });
const placements = (db) => db._tables.seo_link_prospects;
const rows = (db) => db._tables.seo_link_placement_authorities;
const approvals = (db) => db._tables.seo_link_approvals;
const waivers = (db) => db._tables.seo_link_floor_waivers;
const domainState = (db) => db._tables.seo_link_domains[0].agent_state;
const ACTOR = 'Adam';

// park a fresh scenario: one nightly run ⇒ every owner-gated row parked
async function parked(opts) {
  const s = scenario(opts);
  await nightly(s.db);
  return s;
}
const openRows = (db, dimension) => rows(db).filter((r) => !r.ended_at && (!dimension || r.dimension === dimension));
const placementOf = (db, row) => placements(db).find((p) => p.id === row.prospect_id);
const storedPath = (db) => db._tables.seo_link_acquisition_paths[0];
const storedDomain = (db) => db._tables.seo_link_domains[0];
const N = WAVES_LOCATIONS.length; // a signup-lane path bridges one placement per GBP location
const LATER2 = new Date('2026-09-05T07:35:00Z');

beforeEach(() => { isEnabled.mockReturnValue(true); });

describe('listOwnerQueue', () => {
  test('one card per parked placement with its rows, approvability and the path facts', async () => {
    const { db, d } = await parked({ make: paidPath, path: { fee_scope: 'per_location' }, domain: { competitors_linked: 3 } });
    const { cards } = await Q.listOwnerQueue(db);
    expect(cards).toHaveLength(WAVES_LOCATIONS.length);
    const c = cards[0];
    expect(c.domain).toMatchObject({ id: d.id, domain: 'example.org', competitors_linked: 3, agent_state: 'qualified' });
    expect(c.path).toMatchObject({ on_best_path: true, acquisition_type: 'paid_listing', estimated_cost_cents: 4500, currency: 'USD', fee_scope: 'per_location' });
    // the recipient the payment approval will freeze is on the card
    expect(c.path.merchant_binding).toEqual({ checkout_origin: 'https://example.org', processor_host: 'checkout.stripe.com', merchant_account_id: 'acct_1', issuer_merchant_descriptor: null });
    expect(c.d30_confidence).toBeNull();
    expect(c.price_tolerance_cents).toBe(0);
    const byDim = Object.fromEntries(c.rows.map((r) => [r.dimension, r]));
    expect(byDim.execution).toMatchObject({ level: 'OWNER_FREE', action: 'acquire', approvable: true, why_not: null, shared_fee: null });
    expect(byDim.payment).toMatchObject({ level: 'OWNER_PAYMENT', action: 'purchase', approvable: true, shared_fee: null, quote_cents: 4500 });
    expect(c.decidable).toBe(true);
    // a sibling approved ⇒ the domain is lane-owned ⇒ the remaining cards say so instead of offering Reject / Watch
    await Q.approveRow(db, { authorityId: byDim.execution.id, actor: ACTOR, now: NOW, bridge: inline });
    await Q.approveRow(db, { authorityId: byDim.payment.id, actor: ACTOR, approvedAmountCents: 4500, now: NOW, bridge: inline });
    const after = await Q.listOwnerQueue(db);
    expect(after.cards).toHaveLength(N - 1);
    expect(after.cards.every((x) => x.domain.agent_state === 'ready_to_acquire' && x.decidable === false)).toBe(true);
  });

  test('a domain the owner rejected / is watching shows no cards; rows and placements are untouched', async () => {
    const { db, d } = await parked();
    expect((await Q.listOwnerQueue(db)).cards).toHaveLength(N);
    await Q.decideDomain(db, { domainId: d.id, decision: 'rejected', actor: ACTOR, now: NOW });
    expect((await Q.listOwnerQueue(db)).cards).toHaveLength(0);
    expect(placements(db).every((p) => p.status === 'awaiting_owner')).toBe(true);
    expect(openRows(db)).toHaveLength(N);
  });

  test('non-approvable rows carry the reason: communication (send click), human step, price entry, manual payment', async () => {
    const human = await parked({ path: { agent_completable: false } });
    expect((await Q.listOwnerQueue(human.db)).cards[0].rows[0]).toMatchObject({ level: 'OWNER_HUMAN_STEP', approvable: false, why_not: expect.stringMatching(/human performs/) });
    const price = await parked({ make: paidPath, path: { currency: 'unknown' } });
    const pay = (await Q.listOwnerQueue(price.db)).cards[0].rows.find((r) => r.dimension === 'payment');
    expect(pay).toMatchObject({ level: 'OWNER_INPUT_REQUIRED', approvable: false, why_not: expect.stringMatching(/price entry/) });
    const foreign = await parked({ make: paidPath, path: { currency: 'foreign' } });
    expect((await Q.listOwnerQueue(foreign.db)).cards[0].rows.find((r) => r.dimension === 'payment')).toMatchObject({ level: 'OWNER_MANUAL_PAYMENT', approvable: false });
    // an outreach conversation with a drafted pitch parks for the send — approved from the outreach queue, not here
    const d = domainRow(); const p = outreachPath(d); d.best_path_id = p.id;
    const db = makeDb({ seo_link_domains: [d], seo_link_acquisition_paths: [p], seo_link_policy: [policyRow()], seo_link_prospects: [{ id: uid(), domain_id: d.id, path_id: p.id, target_domain: 'example.org', target_page: '/', location_key: '-', status: 'prospect', outreach_status: 'drafted', link_type: 'resource', updated_at: EARLIER }] });
    await nightly(db);
    const comm = (await Q.listOwnerQueue(db)).cards[0].rows.find((r) => r.dimension === 'communication');
    expect(comm).toMatchObject({ level: 'OWNER_OUTREACH', action: 'outreach_send', approvable: false, why_not: expect.stringMatching(/outreach queue/) });
  });
});

  test('§3.3b cards the bridge never parks: the deferred payment at the publisher\'s checkout, a renewal on a live placement', async () => {
    // an outreach path with a USD fee: the nightly DEFERS OWNER_PAYMENT — no park, no card — until the placement reaches the checkout
    const s = await parked({ make: outreachPath, path: { payment_required: true, estimated_cost_cents: 20000, currency: 'USD', fee_scope: 'per_location', merchant_binding: { checkout_origin: 'https://example.org', processor: { host: 'h', merchant_account_id: 'm' } } } });
    const fee = openRows(s.db, 'payment')[0];
    expect(fee.level).toBe('OWNER_PAYMENT');
    const pl = placementOf(s.db, fee);
    expect(pl.status).toBe('prospect');
    expect((await Q.listOwnerQueue(s.db)).cards).toHaveLength(0);
    await expect(Q.approveRow(s.db, { authorityId: fee.id, actor: ACTOR, approvedAmountCents: 20000, now: NOW, bridge: inline })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/the placement is prospect — not awaiting your decision/) });
    expect(approvals(s.db)).toHaveLength(0);
    // the publisher exposed a checkout: the card is the payment's — the other rows on it are not decided here
    Object.assign(pl, { status: 'ready_for_payment', outreach_status: 'sent' });
    const [card] = (await Q.listOwnerQueue(s.db)).cards;
    expect(card.placement.status).toBe('ready_for_payment');
    expect(card.rows.find((r) => r.action === 'purchase')).toMatchObject({ approvable: true, quote_cents: 20000 });
    for (const r of card.rows.filter((r) => r.dimension !== 'payment')) expect(r.approvable).toBe(false);
    const r = await Q.approveRow(s.db, { authorityId: fee.id, actor: ACTOR, approvedAmountCents: 20000, now: NOW, bridge: inline });
    expect(r.approval).toMatchObject({ action: 'purchase', approved_amount_cents: 20000, instance_key: fee.instance_key });
    expect(rows(s.db).find((x) => x.id === fee.id).approval_id).toBe(r.approval.id);
    expect(placementOf(s.db, fee).status).toBe('ready_for_payment'); // the bridge moves nothing at the checkout

    // a renewal instance on a LIVE placement: the Judge owns the status; the card is the renewal's and nothing else's
    const live = await parked({ make: paidPath, path: { renewal_cost_cents: 3900, renewal_period: 'annual' } });
    const first = openRows(live.db, 'payment')[0];
    Object.assign(first, { satisfied_at: NOW, satisfied_reason: 'charged' });
    Object.assign(placementOf(live.db, first), { status: 'live', parked_from_status: null });
    storedDomain(live.db).agent_state = 'acquired';
    const mine = async () => (await Q.listOwnerQueue(live.db)).cards.filter((c) => c.placement.id === first.prospect_id); // the sibling locations stay parked cards
    expect(await mine()).toHaveLength(0); // nothing open the owner decides here ⇒ no card
    const renewalHash = P.decisionInputsHash('payment', { path: storedPath(live.db), domain: storedDomain(live.db), policy: P.normalizePolicyRow(null), score: storedDomain(live.db).score, instanceKey: '2027:1' });
    rows(live.db).push({ ...first, id: uid(), instance_kind: '2027', instance_key: '2027:1', decision_inputs_hash: renewalHash, satisfied_at: undefined, satisfied_reason: undefined, approval_id: undefined });
    const [card2] = await mine();
    expect(card2.placement.status).toBe('live');
    expect(card2.decidable).toBe(false);
    const renewal = card2.rows.find((r) => r.action === 'renewal');
    expect(renewal).toMatchObject({ approvable: true, quote_cents: 3900 });
    for (const r of card2.rows.filter((r) => r.action !== 'renewal')) expect(r.approvable).toBe(false);
    const r2 = await Q.approveRow(live.db, { authorityId: renewal.id, actor: ACTOR, approvedAmountCents: 3900, now: NOW, bridge: inline });
    expect(r2.approval).toMatchObject({ action: 'renewal', action_hash: '2027', approved_amount_cents: 3900 });
    expect(placementOf(live.db, first).status).toBe('live');
  });

  test('a consumed approval on a still-unsatisfied row is spent, not live authority: the card asks again and a fresh approval attaches', async () => {
    const { db } = await parked({ make: paidPath });
    const fee = openRows(db, 'payment')[0];
    const first = await Q.approveRow(db, { authorityId: fee.id, actor: ACTOR, approvedAmountCents: 4500, now: NOW, bridge: inline });
    // the runner leased it and reported a failed terminal outcome: the approval is consumed, the instance awaits rotation
    approvals(db).find((a) => a.id === first.approval.id).consumed_at = LATER;
    Object.assign(placementOf(db, fee), { status: 'awaiting_owner', parked_from_status: 'prospect' });
    const card = (await Q.listOwnerQueue(db)).cards.find((c) => c.placement.id === fee.prospect_id);
    const row = card.rows.find((r) => r.id === fee.id);
    expect(row).toMatchObject({ approved: false, approvable: true });
    const again = await Q.approveRow(db, { authorityId: fee.id, actor: ACTOR, approvedAmountCents: 4500, now: LATER, bridge: inline });
    expect(again.approval.id).not.toBe(first.approval.id);
    expect(rows(db).find((x) => x.id === fee.id).approval_id).toBe(again.approval.id);
    // …while on a SATISFIED row the consumed approval is the durable prerequisite it reads as
    Object.assign(rows(db).find((x) => x.id === fee.id), { satisfied_at: LATER, satisfied_reason: 'charged' });
    approvals(db).find((a) => a.id === again.approval.id).consumed_at = LATER;
    Object.assign(placementOf(db, fee), { status: 'awaiting_owner', parked_from_status: 'prospect' });
    const settled = (await Q.listOwnerQueue(db)).cards.find((c) => c.placement.id === fee.prospect_id);
    expect(settled.rows.find((r) => r.id === fee.id)).toMatchObject({ approved: true, approvable: false });
  });

describe('approveRow', () => {
  test('freezes the §3.6b snapshot, attaches, releases the park and the domain reads ready_to_acquire', async () => {
    const { db, d, p } = await parked();
    const row = openRows(db, 'execution')[0];
    expect(placementOf(db, row).status).toBe('awaiting_owner');
    const r = await Q.approveRow(db, { authorityId: row.id, actor: ACTOR, note: 'go', now: NOW, bridge: inline });
    expect(r.attached).toEqual([row.id]);
    expect(r.bridge).toMatchObject({ gated: false, released: 1, aggregateChanges: 1 });
    const a = approvals(db)[0];
    expect(a).toMatchObject({
      prospect_id: row.prospect_id, path_id: p.id, path_revision: 1, decision: 'approved', authority: 'OWNER_FREE', dimension: 'execution', action: 'acquire',
      instance_key: '-:1', money_action: false, approved_amount_cents: null, max_payable_cents: null, action_hash: null, approved_by: ACTOR, approved_at: NOW,
    });
    expect(a.decision_inputs_hash).toBe(row.decision_inputs_hash);
    expect(a.terms_snapshot).toMatchObject({ dimension: 'execution', instance_key: '-:1', acquisition_type: 'self_service_free', submission_url: 'https://example.org/add', note: 'go', floors: expect.any(Object) });
    expect(Object.keys(a.terms_snapshot).sort()).toEqual(['dimension', 'instance_key', ...P.DIMENSION_INPUT_FIELDS.execution, 'floors', 'note'].sort());
    expect(rows(db).find((x) => x.id === row.id).approval_id).toBe(a.id);
    expect(placementOf(db, row).status).toBe('prospect');
    // the other locations stay parked on their own cards; one authorized pending placement is enough for the domain
    expect(placements(db).filter((x) => x.status === 'awaiting_owner')).toHaveLength(N - 1);
    expect(domainState(db)).toBe('ready_to_acquire');
    expect(d.id).toBe(storedDomain(db).id);
  });

  test('the approval survives an unchanged nightly run and the domain stays ready_to_acquire', async () => {
    const { db } = await parked();
    const row = openRows(db)[0];
    await Q.approveRow(db, { authorityId: row.id, actor: ACTOR, now: NOW, bridge: inline });
    const r = await nightly(db, { now: LATER });
    expect(r.invalidatedApprovals).toBe(0);
    expect(approvals(db)[0].invalidated_at).toBeUndefined();
    expect(placementOf(db, row).status).toBe('prospect');
    expect(domainState(db)).toBe('ready_to_acquire');
    expect(rows(db).find((x) => x.id === row.id).approval_id).toBe(approvals(db)[0].id);
    // and a further unchanged run is a no-op for the domain
    expect(await nightly(db, { now: LATER2 })).toMatchObject({ redecided: 0, released: 0, invalidatedApprovals: 0 });
  });

  test('a changed input since the card refuses 409 and writes nothing (hash, revision, level)', async () => {
    const { db } = await parked();
    const p = storedPath(db);
    const row = openRows(db)[0];
    p.submission_url = 'https://example.org/add-v2';
    await expect(Q.approveRow(db, { authorityId: row.id, actor: ACTOR, now: NOW, bridge: inline })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/inputs changed/) });
    p.submission_url = 'https://example.org/add';
    p.revision_execution = 2;
    await expect(Q.approveRow(db, { authorityId: row.id, actor: ACTOR, now: NOW, bridge: inline })).rejects.toMatchObject({ status: 409 });
    p.revision_execution = 1;
    // the policy loosened: the row would now be AUTO_FREE, so the OWNER_FREE card is stale
    db._tables.seo_link_policy[0].auto_free_acquisition = true;
    await expect(Q.approveRow(db, { authorityId: row.id, actor: ACTOR, now: NOW, bridge: inline })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/now yields AUTO_FREE/) });
    expect(approvals(db)).toHaveLength(0);
    expect(rows(db).every((x) => x.approval_id === undefined)).toBe(true);
    expect(placements(db).every((x) => x.status === 'awaiting_owner')).toBe(true);
  });

  test('already approved, communication, human step, price entry, manual payment and a superseded path all refuse', async () => {
    const { db } = await parked();
    const row = openRows(db)[0];
    await Q.approveRow(db, { authorityId: row.id, actor: ACTOR, now: NOW, bridge: inline });
    // released by the approval ⇒ the card is gone (stale-card check); an un-released approved row reads "approved" (see the account-wide test)
    await expect(Q.approveRow(db, { authorityId: row.id, actor: ACTOR, now: NOW, bridge: inline })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/no longer awaiting/) });
    expect(approvals(db)).toHaveLength(1);
    const human = await parked({ path: { agent_completable: false } });
    await expect(Q.approveRow(human.db, { authorityId: openRows(human.db)[0].id, actor: ACTOR, now: NOW, bridge: inline })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/human/) });
    const price = await parked({ make: paidPath, path: { currency: 'unknown' } });
    await expect(Q.approveRow(price.db, { authorityId: openRows(price.db, 'payment')[0].id, actor: ACTOR, now: NOW, bridge: inline })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/price entry/) });
    const foreign = await parked({ make: paidPath, path: { currency: 'foreign' } });
    await expect(Q.approveRow(foreign.db, { authorityId: openRows(foreign.db, 'payment')[0].id, actor: ACTOR, now: NOW, bridge: inline })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/outside the system/) });
    const d = domainRow(); const p = outreachPath(d); d.best_path_id = p.id;
    const odb = makeDb({ seo_link_domains: [d], seo_link_acquisition_paths: [p], seo_link_policy: [policyRow()], seo_link_prospects: [{ id: uid(), domain_id: d.id, path_id: p.id, target_domain: 'example.org', target_page: '/', location_key: '-', status: 'prospect', outreach_status: 'drafted', link_type: 'resource', updated_at: EARLIER }] });
    await nightly(odb);
    await expect(Q.approveRow(odb, { authorityId: openRows(odb, 'communication')[0].id, actor: ACTOR, now: NOW, bridge: inline })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/outreach queue/) });
    const sup = await parked();
    storedPath(sup.db).superseded_by = uid();
    await expect(Q.approveRow(sup.db, { authorityId: openRows(sup.db)[0].id, actor: ACTOR, now: NOW, bridge: inline })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/superseded/) });
    await expect(Q.approveRow(sup.db, { authorityId: openRows(sup.db)[0].id, actor: null, now: NOW, bridge: inline })).rejects.toMatchObject({ status: 400 });
    await expect(Q.approveRow(sup.db, { authorityId: uid(), actor: ACTOR, now: NOW, bridge: inline })).rejects.toMatchObject({ status: 404 });
    for (const s of [human, price, foreign, sup]) expect(approvals(s.db)).toHaveLength(0);
    expect(approvals(odb)).toHaveLength(0);
  });

  test('a stale card refuses: the domain was rejected / watched or the placement moved since the page loaded', async () => {
    const { db, d } = await parked();
    const row = openRows(db)[0];
    await Q.decideDomain(db, { domainId: d.id, decision: 'rejected', actor: ACTOR, now: NOW });
    await expect(Q.approveRow(db, { authorityId: row.id, actor: ACTOR, now: LATER, bridge: inline })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/left the queue/) });
    // a worker claim / a Judge move on the placement itself
    const s2 = await parked();
    const row2 = openRows(s2.db)[0];
    placementOf(s2.db, row2).claimed_at = NOW;
    await expect(Q.approveRow(s2.db, { authorityId: row2.id, actor: ACTOR, now: LATER, bridge: inline })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/no longer awaiting/) });
    placementOf(s2.db, row2).claimed_at = null;
    placementOf(s2.db, row2).status = 'prospect';
    await expect(Q.approveRow(s2.db, { authorityId: row2.id, actor: ACTOR, now: LATER, bridge: inline })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/no longer awaiting/) });
    expect(approvals(db)).toHaveLength(N); // the reject audit rows only
    expect(approvals(s2.db)).toHaveLength(0);
  });

  test('payment: the amount is the owner\'s statement (never defaulted), max_payable = amount + tolerance, bad amounts refuse', async () => {
    const { db } = await parked({ make: paidPath, policy: { owner_price_tolerance_cents: 500 } });
    const pay = openRows(db, 'payment')[0];
    await expect(Q.approveRow(db, { authorityId: pay.id, actor: ACTOR, approvedAmountCents: 0, now: NOW, bridge: inline })).rejects.toMatchObject({ status: 400 });
    await expect(Q.approveRow(db, { authorityId: pay.id, actor: ACTOR, approvedAmountCents: 12.5, now: NOW, bridge: inline })).rejects.toMatchObject({ status: 400 });
    await expect(Q.approveRow(db, { authorityId: pay.id, actor: ACTOR, approvedAmountCents: 'abc', now: NOW, bridge: inline })).rejects.toMatchObject({ status: 400 });
    // omitted / blank ⇒ 400, never the quote
    await expect(Q.approveRow(db, { authorityId: pay.id, actor: ACTOR, now: NOW, bridge: inline })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/required/) });
    await expect(Q.approveRow(db, { authorityId: pay.id, actor: ACTOR, approvedAmountCents: '', now: NOW, bridge: inline })).rejects.toMatchObject({ status: 400 });
    expect(approvals(db)).toHaveLength(0);
    const r = await Q.approveRow(db, { authorityId: pay.id, actor: ACTOR, approvedAmountCents: 4500, now: NOW, bridge: inline });
    expect(r.approval).toMatchObject({ dimension: 'payment', action: 'purchase', money_action: true, approved_amount_cents: 4500, max_payable_cents: 5000, authority: 'OWNER_PAYMENT' });
    expect(r.approval.terms_snapshot).toMatchObject({ estimated_cost_cents: 4500, currency: 'USD', fee_scope: 'per_location', merchant_binding: expect.objectContaining({ checkout_origin: 'https://example.org' }) });
    // the execution row is still owner-gated ⇒ the placement stays parked, the domain stays qualified
    expect(placements(db).find((p) => p.id === r.approval.prospect_id).status).toBe('awaiting_owner');
    expect(domainState(db)).toBe('qualified');
    // an explicit higher amount is what the owner approved
    const other = openRows(db, 'payment').find((x) => !x.approval_id);
    const r2 = await Q.approveRow(db, { authorityId: other.id, actor: ACTOR, approvedAmountCents: 4800, now: NOW, bridge: inline });
    expect(r2.approval).toMatchObject({ approved_amount_cents: 4800, max_payable_cents: 5300 });
  });

  test('account-wide fee: one approval, its prospect_id the group anchor, attached to every sibling payment row', async () => {
    const { db } = await parked({ make: paidPath, path: { fee_scope: 'account_wide' } });
    const groupId = placements(db)[0].payment_group_id;
    expect(placements(db).every((p) => p.payment_group_id === groupId)).toBe(true);
    const { cards } = await Q.listOwnerQueue(db);
    const primaries = cards.filter((c) => c.rows.some((r) => r.dimension === 'payment' && r.approvable));
    expect(primaries).toHaveLength(1);
    expect(cards.find((c) => c.placement.id !== primaries[0].placement.id).rows.find((r) => r.dimension === 'payment')).toMatchObject({ approvable: false, why_not: expect.stringMatching(/one approval covers/), shared_fee: { group_id: groupId, placements: WAVES_LOCATIONS.length } });
    const pay = openRows(db, 'payment').find((r) => r.prospect_id === primaries[0].placement.id);
    const r = await Q.approveRow(db, { authorityId: pay.id, actor: ACTOR, approvedAmountCents: 4500, now: NOW, bridge: inline });
    expect(approvals(db)).toHaveLength(1);
    expect(r.approval.prospect_id).toBe(groupId);
    expect(r.attached).toHaveLength(WAVES_LOCATIONS.length);
    expect(openRows(db, 'payment').every((x) => x.approval_id === r.approval.id)).toBe(true);
    // approving from a sibling card after the fact is refused as already approved
    const sibling = openRows(db, 'payment').find((x) => x.prospect_id !== pay.prospect_id);
    await expect(Q.approveRow(db, { authorityId: sibling.id, actor: ACTOR, now: NOW, bridge: inline })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/approved/) });
  });

  test('account-wide fee: a stale-path sibling that sorts first never carries the button — the primary is a fresh best-path card', async () => {
    const { db } = await parked({ make: paidPath, path: { fee_scope: 'account_wide' } });
    const groupId = placements(db)[0].payment_group_id;
    const anyPay = openRows(db, 'payment')[0];
    // a parked sibling still bound to a superseded path whose id sorts before every current one
    const stalePath = uid();
    db._tables.seo_link_acquisition_paths.push({ ...storedPath(db), id: stalePath, superseded_by: storedPath(db).id });
    const staleP = { id: '00000000-0000-0000-0000-000000000000', domain_id: db._tables.seo_link_domains[0].id, path_id: stalePath, target_domain: 'example.org', target_page: '/', location_key: 'stale', status: 'awaiting_owner', parked_from_status: 'prospect', payment_group_id: groupId, link_type: 'directory', updated_at: NOW };
    placements(db).push(staleP);
    rows(db).push({ ...anyPay, id: uid(), prospect_id: staleP.id, path_id: stalePath, approval_id: undefined });
    const { cards } = await Q.listOwnerQueue(db);
    const primaries = cards.filter((c) => c.rows.some((r) => r.dimension === 'payment' && r.approvable));
    expect(primaries).toHaveLength(1);
    expect(primaries[0].placement.id).not.toBe(staleP.id);
    expect(primaries[0].path.on_best_path).toBe(true);
    const stale = cards.find((c) => c.placement.id === staleP.id).rows.find((r) => r.dimension === 'payment');
    expect(stale).toMatchObject({ approvable: false, why_not: expect.stringMatching(/not on the domain/) });
    // the card says what ONE approval covers — the siblings the click attaches to, not the raw group size
    expect(primaries[0].rows.find((r) => r.dimension === 'payment').shared_fee).toEqual({ group_id: groupId, placements: N });
    expect(cards.find((c) => c.placement.id !== staleP.id && c.placement.id !== primaries[0].placement.id).rows.find((r) => r.dimension === 'payment').why_not).toMatch(new RegExp(`covers the ${N} locations`));
    // the approval from the fresh primary attaches to the fresh siblings and skips the stale one
    const pay = openRows(db, 'payment').find((r) => r.prospect_id === primaries[0].placement.id);
    const r = await Q.approveRow(db, { authorityId: pay.id, actor: ACTOR, approvedAmountCents: 4500, now: LATER, bridge: inline });
    expect(r.attached).toHaveLength(N);
    expect(rows(db).find((x) => x.prospect_id === staleP.id).approval_id).toBeUndefined();
  });

  test('account-wide fee: a stale-path or in-flight sibling with an equal hash never inherits the approval', async () => {
    const { db, p } = await parked({ make: paidPath, path: { fee_scope: 'account_wide' } });
    const groupId = placements(db)[0].payment_group_id;
    const primaryId = (await Q.listOwnerQueue(db)).cards.find((c) => c.rows.some((r) => r.dimension === 'payment' && r.approvable)).placement.id;
    const pay = openRows(db, 'payment').find((r) => r.prospect_id === primaryId);
    // a sibling still bound to a superseded path, and one a worker has leased — both carry the same hash / level / key
    const stalePath = uid();
    const staleP = { id: uid(), domain_id: db._tables.seo_link_domains[0].id, path_id: stalePath, target_domain: 'example.org', target_page: '/', location_key: 'stale', status: 'awaiting_owner', parked_from_status: 'prospect', payment_group_id: groupId, link_type: 'directory', updated_at: NOW };
    const leasedP = placements(db).find((x) => x.id !== primaryId);
    leasedP.claimed_at = NOW;
    placements(db).push(staleP);
    rows(db).push({ ...pay, id: uid(), prospect_id: staleP.id, path_id: stalePath, approval_id: undefined });
    const r = await Q.approveRow(db, { authorityId: pay.id, actor: ACTOR, approvedAmountCents: 4500, now: LATER, bridge: inline });
    expect(r.attached).toHaveLength(N - 1); // primary + the unleased in-shape siblings; not the leased one, not the stale-path one
    const staleRow = rows(db).find((x) => x.prospect_id === staleP.id);
    const leasedRow = rows(db).find((x) => x.prospect_id === leasedP.id && x.dimension === 'payment');
    expect(staleRow.approval_id).toBeUndefined();
    expect(leasedRow.approval_id).toBeUndefined();
    expect(p.id).toBe(pay.path_id);
  });

  test('a renewal row quotes the renewal price, never the initial fee; no renewal price ⇒ no quote (fail closed)', async () => {
    const { db } = await parked({ make: paidPath, path: { renewal_cost_cents: 3900, renewal_period: 'annual' } });
    // a renewal instance beside the settled initial purchase (kept satisfied so the card is the renewal's)
    const first = openRows(db, 'payment')[0];
    Object.assign(first, { satisfied_at: NOW, satisfied_reason: 'charged' });
    // the hash binds the instance key (§3.6b): the renewal row carries its OWN hash
    const renewalHash = P.decisionInputsHash('payment', { path: storedPath(db), domain: storedDomain(db), policy: P.normalizePolicyRow(null), score: storedDomain(db).score, instanceKey: '2027:1' });
    rows(db).push({ ...first, id: uid(), instance_kind: '2027', instance_key: '2027:1', decision_inputs_hash: renewalHash, satisfied_at: undefined, satisfied_reason: undefined, approval_id: undefined });
    const card = (await Q.listOwnerQueue(db)).cards.find((x) => x.placement.id === first.prospect_id);
    const renewal = card.rows.find((r) => r.action === 'renewal');
    expect(renewal).toMatchObject({ instance_key: '2027:1', quote_cents: 3900, approvable: true });
    expect(card.rows.find((r) => r.action === 'purchase').quote_cents).toBe(4500);
    const r = await Q.approveRow(db, { authorityId: renewal.id, actor: ACTOR, approvedAmountCents: 3900, now: NOW, bridge: inline });
    expect(r.approval).toMatchObject({ action: 'renewal', action_hash: '2027', approved_amount_cents: 3900 });
    // no renewal price on the path ⇒ the renewal row carries no quote
    const none = await parked({ make: paidPath, path: { renewal_cost_cents: null, renewal_period: 'annual' } });
    const f2 = openRows(none.db, 'payment')[0];
    Object.assign(f2, { satisfied_at: NOW, satisfied_reason: 'charged' });
    rows(none.db).push({ ...f2, id: uid(), instance_kind: '2027', instance_key: '2027:1', satisfied_at: undefined, satisfied_reason: undefined, approval_id: undefined });
    const card2 = (await Q.listOwnerQueue(none.db)).cards.find((x) => x.placement.id === f2.prospect_id);
    const r2 = card2.rows.find((r) => r.action === 'renewal');
    // …and the row is not approvable at all — a typed amount cannot stand in for a quote the investigator never priced
    expect(r2).toMatchObject({ quote_cents: null, approvable: false, why_not: expect.stringMatching(/renewal price not verified/) });
    await expect(Q.approveRow(none.db, { authorityId: r2.id, actor: ACTOR, approvedAmountCents: 3900, now: NOW, bridge: inline })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/renewal price not verified/) });
    expect(approvals(none.db)).toHaveLength(0);
  });

  test('a payment approval on an attested path freezes the agreement url too (never only accept_terms)', async () => {
    const { db } = await parked({ make: paidPath, path: { legal_attestation: true, legal_terms_hash: HASH, investigation: JSON.stringify({ legal_terms_url: 'https://example.org/terms' }) } });
    const pay = openRows(db, 'payment')[0];
    const r = await Q.approveRow(db, { authorityId: pay.id, actor: ACTOR, approvedAmountCents: 4500, now: NOW, bridge: inline });
    expect(r.approval.terms_snapshot).toMatchObject({ legal_attestation: true, legal_terms_hash: HASH, legal_terms_url: 'https://example.org/terms', merchant_binding: expect.objectContaining({ checkout_origin: 'https://example.org' }) });
    // and the audit rows of a Reject carry it as well
    const { db: db2, d: d2 } = await parked({ make: paidPath, path: { legal_attestation: true, legal_terms_hash: HASH, investigation: JSON.stringify({ legal_terms_url: 'https://example.org/terms' }) } });
    await Q.decideDomain(db2, { domainId: d2.id, decision: 'rejected', actor: ACTOR, now: NOW });
    expect(approvals(db2).every((a) => a.terms_snapshot.legal_terms_url === 'https://example.org/terms')).toBe(true);
  });

  test('an attested path without a viewable agreement url is not approvable (terms AND the payment beside it)', async () => {
    const { db } = await parked({ make: paidPath, path: { legal_attestation: true, legal_terms_hash: HASH, investigation: JSON.stringify({ reasons: 'terms fetched, url lost' }) } });
    const card = (await Q.listOwnerQueue(db)).cards[0];
    for (const r of card.rows) expect(r).toMatchObject({ approvable: false, why_not: expect.stringMatching(/not viewable/) });
    for (const r of openRows(db).filter((x) => x.prospect_id === card.placement.id)) {
      await expect(Q.approveRow(db, { authorityId: r.id, actor: ACTOR, approvedAmountCents: 4500, now: NOW, bridge: inline })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/not viewable/) });
    }
    expect(approvals(db)).toHaveLength(0);
  });

  test('an approved row whose inputs moved since is shown as stale, not as live authority; bad amount types refuse', async () => {
    const { db } = await parked({ make: paidPath });
    const card = (await Q.listOwnerQueue(db)).cards[0];
    const pay = card.rows.find((r) => r.dimension === 'payment');
    for (const bad of [true, [4500], '4500.00', ' 4500', { cents: 4500 }]) {
      await expect(Q.approveRow(db, { authorityId: pay.id, actor: ACTOR, approvedAmountCents: bad, now: NOW, bridge: inline })).rejects.toMatchObject({ status: 400 });
    }
    expect(approvals(db)).toHaveLength(0);
    await Q.approveRow(db, { authorityId: pay.id, actor: ACTOR, approvedAmountCents: '4500', now: NOW, bridge: inline }); // canonical string is fine
    let after = (await Q.listOwnerQueue(db)).cards.find((c) => c.placement.id === card.placement.id).rows.find((r) => r.dimension === 'payment');
    expect(after).toMatchObject({ approved: true, approval_stale: null, why_not: 'approved' });
    storedPath(db).estimated_cost_cents = 4900; // the quote moved after the approval, before the bridge ran
    after = (await Q.listOwnerQueue(db)).cards.find((c) => c.placement.id === card.placement.id).rows.find((r) => r.dimension === 'payment');
    expect(after).toMatchObject({ approved: true, approval_stale: expect.stringMatching(/inputs changed/) });
  });

  test('a card whose stamp went stale shows why instead of a button (the click\'s own test, applied at listing)', async () => {
    const { db } = await parked();
    expect((await Q.listOwnerQueue(db)).cards[0].rows[0]).toMatchObject({ approvable: true, why_not: null });
    db._tables.seo_link_policy[0].auto_free_acquisition = true; // the row would now be AUTO_FREE
    expect((await Q.listOwnerQueue(db)).cards[0].rows[0]).toMatchObject({ approvable: false, why_not: expect.stringMatching(/policy now yields AUTO_FREE/) });
    db._tables.seo_link_policy[0].auto_free_acquisition = false;
    storedPath(db).submission_url = 'https://example.org/add-v2'; // an execution input moved
    expect((await Q.listOwnerQueue(db)).cards[0].rows[0]).toMatchObject({ approvable: false, why_not: expect.stringMatching(/inputs changed/) });
    storedPath(db).submission_url = 'https://example.org/add';
    expect((await Q.listOwnerQueue(db)).cards[0].rows[0].approvable).toBe(true);
  });

  test('account-wide fee: a sibling row stamped at another path revision does not inherit the approval', async () => {
    const { db } = await parked({ make: paidPath, path: { fee_scope: 'account_wide' } });
    const primaryId = (await Q.listOwnerQueue(db)).cards.find((c) => c.rows.some((r) => r.dimension === 'payment' && r.approvable)).placement.id;
    const pay = openRows(db, 'payment').find((r) => r.prospect_id === primaryId);
    const older = openRows(db, 'payment').find((r) => r.prospect_id !== primaryId);
    older.path_revision = 0; // an older stamp whose hash happens to equal the current one
    const r = await Q.approveRow(db, { authorityId: pay.id, actor: ACTOR, approvedAmountCents: 4500, now: NOW, bridge: inline });
    expect(r.attached).toHaveLength(N - 1);
    expect(rows(db).find((x) => x.id === older.id).approval_id).toBeUndefined();
  });

  test('accept_terms binds the agreement hash; the row and its terms url land in the snapshot', async () => {
    const { db } = await parked({ path: { legal_attestation: true, legal_terms_hash: HASH, investigation: JSON.stringify({ legal_terms_url: 'https://example.org/terms' }) } });
    const terms = openRows(db, 'execution').find((r) => r.instance_kind === 'terms');
    expect(terms.level).toBe('OWNER_LEGAL');
    const r = await Q.approveRow(db, { authorityId: terms.id, actor: ACTOR, now: NOW, bridge: inline });
    expect(r.approval).toMatchObject({ action: 'accept_terms', action_hash: HASH, instance_key: 'terms:1', authority: 'OWNER_LEGAL' });
    expect(r.approval.terms_snapshot).toMatchObject({ legal_terms_hash: HASH, legal_terms_url: 'https://example.org/terms' });
  });

  test('inline run skipped (lock held) or gated: the approval is recorded, the placement is bumped, the next nightly releases it', async () => {
    const { db } = await parked();
    const row = openRows(db)[0];
    expect(placementOf(db, row).updated_at).toEqual(NOW);
    const held = (d, opts) => bridge.runAuthorityBridge(d, { ...opts, exclusive: async () => ({ skipped: 'lease_held' }) });
    const r = await Q.approveRow(db, { authorityId: row.id, actor: ACTOR, now: LATER, bridge: held });
    expect(r.bridge.skipped).toBe('lease_held');
    expect(approvals(db)).toHaveLength(1);
    expect(placementOf(db, row).status).toBe('awaiting_owner');
    expect(placementOf(db, row).updated_at).toEqual(LATER);
    const n = await nightly(db, { now: LATER2 });
    expect(n).toMatchObject({ selected: 1, released: 1 });
    expect(domainState(db)).toBe('ready_to_acquire');
    // the inline run THROWS (a DB blip after commit): the approval is still reported, the run reads skipped: failed
    const boom = await parked();
    const brow = openRows(boom.db)[0];
    const rb = await Q.approveRow(boom.db, { authorityId: brow.id, actor: ACTOR, now: LATER, bridge: async () => { throw new Error('connection reset'); } });
    expect(rb.bridge).toMatchObject({ skipped: 'failed', error: 'connection reset' });
    expect(approvals(boom.db)).toHaveLength(1);
    await nightly(boom.db, { now: LATER2 });
    expect(domainState(boom.db)).toBe('ready_to_acquire');
    // gate off: selection only, the approval still lands
    const g = await parked();
    isEnabled.mockReturnValue(false);
    const grow = openRows(g.db)[0];
    const rg = await Q.approveRow(g.db, { authorityId: grow.id, actor: ACTOR, now: LATER, bridge: inline });
    expect(rg.bridge).toMatchObject({ gated: true, selected: 1 });
    expect(approvals(g.db)).toHaveLength(1);
    expect(placementOf(g.db, grow).status).toBe('awaiting_owner');
    isEnabled.mockReturnValue(true);
    await nightly(g.db, { now: LATER2 });
    expect(domainState(g.db)).toBe('ready_to_acquire');
  });
});

describe('decideDomain (Reject / Watch)', () => {
  test('reject: audit rows for approvable rows only, domain rejected by the owner, nothing ended or moved, nightly leaves it alone, Reopen brings the cards back', async () => {
    const { db, d } = await parked({ make: paidPath, path: { currency: 'unknown' } }); // payment = OWNER_INPUT_REQUIRED (not auditable), execution = OWNER_FREE
    const before = rows(db).map((r) => ({ ...r }));
    const r = await Q.decideDomain(db, { domainId: d.id, decision: 'rejected', actor: ACTOR, note: 'spammy', now: NOW });
    expect(r).toMatchObject({ agent_state: 'rejected', audited: WAVES_LOCATIONS.length, placements: WAVES_LOCATIONS.length });
    expect(approvals(db)).toHaveLength(WAVES_LOCATIONS.length);
    expect(approvals(db).every((a) => a.decision === 'rejected' && a.authority === 'OWNER_FREE' && a.approved_amount_cents === null && a.terms_snapshot.note === 'spammy')).toBe(true);
    expect(db._tables.seo_link_domains[0]).toMatchObject({ agent_state: 'rejected', rejected_by: 'owner' });
    expect(rows(db).map((x) => ({ ...x, updated_at: undefined })).every((x, i) => x.ended_at === before[i].ended_at && x.approval_id === before[i].approval_id)).toBe(true);
    expect(placements(db).every((p) => p.status === 'awaiting_owner')).toBe(true);
    expect((await Q.listOwnerQueue(db)).cards).toHaveLength(0);
    const n = await nightly(db, { now: LATER });
    expect(n.selected).toBe(0);
    expect(domainState(db)).toBe('rejected');
    // the registry Reopen (the investigator later re-qualifies) — same rows, cards back
    storedDomain(db).agent_state = 'qualified';
    storedDomain(db).rejected_by = null;
    await nightly(db, { now: LATER });
    expect((await Q.listOwnerQueue(db)).cards).toHaveLength(WAVES_LOCATIONS.length);
    expect(rows(db).filter((x) => !x.ended_at)).toHaveLength(before.length);
  });

  test('a rejection audited after the inputs moved stamps hash, revision and snapshot from one live context and keeps the card\'s stamp inside', async () => {
    const { db, d } = await parked();
    const before = openRows(db)[0];
    storedPath(db).revision_execution = Number(storedPath(db).revision_execution) + 1;
    storedPath(db).confidence = '0.90';
    await Q.decideDomain(db, { domainId: d.id, decision: 'rejected', actor: ACTOR, now: LATER });
    const a = approvals(db).find((x) => x.prospect_id === before.prospect_id);
    const live = P.decisionInputsHash('execution', { path: storedPath(db), domain: storedDomain(db), policy: P.normalizePolicyRow(null), score: storedDomain(db).score, instanceKey: before.instance_key });
    expect(a).toMatchObject({ decision: 'rejected', authority: before.level, decision_inputs_hash: live, path_revision: Number(before.path_revision) + 1 });
    expect(a.terms_snapshot).toMatchObject({ floors: expect.objectContaining({ confidence: 0.9 }), card: { decision_inputs_hash: before.decision_inputs_hash, path_revision: before.path_revision } });
    expect(a.terms_snapshot.card.decision_inputs_hash).not.toBe(live);
    // unmoved inputs: the stamps equal the card's and no card stamp is repeated
    const { db: db2, d: d2 } = await parked();
    await Q.decideDomain(db2, { domainId: d2.id, decision: 'rejected', actor: ACTOR, now: NOW });
    expect(approvals(db2)[0]).toMatchObject({ decision_inputs_hash: openRows(db2)[0].decision_inputs_hash, path_revision: openRows(db2)[0].path_revision });
    expect(approvals(db2)[0].terms_snapshot.card).toBeUndefined();
  });

  test('reject after an approval whose bridge run was gated: the approval is invalidated and audited, and a Reopen brings the card back UNAPPROVED', async () => {
    const { db, d } = await parked();
    const gated = async () => ({ gated: true, skipped: 'gated', selected: 0, decided: 0, parked: 0, released: 0, aggregateChanges: 0, errors: [] });
    const row = openRows(db)[0];
    const a = await Q.approveRow(db, { authorityId: row.id, actor: ACTOR, now: NOW, bridge: gated });
    expect(domainState(db)).toBe('qualified'); // the gated run moved nothing — the card still offers Reject / Watch
    const r = await Q.decideDomain(db, { domainId: d.id, decision: 'rejected', actor: ACTOR, now: LATER });
    expect(r).toMatchObject({ agent_state: 'rejected', invalidated: 1, audited: N });
    expect(approvals(db).find((x) => x.id === a.approval.id)).toMatchObject({ invalidated_at: LATER, invalidated_reason: expect.stringMatching(/owner rejected/) });
    expect(approvals(db).filter((x) => x.decision === 'rejected' && x.prospect_id === row.prospect_id)).toHaveLength(1);
    // Reopen: the same rows come back as cards, the row no longer reads as approved and the bridge releases nothing
    storedDomain(db).agent_state = 'qualified';
    storedDomain(db).rejected_by = null;
    const n = await nightly(db, { now: LATER2 });
    expect(n.released).toBe(0);
    expect(placements(db).every((p) => p.status === 'awaiting_owner')).toBe(true);
    const card = (await Q.listOwnerQueue(db)).cards.find((c) => c.placement.id === row.prospect_id);
    expect(card.rows.find((x) => x.id === row.id)).toMatchObject({ approved: false, approvable: true });
  });

  test('an orphaned row (path deleted) never blocks the decision: its approval is invalidated, no audit row is written for it', async () => {
    const { db, d } = await parked();
    const gated = async () => ({ gated: true, skipped: 'gated', selected: 0, decided: 0, parked: 0, released: 0, aggregateChanges: 0, errors: [] });
    const orphan = openRows(db)[0];
    const a = await Q.approveRow(db, { authorityId: orphan.id, actor: ACTOR, now: NOW, bridge: gated });
    orphan.path_id = null; // ON DELETE SET NULL
    const r = await Q.decideDomain(db, { domainId: d.id, decision: 'rejected', actor: ACTOR, now: LATER });
    expect(r).toMatchObject({ agent_state: 'rejected', audited: N - 1, invalidated: 1 });
    expect(approvals(db).find((x) => x.id === a.approval.id).invalidated_at).toBe(LATER);
    expect(approvals(db).filter((x) => x.decision === 'rejected').every((x) => x.path_id)).toBe(true);
  });

  test('watch: watching + a 30-day recheck, audit rows decision=watch', async () => {
    const { db, d } = await parked();
    const r = await Q.decideDomain(db, { domainId: d.id, decision: 'watch', actor: ACTOR, now: NOW });
    expect(r.agent_state).toBe('watching');
    expect(db._tables.seo_link_domains[0]).toMatchObject({ agent_state: 'watching', rejected_by: null, probe_coverage_mask: 0 });
    expect(new Date(r.watch_recheck_at).getTime()).toBe(NOW.getTime() + 30 * 86400000);
    expect(approvals(db)).toHaveLength(N);
    expect(approvals(db)[0]).toMatchObject({ decision: 'watch', authority: 'OWNER_FREE', money_action: false });
  });

  test('lane-owned / not awaiting / unknown decisions refuse and write nothing', async () => {
    const { db, d } = await parked();
    await Q.approveRow(db, { authorityId: openRows(db)[0].id, actor: ACTOR, now: NOW, bridge: inline });
    expect(domainState(db)).toBe('ready_to_acquire');
    await expect(Q.decideDomain(db, { domainId: d.id, decision: 'rejected', actor: ACTOR, now: NOW })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/lane-owned/) });
    const fresh = scenario({ domain: { agent_state: 'investigating' } });
    // a pre-bridge domain is decidable (the Registry table's Reject is this decision): nothing to audit, the state moves
    expect(await Q.decideDomain(fresh.db, { domainId: fresh.d.id, decision: 'rejected', actor: ACTOR, now: NOW })).toMatchObject({ agent_state: 'rejected', audited: 0, invalidated: 0, waivers_invalidated: 0 });
    expect(fresh.db._tables.seo_link_domains[0]).toMatchObject({ agent_state: 'rejected', rejected_by: 'owner' });
    await expect(Q.decideDomain(fresh.db, { domainId: fresh.d.id, decision: 'maybe', actor: ACTOR, now: NOW })).rejects.toMatchObject({ status: 400 });
    await expect(Q.decideDomain(fresh.db, { domainId: uid(), decision: 'watch', actor: ACTOR, now: NOW })).rejects.toMatchObject({ status: 404 });
    expect(approvals(db)).toHaveLength(1);
    expect(approvals(fresh.db)).toHaveLength(0);
  });
});

describe('acquireAnyway', () => {
  test('DENY: the failing floors are waived at their values, the bridge lifts the rejection and parks cards without a bell', async () => {
    const s = scenario({ domain: { spam_score: 30, score: 40 } });
    await nightly(s.db);
    expect(domainState(s.db)).toBe('rejected');
    expect(s.db._tables.seo_link_domains[0].rejected_by).toBe('bridge');
    const r = await Q.acquireAnyway(s.db, { domainId: s.d.id, actor: ACTOR, note: 'chamber site', now: NOW, bridge: (d, o) => inline(d, o) }); // the service's own notify (silent) reaches the bridge
    expect(r.floors).toEqual([{ floor: 'spam_score', value: 30, threshold: 10 }, { floor: 'score', value: 40, threshold: 60 }]);
    expect(waivers(s.db)).toHaveLength(1);
    // jsonb takes the STRING form of an array (pg would send a JS array as a Postgres array)
    expect(waivers(s.db)[0]).toMatchObject({ domain_id: s.d.id, path_id: s.p.id, overridden_floors: JSON.stringify(r.floors), approved_by: ACTOR, note: 'chamber site' });
    expect(JSON.parse(waivers(s.db)[0].overridden_floors)).toEqual(r.floors);
    expect(waivers(s.db)[0].decision_inputs_hash).toBe(P.floorInputsHash({ path: s.p, domain: s.db._tables.seo_link_domains[0], policy: P.normalizePolicyRow(null) }));
    expect(r.bridge).toMatchObject({ gated: false, parked: N });
    expect(r).toMatchObject({ awaiting: N, agent_state: 'qualified' });
    expect(notifyAdmin).not.toHaveBeenCalled();
    const row = openRows(s.db)[0];
    expect(row).toMatchObject({ level: 'OWNER_FREE', floor_waiver_id: waivers(s.db)[0].id });
    expect(placements(s.db).every((x) => x.status === 'awaiting_owner')).toBe(true);
    expect(approvals(s.db)).toHaveLength(0);
    // the card shows the waiver while its floors hash holds, and drops it the moment a floor input moves
    expect((await Q.listOwnerQueue(s.db)).cards[0].waiver).toMatchObject({ id: waivers(s.db)[0].id, approved_by: ACTOR });
    storedDomain(s.db).spam_score = 31;
    expect((await Q.listOwnerQueue(s.db)).cards[0].waiver).toBeNull();
    storedDomain(s.db).spam_score = 30;
    // lifted ⇒ qualified: a re-click is refused until the bridge rejects the domain again (inputs moved, waiver stale)
    await expect(Q.acquireAnyway(s.db, { domainId: s.d.id, actor: ACTOR, now: LATER, bridge: inline })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/only a rejected domain/) });
    storedDomain(s.db).agent_state = 'rejected'; storedDomain(s.db).rejected_by = 'bridge';
    // a second click from rejected replaces the (still open) first waiver
    const r2 = await Q.acquireAnyway(s.db, { domainId: s.d.id, actor: ACTOR, now: LATER, bridge: inline });
    expect(r2.replaced).toBe(1);
    expect(waivers(s.db).filter((w) => !w.invalidated_at)).toHaveLength(1);
    expect(waivers(s.db)[0].invalidated_reason).toMatch(/replaced/);
  });

  test('INVALID is never waivable; passing floors leave nothing to waive; no path refuses', async () => {
    const inv = scenario({ domain: { agent_state: 'rejected', rejected_by: 'owner' }, path: { last_investigated_at: null } });
    await expect(Q.acquireAnyway(inv.db, { domainId: inv.d.id, actor: ACTOR, now: NOW, bridge: inline })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/not actionable/) });
    const ok = scenario({ domain: { agent_state: 'rejected', rejected_by: 'owner' } });
    await expect(Q.acquireAnyway(ok.db, { domainId: ok.d.id, actor: ACTOR, now: NOW, bridge: inline })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/nothing to waive/) });
    const none = scenario({ domain: { agent_state: 'rejected', rejected_by: 'bridge' } });
    storedDomain(none.db).best_path_id = null;
    await expect(Q.acquireAnyway(none.db, { domainId: none.d.id, actor: ACTOR, now: NOW, bridge: inline })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/investigate first/) });
    await expect(Q.acquireAnyway(ok.db, { domainId: ok.d.id, actor: null, now: NOW, bridge: inline })).rejects.toMatchObject({ status: 400 });
    // not waivable at all: a lane-owned / qualified / watching domain has no DENY to override
    for (const state of ['qualified', 'ready_to_acquire', 'acquiring', 'acquired', 'watching', 'investigating', 'new']) {
      const s = scenario({ domain: { agent_state: state, spam_score: 30 } });
      await expect(Q.acquireAnyway(s.db, { domainId: s.d.id, actor: ACTOR, now: NOW, bridge: inline })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/only a rejected domain/) });
      expect(waivers(s.db)).toHaveLength(0);
    }
    for (const s of [inv, ok, none]) expect(waivers(s.db)).toHaveLength(0);
  });

  test('a bridge run that resolves with a per-domain error is reported as deferred (skipped: failed), the waiver still recorded', async () => {
    const s = scenario({ domain: { agent_state: 'rejected', score: 40 } });
    const erring = async () => ({ gated: false, selected: 1, decided: 0, parked: 0, released: 0, aggregateChanges: 0, errors: ['example.org: deadlock detected'] });
    const r = await Q.acquireAnyway(s.db, { domainId: s.d.id, actor: ACTOR, now: NOW, bridge: erring });
    expect(waivers(s.db)).toHaveLength(1);
    expect(r.bridge).toMatchObject({ skipped: 'failed', error: expect.stringMatching(/deadlock/) });
  });

  test('a post-commit summary read failure keeps the recorded waiver: an unavailable summary, never a 500', async () => {
    const s = scenario({ domain: { agent_state: 'rejected', score: 40 } });
    s.db._beforeResolve = (table, db) => { if (table === 'seo_link_prospects' && waivers(db).length) throw new Error('connection reset'); };
    const r = await Q.acquireAnyway(s.db, { domainId: s.d.id, actor: ACTOR, now: NOW, bridge: async () => ({ skipped: 'lease_held', gated: false, selected: 0, decided: 0, parked: 0, released: 0, aggregateChanges: 0, errors: [] }) });
    expect(waivers(s.db)).toHaveLength(1);
    expect(r).toMatchObject({ summary_unavailable: true, awaiting: null, agent_state: null, floors: [expect.objectContaining({ floor: 'score' })] });
  });

  test('waivableFloors: the registry flag matches what a click can waive', () => {
    const ok = scenario({ domain: { agent_state: 'rejected', score: 40 } });
    const { policy } = { policy: ok.db._tables.seo_link_policy[0] };
    expect(Q.waivableFloors(ok.p, ok.d, policy).map((f) => f.floor)).toEqual(['score']);
    expect(Q.waivableFloors({ ...ok.p, superseded_by: uid() }, ok.d, policy)).toEqual([]);
    expect(Q.waivableFloors(null, ok.d, policy)).toEqual([]);
    const passing = scenario({ domain: { agent_state: 'rejected' } });
    expect(Q.waivableFloors(passing.p, passing.d, policy)).toEqual([]);
  });

  test('a Reject after Acquire anyway ends the waiver: the next nightly run leaves the domain rejected; a Reopen after leaving the queue still invalidates a live approval', async () => {
    const s = scenario({ domain: { agent_state: 'rejected', score: 40 } });
    await Q.acquireAnyway(s.db, { domainId: s.d.id, actor: ACTOR, now: NOW, bridge: inline });
    expect(domainState(s.db)).toBe('qualified');
    const r = await Q.decideDomain(s.db, { domainId: s.d.id, decision: 'rejected', actor: ACTOR, now: LATER });
    expect(r.waivers_invalidated).toBe(1);
    expect(waivers(s.db)[0]).toMatchObject({ invalidated_at: LATER, invalidated_reason: expect.stringMatching(/owner rejected/) });
    // the sweep still selects the domain (its placements were bumped) but honours no waiver: every row re-decides to
    // DENY, the parks lift into 'prospect' (nothing to wait for) and the owner's rejection stands — the worker excludes
    // rejected domains, so nothing executes
    const n = await nightly(s.db, { now: LATER2 });
    expect(n.invalidatedWaivers).toBe(0); // already ended by the decision
    expect(storedDomain(s.db)).toMatchObject({ agent_state: 'rejected', rejected_by: 'owner' });
    expect(openRows(s.db).every((r) => r.level === 'DENY')).toBe(true);
    expect(placements(s.db).every((p) => p.status === 'prospect' && !p.claimed_at)).toBe(true);
    // Reopen → investigating with an approved row still attached (its bridge run was gated): the Registry Reject from
    // THAT state is the same decision — the approval is invalidated, never left for a later bridge pass
    const { db, d } = await parked();
    const gated = async () => ({ gated: true, skipped: 'gated', selected: 0, decided: 0, parked: 0, released: 0, aggregateChanges: 0, errors: [] });
    const a = await Q.approveRow(db, { authorityId: openRows(db)[0].id, actor: ACTOR, now: NOW, bridge: gated });
    await R.applyRegistryAction(db, storedDomain(db), 'reopen', LATER);
    expect(domainState(db)).toBe('investigating');
    const r2 = await Q.decideDomain(db, { domainId: d.id, decision: 'watch', actor: ACTOR, now: LATER2 });
    expect(r2).toMatchObject({ agent_state: 'watching', invalidated: 1 });
    expect(approvals(db).find((x) => x.id === a.approval.id)).toMatchObject({ invalidated_at: LATER2, invalidated_reason: expect.stringMatching(/owner watches/) });
  });

  test('the owner\'s own registry Reject is lifted by the waiver too (the click is the owner\'s)', async () => {
    const s = scenario({ domain: { agent_state: 'rejected', rejected_by: 'owner', score: 40 } });
    const r = await Q.acquireAnyway(s.db, { domainId: s.d.id, actor: ACTOR, now: NOW, bridge: inline });
    expect(r.agent_state).toBe('qualified');
    expect(placements(s.db)).toHaveLength(N);
  });
});
