jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/email/gmail-client', () => ({ sendMessage: jest.fn(), isConnected: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn() }));
// the §13 recipient lookup is exercised in its own suite; here it is clear unless a test says otherwise
jest.mock('../services/seo/link-outreach-mandate', () => ({ ...jest.requireActual('../services/seo/link-outreach-mandate'), recipientReview: jest.fn() }));

const db = require('../models/db');
const gmail = require('../services/email/gmail-client');
const { isEnabled } = require('../config/feature-gates');
const M = require('../services/seo/link-outreach-mandate');
const Outreach = require('../services/seo/link-prospect-outreach');
// the shipped lane: the outreach gate on, the authority contract (GATE_LINK_AUTHORITY) off — no rows decided
const outreachGateOn = () => isEnabled.mockImplementation((g) => g === 'linkProspectOutreach');
const clearReview = (to = 'editor@bradentonherald.com') => ({ kind: 'clear', recipient: to, matched: [], lookup_hash: 'h-clear' });

// Minimal chainable knex mock. `result` is what awaiting the builder resolves to
// (used by .update() compare-and-swaps that read the affected-row count); `first`
// and `returning` back .first() / .returning('*'). .where(fn) ignores the callback
// (the cap-count's nested where/orWhere never has to execute under the mock).
function chain({ result = [], first, returning } = {}) {
  const q = {};
  ['where', 'whereRaw', 'whereIn', 'whereNull', 'whereNotNull', 'orWhere', 'andWhere', 'orderBy', 'orderByRaw', 'select', 'count', 'forUpdate']
    .forEach((m) => { q[m] = jest.fn(() => q); });
  q.update = jest.fn(() => q);
  q.first = jest.fn(async () => first);
  q.returning = jest.fn(async () => returning || []);
  q.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  q.catch = (reject) => Promise.resolve(result).catch(reject);
  return q;
}

// Queue chain responses per table, consumed in call order. Also wires the
// transaction + raw helpers the send path uses (trx === db so it shares the queue).
function setDbQueues(queues) {
  const tableQueues = new Map(Object.entries(queues));
  db.mockImplementation((table) => {
    // the policy read under the lock (§6.4 cap): defaults unless a test queues a row
    if (table === 'seo_link_policy' && !tableQueues.has(table)) return chain({ first: undefined });
    if (table === 'seo_link_attempts' && !tableQueues.has(table)) return chain();
    const q = tableQueues.get(table);
    if (!q || q.length === 0) throw new Error(`unexpected db('${table}') call (queue empty)`);
    return q.shift();
  });
  db.transaction = jest.fn(async (cb) => cb(db));
  db.raw = jest.fn(async () => []);
}

const draftedProspect = (over = {}) => ({
  id: 'p1',
  link_type: 'editorial',
  status: 'prospect',
  outreach_status: 'drafted',
  outreach_to_email: 'editor@bradentonherald.com',
  outreach_subject: 'Local pest-pressure data for your readers',
  outreach_body: 'Hi there,\nWe track Gulf Coast pest activity...',
  outreach_sent_at: null,
  updated_at: null,
  notes: null,
  owner: null,
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.LINK_OUTREACH_DAILY_CAP;
  gmail.isConnected.mockResolvedValue(true); // connected by default; the not-connected test overrides
  M.recipientReview.mockResolvedValue(clearReview());
});

describe('isValidEmail', () => {
  test('accepts a normal address, rejects garbage', () => {
    expect(Outreach.isValidEmail('a@b.com')).toBe(true);
    expect(Outreach.isValidEmail('  editor@site.co.uk ')).toBe(true);
    expect(Outreach.isValidEmail('no-at-sign')).toBe(false);
    expect(Outreach.isValidEmail('two@@b.com')).toBe(false);
    expect(Outreach.isValidEmail('spaces in@b.com')).toBe(false);
    expect(Outreach.isValidEmail('nodot@domain')).toBe(false);
    expect(Outreach.isValidEmail('')).toBe(false);
    expect(Outreach.isValidEmail(null)).toBe(false);
    expect(Outreach.isValidEmail(`${'x'.repeat(250)}@b.com`)).toBe(false); // > 254
  });
});

