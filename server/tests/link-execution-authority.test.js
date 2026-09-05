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
  expect(await E.beginSubmission(s.db,{prospectId:s.placement.id,leaseToken:s.token})).toBe(false);
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
  const args={prospectId:s.placement.id,leaseToken:s.token};
  expect(await E.beginSubmission(s.db,args)).toBe(true);
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
  expect(await E.beginSubmission(s.db,{prospectId:s.placement.id,leaseToken:s.token})).toBe(false);
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
  expect(await E.beginSubmission(s.db, { prospectId: s.placement.id, leaseToken: s.placement.claimed_at.toISOString() })).toBe(false);
});


test('owner placement confirmation resolves a held attempt and its exact execution approval once', async () => {
  const s = scenario();
  s.db._tables.audit_log = [];
  s.db._tables.seo_link_prospects[0].claimed_at = null;
  const approvalId = uid();
  s.db._tables.seo_link_approvals.push({ id: approvalId, prospect_id: s.placement.id, dimension: 'execution', action: 'acquire', consumed_at: null });
  s.db._tables.seo_link_attempts.push({ id: uid(), prospect_id: s.placement.id, path_id: s.path.id, action: 'submit', outcome: 'submit_ambiguous', evidence_url: 'synthetic/evidence.png', detail: { authority_id: s.authority.id, approval_id: approvalId } });
  const currentDecision = { ...s.authority, id: uid(), instance_key: 'revised-instance', satisfied_at: null };
  s.db._tables.seo_link_placement_authorities[0].ended_at = new Date();
  s.db._tables.seo_link_placement_authorities.push(currentDecision);
  const args = { prospectId: s.placement.id, status: 'placed' };
  expect(await E.reconcileOwnerPlacement(s.db, args)).toEqual({ ok: true });
  expect(s.db._tables.seo_link_attempts[0]).toMatchObject({ outcome: 'placed', evidence_url: 'synthetic/evidence.png' });
  expect(s.db._tables.seo_link_placement_authorities.every(r => r.satisfied_reason === 'placed')).toBe(true);
  expect(s.db._tables.seo_link_approvals[0].consumed_at).toBeInstanceOf(Date);
  expect(await E.reconcileOwnerPlacement(s.db, args)).toEqual({ ok: true });
  expect(s.db._tables.audit_log).toHaveLength(1);
});

test('owner confirmation refuses an active acquisition lease', async () => {
  const s = scenario();
  expect(await E.reconcileOwnerPlacement(s.db, { prospectId: s.placement.id, status: 'placed' })).toMatchObject({ ok: false });
});
