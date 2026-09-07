jest.mock('../models/db', () => jest.fn());
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));
const { isEnabled } = require('../config/feature-gates');
const E = require('../services/seo/link-execution-authority');
const P = require('../services/seo/link-authority-policy');
const { makeDb, uid } = require('./helpers/link-authority-store');

function scenario(overrides = {}) {
  const path = { id: uid(), acquisition_type: 'self_service_free', link_type: 'directory', submission_url: 'https://publisher.example/add',
    account_required: false, email_verification: false, payment_required: false, legal_attestation: false,
    agent_completable: true, baseline: false, currency: 'unknown', terms_accepted_by_send: false, last_investigated_at: new Date(), confidence: 0.9, revision: 1, revision_execution: 1, execution_after_send: true, ...overrides.path };
  const domain = { id: uid(), domain: 'publisher.example', best_path_id: path.id, agent_state: 'ready_to_acquire', score: 85, spam_score: 1, ...overrides.domain };
  path.domain_id = domain.id;
  const placement = { id: uid(), domain_id: domain.id, target_domain: domain.domain, path_id: path.id, status: 'prospect', claimed_at: new Date(), leased_provider: 'deterministic_runner', lease_mode: 'acquire', leased_path_revision: 1, ...overrides.placement };
  const policy = { ...P.normalizePolicyRow(null), auto_free_acquisition: true, auto_submission_daily_cap: 1, ...overrides.policy };
  const ctx = { path, domain, policy, score: domain.score, instanceKey: 'test-instance' };
  const authority = { id: uid(), prospect_id: placement.id, path_id: path.id, dimension: 'execution', instance_kind: '-', instance_key: ctx.instanceKey,
    level: 'AUTO_FREE', path_revision: 1, decision_inputs_hash: P.decisionInputsHash('execution', ctx), ...overrides.authority };
  const db = makeDb({ seo_link_acquisition_paths: [path], seo_link_domains: [domain], seo_link_prospects: [placement], seo_link_policy: [{id:1,...policy}], seo_link_placement_authorities: [authority] });
  return { db, path, placement, policy, authority, token: placement.claimed_at.toISOString() };
}
beforeEach(() => isEnabled.mockImplementation(() => true));
const authorize = (s, provider = 'deterministic_runner') => E.authorize(s.db, s.placement, s.path, provider);

