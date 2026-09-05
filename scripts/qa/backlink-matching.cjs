/**
 * MUTATES synthetic fixtures only: rollback checks plus a concurrent case cleaned in finally.
 * Requires the backlink schema on a verified dev/preview Postgres database, no external
 * provider keys. Set WAVES_DATABASE_ENVIRONMENT=test and BACKLINK_TEST_DATABASE_URL.
 * Run from the repository root: node scripts/qa/backlink-matching.cjs
 */
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const env = { ...process.env, DATABASE_URL: process.env.BACKLINK_TEST_DATABASE_URL };
if (env.WAVES_DATABASE_ENVIRONMENT !== 'test' || !new URL(env.DATABASE_URL).pathname.startsWith('/waves_qa_')) throw Error('Synthetic preview database required');
const db = require('knex')({ client: 'pg', connection: env.DATABASE_URL, pool: { min: 0, max: 3 } });
const root = process.cwd();
const stub = (file, value) => { const id = require.resolve(`${root}/server/${file}`); require.cache[id] = { id, filename: id, loaded: true, exports: value }; };
const gates = new Set(['linkAuthority', 'signupRunner', 'outreachDrafter']);
stub('config/feature-gates', { isEnabled: (k) => gates.has(k) });
stub('services/logger', { info() {}, warn() {}, error() {} });
let active;
const proxy = (...a) => active(...a);
proxy.transaction = (...a) => active.transaction(...a);
proxy.raw = (...a) => active.raw(...a);
stub('models/db', proxy);
(async () => {
  const trx = await db.transaction(); active = trx;
  try {
    await require(`${root}/server/models/migrations/20260830000010_backlink_worker_auth_step1b`).up(trx);
    const V = require(`${root}/server/services/seo/link-prospect-verifier`);
    const oid = randomUUID(), opath = randomUUID(), first = randomUUID(), second = randomUUID(), backlink = randomUUID();
    const publisher = `synthetic-${oid}.example`, target = 'https://wavespestcontrol.com/pest-control/';
    const sent = new Date(Date.now() - 3 * 86400000);
    await trx('seo_link_domains').insert({id:oid,domain:publisher,source:'owner_seed',agent_state:'acquiring',score:85,spam_score:1});
    await trx('seo_link_acquisition_paths').insert({id:opath,domain_id:oid,path_key:'outreach-test',acquisition_type:'resource_outreach',link_type:'resource',account_required:false,email_verification:false,payment_required:false,legal_attestation:false,agent_completable:true,confidence:0.9,last_investigated_at:new Date()});
    await trx('seo_link_domains').where({id:oid}).update({best_path_id:opath});
    for (const [pid,location] of [[first,'sarasota'],[second,'bradenton']]) await trx('seo_link_prospects').insert({id:pid,domain_id:oid,path_id:opath,target_domain:publisher,target_page:target,location_key:location,status:'contacted',link_type:'resource',outreach_status:'sent',outreach_sent_at:sent,follow_up_status:'drafted'});
    await trx('seo_backlinks').insert({id:backlink,source_domain:publisher,source_url:`https://${publisher}/resources`,target_url:target,status:'active',discovery_source:'dataforseo',first_seen:require(`${root}/server/utils/datetime-et`).etDateString(new Date())});
    assert.deepEqual(await V.reconcileOutreach(), {matched:0,ambiguous:2});
    assert.equal((await trx('seo_link_placement_backlinks').where({ backlink_id: backlink })).length, 0);
    // A non-representative backlink is already owned by a live sibling. Matching
    // must neither steal it nor retire the waiting placement's follow-up.
    await trx('seo_link_prospects').where({ id: first }).update({ status: 'live' });
    await trx('seo_link_placement_backlinks').insert({ prospect_id: first, backlink_id: backlink });
    assert.deepEqual(await V.reconcileOutreach(), { matched: 0, ambiguous: 0 });
    assert.equal((await trx('seo_link_prospects').where({ id: second }).first()).follow_up_status, 'drafted');
    assert.equal((await trx('seo_link_placement_backlinks').where({ backlink_id: backlink }).first()).prospect_id, first);
    // Removing the synthetic ownership makes exact evidence available to second.
    await trx('seo_link_placement_backlinks').where({ backlink_id: backlink }).delete();
    await trx('seo_link_prospects').where({ id: second }).update({ target_url: `https://${publisher}/resources` });
    assert.deepEqual(await V.reconcileOutreach(), { matched: 1, ambiguous: 0 });
    const chosen = await trx('seo_link_prospects').where({ id: second }).first();
    assert.equal(chosen.status, 'placed'); assert.equal(chosen.backlink_id, backlink); assert.equal(chosen.follow_up_status, 'skipped');
    assert.equal((await trx('seo_link_placement_backlinks').where({ backlink_id: backlink }).first()).prospect_id, second);
    assert.deepEqual(await V.reconcileOutreach(), { matched: 0, ambiguous: 0 });
    console.log('PASS canonical non-representative ownership, mapping persistence, follow-up retirement, replay');
    await trx('seo_link_prospects').where({ id: first }).update({ status: 'contacted' });
    // Recovery retains the historic attribution. A restored link can settle that
    // same placement, but may never be reassigned to its still-waiting sibling.
    await trx('seo_link_prospects').where({ id: second }).update({ status: 'contacted', follow_up_status: 'drafted', quality_signals: { lost_recovery: true } });
    await trx('seo_backlinks').where({ id: backlink }).update({ first_seen: '2020-01-01' });
    assert.deepEqual(await V.reconcileOutreach(), { matched: 1, ambiguous: 0 });
    assert.equal((await trx('seo_link_prospects').where({ id: second }).first()).follow_up_status, 'skipped');
    assert.equal((await trx('seo_link_prospects').where({ id: first }).first()).status, 'contacted');
    await trx('seo_link_prospects').where({ id: first }).update({ status: 'rejected' });
    await trx('seo_link_prospects').where({ id: second }).update({ status: 'contacted', follow_up_status: 'drafted', indexing_status: 'indexed' });
    await trx('seo_backlinks').where({ id: backlink }).update({ status: 'lost' });
    const replacement = randomUUID();
    await trx('seo_backlinks').insert({ id: replacement, source_domain: publisher, source_url: `https://${publisher}/new-resources`, target_url: target, status: 'active', discovery_source: 'dataforseo', first_seen: require(`${root}/server/utils/datetime-et`).etDateString(new Date()) });
    assert.deepEqual(await V.reconcileOutreach(), { matched: 1, ambiguous: 0 });
    const restored = await trx('seo_link_prospects').where({ id: second }).first();
    assert.equal(restored.backlink_id, replacement);
    assert.equal(restored.follow_up_status, 'skipped');
    assert.equal(restored.indexing_status, 'not_checked');
    console.log('PASS recovered historical and moved backlinks settle only their own placement and retire follow-ups');
    // Canonical mail/apex spellings use the same publisher identity in SQL and matching.
    await trx('seo_link_prospects').where({ id: second }).update({ status: 'contacted', live_url: null, backlink_id: null, quality_signals: {} });
    await trx('seo_backlinks').where({ id: replacement }).update({ source_domain: `mail.${publisher}`, source_url: `https://mail.${publisher}/new-resources` });
    assert.deepEqual(await V.reconcileOutreach(), { matched: 1, ambiguous: 0 });
    console.log('PASS mail publisher canonicalization in the database query and matcher');

    // A generic URL sorts before the known page by UUID; exact identity must still win.
    const generic = '00000000-0000-4000-8000-000000000001';
    await trx('seo_backlinks').insert({ id: generic, source_domain: publisher, source_url: `https://${publisher}/generic`, target_url: target, status: 'active', discovery_source: 'dataforseo', first_seen: require(`${root}/server/utils/datetime-et`).etDateString(new Date()) });
    await trx('seo_link_prospects').where({ id: second }).update({ status: 'contacted', live_url: null, backlink_id: null, target_url: `https://mail.${publisher}/new-resources`, quality_signals: {} });
    assert.deepEqual(await V.reconcileOutreach(), { matched: 1, ambiguous: 0 });
    assert.equal((await trx('seo_link_prospects').where({ id: second }).first()).backlink_id, replacement);
    console.log('PASS exact publisher page wins before a lower-UUID generic backlink');

    // A lease can defer a weekly match; the next automatic bridge must retry it
    // before considering any follow-up send.
    await trx('seo_link_prospects').where({ id: second }).update({ status: 'contacted', claimed_at: new Date(), follow_up_status: 'drafted' });
    assert.equal((await V.reconcileOutreach()).matched, 0);
    await trx('seo_link_prospects').where({ id: second }).update({ claimed_at: null });
    gates.add('linkProspectOutreach');
    const bridge = await require(`${root}/server/services/seo/link-authority-bridge`).runAuthorityBridge(proxy, {
      domainIds: [oid], autoSend: true, exclusive: async (_key, work) => work(), notify: async () => {},
      send: async () => { throw Error('Matched follow-up must not send'); },
    });
    assert.deepEqual(bridge.errors, []);
    assert.equal((await trx('seo_link_prospects').where({ id: second }).first()).status, 'placed');
    assert.equal((await trx('seo_link_prospects').where({ id: second }).first()).follow_up_status, 'skipped');
    console.log('PASS automatic bridge retries a lease-deferred match before sending');

  } finally { await trx.rollback(); }
  // Real independent transactions exercise publisher-lock serialization and replay.
  // Only this unique synthetic fixture is committed; its rows are removed below.
  const domainId = randomUUID(), prospectId = randomUUID(), linkId = randomUUID();
  const publisher = `concurrent-${domainId}.example`, target = 'https://wavespestcontrol.com/pest-control/';
  try {
    await db.transaction(async (seed) => {
      await seed('seo_link_domains').insert({ id: domainId, domain: publisher, source: 'owner_seed' });
      await seed('seo_link_prospects').insert({ id: prospectId, domain_id: domainId, target_domain: publisher, target_page: target, location_key: 'sarasota', status: 'contacted', link_type: 'resource', outreach_status: 'sent', outreach_sent_at: new Date(Date.now() - 3 * 86400000), follow_up_status: 'drafted' });
      await seed('seo_backlinks').insert({ id: linkId, source_domain: publisher, source_url: `https://${publisher}/resources`, target_url: target, status: 'active', discovery_source: 'dataforseo', first_seen: require(`${root}/server/utils/datetime-et`).etDateString(new Date()) });
    });
    active = db;
    const verifier = require(`${root}/server/services/seo/link-prospect-verifier`);
    const results = await Promise.all([verifier.reconcileOutreach(), verifier.reconcileOutreach()]);
    assert.equal(results.reduce((total, result) => total + result.matched, 0), 1);
    assert.deepEqual((await db('seo_link_placement_backlinks').where({ backlink_id: linkId })).map((row) => row.prospect_id), [prospectId]);
    assert.equal((await db('seo_link_prospects').where({ id: prospectId }).first()).follow_up_status, 'skipped');
    console.log('PASS concurrent independent reconcilers settle once with one canonical owner');
  } finally {
    await db('seo_link_prospects').where({ id: prospectId }).delete();
    await db('seo_backlinks').where({ id: linkId }).delete();
    await db('seo_link_domains').where({ id: domainId }).delete();
  }
})().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => db.destroy());
