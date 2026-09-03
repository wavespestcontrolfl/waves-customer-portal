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
    expect(c.d30_confidence).toBeNull();
    expect(c.price_tolerance_cents).toBe(0);
    const byDim = Object.fromEntries(c.rows.map((r) => [r.dimension, r]));
    expect(byDim.execution).toMatchObject({ level: 'OWNER_FREE', action: 'acquire', approvable: true, why_not: null, shared_fee: null });
    expect(byDim.payment).toMatchObject({ level: 'OWNER_PAYMENT', action: 'purchase', approvable: true, shared_fee: null });
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
    await expect(Q.decideDomain(fresh.db, { domainId: fresh.d.id, decision: 'rejected', actor: ACTOR, now: NOW })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/not awaiting/) });
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

  test('the owner\'s own registry Reject is lifted by the waiver too (the click is the owner\'s)', async () => {
    const s = scenario({ domain: { agent_state: 'rejected', rejected_by: 'owner', score: 40 } });
    const r = await Q.acquireAnyway(s.db, { domainId: s.d.id, actor: ACTOR, now: NOW, bridge: inline });
    expect(r.agent_state).toBe('qualified');
    expect(placements(s.db)).toHaveLength(N);
  });
});