test('free authority accepts only its selected provider, current policy and current best path', async () => {
  const s = scenario();
  expect(await authorize(s)).toBeTruthy();
  expect(await authorize(s, 'hermes')).toBeNull();
  s.db._tables.seo_link_policy[0].auto_free_acquisition = false;
  expect(await authorize(s)).toBeNull();
});
test.each(['account_required', 'email_verification', 'payment_required', 'legal_attestation', 'baseline'])('%s blocks free execution even with an authority row', async (field) => {
  expect(await authorize(scenario({path:{[field]:true}}))).toBeNull();
});
test.each(['watching', 'rejected', 'investigating', 'new'])('%s domain cannot execute', async (agent_state) => {
  expect(await authorize(scenario({domain:{agent_state}}))).toBeNull();
});
test.each(['linkAuthority','signupRunner'])('%s kill switch refuses the mutation boundary', async (gate) => {
  const s = scenario();
  const auth = await authorize(s);
  await E.reserveSlot(s.db,s.placement,s.path,auth,s.token,new Date());
  isEnabled.mockImplementation(k=>k!==gate);
  expect(await E.beginSubmission(s.db,{prospectId:s.placement.id,leaseToken:s.token,citation:{website:'https://wavespestcontrol.com',location:'sarasota'}})).toBe(false);
  expect(s.db._tables.seo_link_attempts[0].outcome).toBe('slot_reserved');
});
test('reservation consumes the daily cap; preview writes nothing and counts earlier preview candidates', async()=>{
  const s=scenario(); const auth=await authorize(s);
  expect(await E.reserveSlot(s.db,s.placement,s.path,auth,null,new Date(),true)).toBeTruthy();
  expect(await E.reserveSlot(s.db,s.placement,s.path,auth,null,new Date(),true,1)).toBeNull();
  expect(s.db._tables.seo_link_attempts).toHaveLength(0);
  await E.reserveSlot(s.db,s.placement,s.path,auth,s.token,new Date());
  expect(await E.reserveSlot(s.db,{...s.placement,id:uid()},s.path,auth,s.token,new Date())).toBeNull();
});
test('only one submit begins; release after it preserves ambiguity and prohibits replay', async()=>{
  const s=scenario(); const auth=await authorize(s);
  await E.reserveSlot(s.db,s.placement,s.path,auth,s.token,new Date());
  const args={prospectId:s.placement.id,leaseToken:s.token,citation:{website:'https://wavespestcontrol.com',location:'sarasota'}};
  expect(await E.beginSubmission(s.db,args)).toBe(true);
  expect(s.db._tables.seo_link_attempts[0].detail.citation).toEqual(args.citation);
  expect(Number.isFinite(Date.parse(s.db._tables.seo_link_attempts[0].detail.submitted_at))).toBe(true);
  expect(await E.beginSubmission(s.db,args)).toBe(false);
  await E.releaseSlots(s.db,[s.placement.id]);
  expect(s.db._tables.seo_link_attempts[0].outcome).toBe('submit_ambiguous');
  expect(await E.reserveSlot(s.db,s.placement,s.path,auth,s.token,new Date())).toBeNull();
});
test('a pre-submit release frees the slot for retry, while path changes invalidate a reserved lease', async()=>{
  const s=scenario(); const auth=await authorize(s);
  await E.reserveSlot(s.db,s.placement,s.path,auth,s.token,new Date());
  await E.releaseSlots(s.db,[s.placement.id]);
  expect(s.db._tables.seo_link_attempts[0].outcome).toBe('slot_released');
  await E.reserveSlot(s.db,s.placement,s.path,auth,s.token,new Date());
  s.db._tables.seo_link_acquisition_paths[0].revision=2;
  expect(await E.beginSubmission(s.db,{prospectId:s.placement.id,leaseToken:s.token,citation:{website:'https://wavespestcontrol.com',location:'sarasota'}})).toBe(false);
  expect(s.db._tables.seo_link_attempts).toHaveLength(1);
});
test('send-first acquisition waits for the initial communication instance to be satisfied',async()=>{
  const s=scenario({path:{acquisition_type:'content_submission',link_type:'resource'},placement:{status:'contacted'}});
  expect(await authorize(s)).toBeNull();
  s.db._tables.seo_link_placement_authorities.push({id:uid(),prospect_id:s.placement.id,path_id:s.path.id,dimension:'communication',instance_kind:'-',satisfied_at:new Date(),satisfied_reason:'sent'});
  expect(await authorize(s)).toBeTruthy();
});


test('an ambiguous submission blocks a newly rotated authority too',async()=>{
  const s=scenario();const auth=await authorize(s);
  s.db._tables.seo_link_attempts.push({id:uid(),prospect_id:s.placement.id,action:'submit',outcome:'submit_ambiguous',idempotency_key:'previous-generation'});
  expect(await E.reserveSlot(s.db,s.placement,s.path,auth,s.token,new Date())).toBeNull();
});
test('owner free execution needs the exact unconsumed approval snapshot',async()=>{
  const s=scenario({policy:{auto_free_acquisition:false},authority:{level:'OWNER_FREE'}});
  expect(await authorize(s)).toBeNull();
  const approval={id:uid(),prospect_id:s.placement.id,path_id:s.path.id,dimension:'execution',action:'acquire',instance_key:s.authority.instance_key,authority:'OWNER_FREE',decision:'approved',decision_inputs_hash:s.authority.decision_inputs_hash,path_revision:1};
  s.db._tables.seo_link_approvals.push(approval);s.db._tables.seo_link_placement_authorities[0].approval_id=approval.id;
  expect(await authorize(s)).toBeTruthy();
  approval.consumed_at=new Date();expect(await authorize(s)).toBeNull();
});


