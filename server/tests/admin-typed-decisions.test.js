/**
 * /api/admin/typed-decisions: the review queue (subject text read live, never
 * stored) and the label write path (verdict -> label_status, confirmed labels
 * need force, audit-logged).
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  requireAdmin: (req, res, next) => next(),
  adminAuthenticate: (req, _res, next) => {
    req.technician = { id: 'admin-1', email: 'owner@example.test' };
    req.technicianId = 'admin-1';
    return next();
  },
}));
const mockAudit = jest.fn(async () => 'audit-1');
const mockCloseIfEmpty = jest.fn(async () => 0);
jest.mock('../services/typed-decisions/daily-review-item', () => ({ closeIfQueueEmpty: (...a) => mockCloseIfEmpty(...a) }));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: (...a) => mockAudit(...a) }));
const mockEvaluate = jest.fn(async ({ days } = {}) => ({ generatedAt: '2026-10-02T00:00:00.000Z', windowDays: 90, requestedDays: days ?? null, capabilities: [] }));
jest.mock('../services/typed-decisions/eval', () => ({ evaluateCapabilities: (...a) => mockEvaluate(...a) }));

const express = require('express');
const db = require('../models/db');
const router = require('../routes/admin-typed-decisions');
const { callSubjectHash, smsSubjectHash } = require('../services/typed-decisions/subject-hash');

const ID = '11111111-1111-4111-8111-111111111111';
const SEEN = { p: 0.9, yes: true, confident: true };
const baseRow = (over = {}) => ({
  id: ID, capability: 'sms_courtesy', package_id: 'sms_courtesy.v1', package_hash: 'h', served_model: 'jev-1.13.0',
  subject_type: 'sms_log', subject_id: 'sms-1', question_id: 'is_courtesy_only',
  jev_answer: JSON.stringify({ p: 0.9, yes: true, confident: true }), baseline_answers: JSON.stringify({ rules: false }),
  outcome_evidence: null, sampled_for: 'disagreement', label: null, label_status: 'unreviewed', labeled_by: null, labeled_at: null,
  created_at: new Date('2026-09-30T12:00:00Z'), ...over,
});

// A table-keyed knex stand-in. `results[table]` answers awaits and `first`;
// every call is recorded on `log[table]`.
function installDb(results) {
  const log = {};
  db.mockImplementation((table) => {
    const calls = (log[table] = log[table] || []);
    const b = new Proxy({}, {
      get(_t, prop) {
        if (prop === 'then') return (res, rej) => Promise.resolve(results[table]?.list ?? []).then(res, rej);
        if (prop === 'first') return async (...a) => { calls.push(['first', a]); const q = results[table]?.first; return Array.isArray(q) ? q.shift() : q; };
        if (prop === 'returning') return async (...a) => { calls.push(['returning', a]); const row = (results[table]?.returning || []).shift(); return row ? [row] : []; };
        return (...a) => { calls.push([prop, a]); return b; };
      },
    });
    return b;
  });
  db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  return log;
}

let server;
let baseUrl;
beforeAll(() => {
  const app = express();
  app.use(express.json());
  app.use('/admin/typed-decisions', router);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((resolve) => server.close(resolve)));
const gateBefore = process.env.GATE_TYPED_DECISIONS;
beforeEach(() => { db.mockReset(); mockAudit.mockClear(); mockCloseIfEmpty.mockClear(); process.env.GATE_TYPED_DECISIONS = 'true'; });
afterAll(() => { if (gateBefore === undefined) delete process.env.GATE_TYPED_DECISIONS; else process.env.GATE_TYPED_DECISIONS = gateBefore; });

describe('GATE_TYPED_DECISIONS off', () => {
  test('both routes are 404 before any database access', async () => {
    delete process.env.GATE_TYPED_DECISIONS;
    expect((await get('/reviews')).status).toBe(404);
    expect((await post(`/reviews/${ID}/label`, { verdict: 'jev_right', seen_answer: SEEN })).status).toBe(404);
    expect((await get('/status')).status).toBe(404);
    expect(db).not.toHaveBeenCalled();
    expect(mockEvaluate).not.toHaveBeenCalled();
  });
});

const get = async (path) => { const r = await fetch(`${baseUrl}/admin/typed-decisions${path}`); return { status: r.status, body: await r.json() }; };
const post = async (path, body) => {
  const r = await fetch(`${baseUrl}/admin/typed-decisions${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const called = (log, table, method) => (log[table] || []).filter(([m]) => m === method).map(([, a]) => a);

describe('GET /reviews', () => {
  test('lists the queue and joins the subject text live, for display only', async () => {
    const log = installDb({
      decision_reviews: { list: [baseRow(), baseRow({ id: '22222222-2222-4222-8222-222222222222', capability: 'call_judge', package_id: 'call_judge.v2', subject_type: 'call_log', subject_id: 'call-1', question_id: 'is_spam' })] },
      sms_log: { list: [{ id: 'sms-1', from_phone: '+15550000001', to_phone: '+15550000002', direction: 'inbound', message_body: 'Thanks!', created_at: new Date('2026-09-30T11:59:00Z') }], first: { message_body: 'See you Tuesday.' } },
      call_log: { list: [{ id: 'call-1', direction: 'inbound', created_at: new Date(), transcription: 'Agent: Waves. Caller: hello.' }] },
    });
    const { status, body } = await get('/reviews?status=unreviewed&sampled_for=disagreement,random_audit&limit=50');
    expect(status).toBe(200);
    expect(body.count).toBe(2);
    const sms = body.reviews.find((r) => r.subjectType === 'sms_log');
    expect(sms).toMatchObject({ capability: 'sms_courtesy', questionId: 'is_courtesy_only', labelStatus: 'unreviewed', sampledFor: 'disagreement' });
    expect(sms.jevAnswer).toMatchObject({ yes: true });
    expect(sms.baselineAnswers).toEqual({ rules: false });
    expect(sms.question).toMatch(/courtesy closer/);
    expect(sms.subject).toMatchObject({ text: 'Thanks!', previousText: 'See you Tuesday.' });
    expect(body.reviews.find((r) => r.subjectType === 'call_log').subject).toMatchObject({ text: 'Agent: Waves. Caller: hello.' });
    // The previous text is read the way the shadow read it: this line's phone
    // pair, successful sends only, in the 24h before the customer's text.
    expect(called(log, 'sms_log', 'where')).toContainEqual([{ direction: 'outbound', to_phone: '+15550000001', from_phone: '+15550000002' }]);
    expect(called(log, 'sms_log', 'whereIn')).toContainEqual(['status', ['queued', 'sent', 'delivered']]);
    expect(called(log, 'sms_log', 'where')).toContainEqual(['created_at', '>', new Date('2026-09-29T11:59:00Z')]);
    expect(called(log, 'sms_log', 'where')).toContainEqual(['created_at', '<', new Date('2026-09-30T11:59:00Z')]);
    // Filters reached the query; the transcript is cut in SQL.
    expect(called(log, 'decision_reviews', 'where')).toContainEqual(['label_status', 'unreviewed']);
    expect(called(log, 'decision_reviews', 'whereIn')).toContainEqual(['sampled_for', ['disagreement', 'random_audit']]);
    expect(called(log, 'decision_reviews', 'limit')).toContainEqual([50]);
    // the span call_judge was given, cut in JS exactly as call-self-audit cuts it; no digest leaves the server
    expect(JSON.stringify(body.reviews)).not.toMatch(/"hash"/);
    // Reads only: nothing is written anywhere.
    expect(Object.keys(log).flatMap((t) => log[t]).filter(([m]) => ['insert', 'update', 'delete'].includes(m))).toEqual([]);
  });

  test('before_id pages strictly after that row in (created_at, id) order; a bad id is 400', async () => {
    const log = installDb({ decision_reviews: { list: [] } });
    expect((await get(`/reviews?before_id=${ID}`)).status).toBe(200);
    expect(called(log, 'decision_reviews', 'orderBy')).toContainEqual([[{ column: 'created_at', order: 'desc' }, { column: 'id', order: 'desc' }]]);
    expect(called(log, 'decision_reviews', 'whereRaw')).toContainEqual(['(created_at, id) < (SELECT created_at, id FROM decision_reviews WHERE id = ?)', [ID]]);
    expect((await get('/reviews?before_id=yesterday')).status).toBe(400);
  });

  test('a call whose live transcript no longer matches its stored digest is flagged subjectChanged', async () => {
    const row = (id, hash) => baseRow({ id, capability: 'call_judge', package_id: 'call_judge.v2', subject_type: 'call_log', subject_id: 'call-1', question_id: 'is_spam', subject_hash: hash });
    installDb({
      decision_reviews: { list: [row('a1111111-1111-4111-8111-111111111111', callSubjectHash('Caller: old')), row('b1111111-1111-4111-8111-111111111111', callSubjectHash('Caller: now')), row('c1111111-1111-4111-8111-111111111111', null)] },
      call_log: { list: [{ id: 'call-1', direction: 'inbound', created_at: new Date(), transcription: 'Caller: now' }] },
    });
    const { body } = await get('/reviews');
    expect(body.reviews.map((r) => r.subjectChanged)).toEqual([true, false, false]);
    expect(body.reviews[1].subjectVersion).toBe(callSubjectHash('Caller: now'));
  });

  test('rejects an unknown status or sampled_for, clamps the limit', async () => {
    installDb({ decision_reviews: { list: [] } });
    expect((await get('/reviews?status=nope')).status).toBe(400);
    expect((await get('/reviews?sampled_for=disagreement,bogus')).status).toBe(400);
    const log = installDb({ decision_reviews: { list: [] } });
    expect((await get('/reviews?status=all&limit=9999')).status).toBe(200);
    expect(called(log, 'decision_reviews', 'limit')).toContainEqual([200]);
    expect(called(log, 'decision_reviews', 'where').some(([c]) => c === 'label_status')).toBe(false);
  });

  test('a failed subject read leaves the rows without text instead of failing the page', async () => {
    installDb({ decision_reviews: { list: [baseRow()] } });
    db.mockImplementation((table) => {
      if (table === 'decision_reviews') { const b = new Proxy({}, { get: (_t, p) => (p === 'then' ? (res) => Promise.resolve([baseRow()]).then(res) : () => b) }); return b; }
      throw new Error('sms_log down');
    });
    const { status, body } = await get('/reviews');
    expect(status).toBe(200);
    expect(body.reviews[0].subject).toBeNull();
  });
});

describe('POST /reviews/:id/label', () => {
  test.each([
    ['jev_right', 'confirmed_correct'],
    ['jev_wrong', 'confirmed_error'],
    ['unclear', 'disagreement'],
  ])('%s sets label_status %s, stamps who and when, and is audit-logged', async (verdict, status) => {
    const log = installDb({ decision_reviews: { returning: [baseRow({ label_status: status })], first: [baseRow()] } });
    const { status: http, body } = await post(`/reviews/${ID}/label`, { verdict, correct_value: false, note: 'checked the call', seen_answer: SEEN });
    expect(http).toBe(200);
    expect(body.review.labelStatus).toBe(status);
    const [patch] = called(log, 'decision_reviews', 'update')[0];
    expect(patch.label_status).toBe(status);
    // only jev_wrong carries a correct_value
    expect(JSON.parse(patch.label)).toEqual({ verdict, correct_value: verdict === 'jev_wrong' ? false : null, note: 'checked the call', reason: null });
    expect(patch.labeled_by).toBe('owner@example.test');
    expect(patch.labeled_at).toBeInstanceOf(Date);
    expect(called(log, 'decision_reviews', 'where')).toContainEqual([{ id: ID }]);
    // Unforced: a confirmed label is not replaced.
    expect(called(log, 'decision_reviews', 'whereNotIn')).toContainEqual(['label_status', ['confirmed_correct', 'confirmed_error']]);
    // only while the row still holds the answer the reviewer saw
    expect(called(log, 'decision_reviews', 'whereRaw')).toContainEqual(['jev_answer = ?::jsonb', [JSON.stringify(SEEN)]]);
    // and the transcript version shown (null for a text subject)
    expect(called(log, 'decision_reviews', 'whereRaw')).toContainEqual(['subject_hash IS NOT DISTINCT FROM ?', [null]]);
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
      actor_type: 'technician', actor_id: 'admin-1', action: 'typed_decision.labeled', resource_type: 'decision_review', resource_id: ID,
      metadata: expect.objectContaining({ verdict, label_status: status, forced: false }),
    }));
    expect(JSON.stringify(mockAudit.mock.calls)).not.toMatch(/checked the call/);
    // a label may finish the queue: the daily review item is closed when it does
    expect(mockCloseIfEmpty).toHaveBeenCalledTimes(1);
  });

  test('refuses to re-label a confirmed row without force (409), and says which status it holds', async () => {
    installDb({ decision_reviews: { returning: [undefined], first: [baseRow(), { id: ID, label_status: 'confirmed_error' }] } });
    const { status, body } = await post(`/reviews/${ID}/label`, { verdict: 'jev_right', seen_answer: SEEN });
    expect(status).toBe(409);
    expect(body.labelStatus).toBe('confirmed_error');
    expect(body.code).toBe('already_confirmed');
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('force: true replaces a confirmed label and the audit row says so', async () => {
    const log = installDb({ decision_reviews: { returning: [baseRow({ label_status: 'confirmed_correct' })], first: [baseRow()] } });
    const { status } = await post(`/reviews/${ID}/label`, { verdict: 'jev_right', force: true, seen_answer: SEEN });
    expect(status).toBe(200);
    expect(called(log, 'decision_reviews', 'whereNotIn')).toEqual([]);
    expect(mockAudit.mock.calls[0][0].metadata.forced).toBe(true);
  });

  test('a missing review is 404; a malformed id never reaches the database', async () => {
    installDb({ decision_reviews: { returning: [undefined], first: [undefined] } });
    expect((await post(`/reviews/${ID}/label`, { verdict: 'unclear', seen_answer: SEEN })).status).toBe(404);
    db.mockClear();
    expect((await post('/reviews/not-a-uuid/label', { verdict: 'unclear' })).status).toBe(404);
    expect(db).not.toHaveBeenCalled();
  });

  test.each([
    ['no verdict', {}],
    ['an unknown verdict', { verdict: 'maybe' }],
    ['jev_wrong with no correct_value', { verdict: 'jev_wrong' }],
    ['no seen_answer', { verdict: 'jev_right' }],
    ['a non-object seen_answer', { verdict: 'unclear', seen_answer: 'yes' }],
    ['jev_wrong with a string for a yes/no question', { verdict: 'jev_wrong', correct_value: 'no' }],
    ['jev_wrong with free text', { verdict: 'jev_wrong', correct_value: 'x'.repeat(3000) }],
    ['jev_wrong whose correct_value repeats Jev\'s answer', { verdict: 'jev_wrong', correct_value: true, seen_answer: SEEN }],
    ['an unknown one-tap reason', { verdict: 'jev_right', seen_answer: SEEN, reason: 'bad_vibes' }],
  ])('%s is 400 and writes nothing', async (_name, payload) => {
    const log = installDb({ decision_reviews: { first: [baseRow()] } });
    expect((await post(`/reviews/${ID}/label`, payload)).status).toBe(400);
    expect(called(log, 'decision_reviews', 'update')).toEqual([]);
  });

  test('the one-tap reason rides inside the label and the audit row names it, never the note text', async () => {
    const log = installDb({ decision_reviews: { returning: [baseRow({ label_status: 'confirmed_error' })], first: [baseRow()] } });
    const { status: http } = await post(`/reviews/${ID}/label`, { verdict: 'jev_wrong', correct_value: false, note: 'they only said thanks', reason: 'wrong_tone', seen_answer: SEEN });
    expect(http).toBe(200);
    const [patch] = called(log, 'decision_reviews', 'update')[0];
    expect(JSON.parse(patch.label)).toEqual({ verdict: 'jev_wrong', correct_value: false, note: 'they only said thanks', reason: 'wrong_tone' });
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ reason: 'wrong_tone' }) }));
    expect(JSON.stringify(mockAudit.mock.calls)).not.toMatch(/only said thanks/);
  });

  test('an answer re-recorded since the page loaded is 409 answer_changed, not a label', async () => {
    installDb({ decision_reviews: { returning: [undefined], first: [baseRow(), { id: ID, label_status: 'unreviewed' }] } });
    const { status, body } = await post(`/reviews/${ID}/label`, { verdict: 'jev_right', seen_answer: { p: 0.2, yes: false, confident: false } });
    expect(status).toBe(409);
    expect(body.code).toBe('answer_changed');
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('a call reprocessed after Jev answered is 409 subject_changed, and nothing is written', async () => {
    const callRow = baseRow({ subject_type: 'call_log', subject_id: 'call-1', capability: 'call_judge', package_id: 'call_judge.v2', question_id: 'is_spam', subject_hash: callSubjectHash('Caller: the original words') });
    const log = installDb({ decision_reviews: { first: [callRow] }, call_log: { first: [{ transcription: 'Caller: new words after reprocessing' }] } });
    const { status, body } = await post(`/reviews/${ID}/label`, { verdict: 'jev_right', seen_answer: SEEN });
    expect(status).toBe(409);
    expect(body.code).toBe('subject_changed');
    expect(called(log, 'decision_reviews', 'update')).toEqual([]);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('a text whose earlier Waves message now resolves differently is 409 subject_changed', async () => {
    const smsRow = baseRow({ subject_hash: smsSubjectHash({ previous: 'See you Tuesday.', body: 'Thanks!' }) });
    const log = installDb({
      decision_reviews: { first: [smsRow] },
      // the inbound row, then the previous-text lookup: that send no longer qualifies
      sms_log: { first: [{ from_phone: '+15550000001', to_phone: '+15550000002', message_body: 'Thanks!', created_at: new Date('2026-09-30T11:59:00Z') }, undefined] },
    });
    const { status, body } = await post(`/reviews/${ID}/label`, { verdict: 'jev_right', seen_answer: SEEN, seen_subject: smsRow.subject_hash });
    expect(status).toBe(409);
    expect(body.code).toBe('subject_changed');
    expect(called(log, 'decision_reviews', 'update')).toEqual([]);
  });

  test('the same call transcript labels normally, bound to the transcript version shown', async () => {
    const words = 'Caller: the original words';
    const version = callSubjectHash(words);
    const callRow = baseRow({ subject_type: 'call_log', subject_id: 'call-1', capability: 'call_judge', package_id: 'call_judge.v2', question_id: 'is_spam', subject_hash: version });
    const log = installDb({ decision_reviews: { first: [callRow], returning: [callRow] }, call_log: { first: [{ transcription: words }] } });
    expect((await post(`/reviews/${ID}/label`, { verdict: 'jev_right', seen_answer: SEEN, seen_subject: version })).status).toBe(200);
    expect(called(log, 'decision_reviews', 'whereRaw')).toContainEqual(['subject_hash IS NOT DISTINCT FROM ?', [version]]);
  });

  test('jev_wrong on a missing review is 404 before any write', async () => {
    const log = installDb({ decision_reviews: { first: [undefined] } });
    expect((await post(`/reviews/${ID}/label`, { verdict: 'jev_wrong', correct_value: false, seen_answer: SEEN })).status).toBe(404);
    expect(called(log, 'decision_reviews', 'update')).toEqual([]);
  });

  test('a note is trimmed to its cap and an absent correct_value is stored as null', async () => {
    const log = installDb({ decision_reviews: { returning: [baseRow()], first: [baseRow()] } });
    await post(`/reviews/${ID}/label`, { verdict: 'unclear', note: 'n'.repeat(5000), seen_answer: SEEN });
    const label = JSON.parse(called(log, 'decision_reviews', 'update')[0][0].label);
    expect(label.note).toHaveLength(2000);
    expect(label.correct_value).toBeNull();
  });
});

describe('GET /status', () => {
  test('returns the per-capability evaluation for the requested window; the route itself reads nothing', async () => {
    installDb({});
    mockEvaluate.mockClear();
    const { status, body } = await get('/status?days=30');
    expect(status).toBe(200);
    expect(body).toMatchObject({ windowDays: 90, requestedDays: '30', capabilities: [] });
    expect(mockEvaluate).toHaveBeenCalledWith({ days: '30' });
    expect(db).not.toHaveBeenCalled();
  });

  test('an evaluation failure is a 500 through the error handler, never a partial payload', async () => {
    installDb({});
    mockEvaluate.mockRejectedValueOnce(new Error('relation missing'));
    const { status, body } = await get('/status');
    expect(status).toBe(500);
    expect(body.error).toMatch(/relation missing/);
  });
});