describe('textToHtml', () => {
  test('escapes HTML and converts newlines to <br>', () => {
    expect(Outreach.textToHtml('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
    expect(Outreach.textToHtml('line1\nline2\r\nline3')).toBe('line1<br>\nline2<br>\nline3');
    expect(Outreach.textToHtml(null)).toBe('');
  });
});

describe('dailyCap', () => {
  test('defaults to 12 and honors a valid env override', () => {
    expect(Outreach.dailyCap()).toBe(Outreach.DEFAULT_DAILY_CAP);
    process.env.LINK_OUTREACH_DAILY_CAP = '5';
    expect(Outreach.dailyCap()).toBe(5);
    process.env.LINK_OUTREACH_DAILY_CAP = 'nonsense';
    expect(Outreach.dailyCap()).toBe(12);
    process.env.LINK_OUTREACH_DAILY_CAP = '0';
    expect(Outreach.dailyCap()).toBe(12); // non-positive ignored
  });
});

describe('checkSendPreconditions (pure)', () => {
  const base = { prospect: draftedProspect(), gateOn: true, dailyCount: 0, cap: 12 };
  test('passes a complete drafted outreach prospect under the cap', () => {
    expect(Outreach.checkSendPreconditions(base)).toEqual({ ok: true });
  });
  test('gate off short-circuits everything', () => {
    expect(Outreach.checkSendPreconditions({ ...base, gateOn: false }).code).toBe('gate_off');
  });
  test('missing prospect → not_found', () => {
    expect(Outreach.checkSendPreconditions({ ...base, prospect: null }).code).toBe('not_found');
  });
  test('non-outreach link_type → not_outreach', () => {
    expect(Outreach.checkSendPreconditions({ ...base, prospect: draftedProspect({ link_type: 'directory' }) }).code).toBe('not_outreach');
  });
  test('already sent (timestamp) → already_sent', () => {
    expect(Outreach.checkSendPreconditions({ ...base, prospect: draftedProspect({ outreach_sent_at: new Date() }) }).code).toBe('already_sent');
  });
  test('already sent (status) → already_sent', () => {
    expect(Outreach.checkSendPreconditions({ ...base, prospect: draftedProspect({ outreach_status: 'sent' }) }).code).toBe('already_sent');
  });
  test('terminal lifecycle status → not_actionable', () => {
    expect(Outreach.checkSendPreconditions({ ...base, prospect: draftedProspect({ status: 'rejected' }) }).code).toBe('not_actionable');
  });
  test('no draft yet → no_draft', () => {
    expect(Outreach.checkSendPreconditions({ ...base, prospect: draftedProspect({ outreach_status: 'none' }) }).code).toBe('no_draft');
  });
  test('invalid recipient → invalid_recipient', () => {
    expect(Outreach.checkSendPreconditions({ ...base, prospect: draftedProspect({ outreach_to_email: 'nope' }) }).code).toBe('invalid_recipient');
  });
  test('missing body → incomplete_draft', () => {
    expect(Outreach.checkSendPreconditions({ ...base, prospect: draftedProspect({ outreach_body: '' }) }).code).toBe('incomplete_draft');
  });
  test('at the daily cap → rate_limited', () => {
    expect(Outreach.checkSendPreconditions({ ...base, dailyCount: 12 }).code).toBe('rate_limited');
  });
});

describe('sendOutreach', () => {
  test('happy path: sends the CLAIMED draft, marks contacted/sent, records thread ref', async () => {
    outreachGateOn();
    gmail.sendMessage.mockResolvedValue({ id: 'msg1', threadId: 'thr1' });
    const finalRow = draftedProspect({ status: 'contacted', outreach_status: 'sent' });
    setDbQueues({ seo_link_prospects: [
      chain({ first: draftedProspect() }),         // pre-read (fast-fail checks)
      chain({ first: { id: 'p1' } }),                 // [txn] prospect row lock (prospect → path order)
      chain({ result: [] }),                       // [txn] inbox guard: no other conversation with this recipient
      chain({ result: [] }),                       // [txn] pre-send settlement's row read → path unchanged
      chain({ first: draftedProspect({ path_id: 'path-ok', leased_path_revision: 1 }) }),    // [txn] the path it will send on…
      chain({ first: { c: '0' } }),                // [txn] dailySendCount under the lock (after the authority check)                // [txn] dailySendCount under the lock
      chain({ returning: [draftedProspect()] }),   // [txn] CAS claim → returns the locked row
      chain({ returning: [finalRow] }),            // finalize → sent (token-gated)
    ], seo_link_acquisition_paths: [chain({ first: { id: 'path-ok', superseded_by: null, confidence: 0.7, agent_completable: true, revision: 1 } })] }); // …is live and standing

    const res = await Outreach.sendOutreach({ prospectId: 'p1', approvedBy: 'Adam' });
    expect(res.ok).toBe(true);
    expect(res.message_id).toBe('msg1');
    expect(res.thread_id).toBe('thr1');
    expect(db.transaction).toHaveBeenCalledTimes(2); // the claim, then the finalize (with the instance satisfaction)
    expect(db.raw).toHaveBeenCalled(); // advisory lock acquired
    expect(gmail.sendMessage).toHaveBeenCalledTimes(1);
    const [to, subject, htmlBody] = gmail.sendMessage.mock.calls[0];
    expect(to).toBe('editor@bradentonherald.com');
    expect(subject).toBe('Local pest-pressure data for your readers');
    expect(htmlBody).toContain('<br>');
  });

  test('finalize matches no row after a real send → finalize_failed (surfaced, not silent ok)', async () => {
    outreachGateOn();
    gmail.sendMessage.mockResolvedValue({ id: 'msg9', threadId: 'thr9' });
    setDbQueues({ seo_link_prospects: [
      chain({ first: draftedProspect() }),
      chain({ first: { id: 'p1' } }),                 // [txn] prospect row lock (prospect → path order)
      chain({ result: [] }),                       // [txn] inbox guard: no other conversation with this recipient
      chain({ result: [] }),                       // [txn] pre-send settlement's row read → path unchanged
      chain({ first: draftedProspect({ path_id: 'path-ok', leased_path_revision: 1 }) }),    // [txn] the path it will send on…
      chain({ first: { c: '0' } }),                // [txn] dailySendCount under the lock (after the authority check)
      chain({ returning: [draftedProspect()] }), // CAS claim
      chain({ returning: [] }),                  // finalize (row still awaiting its conversation) matched 0 rows…
      chain({ returning: [] }),                  // …and so did the lifecycle-preserving fallback: the token is gone
    ], seo_link_acquisition_paths: [chain({ first: { id: 'path-ok', superseded_by: null, confidence: 0.7, agent_completable: true, revision: 1 } })] });
    const res = await Outreach.sendOutreach({ prospectId: 'p1' });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('finalize_failed');
    expect(res.message_id).toBe('msg9'); // the send happened — caller can reconcile
    expect(gmail.sendMessage).toHaveBeenCalledTimes(1);
  });

  test('gate off → gate_off, never opens a txn or sends', async () => {
    isEnabled.mockReturnValue(false);
    setDbQueues({ seo_link_prospects: [chain({ first: draftedProspect() })] });
    const res = await Outreach.sendOutreach({ prospectId: 'p1' });
    expect(res.code).toBe('gate_off');
    expect(db.transaction).not.toHaveBeenCalled();
    expect(gmail.sendMessage).not.toHaveBeenCalled();
  });

  test('at the daily cap (checked atomically in the txn) → rate_limited, never sends', async () => {
    outreachGateOn();
    setDbQueues({ seo_link_prospects: [
      chain({ first: draftedProspect() }),
      chain({ first: { id: 'p1' } }),                 // [txn] prospect row lock (prospect → path order)
      chain({ result: [] }),                       // [txn] inbox guard: no other conversation with this recipient
      chain({ result: [] }),                       // [txn] pre-send settlement's row read → path unchanged
      chain({ first: draftedProspect({ path_id: 'path-ok', leased_path_revision: 1 }) }),    // [txn] the path it will send on…
      chain({ first: { c: '12' } }), // [txn] already at cap
    ], seo_link_acquisition_paths: [chain({ first: { id: 'path-ok', superseded_by: null, confidence: 0.7, agent_completable: true, revision: 1 } })] });
    const res = await Outreach.sendOutreach({ prospectId: 'p1' });
    expect(res.code).toBe('rate_limited');
    expect(gmail.sendMessage).not.toHaveBeenCalled();
  });

  test('lost the CAS race (claim returns 0 rows) → already_sent, never sends', async () => {
    outreachGateOn();
    setDbQueues({ seo_link_prospects: [
      chain({ first: draftedProspect() }),
      chain({ first: { id: 'p1' } }),                 // [txn] prospect row lock (prospect → path order)
      chain({ result: [] }),                       // [txn] inbox guard: no other conversation with this recipient
      chain({ result: [] }),                       // [txn] pre-send settlement's row read → path unchanged
      chain({ first: draftedProspect({ path_id: 'path-ok', leased_path_revision: 1 }) }),    // [txn] the path it will send on…
      chain({ first: { c: '0' } }),                // [txn] dailySendCount under the lock (after the authority check)
      chain({ returning: [] }), // another click already flipped drafted→sending
    ], seo_link_acquisition_paths: [chain({ first: { id: 'path-ok', superseded_by: null, confidence: 0.7, agent_completable: true, revision: 1 } })] });
    const res = await Outreach.sendOutreach({ prospectId: 'p1' });
    expect(res.code).toBe('already_sent');
    expect(gmail.sendMessage).not.toHaveBeenCalled();
  });

  test('the LOCKED draft is incomplete (a revision raced the pre-read) → incomplete_draft before the CAS, nothing claimed, no send', async () => {
    outreachGateOn();
    setDbQueues({ seo_link_prospects: [
      chain({ first: draftedProspect() }),                            // pre-read looks complete
      chain({ first: { id: 'p1' } }),                 // [txn] prospect row lock (prospect → path order)
      chain({ result: [] }),                       // [txn] inbox guard: no other conversation with this recipient
      chain({ result: [] }),                       // [txn] pre-send settlement's row read → path unchanged
      chain({ first: draftedProspect({ path_id: 'path-ok', leased_path_revision: 1, outreach_body: '' }) }), // …but the locked row is incomplete
    ], seo_link_acquisition_paths: [chain({ first: { id: 'path-ok', superseded_by: null, confidence: 0.7, agent_completable: true, revision: 1 } })] });
    const res = await Outreach.sendOutreach({ prospectId: 'p1' });
    expect(res.code).toBe('incomplete_draft');
    expect(gmail.sendMessage).not.toHaveBeenCalled();
  });

  test('not connected → gmail_not_connected, no claim, draft untouched', async () => {
    outreachGateOn();
    gmail.isConnected.mockResolvedValue(false);
    setDbQueues({ seo_link_prospects: [chain({ first: draftedProspect() })] });
    const res = await Outreach.sendOutreach({ prospectId: 'p1' });
    expect(res.code).toBe('gmail_not_connected');
    expect(db.transaction).not.toHaveBeenCalled();
    expect(gmail.sendMessage).not.toHaveBeenCalled();
  });

  test('ambiguous Gmail failure → send_failed, parks in non-sendable send_error (not drafted)', async () => {
    outreachGateOn();
    gmail.sendMessage.mockRejectedValue(new Error('socket timeout'));
    const errMark = chain({ result: 1 });
    setDbQueues({ seo_link_prospects: [
      chain({ first: draftedProspect() }),
      chain({ first: { id: 'p1' } }),                 // [txn] prospect row lock (prospect → path order)
      chain({ result: [] }),                       // [txn] inbox guard: no other conversation with this recipient
      chain({ result: [] }),                       // [txn] pre-send settlement's row read → path unchanged
      chain({ first: draftedProspect({ path_id: 'path-ok', leased_path_revision: 1 }) }),    // [txn] the path it will send on…
      chain({ first: { c: '0' } }),                // [txn] dailySendCount under the lock (after the authority check)               // [txn] count
      chain({ returning: [draftedProspect()] }),  // [txn] CAS claims → returns row
      errMark,                                     // mark sending→send_error (token-gated)
    ], seo_link_acquisition_paths: [chain({ first: { id: 'path-ok', superseded_by: null, confidence: 0.7, agent_completable: true, revision: 1 } })] });
    const res = await Outreach.sendOutreach({ prospectId: 'p1' });
    expect(res.code).toBe('send_failed');
    expect(gmail.sendMessage).toHaveBeenCalledTimes(1);
    // NOT reopened to 'drafted' — that would risk a duplicate send.
    expect(errMark.update).toHaveBeenCalledWith(expect.objectContaining({ outreach_status: 'send_error' }));
  });

  test('prospect already sent (precondition) → already_sent, no txn', async () => {
    outreachGateOn();
    setDbQueues({ seo_link_prospects: [
      chain({ first: draftedProspect({ outreach_sent_at: new Date(), outreach_status: 'sent' }) }),
    ] });
    const res = await Outreach.sendOutreach({ prospectId: 'p1' });
    expect(res.code).toBe('already_sent');
    expect(db.transaction).not.toHaveBeenCalled();
    expect(gmail.sendMessage).not.toHaveBeenCalled();
  });

  test('a draft whose acquisition path moved since it was saved is NOT sent → path_moved (settled inside the send transaction, before the CAS)', async () => {
    outreachGateOn();
    const move = chain({ result: 1 });
    setDbQueues({
      seo_link_prospects: [
        chain({ first: draftedProspect() }),
        chain({ first: { id: 'p1' } }),                 // [txn] prospect row lock (prospect → path order)
      chain({ result: [] }),                       // [txn] inbox guard: no other conversation with this recipient
        chain({ result: [{ id: 'p1', path_id: 'path-old', link_type: 'editorial', outreach_status: 'drafted', outreach_sent_at: null, outreach_send_token: null, leased_path_revision: null }] }), // settlement's row read
        move, // the transition clears the draft
      ],
      seo_link_acquisition_paths: [
        chain({ first: { id: 'path-old', superseded_by: 'path-new' } }), // pass 1: resolve the chain…
        chain({ first: { id: 'path-new', superseded_by: null } }),
        chain({ result: [ // pass 2: lock the involved paths in sorted order
          { id: 'path-new', superseded_by: null, submission_url: null, link_type: 'editorial', revision: 1, confidence: 0.7 },
          { id: 'path-old', superseded_by: 'path-new', submission_url: null, link_type: 'editorial' },
        ] }),
      ],
    });
    const res = await Outreach.sendOutreach({ prospectId: 'p1', approvedBy: 'Adam' });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('path_moved');
    expect(gmail.sendMessage).not.toHaveBeenCalled();
    expect(move.update).toHaveBeenCalledWith(expect.objectContaining({ path_id: 'path-new', outreach_status: 'none' }));
  });

  test('a settlement that cannot resolve the chain is not "unchanged": the send fails closed when the row is still on a superseded path', async () => {
    outreachGateOn();
    setDbQueues({
      seo_link_prospects: [
        chain({ first: draftedProspect() }),
        chain({ first: { id: 'p1' } }),                 // [txn] prospect row lock (prospect → path order)
      chain({ result: [] }),                       // [txn] inbox guard: no other conversation with this recipient
        chain({ result: [] }),                        // settlement read (nothing moved — e.g. the chain exceeded its hop bound)
        chain({ first: draftedProspect({ path_id: 'path-retired' }) }), // the path the send would run on…
      ],
      seo_link_acquisition_paths: [chain({ first: { id: 'path-retired', superseded_by: 'path-x' } })], // …is retired
    });
    const res = await Outreach.sendOutreach({ prospectId: 'p1', approvedBy: 'Adam' });
    expect(res.code).toBe('path_moved');
    expect(gmail.sendMessage).not.toHaveBeenCalled();
  });

  test('a draft on a path disproven (or ruled human-only) since it was saved is not sent → path_moved', async () => {
    outreachGateOn();
    setDbQueues({
      seo_link_prospects: [chain({ first: draftedProspect() }), chain({ first: { id: 'p1' } }),                 // [txn] prospect row lock (prospect → path order)
      chain({ result: [] }),                       // [txn] inbox guard: no other conversation with this recipient
      chain({ result: [] }), chain({ first: draftedProspect({ path_id: 'path-dead' }) })],
      seo_link_acquisition_paths: [chain({ first: { id: 'path-dead', superseded_by: null, confidence: 0, agent_completable: true } })],
    });
    expect((await Outreach.sendOutreach({ prospectId: 'p1' })).code).toBe('path_moved');
    setDbQueues({
      seo_link_prospects: [chain({ first: draftedProspect() }), chain({ first: { id: 'p1' } }),                 // [txn] prospect row lock (prospect → path order)
      chain({ result: [] }),                       // [txn] inbox guard: no other conversation with this recipient
      chain({ result: [] }), chain({ first: draftedProspect({ path_id: 'path-human' }) })],
      seo_link_acquisition_paths: [chain({ first: { id: 'path-human', superseded_by: null, confidence: 0.8, agent_completable: false } })],
    });
    expect((await Outreach.sendOutreach({ prospectId: 'p1' })).code).toBe('path_moved');
    expect(gmail.sendMessage).not.toHaveBeenCalled();
  });

  test('NULL confidence (never assessed) is not standing → path_moved (Codex #3720 r6 P1)', async () => {
    outreachGateOn();
    setDbQueues({
      seo_link_prospects: [chain({ first: draftedProspect() }), chain({ first: { id: 'p1' } }),                 // [txn] prospect row lock (prospect → path order)
      chain({ result: [] }),                       // [txn] inbox guard: no other conversation with this recipient
      chain({ result: [] }), chain({ first: draftedProspect({ path_id: 'path-unassessed' }) })],
      seo_link_acquisition_paths: [chain({ first: { id: 'path-unassessed', superseded_by: null, confidence: null, agent_completable: true } })],
    });
    expect((await Outreach.sendOutreach({ prospectId: 'p1' })).code).toBe('path_moved');
    expect(gmail.sendMessage).not.toHaveBeenCalled();
  });

  test('a draft carrying NO revision stamp is not sent → path_moved: the stamp is required, never skipped (Codex #3720 r7 P1)', async () => {
    outreachGateOn();
    setDbQueues({
      seo_link_prospects: [chain({ first: draftedProspect() }), chain({ first: { id: 'p1' } }), chain({ result: [] }), chain({ result: [] }), chain({ first: draftedProspect({ path_id: 'path-ok', leased_path_revision: null }) })],
      seo_link_acquisition_paths: [chain({ first: { id: 'path-ok', superseded_by: null, confidence: 0.7, agent_completable: true, revision: 1 } })],
    });
    expect((await Outreach.sendOutreach({ prospectId: 'p1' })).code).toBe('path_moved');
    expect(gmail.sendMessage).not.toHaveBeenCalled();
  });

  test('a draft whose path was revised in place after it was written is not sent → path_moved (revision stamp)', async () => {
    outreachGateOn();
    setDbQueues({
      seo_link_prospects: [chain({ first: draftedProspect() }), chain({ first: { id: 'p1' } }), chain({ result: [] }), chain({ result: [] }), chain({ first: draftedProspect({ path_id: 'path-ok', leased_path_revision: 3 }) })],
      seo_link_acquisition_paths: [chain({ first: { id: 'path-ok', superseded_by: null, confidence: 0.7, agent_completable: true, revision: 4 } })],
    });
    expect((await Outreach.sendOutreach({ prospectId: 'p1' })).code).toBe('path_moved');
    expect(gmail.sendMessage).not.toHaveBeenCalled();
  });
});

describe('saveDraft', () => {
  test('rejects an invalid recipient before any DB work', async () => {
    const res = await Outreach.saveDraft({ prospectId: 'p1', to: 'bad', subject: 's', body: 'b' });
    expect(res.code).toBe('invalid_recipient');
    expect(db).not.toHaveBeenCalled();
  });

  test('rejects an incomplete draft', async () => {
    const res = await Outreach.saveDraft({ prospectId: 'p1', to: 'a@b.com', subject: '', body: 'b' });
    expect(res.code).toBe('incomplete_draft');
  });

  test('non-outreach prospect → not_outreach', async () => {
    setDbQueues({ seo_link_prospects: [chain({ first: draftedProspect({ link_type: 'directory' }) })] });
    const res = await Outreach.saveDraft({ prospectId: 'p1', to: 'a@b.com', subject: 's', body: 'b' });
    expect(res.code).toBe('not_outreach');
  });

  test('already-sent prospect is not overwritten', async () => {
    setDbQueues({ seo_link_prospects: [chain({ first: draftedProspect({ outreach_status: 'sent', outreach_sent_at: new Date() }) })] });
    const res = await Outreach.saveDraft({ prospectId: 'p1', to: 'a@b.com', subject: 's', body: 'b' });
    expect(res.code).toBe('already_sent');
  });

  test('a fresh in-flight send is not reopened → send_in_flight', async () => {
    setDbQueues({ seo_link_prospects: [chain({ first: draftedProspect({ outreach_status: 'sending', updated_at: new Date() }) })] });
    const res = await Outreach.saveDraft({ prospectId: 'p1', to: 'a@b.com', subject: 's', body: 'b' });
    expect(res.code).toBe('send_in_flight');
  });

  test('a stuck (stale) send is not silently reopened by saveDraft → needs_reconcile', async () => {
    const stale = new Date(Date.now() - 30 * 60 * 1000); // 30 min ago
    setDbQueues({ seo_link_prospects: [chain({ first: draftedProspect({ outreach_status: 'sending', updated_at: stale }) })] });
    const res = await Outreach.saveDraft({ prospectId: 'p1', to: 'a@b.com', subject: 's', body: 'b' });
    expect(res.code).toBe('needs_reconcile');
  });

  test('a send racing between read and conditional write → send_in_flight (0 rows)', async () => {
    setDbQueues({ seo_link_prospects: [
      chain({ first: draftedProspect({ outreach_status: 'drafted' }) }), // read sees a writable row
      chain({ first: { id: 'p1' } }),                                    // [txn] prospect row lock
      chain({ returning: [] }),                                          // but /send flipped it → 0 rows
    ] });
    const res = await Outreach.saveDraft({ prospectId: 'p1', to: 'a@b.com', subject: 's', body: 'b' });
    expect(res.code).toBe('send_in_flight');
  });

  test('a send_error row is NOT silently re-drafted → needs_reconcile', async () => {
    setDbQueues({ seo_link_prospects: [chain({ first: draftedProspect({ outreach_status: 'send_error' }) })] });
    const res = await Outreach.saveDraft({ prospectId: 'p1', to: 'a@b.com', subject: 's', body: 'b' });
    expect(res.code).toBe('needs_reconcile');
  });

  test('terminal lifecycle status → not_actionable', async () => {
    setDbQueues({ seo_link_prospects: [chain({ first: draftedProspect({ status: 'lost' }) })] });
    const res = await Outreach.saveDraft({ prospectId: 'p1', to: 'a@b.com', subject: 's', body: 'b' });
    expect(res.code).toBe('not_actionable');
  });

  test('happy path persists the draft as drafted (trims recipient, sets owner)', async () => {
    const upd = chain({ returning: [draftedProspect({ outreach_to_email: 'a@b.com' })] });
    setDbQueues({ seo_link_prospects: [
      chain({ first: draftedProspect({ outreach_status: 'none', owner: null }) }),
      chain({ first: { id: 'p1' } }), // [txn] prospect row lock (prospect → path order)
      upd,
      chain({ result: [] }), // release-side settlement's row read: the path is live → nothing to move
    ] });
    const res = await Outreach.saveDraft({ prospectId: 'p1', to: ' a@b.com ', subject: 's', body: 'b', owner: 'Adam' });
    expect(res.ok).toBe(true);
    expect(upd.update).toHaveBeenCalledWith(expect.objectContaining({
      outreach_status: 'drafted', outreach_to_email: 'a@b.com', owner: 'Adam',
    }));
    // the write is predicated on the lane (and path) the operator drafted against — a concurrent move makes it miss
    expect(upd.where).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1', status: 'prospect', link_type: 'editorial' }));
    expect(upd.whereNull).toHaveBeenCalledWith('path_id');
  });

  test('a draft written against a placement whose path was superseded is discarded → path_moved (settlement in the same transaction)', async () => {
    const upd = chain({ returning: [draftedProspect({ outreach_to_email: 'a@b.com' })] });
    const move = chain({ result: 1 });
    setDbQueues({
      seo_link_prospects: [
        chain({ first: draftedProspect({ outreach_status: 'none', owner: null }) }),
        chain({ first: { id: 'p1' } }), // [txn] prospect row lock
        upd,
        chain({ result: [{ id: 'p1', path_id: 'path-old', link_type: 'editorial', outreach_status: 'drafted', outreach_sent_at: null, outreach_send_token: null, leased_path_revision: null }] }), // settlement's row read
        move, // the transition (draft cleared, unclassified) onto the live successor
      ],
      seo_link_acquisition_paths: [
        chain({ first: { id: 'path-old', superseded_by: 'path-new' } }), // pass 1: resolve the chain…
        chain({ first: { id: 'path-new', superseded_by: null } }),
        chain({ result: [ // pass 2: lock the involved paths in sorted order
          { id: 'path-new', superseded_by: null, submission_url: null, link_type: 'editorial', revision: 1, confidence: 0.7 },
          { id: 'path-old', superseded_by: 'path-new', submission_url: null, link_type: 'editorial' },
        ] }),
      ],
    });
    const res = await Outreach.saveDraft({ prospectId: 'p1', to: 'a@b.com', subject: 's', body: 'b' });
    expect(res.code).toBe('path_moved');
    expect(move.update).toHaveBeenCalledWith(expect.objectContaining({ path_id: 'path-new', outreach_status: 'none', outreach_send_token: null }));
  });
});

describe('reconcileSendError', () => {
  test('rejects an unknown outcome', async () => {
    const res = await Outreach.reconcileSendError({ prospectId: 'p1', outcome: 'maybe' });
    expect(res.code).toBe('bad_outcome');
    expect(db).not.toHaveBeenCalled();
  });

  test('missing prospect → not_found', async () => {
    setDbQueues({ seo_link_prospects: [chain({ first: undefined })] });
    const res = await Outreach.reconcileSendError({ prospectId: 'p1', outcome: 'sent' });
    expect(res.code).toBe('not_found');
  });

  test('a non-ambiguous status → not_reconcilable', async () => {
    setDbQueues({ seo_link_prospects: [chain({ first: draftedProspect({ outreach_status: 'drafted' }) })] });
    const res = await Outreach.reconcileSendError({ prospectId: 'p1', outcome: 'requeue' });
    expect(res.code).toBe('not_reconcilable');
  });

  test('a FRESH in-flight send cannot be reconciled → send_in_flight', async () => {
    setDbQueues({ seo_link_prospects: [chain({ first: draftedProspect({ outreach_status: 'sending', updated_at: new Date() }) })] });
    const res = await Outreach.reconcileSendError({ prospectId: 'p1', outcome: 'requeue' });
    expect(res.code).toBe('send_in_flight');
  });

  test("'sent' marks a send_error contacted/sent", async () => {
    const upd = chain({ returning: [draftedProspect({ status: 'contacted', outreach_status: 'sent' })] });
    setDbQueues({ seo_link_prospects: [
      chain({ first: draftedProspect({ outreach_status: 'send_error' }) }),
      upd,
      chain({ first: draftedProspect({ path_id: 'path-ok', leased_path_revision: 1 }) }), // the revision the send was bound to
    ], seo_link_acquisition_paths: [chain({ first: { id: 'path-ok', revision: 1, revision_communication: 1 } })],
    seo_link_placement_authorities: [chain({ result: [] })] }); // the Sent folder proved the send: its open instance (none here) is satisfied
    const res = await Outreach.reconcileSendError({ prospectId: 'p1', outcome: 'sent', approvedBy: 'Adam' });
    expect(res.ok).toBe(true);
    expect(upd.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'contacted', outreach_status: 'sent' }));
  });

  test("'requeue' on a stale sending returns it to drafted and clears the attempt", async () => {
    const stale = new Date(Date.now() - 30 * 60 * 1000);
    const upd = chain({ returning: [draftedProspect()] });
    setDbQueues({ seo_link_prospects: [
      chain({ first: draftedProspect({ outreach_status: 'sending', updated_at: stale }) }),
      upd,
    ] });
    const res = await Outreach.reconcileSendError({ prospectId: 'p1', outcome: 'requeue', approvedBy: 'Adam' });
    expect(res.ok).toBe(true);
    expect(upd.update).toHaveBeenCalledWith(expect.objectContaining({ outreach_status: 'drafted', outreach_attempted_at: null }));
  });
});