test('reusing a released reservation binds the current approval, not the earlier click',async()=>{
  const s=scenario();const auth=await authorize(s);
  auth.approval={id:uid()};
  await E.reserveSlot(s.db,s.placement,s.path,auth,s.token,new Date());
  await E.releaseSlots(s.db,[s.placement.id]);
  auth.approval={id:uid()};
  await E.reserveSlot(s.db,s.placement,s.path,auth,s.token,new Date());
  expect(s.db._tables.seo_link_attempts[0].detail.approval_id).toBe(auth.approval.id);
});


test.each(['sending', 'send_error'])('a %s follow-up refuses both acquisition authorization and its mutation recheck', async (follow_up_status) => {
  const s = scenario({ placement: { follow_up_status } });
  expect(await authorize(s)).toBeNull();
  expect(await E.beginSubmission(s.db, { prospectId: s.placement.id, leaseToken: s.placement.claimed_at.toISOString(), citation: { website: 'https://wavespestcontrol.com', location: 'sarasota' } })).toBe(false);
});


test('owner placement confirmation resolves a held attempt and its exact execution approval once', async () => {
  const s = scenario();
  s.db._tables.audit_log = [];
  s.db._tables.seo_link_prospects[0].claimed_at = null;
  const approvalId = uid();
  s.db._tables.seo_link_approvals.push({ id: approvalId, prospect_id: s.placement.id, dimension: 'execution', action: 'acquire', consumed_at: null });
  s.db._tables.seo_link_attempts.push({ id: uid(), prospect_id: s.placement.id, path_id: s.path.id, action: 'submit', outcome: 'submit_ambiguous', lease_token: s.token, evidence_url: 'synthetic/evidence.png', detail: { authority_id: s.authority.id, execution_revision: 1, approval_id: approvalId, citation: { website: 'https://wavespestcontrol.com', location: 'sarasota' } } });
  const currentDecision = { ...s.authority, id: uid(), instance_key: 'revised-instance', satisfied_at: null };
  s.db._tables.seo_link_placement_authorities[0].ended_at = new Date();
  s.db._tables.seo_link_placement_authorities.push(currentDecision);
  const args = { prospectId: s.placement.id, status: 'placed', liveUrl: 'https://publisher.example/confirmed', attemptId: s.db._tables.seo_link_attempts[0].id };
  expect(await E.reconcileOwnerPlacement(s.db, args)).toMatchObject({ ok: true });
  expect(s.db._tables.seo_link_attempts[0]).toMatchObject({ outcome: 'placed', evidence_url: 'synthetic/evidence.png' });
  expect(s.db._tables.seo_link_placement_authorities.every(r => r.satisfied_reason === 'placed')).toBe(true);
  expect(s.db._tables.seo_link_approvals[0].consumed_at).toBeInstanceOf(Date);
  expect(s.db._tables.seo_link_prospects[0]).toMatchObject({ location_key: 'sarasota', quality_signals: { cited_homepage: true, submitted_website: 'https://wavespestcontrol.com', location: 'sarasota' } });
  expect(await E.reconcileOwnerPlacement(s.db, args)).toMatchObject({ ok: false });
  expect(s.db._tables.audit_log).toHaveLength(1);
});

test('owner confirmation refuses an active acquisition lease', async () => {
  const s = scenario();
  expect(await E.reconcileOwnerPlacement(s.db, { prospectId: s.placement.id, status: 'placed' })).toMatchObject({ ok: false });
});


