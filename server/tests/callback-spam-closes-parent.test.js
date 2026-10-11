// A callback that reaches a solicitor settles its parent voicemail
// (GATE_CALLBACK_SPAM_CLOSES_PARENT): the parent's open Needs Review cards
// resolve, its open callback promise is dismissed, review_status syncs, and
// metadata.callback_verdict is stamped. The parent's processing_status, lead
// and customer are not touched. Nothing is sent.
//
// Unit cases need no database (the gate and direction checks return before
// any query). The behavior suite runs on real rows (DATABASE_URL only, same
// convention as call-processor-shutdown-release.test.js). Fixtures are
// fictitious: 555-01xx numbers, fake SIDs, no transcript text.
const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const sid = (tail) => 'CA' + '7'.repeat(30) + tail;
const PARENT_SID = sid('p1');
const CHILD_SID = sid('c1');
const OTHER_PARENT_SID = sid('p2');

describe('closeParentOnCallbackSpam without a database', () => {
  test('gate off: nothing happens', async () => {
    let processor;
    jest.isolateModules(() => {
      delete process.env.GATE_CALLBACK_SPAM_CLOSES_PARENT;
      processor = require('../services/call-recording-processor');
    });
    const r = await processor.closeParentOnCallbackSpam({ direction: 'outbound', metadata: { relatedCallId: '11111111-1111-4111-8111-111111111111' } });
    expect(r).toEqual({ applied: false, reason: 'gated_off' });
  });

  test('gate on: an inbound call, or a callback with no parent, is left alone before any query', async () => {
    let processor;
    jest.isolateModules(() => {
      process.env.GATE_CALLBACK_SPAM_CLOSES_PARENT = 'true';
      processor = require('../services/call-recording-processor');
    });
    delete process.env.GATE_CALLBACK_SPAM_CLOSES_PARENT;
    expect(await processor.closeParentOnCallbackSpam({ direction: 'inbound', metadata: { relatedCallId: '11111111-1111-4111-8111-111111111111' } })).toEqual({ applied: false, reason: 'not_outbound' });
    expect(await processor.closeParentOnCallbackSpam({ direction: 'outbound', metadata: {} })).toEqual({ applied: false, reason: 'no_parent' });
    expect(await processor.closeParentOnCallbackSpam({ direction: 'outbound', metadata: JSON.stringify({ relatedCallId: 'undefined' }) })).toEqual({ applied: false, reason: 'no_parent' });
    expect(await processor.closeParentOnCallbackSpam({ direction: 'outbound-api', metadata: 'not json' })).toEqual({ applied: false, reason: 'no_parent' });
  });
});

maybeDescribe('closeParentOnCallbackSpam on real rows (live Postgres)', () => {
  let db;
  let processor;
  const ALL_SIDS = [PARENT_SID, CHILD_SID, OTHER_PARENT_SID];
  const readCall = (s) => db('call_log').where({ twilio_call_sid: s }).first();
  const insertCall = async (s, overrides = {}) => {
    const [row] = await db('call_log').insert({
      twilio_call_sid: s,
      direction: 'inbound',
      from_phone: '+15555550144',
      to_phone: '+15555550100',
      status: 'completed',
      duration_seconds: 20,
      processing_status: 'voicemail',
      answered_by: 'voicemail',
      review_status: 'open',
      metadata: JSON.stringify({ source: 'voice_webhook', fixture: 'callback-spam' }),
      ...overrides,
    }).returning('id');
    return row.id;
  };

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

  test('the parent voicemail\'s open cards resolve, its callback promise is dismissed, review closes, verdict stamped; another call is untouched', async () => {
    const parentId = await insertCall(PARENT_SID);
    const otherId = await insertCall(OTHER_PARENT_SID, { from_phone: '+15555550155' });
    const card = (callLogId, reason, status = 'open') => ({ call_log_id: callLogId, category: 'address_review', reason_code: reason, status, summary: 'fixture' });
    await db('triage_items').insert([
      card(parentId, 'missing_service_address'),
      card(parentId, 'missing_last_name', 'in_progress'),
      card(parentId, 'quote_promised', 'resolved'),
      card(otherId, 'missing_service_address'),
    ]);
    const promise = (callLogId, key, kind = 'callback', status = 'open') => ({
      call_log_id: callLogId, commitment_key: key, party: 'waves', kind, description: 'Call the customer back', status, evidence: '[]',
    });
    await db('call_commitments').insert([
      promise(parentId, 'cb-open'),
      promise(parentId, 'cb-done', 'callback', 'fulfilled'),
      promise(otherId, 'cb-other'),
    ]);
    const childId = await insertCall(CHILD_SID, {
      direction: 'outbound-api', from_phone: '+15555550100', to_phone: '+15555550144', processing_status: 'spam', answered_by: null,
      review_status: null, metadata: JSON.stringify({ source: 'admin-callback', relatedCallId: parentId }),
    });

    const r = await processor.closeParentOnCallbackSpam(await readCall(CHILD_SID), { callSid: CHILD_SID });
    expect(r).toEqual({ applied: true, cards: 2, promises: 1, reviewSynced: true });

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
    expect(parent.processing_status).toBe('voicemail'); // not re-graded
    expect(parent.metadata.callback_verdict).toMatchObject({ spam: true, callback_call_log_id: childId });

    // The other voicemail keeps its card and its promise.
    expect((await db('triage_items').where({ call_log_id: otherId }).first()).status).toBe('open');
    expect((await db('call_commitments').where({ call_log_id: otherId }).first()).status).toBe('open');
    expect((await readCall(OTHER_PARENT_SID)).review_status).toBe('open');

    // Idempotent: a second verdict finds nothing open and does not reopen anything.
    expect(await processor.closeParentOnCallbackSpam(await readCall(CHILD_SID), { callSid: CHILD_SID })).toEqual({ applied: true, cards: 0, promises: 0, reviewSynced: false });
  });

  test('a parent id that is not an inbound call is reported, not written', async () => {
    const r = await processor.closeParentOnCallbackSpam({ id: '22222222-2222-4222-8222-222222222222', direction: 'outbound-api', metadata: { relatedCallId: '33333333-3333-4333-8333-333333333333' } });
    expect(r).toEqual({ applied: false, reason: 'parent_not_found' });
  });
});
