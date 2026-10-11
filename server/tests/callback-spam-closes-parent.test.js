// A callback that reaches a solicitor settles its parent voicemail
// (GATE_CALLBACK_SPAM_CLOSES_PARENT). Two writers, one lifecycle each:
//  - cards: closeParentOnCallbackSpam resolves the parent's open asks a return
//    call would have answered (CALLBACK_SPAM_MOOT_CODES), syncs review_status
//    and stamps metadata.callback_verdict; the nightly triage auto-resolve
//    sweep re-closes a card a later reprocess filed again (rule callback_spam);
//  - the callback promise: call-commitments' own fulfillment lifecycle reads
//    the spam callback as a callback_spam proof and dismisses it
//    (refreshFulfillment), asked for right after the cards settle.
// A callback later reprocessed into a real conversation gives everything back
// (reopenParentOnCallbackCorrected + reopenCallbackSpamDismissals).
// Cards that judge on-file data stay. The parent's processing_status, lead
// and customer are not touched. Nothing is sent.
//
// Eligibility (codex #6271): the child is an admin callback (source
// 'admin-callback') to the parent's own number or customer; the parent is an
// inbound voicemail; the child's verdict is still the one on the row (same
// generation, no live token). The shared triage lock is taken first.
//
// Unit cases need no database. The behavior suite runs on real rows
// (DATABASE_URL only, same convention as call-processor-shutdown-release.test.js).
// Fixtures are fictitious: 555-01xx numbers, fake SIDs, no transcript text.
const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const sid = (tail) => 'CA' + '7'.repeat(30) + tail;
const PARENT_SID = sid('p1');
const CHILD_SID = sid('c1');
const OTHER_PARENT_SID = sid('p2');
const KEPT_PARENT_SID = sid('p3');
const KEPT_CHILD_SID = sid('c3');
const PLAIN_PARENT_SID = sid('p4');
const PLAIN_CHILD_SID = sid('c4');
const FAR_CHILD_SID = sid('c5');
const ORPHAN_CHILD_SID = sid('c6');
const FIXED_PARENT_SID = sid('p7');
const FIXED_CHILD_SID = sid('c7');
const SWEPT_PARENT_SID = sid('p8');
const SWEPT_CHILD_SID = sid('c8');
const UUID = '11111111-1111-4111-8111-111111111111';