test.each(['submit_rejected', 'submit_blocked'])('negative owner verdict releases %s retry hold, preserves evidence and refuses replay', async (errorCode) => {
  const s = scenario();
  s.db._tables.audit_log = [];
  s.db._tables.seo_link_prospects[0].claimed_at = null;
  const auth = await authorize(s);
  await E.reserveSlot(s.db, s.placement, s.path, auth, s.token, new Date());
  const attempt = s.db._tables.seo_link_attempts[0];
  Object.assign(attempt, { outcome: 'submit_ambiguous', evidence_url: 'synthetic/evidence.png', detail: { ...attempt.detail, error_code: errorCode } });
  s.db._tables.seo_link_prospects[0].automation_policy = 'skip';
  s.db._tables.seo_link_prospects[0].attempts = 3;
  const args = { prospectId: s.placement.id, attemptId: attempt.id, notSubmitted: true };
  expect(await E.reconcileOwnerPlacement(s.db, { ...args, attemptId: uid() })).toMatchObject({ ok: false });
  expect(await E.reconcileOwnerPlacement(s.db, args)).toMatchObject({ ok: true });
  expect(attempt).toMatchObject({ outcome: 'slot_released', evidence_url: 'synthetic/evidence.png', idempotency_key: null });
  expect(s.db._tables.seo_link_placement_authorities[0].satisfied_at).toBeUndefined();
  expect(s.db._tables.seo_link_prospects[0].automation_policy).toBeNull();
  expect(s.db._tables.seo_link_prospects[0].attempts).toBe(3);
  const retry = await E.reserveSlot(s.db, s.placement, s.path, auth, s.token, new Date());
  expect(retry.id).not.toBe(attempt.id);
  expect(await E.reconcileOwnerPlacement(s.db, args)).toMatchObject({ ok: false });
  expect(s.db._tables.audit_log).toHaveLength(1);
});

test('submission without a durable citation snapshot cannot cross the mutation boundary', async () => {
  const s = scenario(); const auth = await authorize(s);
  await E.reserveSlot(s.db, s.placement, s.path, auth, s.token, new Date());
  expect(await E.beginSubmission(s.db, { prospectId: s.placement.id, leaseToken: s.token })).toBe(false);
  expect(s.db._tables.seo_link_attempts[0].outcome).toBe('slot_reserved');
});


test.each(['-', 'sarasota'])('legacy hold with location key %s cannot infer citation identity from a moved board target', async (location_key) => {
  const s = scenario({ placement: { location_key, target_page: '/sarasota-pest-control/' } });
  s.db._tables.audit_log = [];
  const placement = s.db._tables.seo_link_prospects[0];
  placement.claimed_at = null;
  const attempt = { id: uid(), prospect_id: s.placement.id, path_id: s.path.id, provider: 'deterministic_runner', action: 'submit', outcome: 'submit_ambiguous', lease_token: s.token, detail: { authority_id: s.authority.id } };
  s.db._tables.seo_link_attempts.push(attempt);
  placement.target_page = '/venice-pest-control/';
  const before = JSON.stringify(s.db._tables);
  expect(await E.reconcileOwnerPlacement(s.db, { prospectId: s.placement.id, attemptId: attempt.id, status: 'placed', liveUrl: 'https://www.publisher.example/confirmed' })).toMatchObject({ ok: false, error: expect.stringMatching(/identity/) });
  expect(JSON.stringify(s.db._tables)).toBe(before);
});

test('a hold with unknown provider identity remains unresolved', async () => {
  const s = scenario(); s.db._tables.audit_log = [];
  s.db._tables.seo_link_prospects[0].claimed_at = null;
  const attempt = { id: uid(), prospect_id: s.placement.id, path_id: s.path.id, provider: 'hermes', action: 'submit', outcome: 'submit_ambiguous', detail: { authority_id: s.authority.id } };
  s.db._tables.seo_link_attempts.push(attempt);
  expect(await E.reconcileOwnerPlacement(s.db, { prospectId: s.placement.id, attemptId: attempt.id, status: 'placed', liveUrl: 'https://publisher.example/confirmed' })).toMatchObject({ ok: false, error: expect.stringMatching(/identity/) });
  expect(attempt.outcome).toBe('submit_ambiguous');
  expect(s.db._tables.audit_log).toHaveLength(0);
  expect(s.db._tables.seo_link_placement_authorities[0].satisfied_at).toBeUndefined();
});


