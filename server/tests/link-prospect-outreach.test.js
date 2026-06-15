jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/email/gmail-client', () => ({ sendMessage: jest.fn(), isConnected: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn() }));

const db = require('../models/db');
const gmail = require('../services/email/gmail-client');
const { isEnabled } = require('../config/feature-gates');
const Outreach = require('../services/seo/link-prospect-outreach');

// Minimal chainable knex mock. `result` is what awaiting the builder resolves to
// (used by .update() compare-and-swaps that read the affected-row count); `first`
// and `returning` back .first() / .returning('*'). .where(fn) ignores the callback
// (the cap-count's nested where/orWhere never has to execute under the mock).
function chain({ result = [], first, returning } = {}) {
  const q = {};
  ['where', 'whereIn', 'whereNull', 'whereNotNull', 'orWhere', 'andWhere', 'orderBy', 'orderByRaw', 'select', 'count']
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
    isEnabled.mockReturnValue(true);
    gmail.sendMessage.mockResolvedValue({ id: 'msg1', threadId: 'thr1' });
    const finalRow = draftedProspect({ status: 'contacted', outreach_status: 'sent' });
    setDbQueues({ seo_link_prospects: [
      chain({ first: draftedProspect() }),         // pre-read (fast-fail checks)
      chain({ first: { c: '0' } }),                // [txn] dailySendCount under the lock
      chain({ returning: [draftedProspect()] }),   // [txn] CAS claim → returns the locked row
      chain({ returning: [finalRow] }),            // finalize → sent (token-gated)
    ] });

    const res = await Outreach.sendOutreach({ prospectId: 'p1', approvedBy: 'Adam' });
    expect(res.ok).toBe(true);
    expect(res.message_id).toBe('msg1');
    expect(res.thread_id).toBe('thr1');
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(db.raw).toHaveBeenCalled(); // advisory lock acquired
    expect(gmail.sendMessage).toHaveBeenCalledTimes(1);
    const [to, subject, htmlBody] = gmail.sendMessage.mock.calls[0];
    expect(to).toBe('editor@bradentonherald.com');
    expect(subject).toBe('Local pest-pressure data for your readers');
    expect(htmlBody).toContain('<br>');
  });

  test('finalize matches no row after a real send → finalize_failed (surfaced, not silent ok)', async () => {
    isEnabled.mockReturnValue(true);
    gmail.sendMessage.mockResolvedValue({ id: 'msg9', threadId: 'thr9' });
    setDbQueues({ seo_link_prospects: [
      chain({ first: draftedProspect() }),
      chain({ first: { c: '0' } }),
      chain({ returning: [draftedProspect()] }), // CAS claim
      chain({ returning: [] }),                  // finalize matched 0 rows
    ] });
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
    isEnabled.mockReturnValue(true);
    setDbQueues({ seo_link_prospects: [
      chain({ first: draftedProspect() }),
      chain({ first: { c: '12' } }), // [txn] already at cap
    ] });
    const res = await Outreach.sendOutreach({ prospectId: 'p1' });
    expect(res.code).toBe('rate_limited');
    expect(gmail.sendMessage).not.toHaveBeenCalled();
  });

  test('lost the CAS race (claim returns 0 rows) → already_sent, never sends', async () => {
    isEnabled.mockReturnValue(true);
    setDbQueues({ seo_link_prospects: [
      chain({ first: draftedProspect() }),
      chain({ first: { c: '0' } }),
      chain({ returning: [] }), // another click already flipped drafted→sending
    ] });
    const res = await Outreach.sendOutreach({ prospectId: 'p1' });
    expect(res.code).toBe('already_sent');
    expect(gmail.sendMessage).not.toHaveBeenCalled();
  });

  test('claimed draft is incomplete (raced revision) → incomplete_draft, releases claim, no send', async () => {
    isEnabled.mockReturnValue(true);
    const release = chain({ result: 1 });
    setDbQueues({ seo_link_prospects: [
      chain({ first: draftedProspect() }),                            // pre-read looks complete
      chain({ first: { c: '0' } }),
      chain({ returning: [draftedProspect({ outreach_body: '' })] }), // but the claimed row is incomplete
      release,                                                        // release our claim
    ] });
    const res = await Outreach.sendOutreach({ prospectId: 'p1' });
    expect(res.code).toBe('incomplete_draft');
    expect(gmail.sendMessage).not.toHaveBeenCalled();
    expect(release.update).toHaveBeenCalledWith(expect.objectContaining({ outreach_status: 'drafted' }));
  });

  test('not connected → gmail_not_connected, no claim, draft untouched', async () => {
    isEnabled.mockReturnValue(true);
    gmail.isConnected.mockResolvedValue(false);
    setDbQueues({ seo_link_prospects: [chain({ first: draftedProspect() })] });
    const res = await Outreach.sendOutreach({ prospectId: 'p1' });
    expect(res.code).toBe('gmail_not_connected');
    expect(db.transaction).not.toHaveBeenCalled();
    expect(gmail.sendMessage).not.toHaveBeenCalled();
  });

  test('ambiguous Gmail failure → send_failed, parks in non-sendable send_error (not drafted)', async () => {
    isEnabled.mockReturnValue(true);
    gmail.sendMessage.mockRejectedValue(new Error('socket timeout'));
    const errMark = chain({ result: 1 });
    setDbQueues({ seo_link_prospects: [
      chain({ first: draftedProspect() }),
      chain({ first: { c: '0' } }),               // [txn] count
      chain({ returning: [draftedProspect()] }),  // [txn] CAS claims → returns row
      errMark,                                     // mark sending→send_error (token-gated)
    ] });
    const res = await Outreach.sendOutreach({ prospectId: 'p1' });
    expect(res.code).toBe('send_failed');
    expect(gmail.sendMessage).toHaveBeenCalledTimes(1);
    // NOT reopened to 'drafted' — that would risk a duplicate send.
    expect(errMark.update).toHaveBeenCalledWith(expect.objectContaining({ outreach_status: 'send_error' }));
  });

  test('prospect already sent (precondition) → already_sent, no txn', async () => {
    isEnabled.mockReturnValue(true);
    setDbQueues({ seo_link_prospects: [
      chain({ first: draftedProspect({ outreach_sent_at: new Date(), outreach_status: 'sent' }) }),
    ] });
    const res = await Outreach.sendOutreach({ prospectId: 'p1' });
    expect(res.code).toBe('already_sent');
    expect(db.transaction).not.toHaveBeenCalled();
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
      upd,
    ] });
    const res = await Outreach.saveDraft({ prospectId: 'p1', to: ' a@b.com ', subject: 's', body: 'b', owner: 'Adam' });
    expect(res.ok).toBe(true);
    expect(upd.update).toHaveBeenCalledWith(expect.objectContaining({
      outreach_status: 'drafted', outreach_to_email: 'a@b.com', owner: 'Adam',
    }));
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
    ] });
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