describe('closeParentOnCallbackSpam without a database', () => {
  test('gate off: nothing happens', async () => {
    let processor;
    jest.isolateModules(() => {
      delete process.env.GATE_CALLBACK_SPAM_CLOSES_PARENT;
      processor = require('../services/call-recording-processor');
    });
    const r = await processor.closeParentOnCallbackSpam({ id: UUID, direction: 'outbound', source: 'admin-callback', metadata: { relatedCallId: UUID } });
    expect(r).toEqual({ applied: false, reason: 'gated_off' });
    expect(await processor.reopenParentOnCallbackCorrected({ id: UUID, direction: 'outbound', source: 'admin-callback', metadata: { relatedCallId: UUID } })).toEqual({ applied: false, reason: 'no_parent' });
  });

  test('gate on: an inbound call, a non-admin outbound call, or a callback with no parent is left alone before any query', async () => {
    let processor;
    jest.isolateModules(() => {
      process.env.GATE_CALLBACK_SPAM_CLOSES_PARENT = 'true';
      processor = require('../services/call-recording-processor');
    });
    delete process.env.GATE_CALLBACK_SPAM_CLOSES_PARENT;
    const close = (call) => processor.closeParentOnCallbackSpam(call, { procGeneration: 1 });
    expect(await close({ id: UUID, direction: 'inbound', source: 'admin-callback', metadata: { relatedCallId: UUID } })).toEqual({ applied: false, reason: 'not_outbound' });
    // An outbound call that is not an office callback (admin-click, tech dial, voice agent) never settles anything.
    expect(await close({ id: UUID, direction: 'outbound', source: 'admin-click', metadata: { relatedCallId: UUID } })).toEqual({ applied: false, reason: 'not_admin_callback' });
    expect(await close({ id: UUID, direction: 'outbound-api', source: null, metadata: { relatedCallId: UUID } })).toEqual({ applied: false, reason: 'not_admin_callback' });
    expect(await close({ id: UUID, direction: 'outbound', source: 'admin-callback', metadata: {} })).toEqual({ applied: false, reason: 'no_parent' });
    expect(await close({ id: UUID, direction: 'outbound', source: 'admin-callback', metadata: JSON.stringify({ relatedCallId: 'undefined' }) })).toEqual({ applied: false, reason: 'no_parent' });
    expect(await close({ id: UUID, direction: 'outbound-api', source: 'admin-callback', metadata: 'not json' })).toEqual({ applied: false, reason: 'no_parent' });
  });

  test('the moot set holds the asks a return call answers and none of the human verdicts', () => {
    const { CALLBACK_SPAM_MOOT_CODES } = require('../services/call-triage-flags');
    for (const f of ['missing_service_address', 'address_unverifiable', 'missing_last_name', 'not_confirmed', 'quote_promised']) expect(CALLBACK_SPAM_MOOT_CODES.has(f)).toBe(true);
    // callback_number_needed: the caller said the inbound number was not theirs, so a callback to it answers nothing.
    for (const f of ['callback_number_needed', 'missing_unit_number', 'on_file_house_number_conflict', 'email_unverified', 'caller_not_authorized', 'out_of_service_area', 'property_role_confirm']) expect(CALLBACK_SPAM_MOOT_CODES.has(f)).toBe(false);
  });

  test('the sweep rule resolves a moot card on callback_spam evidence and nothing without it', () => {
    const { classifyTriageItem } = require('../services/triage-auto-resolve');
    const item = { id: 't1', status: 'open', severity: 'blocking', reason_code: 'missing_service_address', payload: {}, created_at: new Date() };
    expect(classifyTriageItem(item, { evidence: new Map([['t1', { callback_spam: true }]]) })).toEqual({ action: 'resolve', rule: 'callback_spam' });
    expect(classifyTriageItem({ ...item, reason_code: 'on_file_house_number_conflict' }, { evidence: new Map([['t1', { callback_spam: true }]]) })?.rule).not.toBe('callback_spam');
    expect(classifyTriageItem(item, { evidence: new Map([['t1', {}]]) })?.rule).not.toBe('callback_spam');
  });
});