test.each(['prospect', 'live', 'indexed'])('confirmation preserves %s lifecycle and original submission boundary', async (status) => {
  const s = scenario({ placement: { status, live_url: 'https://publisher.example/confirmed', location_key: '-', target_page: '/venice-pest-control/' } });
  s.db._tables.audit_log = [];
  const submitted_at = new Date(Date.now() - 5 * 86400000).toISOString();
  const attempt = { id: uid(), prospect_id: s.placement.id, path_id: s.path.id, provider: 'deterministic_runner', action: 'submit', outcome: 'submit_ambiguous', lease_token: s.token, detail: { authority_id: s.authority.id, execution_revision: 1, submitted_at, citation: { website: 'https://wavespestcontrol.com', location: 'sarasota' } } };
  s.db._tables.seo_link_attempts.push(attempt);
  s.db._tables.seo_link_prospects[0].claimed_at = null;
  const result = await E.reconcileOwnerPlacement(s.db, { prospectId: s.placement.id, attemptId: attempt.id, status: 'placed', liveUrl: 'https://publisher.example/confirmed' });
  expect(result).toEqual({ ok: true, status: status === 'prospect' ? 'placed' : status });
  expect(s.db._tables.seo_link_prospects[0].quality_signals.submitted_at).toBe(submitted_at);
  expect(attempt.detail.submitted_at).toBe(submitted_at);
  expect(s.db._tables.seo_link_prospects[0].location_key).toBe('sarasota');
});


test.each(['path only', 'bridge redecided'])('confirmation refuses a revised execution mandate after %s', async (ordering) => {
  const s = scenario();
  s.db._tables.audit_log = [];
  const auth = await authorize(s);
  await E.reserveSlot(s.db, s.placement, s.path, auth, s.token, new Date());
  expect(await E.beginSubmission(s.db, { prospectId: s.placement.id, leaseToken: s.token, citation: { website: 'https://wavespestcontrol.com', location: 'sarasota' } })).toBe(true);
  await E.releaseSlots(s.db, [s.placement.id]);
  s.db._tables.seo_link_prospects[0].claimed_at = null;
  const attempt = s.db._tables.seo_link_attempts[0];
  expect(attempt.detail.execution_revision).toBe(1);
  Object.assign(s.db._tables.seo_link_acquisition_paths[0], { revision: 2, revision_execution: 2, submission_url: 'https://publisher.example/new-form' });
  if (ordering === 'bridge redecided') Object.assign(s.db._tables.seo_link_placement_authorities[0], { path_revision: 2, decision_inputs_hash: 'changed' });
  const before = JSON.stringify(s.db._tables);
  const result = await E.reconcileOwnerPlacement(s.db, { prospectId: s.placement.id, attemptId: attempt.id, status: 'placed', liveUrl: 'https://publisher.example/confirmed' });
  expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/execution revision/) });
  expect(JSON.stringify(s.db._tables)).toBe(before);
  // A negative verdict asserts no submission occurred; it may still release the reviewed hold.
  expect(await E.reconcileOwnerPlacement(s.db, { prospectId: s.placement.id, attemptId: attempt.id, notSubmitted: true })).toMatchObject({ ok: true });
  expect(attempt.outcome).toBe('slot_released');
});

test('unrelated path revisions and domain reclassification do not invalidate submitted execution evidence', async () => {
  const s = scenario();
  s.db._tables.audit_log = [];
  const auth = await authorize(s);
  await E.reserveSlot(s.db, s.placement, s.path, auth, s.token, new Date());
  expect(await E.beginSubmission(s.db, { prospectId: s.placement.id, leaseToken: s.token, citation: { website: 'https://wavespestcontrol.com', location: 'sarasota' } })).toBe(true);
  await E.releaseSlots(s.db, [s.placement.id]);
  s.db._tables.seo_link_prospects[0].claimed_at = null;
  Object.assign(s.db._tables.seo_link_acquisition_paths[0], { revision: 2, revision_payment: 2 });
  Object.assign(s.db._tables.seo_link_domains[0], { agent_state: 'rejected', score: 0 });
  Object.assign(s.db._tables.seo_link_placement_authorities[0], { level: 'DENY', decision_inputs_hash: 'new-floors' });
  const attempt = s.db._tables.seo_link_attempts[0];
  expect(await E.reconcileOwnerPlacement(s.db, { prospectId: s.placement.id, attemptId: attempt.id, status: 'placed', liveUrl: 'https://publisher.example/confirmed' })).toMatchObject({ ok: true });
  expect(attempt.outcome).toBe('placed');
  expect(s.db._tables.seo_link_domains[0].agent_state).toBe('rejected');
});

