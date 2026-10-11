// A callback that reaches a solicitor settles its parent voicemail
// (GATE_CALLBACK_SPAM_CLOSES_PARENT): the parent's open Needs Review cards
// that a return call would have answered resolve, its open callback promise is
// dismissed, review_status syncs, and metadata.callback_verdict is stamped.
// Cards that judge on-file data stay. The parent's processing_status, lead
// and customer are not touched. Nothing is sent.
//
// Eligibility (codex #6271 r1): the child is an admin callback (source
// 'admin-callback') to the parent's own number or customer; the parent is an
// inbound voicemail; the child's spam verdict is still the one on the row
// (same generation, no live token). The shared triage lock is taken first.
//
// Unit cases need no database (the gate, direction, source and parent-id
// checks return before any query). The behavior suite runs on real rows
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
});

maybeDescribe('closeParentOnCallbackSpam on real rows (live Postgres)', () => {
  let db;
  let processor;
  const ALL_SIDS = [PARENT_SID, CHILD_SID, OTHER_PARENT_SID, KEPT_PARENT_SID, KEPT_CHILD_SID, PLAIN_PARENT_SID, PLAIN_CHILD_SID, FAR_CHILD_SID];
  const readCall = (s) => db('call_log').where({ twilio_call_sid: s }).first();
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
    review_status: null, metadata: JSON.stringify({ source: 'admin-callback', relatedCallId: parentId }),
    ...overrides,
  });
  const card = (callLogId, reason, status = 'open') => ({ call_log_id: callLogId, category: 'address_review', reason_code: reason, status, summary: 'fixture' });
  const promise = (callLogId, key, kind = 'callback', status = 'open') => ({
    call_log_id: callLogId, commitment_key: key, party: 'waves', kind, description: 'Call the customer back', status, evidence: '[]',
  });
  const close = (s, procGeneration = 3) => readCall(s).then((c) => processor.closeParentOnCallbackSpam(c, { callSid: s, procGeneration }));

  beforeAll(async () => {
    process.env.GATE_CALLBACK_SPAM_CLOSES_PARENT = 'true';
    jest.resetModules();
    db = require('../models/db');
    processor = require('../services/call-recording-processor');
    await db('call_log').whereIn('twilio_call_sid', ALL_SIDS).del();
  });

  afterAll(async () => {
    delete process.env.GATE_CALLBACK_SPAM_CLOSES_PARENT;
    await db('call_log').whereIn('twilio_call_sid', ALL_SIDS).del(); // cards and commitments cascade
    await db.destroy();
  });

  test('the parent voicemail\'s open asks resolve, its callback promise is dismissed, review closes, verdict stamped; another call is untouched', async () => {
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
    expect(promises.map((p) => [p.commitment_key, p.status, p.fulfillment?.closed_by || null, p.fulfilled_at])).toEqual([
      ['cb-done', 'fulfilled', null, null],
      ['cb-open', 'dismissed', 'callback_spam', null],
    ]);
    expect(promises[1].fulfillment.callback_call_log_id).toBe(childId);

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
    const childId = await insertChild(sid('c6'), '33333333-3333-4333-8333-333333333333');
    ALL_SIDS.push(sid('c6'));
    const r = await processor.closeParentOnCallbackSpam(await db('call_log').where({ id: childId }).first(), { callSid: sid('c6'), procGeneration: 3 });
    expect(r).toEqual({ applied: false, reason: 'parent_not_found' });
  });
});