maybeDescribe('callback spam settles the parent voicemail (live Postgres)', () => {
  let db;
  let processor;
  const ALL_SIDS = [PARENT_SID, CHILD_SID, OTHER_PARENT_SID, KEPT_PARENT_SID, KEPT_CHILD_SID, PLAIN_PARENT_SID, PLAIN_CHILD_SID, FAR_CHILD_SID, ORPHAN_CHILD_SID, FIXED_PARENT_SID, FIXED_CHILD_SID, SWEPT_PARENT_SID, SWEPT_CHILD_SID];
  const readCall = (s) => db('call_log').where({ twilio_call_sid: s }).first();
  // A voicemail an hour ago: the promise lifecycle counts evidence from the
  // end of the call, so the callback (now) is after it.
  const insertCall = async (s, overrides = {}) => {
    const [row] = await db('call_log').insert({
      twilio_call_sid: s,
      direction: 'inbound',
      from_phone: '+15555550144',
      to_phone: '+15555550100',
      status: 'completed',
      duration_seconds: 20,
      processing_status: 'processed',
      call_outcome: 'voicemail',
      answered_by: 'voicemail',
      review_status: 'open',
      created_at: new Date(Date.now() - 60 * 60 * 1000),
      metadata: JSON.stringify({ source: 'voice_webhook', fixture: 'callback-spam' }),
      ...overrides,
    }).returning('id');
    return row.id;
  };
  // The office callback row admin-communications writes: source
  // 'admin-callback', metadata.relatedCallId, dialed to the voicemail's number.
  const insertChild = (s, parentId, overrides = {}) => insertCall(s, {
    direction: 'outbound-api', source: 'admin-callback', from_phone: '+15555550100', to_phone: '+15555550144',
    processing_status: 'spam', processing_generation: 3, processing_token: null, call_outcome: null, answered_by: null,
    review_status: null, created_at: new Date(), metadata: JSON.stringify({ source: 'admin-callback', relatedCallId: parentId }),
    ...overrides,
  });
  const card = (callLogId, reason, status = 'open') => ({ call_log_id: callLogId, category: 'address_review', reason_code: reason, status, summary: 'fixture' });
  const promise = (callLogId, key, kind = 'callback', status = 'open') => ({
    call_log_id: callLogId, commitment_key: key, party: 'waves', kind, description: 'Call the customer back', status, evidence: '[]', source: 'ai',
  });
  const close = (s, procGeneration = 3) => readCall(s).then((c) => processor.closeParentOnCallbackSpam(c, { callSid: s, procGeneration }));
  const reopen = (s, procGeneration = 3) => readCall(s).then((c) => processor.reopenParentOnCallbackCorrected(c, { callSid: s, procGeneration }));

  beforeAll(async () => {
    process.env.GATE_CALLBACK_SPAM_CLOSES_PARENT = 'true';
    process.env.GATE_TRIAGE_AUTO_RESOLVE = 'true';
    process.env.GATE_TRIAGE_AUTO_RESOLVE_EVIDENCE = 'true';
    jest.resetModules();
    db = require('../models/db');
    processor = require('../services/call-recording-processor');
    await db('call_log').whereIn('twilio_call_sid', ALL_SIDS).del();
  });

  afterAll(async () => {
    delete process.env.GATE_CALLBACK_SPAM_CLOSES_PARENT;
    delete process.env.GATE_TRIAGE_AUTO_RESOLVE;
    delete process.env.GATE_TRIAGE_AUTO_RESOLVE_EVIDENCE;
    await db('call_log').whereIn('twilio_call_sid', ALL_SIDS).del(); // cards and commitments cascade
    await db.destroy();
  });

  test('the parent voicemail\'s open asks resolve, its callback promise is dismissed through the promise lifecycle, review closes, verdict stamped; another call is untouched', async () => {
    const parentId = await insertCall(PARENT_SID);
    const otherId = await insertCall(OTHER_PARENT_SID, { from_phone: '+15555550155' });
    await db('triage_items').insert([
      card(parentId, 'missing_service_address'),
      card(parentId, 'missing_last_name', 'in_progress'),
      card(parentId, 'quote_promised', 'resolved'),
      card(otherId, 'missing_service_address'),
    ]);
    await db('call_commitments').insert([
      promise(parentId, 'cb-open'),
      promise(parentId, 'cb-done', 'callback', 'fulfilled'),
      promise(otherId, 'cb-other'),
    ]);
    const childId = await insertChild(CHILD_SID, parentId);

    expect(await close(CHILD_SID)).toEqual({ applied: true, cards: 2, promises: 1, reviewSynced: true });

    const cards = await db('triage_items').where({ call_log_id: parentId }).orderBy('reason_code');
    expect(cards.map((c) => [c.reason_code, c.status, c.resolution_rule])).toEqual([
      ['missing_last_name', 'resolved', 'callback_spam'],
      ['missing_service_address', 'resolved', 'callback_spam'],
      ['quote_promised', 'resolved', null],
    ]);
    const promises = await db('call_commitments').where({ call_log_id: parentId }).orderBy('commitment_key');
    expect(promises.map((p) => [p.commitment_key, p.status, p.fulfillment?.kind || null, p.fulfilled_at])).toEqual([
      ['cb-done', 'fulfilled', null, null],
      ['cb-open', 'dismissed', 'callback_spam', null],
    ]);
    expect(promises[1].fulfillment).toMatchObject({ record_id: childId, strength: 'direct', basis: 'callback_reached_solicitor' });

    const parent = await readCall(PARENT_SID);
    expect(parent.review_status).toBe('resolved');
    expect(parent.processing_status).toBe('processed'); // not re-graded
    expect(parent.metadata.callback_verdict).toMatchObject({ spam: true, callback_call_log_id: childId });

    // The other voicemail keeps its card and its promise.
    expect((await db('triage_items').where({ call_log_id: otherId }).first()).status).toBe('open');
    expect((await db('call_commitments').where({ call_log_id: otherId }).first()).status).toBe('open');
    expect((await readCall(OTHER_PARENT_SID)).review_status).toBe('open');

    // Idempotent: a second verdict finds nothing open and does not reopen anything.
    expect(await close(CHILD_SID)).toEqual({ applied: true, cards: 0, promises: 0, reviewSynced: false });
  });

  test('a card that judges on-file data stays open and keeps the review open', async () => {
    const parentId = await insertCall(KEPT_PARENT_SID, { from_phone: '+15555550166' });
    await db('triage_items').insert([
      card(parentId, 'missing_service_address'),
      card(parentId, 'on_file_house_number_conflict'),
      card(parentId, 'missing_unit_number'),
    ]);
    await insertChild(KEPT_CHILD_SID, parentId, { to_phone: '+15555550166' });

    expect(await close(KEPT_CHILD_SID)).toEqual({ applied: true, cards: 1, promises: 0, reviewSynced: false });
    const cards = await db('triage_items').where({ call_log_id: parentId }).orderBy('reason_code');
    expect(cards.map((c) => [c.reason_code, c.status])).toEqual([
      ['missing_service_address', 'resolved'],
      ['missing_unit_number', 'open'],
      ['on_file_house_number_conflict', 'open'],
    ]);
    expect((await readCall(KEPT_PARENT_SID)).review_status).toBe('open');
  });

  test('a superseded verdict, a parent that is not a voicemail, or a callback to another number writes nothing', async () => {
    // Parent answered live (no voicemail marker): the callback's verdict says nothing about it.
    const plainId = await insertCall(PLAIN_PARENT_SID, { from_phone: '+15555550177', call_outcome: null, answered_by: null });
    await db('triage_items').insert([card(plainId, 'missing_service_address')]);
    await insertChild(PLAIN_CHILD_SID, plainId, { to_phone: '+15555550177' });
    expect(await close(PLAIN_CHILD_SID)).toEqual({ applied: false, reason: 'parent_not_voicemail' });

    // Same parent, now a voicemail, but the pass that calls us is an older generation (a peer reclaimed).
    await db('call_log').where({ id: plainId }).update({ call_outcome: 'voicemail' });
    expect(await close(PLAIN_CHILD_SID, 2)).toEqual({ applied: false, reason: 'verdict_superseded' });
    // A live claim token on the child: its verdict is being re-decided.
    await db('call_log').where({ twilio_call_sid: PLAIN_CHILD_SID }).update({ processing_token: 'tok-live' });
    expect(await close(PLAIN_CHILD_SID)).toEqual({ applied: false, reason: 'verdict_superseded' });
    // The child reprocessed into a real lead: no longer spam.
    await db('call_log').where({ twilio_call_sid: PLAIN_CHILD_SID }).update({ processing_token: null, processing_status: 'processed' });
    expect(await close(PLAIN_CHILD_SID)).toEqual({ applied: false, reason: 'verdict_superseded' });

    // A callback to a different number that merely names this parent.
    await insertChild(FAR_CHILD_SID, plainId, { to_phone: '+15555550199' });
    expect(await close(FAR_CHILD_SID)).toEqual({ applied: false, reason: 'parent_mismatch' });

    expect((await db('triage_items').where({ call_log_id: plainId }).first()).status).toBe('open');
    const parent = await readCall(PLAIN_PARENT_SID);
    expect(parent.review_status).toBe('open');
    expect(parent.metadata.callback_verdict).toBeUndefined();
  });

  test('a parent id that is not an inbound call is reported, not written', async () => {
    const childId = await insertChild(ORPHAN_CHILD_SID, '33333333-3333-4333-8333-333333333333');
    const r = await processor.closeParentOnCallbackSpam(await db('call_log').where({ id: childId }).first(), { callSid: ORPHAN_CHILD_SID, procGeneration: 3 });
    expect(r).toEqual({ applied: false, reason: 'parent_not_found' });
  });

  test('a callback corrected to a real conversation gives the parent back its cards and its promise', async () => {
    const parentId = await insertCall(FIXED_PARENT_SID, { from_phone: '+15555550188' });
    await db('triage_items').insert([card(parentId, 'missing_service_address'), card(parentId, 'on_file_house_number_conflict', 'resolved')]);
    await db('call_commitments').insert([promise(parentId, 'cb-fixed')]);
    const childId = await insertChild(FIXED_CHILD_SID, parentId, { to_phone: '+15555550188' });
    expect(await close(FIXED_CHILD_SID)).toEqual({ applied: true, cards: 1, promises: 1, reviewSynced: true });

    // The correction only counts once the child's row reads processed with no live token, on this pass's generation.
    expect(await reopen(FIXED_CHILD_SID)).toEqual({ applied: false, reason: 'verdict_superseded' });
    await db('call_log').where({ id: childId }).update({ processing_status: 'processed' });
    expect(await reopen(FIXED_CHILD_SID, 2)).toEqual({ applied: false, reason: 'verdict_superseded' });
    expect(await reopen(FIXED_CHILD_SID)).toEqual({ applied: true, cards: 1, promises: 1 });

    const cards = await db('triage_items').where({ call_log_id: parentId }).orderBy('reason_code');
    expect(cards.map((c) => [c.reason_code, c.status, c.resolution_rule])).toEqual([
      ['missing_service_address', 'open', null],
      ['on_file_house_number_conflict', 'resolved', null], // someone else's close stays
    ]);
    const p = await db('call_commitments').where({ call_log_id: parentId }).first();
    expect([p.status, p.fulfillment, p.fulfilled_at]).toEqual(['open', null, null]);
    const parent = await readCall(FIXED_PARENT_SID);
    expect(parent.review_status).toBe('open');
    expect(parent.metadata.callback_verdict).toBeUndefined();
    // Nothing left to undo.
    expect(await reopen(FIXED_CHILD_SID)).toEqual({ applied: false, reason: 'no_verdict' });
  });

  test('the nightly sweep re-closes a moot card a reprocess filed again after the callback verdict', async () => {
    const parentId = await insertCall(SWEPT_PARENT_SID, { from_phone: '+15555550133' });
    // The spam callback happened 30 minutes ago; the card was filed just now (a reprocess).
    await insertChild(SWEPT_CHILD_SID, parentId, { to_phone: '+15555550133', created_at: new Date(Date.now() - 30 * 60 * 1000) });
    await db('triage_items').insert([
      { ...card(parentId, 'missing_service_address'), severity: 'blocking' },
      { ...card(parentId, 'on_file_house_number_conflict'), severity: 'blocking' },
    ]);
    const sweep = require('../services/triage-auto-resolve');
    const result = await sweep.runTriageAutoResolve({ now: new Date() });
    expect(result.skipped).toBeFalsy();
    const cards = await db('triage_items').where({ call_log_id: parentId }).orderBy('reason_code');
    expect(cards.map((c) => [c.reason_code, c.status, c.resolution_rule])).toEqual([
      ['missing_service_address', 'resolved', 'callback_spam'],
      ['on_file_house_number_conflict', 'open', null],
    ]);
    expect((await readCall(SWEPT_PARENT_SID)).review_status).toBe('open'); // one human verdict still owed
  });
});