test('a citation snapshot without an execution revision cannot satisfy a current mandate', async () => {
  const s = scenario();
  s.db._tables.audit_log = [];
  s.db._tables.seo_link_prospects[0].claimed_at = null;
  const attempt = { id: uid(), prospect_id: s.placement.id, path_id: s.path.id, action: 'submit', outcome: 'submit_ambiguous', detail: { authority_id: s.authority.id, citation: { website: 'https://wavespestcontrol.com', location: 'sarasota' } } };
  s.db._tables.seo_link_attempts.push(attempt);
  const before = JSON.stringify(s.db._tables);
  expect(await E.reconcileOwnerPlacement(s.db, { prospectId: s.placement.id, attemptId: attempt.id, status: 'placed', liveUrl: 'https://publisher.example/confirmed' })).toMatchObject({ ok: false, error: expect.stringMatching(/execution revision/) });
  expect(JSON.stringify(s.db._tables)).toBe(before);
});

test.each([
  ['exact', 'publisher.example', 'https://wavespestcontrol.com/pest-control/'],
  ['canonical', 'WWW.Publisher.Example', 'http://www.wavespestcontrol.com/pest-control'],
  ['relative', 'publisher.example', '/pest-control/'],
])('restoring a submitted location refuses an %s duplicate before writing', async (_kind, target_domain, target_page) => {
  const s = scenario({ placement: { location_key: '-', target_page: 'https://wavespestcontrol.com/pest-control/' } });
  s.db._tables.audit_log = [];
  s.db._tables.seo_link_prospects[0].claimed_at = null;
  const attempt = { id: uid(), prospect_id: s.placement.id, path_id: s.path.id, action: 'submit', outcome: 'submit_ambiguous', lease_token: s.token, detail: { authority_id: s.authority.id, execution_revision: 1, citation: { website: 'https://wavespestcontrol.com', location: 'sarasota' } } };
  s.db._tables.seo_link_attempts.push(attempt);
  const sibling = { id: uid(), target_domain, target_page, location_key: 'sarasota', status: 'live' };
  s.db._tables.seo_link_prospects.push(sibling);
  const before = JSON.stringify(s.db._tables);
  const args = { prospectId: s.placement.id, attemptId: attempt.id, status: 'placed', liveUrl: 'https://publisher.example/confirmed' };
  expect(await E.reconcileOwnerPlacement(s.db, args)).toMatchObject({ ok: false, error: expect.stringMatching(/Another placement/) });
  expect(JSON.stringify(s.db._tables)).toBe(before);
  sibling.location_key = 'venice';
  expect(await E.reconcileOwnerPlacement(s.db, args)).toMatchObject({ ok: true });
});


test.each(['live', 'indexed'])('held confirmation cannot replace the URL backing a %s placement', async (status) => {
  const liveUrl = 'https://publisher.example/verified';
  const s = scenario({ placement: { status, live_url: liveUrl, indexing_status: 'indexed', last_index_check: new Date(), last_live_check: new Date(), backlink_id: uid() } });
  s.db._tables.audit_log = [];
  s.db._tables.seo_link_prospects[0].claimed_at = null;
  const attempt = { id: uid(), prospect_id: s.placement.id, path_id: s.path.id, action: 'submit', outcome: 'submit_ambiguous', lease_token: s.token, detail: { authority_id: s.authority.id, execution_revision: 1, citation: { website: 'https://wavespestcontrol.com', location: 'sarasota' } } };
  s.db._tables.seo_link_attempts.push(attempt);
  const args = { prospectId: s.placement.id, attemptId: attempt.id, status: 'placed' };
  const before = JSON.stringify(s.db._tables);
  expect(await E.reconcileOwnerPlacement(s.db, { ...args, liveUrl: 'https://publisher.example/unverified' })).toMatchObject({ ok: false, error: expect.stringMatching(/verified publisher URL/) });
  expect(JSON.stringify(s.db._tables)).toBe(before);
  expect(await E.reconcileOwnerPlacement(s.db, { ...args, liveUrl })).toMatchObject({ ok: true, status });
  expect(s.db._tables.seo_link_prospects[0]).toMatchObject({ live_url: liveUrl, indexing_status: 'indexed', backlink_id: s.placement.backlink_id });
});