describe('dailySendCount', () => {
  test('counts the current attempt (COALESCEd — a NULL must not zero the row) PLUS every in-window entry of the append-only prior_outreach_attempts ledger', async () => {
    const wheres = [], raws = [];
    const q = Object.assign(() => q, {
      whereRaw: jest.fn((sql, bind) => { wheres.push([sql, bind]); return q; }),
      select: jest.fn(() => q),
      first: jest.fn(async () => ({ c: '3' })),
      raw: jest.fn((sql, bind) => { raws.push([sql, bind]); return { sql, bind }; }),
    });
    expect(await Outreach.dailySendCount(q, new Date('2026-09-03T07:35:00Z'))).toBe(3); // 03:35 ET
    const [sql, bind] = raws[0];
    // the window opens at ET midnight of the run's day (a trailing 24h from a 3:35 nightly still held the previous night's attempts)
    const since = new Date('2026-09-03T04:00:00Z');
    expect(bind).toEqual([since, since, since]);
    // the follow-up attempt (§6.4) is a second COALESCEd term — a NULL follow-up stamp never nulls the row's sum
    expect(sql).toMatch(/SUM\(COALESCE\(\(outreach_attempted_at >= \?\)::int, 0\) \+ COALESCE\(\(follow_up_attempted_at >= \?\)::int, 0\) \+ \(SELECT count\(\*\) FROM jsonb_array_elements_text\(.*'prior_outreach_attempts'.*\) AS a WHERE a::timestamptz >= \?\)\)/);
    // both raws compile through knex with exactly three bindings each (since ×3) — no stray '?'
    const knex = require('knex')({ client: 'pg' });
    expect(knex('seo_link_prospects').select(knex.raw(sql, bind)).toSQL().toNative().bindings).toHaveLength(3);
    expect(knex('seo_link_prospects').whereRaw(wheres[0][0], wheres[0][1]).toSQL().toNative().bindings).toHaveLength(3);
  });

  test('a manual draft on a linked prospect is stamped with the path revision it was written against (Codex #3720 r5 P1)', async () => {
    const upd = chain({ returning: [draftedProspect({ path_id: 'path-7' })] });
    setDbQueues({
      seo_link_prospects: [
        chain({ first: draftedProspect({ outreach_status: 'none', path_id: 'path-7' }) }),
        chain({ first: { id: 'p1' } }), // prospect lock
        upd,
        chain({ result: [] }),
      ],
      seo_link_acquisition_paths: [chain({ first: { id: 'path-7', revision: 4 } }), chain({ first: { id: 'path-7', revision: 4 } })], // observed (pre-read) then locked — same revision
    });
    const res = await Outreach.saveDraft({ prospectId: 'p1', to: 'a@b.com', subject: 's', body: 'b' });
    expect(res.ok).toBe(true);
    expect(upd.update).toHaveBeenCalledWith(expect.objectContaining({ leased_path_revision: 4 }));
  });

  test('a path revised between the operator read and the locked write is not stamped → path_moved (hook P1 on 408748c29)', async () => {
    const upd = chain({ returning: [draftedProspect({ path_id: 'path-7' })] });
    setDbQueues({
      seo_link_prospects: [
        chain({ first: draftedProspect({ outreach_status: 'none', path_id: 'path-7' }) }),
        chain({ first: { id: 'p1' } }), // prospect lock
        upd,
        chain({ result: [] }),
      ],
      seo_link_acquisition_paths: [chain({ first: { id: 'path-7', revision: 4 } }), chain({ first: { id: 'path-7', revision: 5 } })], // observed 4, locked 5
    });
    const res = await Outreach.saveDraft({ prospectId: 'p1', to: 'a@b.com', subject: 's', body: 'b' });
    expect(res).toEqual({ ok: false, code: 'path_moved' });
    expect(upd.update).not.toHaveBeenCalled();
  });
});
