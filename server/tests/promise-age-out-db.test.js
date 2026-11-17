/**
 * Promise age-out against live Postgres (server/services/promise-age-out.js): what a run dismisses and what it
 * leaves, the marker it writes, the alerts that close with a text or an email promise, the dry run, a person's
 * action and the text lane's own close that land during a run, the Owed tab's closed-automatically list with its
 * Reopen, the undo (promises and the alerts the run closed), and a run whose audit row was not written. Synthetic
 * data only. Every run is scoped to this file's own promises, so it never touches another suite's rows.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { randomUUID } = require('node:crypto');

const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;

const DAY = 24 * 60 * 60 * 1000;
const OUR_NUMBER = '+15555550100';
const PROOF_KEYS = ['basis', 'closed_at', 'closed_by', 'days', 'kind', 'run'];

jest.setTimeout(30000);

maybeDescribe('promise age-out (live Postgres)', () => {
  let db;
  let ageOut;
  let cc;
  const made = { customers: [], calls: [], texts: [], emails: [], promises: [], alerts: [], runs: [] };
  const now = new Date();
  const ago = (days) => new Date(now.getTime() - days * DAY);
  const token = () => randomUUID().replaceAll('-', '');

  beforeAll(() => {
    db = require('../models/db');
    ageOut = require('../services/promise-age-out');
    cc = require('../services/call-commitments');
  });
  afterAll(async () => {
    const del = async (table, ids) => { if (ids.length) await db(table).whereIn('id', ids).del(); };
    if (made.runs.length) await db('audit_log').whereRaw("metadata->>'runId' = ANY(?::text[])", [made.runs]).del();
    await del('notifications', made.alerts);
    await del('call_commitments', made.promises);
    await del('sms_log', made.texts);
    await del('emails', made.emails);
    await del('call_log', made.calls);
    await del('customers', made.customers);
    await db.destroy();
  });

  // Each run gets its own instant, so its id (the instant) names it alone.
  const run = (extra = {}) => {
    const at = new Date(now.getTime() + (made.runs.length + 1) * 1000);
    made.runs.push(at.toISOString());
    return ageOut.runPromiseAgeOut({ now: at, scope: (q) => q.whereIn('cc.id', made.promises), ...extra });
  };
  const row = (id) => db('call_commitments').where({ id }).first();
  const alertRow = (id) => db('notifications').where({ id }).first();
  const meta = (r) => (typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata);

  async function customer() {
    const digits = String(Math.floor(Math.random() * 1e7)).padStart(7, '0');
    const [made1] = await db('customers').insert({ first_name: 'AgeOut', last_name: 'Fixture', phone: `+1555${digits}`, email: `ageout-${token()}@example.invalid` }).returning('id');
    made.customers.push(made1.id);
    return { id: made1.id, phone: `+1555${digits}` };
  }
  const promise = async (source, over) => {
    const [made1] = await db('call_commitments').insert({
      commitment_key: `waves:other:${token()}`, party: 'waves', kind: 'other', description: 'Send the details over', source: 'ai',
      evidence: JSON.stringify([{ quote: 'I will send the details over today' }]), status: 'open', ...source, ...over,
    }).returning('*');
    made.promises.push(made1.id);
    return made1;
  };
  // A promise recorded `days` ago on a call of its own (or on `call`).
  async function callPromise({ days = 40, call = null, ...over } = {}) {
    const who = call ? null : await customer();
    const onCall = call || (await db('call_log').insert({
      twilio_call_sid: `CA${token().slice(0, 30)}`, direction: 'inbound', from_phone: who.phone, to_phone: OUR_NUMBER, status: 'completed',
      duration_seconds: 90, customer_id: who.id, created_at: ago(days),
    }).returning('id'))[0];
    if (!call) made.calls.push(onCall.id);
    return { ...await promise({ call_log_id: onCall.id, last_seen_generation: 1 }, { created_at: ago(days), updated_at: ago(days), ...over }), call: onCall };
  }
  // A staff text to a customer of its own, or to `who` (the `owner` of an earlier text).
  async function staffText({ days = 40, who = null } = {}) {
    const owner = who || await customer();
    const [text] = await db('sms_log').insert({
      direction: 'outbound', from_phone: OUR_NUMBER, to_phone: owner.phone, customer_id: owner.id, message_type: 'manual', status: 'delivered',
      message_body: 'I will send the details over today, and I will call you tomorrow.', created_at: ago(days),
    }).returning('id');
    made.texts.push(text.id);
    return { id: text.id, customerId: owner.id, owner };
  }
  const textPromise = ({ text, days = 40, ...over }) => promise({ sms_log_id: text.id },
    { sms_context: JSON.stringify({ basis: 'promise', customer_id: text.customerId }), created_at: ago(days), updated_at: ago(days), ...over });
  async function emailPromise({ days = 40, ...over } = {}) {
    const who = await customer();
    const [email] = await db('emails').insert({
      gmail_id: `g-${token()}`, gmail_thread_id: `t-${token()}`, from_address: 'office@example.invalid', label_ids: JSON.stringify(['SENT']), received_at: ago(days),
    }).returning('id');
    made.emails.push(email.id);
    return promise({ email_id: email.id, email_customer_id: who.id }, { created_at: ago(days), updated_at: ago(days), ...over });
  }
  async function alert(metadata) {
    const [made1] = await db('notifications').insert({
      recipient_type: 'admin', category: 'alert', title: 'Age-out fixture alert', body: 'Fixture body.', metadata: JSON.stringify(metadata),
    }).returning('*');
    made.alerts.push(made1.id);
    return made1;
  }
  // The one alert a customer's text promises share: it lists `listed` and has spoken for `texts`.
  const customerAlert = (customerId, listed, texts) => alert({ dedupeKey: `sms-commitment-customer:${customerId}`, customerId, sms_log_id: listed[0].sms_log_id,
    commitment_id: listed[0].id, commitment_ids: listed.map((item) => item.id), itemKeys: listed.map((item) => item.id).sort(), spoke_for: texts.map((text) => text.id) });
  // Resolves once a statement over `table` is waiting on a row lock: the run has read its page and is blocked.
  async function waitingOnLock(table) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const { rows } = await db.raw(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE ?", [`%"${table}"%`]);
      if (rows[0].n > 0) return;
      await new Promise((resolve) => { setTimeout(resolve, 25); });
    }
    throw new Error(`no statement over ${table} ever waited on a lock`);
  }

  test('a run dismisses an untouched promise past 30 days on each channel and for each party, with its own marker', async () => {
    const ours = await callPromise();
    const theirs = await callPromise({ party: 'customer', kind: 'call_back', commitment_key: 'customer:call_back' });
    const byText = await textPromise({ text: await staffText() });
    const byEmail = await emailPromise();

    const summary = await run();

    expect(summary.expired).toEqual({ total: 4, byChannel: { call: 2, text: 1, email: 1 }, byParty: { waves: 3, customer: 1 }, byKind: { other: 3, call_back: 1 } });
    expect([summary.failed, summary.complete, summary.dryRun]).toEqual([0, true, false]);
    for (const made1 of [ours, theirs, byText, byEmail]) {
      const after = await row(made1.id);
      expect([after.status, after.human_state, after.fulfilled_at]).toEqual(['dismissed', null, null]);
      expect(after.fulfillment).toEqual({ kind: 'aged_out', basis: 'no_action_in_30_days', closed_by: 'promise_age_out', closed_at: summary.runId, run: summary.runId, days: 30 });
      expect(Object.keys(after.fulfillment).sort()).toEqual(PROOF_KEYS);
    }
    const audit = await db('audit_log').where({ action: 'promise_age_out.expire' }).whereRaw("metadata->>'runId' = ?", [summary.runId]).first('metadata', 'actor_type');
    expect(audit.actor_type).toBe('system');
    expect(audit.metadata.expired.total).toBe(4);
  });

  test('a run leaves a promise that is inside 30 days, has a later date, belongs to a person or to the link worker, is not live work, or is closed', async () => {
    const recent = await callPromise({ days: 29 });
    const dueLater = await callPromise({ days: 60, due_at: ago(5) });
    const cardDeadline = await callPromise({ days: 60, kind: 'callback', commitment_key: 'waves:callback', callback_due_at: ago(10) });
    const snoozed = await callPromise({ days: 60, kind: 'callback', commitment_key: 'waves:callback', snoozed_until: new Date(now.getTime() + DAY) });
    const confirmed = await callPromise({ days: 60, human_state: 'confirmed' });
    const linkPromise = await callPromise({ days: 60, kind: 'send_reschedule_link', commitment_key: 'waves:send_reschedule_link' });
    // A later pass of the same call saw `seenAgain` and no longer saw `notSeen`.
    const seenAgain = await callPromise({ days: 60, last_seen_generation: 2 });
    const notSeen = await callPromise({ days: 60, call: seenAgain.call, last_seen_generation: 1 });
    const kept = await callPromise({ days: 60, status: 'fulfilled', fulfillment: JSON.stringify({ kind: 'estimate', basis: 'estimate_sent' }) });

    const summary = await run();

    expect(summary.expired.total).toBe(1);
    expect((await row(seenAgain.id)).status).toBe('dismissed');
    for (const made1 of [recent, dueLater, cardDeadline, snoozed, confirmed, linkPromise, notSeen]) {
      const after = await row(made1.id);
      expect([after.status, after.fulfillment, after.updated_at.getTime()]).toEqual(['open', null, made1.updated_at.getTime()]);
    }
    expect((await row(kept.id)).fulfillment).toEqual({ kind: 'estimate', basis: 'estimate_sent' });
  });

  test('a dry run counts the same promises and writes nothing', async () => {
    const aged = await callPromise();

    const summary = await run({ dryRun: true });

    expect([summary.dryRun, summary.expired.total, summary.expired.byChannel.call]).toEqual([true, 1, 1]);
    expect((await row(aged.id)).status).toBe('open');
    expect(await db('audit_log').whereRaw("metadata->>'runId' = ?", [summary.runId]).first('id')).toBeUndefined();
    await run();
  });

  test('a text promise closes its alerts; the alert the text shares stays for a promise still inside 30 days, then closes with it', async () => {
    const text = await staffText();
    const aged = await textPromise({ text });
    const stillDue = await textPromise({ text, description: 'Call you tomorrow', due_at: ago(10) });
    const shared = await alert({ dedupeKey: `sms-commitment-source:${text.id}`, customerId: text.customerId, sms_log_id: text.id, commitment_id: aged.id, commitment_ids: [aged.id, stillDue.id] });
    const legacy = await alert({ dedupeKey: `sms-commitment:${aged.id}`, customerId: text.customerId, sms_log_id: text.id, commitment_id: aged.id });

    const first = await run();

    expect(first.expired.total).toBe(1);
    expect([(await row(aged.id)).status, (await row(stillDue.id)).status]).toEqual(['dismissed', 'open']);
    const legacyAfter = await alertRow(legacy.id);
    expect([legacyAfter.done_by, legacyAfter.resolution]).toEqual(['promise-age-out', 'The promise expired: no action in 30 days']);
    expect(legacyAfter.done_at).not.toBeNull();
    const sharedAfter = await alertRow(shared.id);
    expect(sharedAfter.done_at).toBeNull();
    expect(meta(sharedAfter).commitment_ids).toEqual([stillDue.id]);

    await db('call_commitments').where({ id: stillDue.id }).update({ due_at: ago(31) });
    const second = await run();

    expect(second.expired.total).toBe(1);
    expect((await row(stillDue.id)).status).toBe('dismissed');
    expect((await alertRow(shared.id)).done_by).toBe('promise-age-out');
  });

  test('an email promise closes its alert', async () => {
    const aged = await emailPromise();
    const bell = await alert({ dedupeKey: `email-commitment:${aged.id}`, email_id: aged.email_id, commitment_id: aged.id });

    await run();

    const after = await alertRow(bell.id);
    expect([after.done_by, after.resolution]).toEqual(['promise-age-out', 'The promise expired: no action in 30 days']);
    expect(after.done_at).not.toBeNull();
  });

  test("a person's action that lands while the run holds the promise in its page wins: the promise stays open", async () => {
    const aged = await callPromise();
    const person = await db.transaction();
    let running;
    try {
      await person('call_commitments').where({ id: aged.id }).update({ human_state: 'confirmed' });
      running = run();
      await waitingOnLock('call_commitments');
      await person.commit();
    } catch (err) {
      await person.rollback().catch(() => {});
      throw err;
    }

    const summary = await running;

    expect(summary.expired.total).toBe(0);
    const after = await row(aged.id);
    expect([after.status, after.human_state, after.fulfillment]).toEqual(['open', 'confirmed', null]);
  });

  test("the run waits for the text lane's lock on the text: a promise the lane settles meanwhile no longer holds the shared alert open", async () => {
    const text = await staffText();
    const aged = await textPromise({ text });
    const settling = await textPromise({ text, description: 'Call you tomorrow', due_at: ago(10) });
    const shared = await alert({ dedupeKey: `sms-commitment-source:${text.id}`, customerId: text.customerId, sms_log_id: text.id, commitment_id: aged.id, commitment_ids: [aged.id, settling.id] });
    // The lane's order: the text's row first, then the promise it settles.
    const lane = await db.transaction();
    let running;
    try {
      await lane('sms_log').where({ id: text.id }).forUpdate().first('id');
      await lane('call_commitments').where({ id: settling.id }).update({ status: 'fulfilled', fulfilled_at: now });
      running = run();
      await waitingOnLock('sms_log');
      await lane.commit();
    } catch (err) {
      await lane.rollback().catch(() => {});
      throw err;
    }

    expect((await running).expired.total).toBe(1);
    expect((await row(aged.id)).status).toBe('dismissed');
    const after = await alertRow(shared.id);
    expect([after.done_by, after.done_at === null]).toEqual(['promise-age-out', false]);
  });

  test("the closed-automatically list shows an expired Waves call promise; its Reopen makes it the office's, and it does not expire again", async () => {
    const ours = await callPromise();
    const theirs = await callPromise({ party: 'customer', kind: 'call_back', commitment_key: 'customer:call_back' });
    await run();

    const listed = [];
    for (let before = null, page = 0; page < 1000; page += 1) {
      const { commitments, next } = await cc.listAutoClosedCommitments(db, { days: 7, before });
      listed.push(...commitments);
      if (!next) break;
      before = next;
    }
    const mine = listed.filter((c) => [ours.id, theirs.id].includes(c.id));
    expect(mine.map((c) => [c.id, c.fulfillment.kind])).toEqual([[ours.id, 'aged_out']]);

    const reopened = await cc.applyHumanUpdate(db, ours.id, { action: 'reopen', reviewedBy: null, expectedAt: mine[0].updated_at });
    expect([reopened.status, reopened.human_state, reopened.fulfillment]).toEqual(['open', 'confirmed', null]);
    expect((await run()).expired.total).toBe(0);
    expect((await row(ours.id)).status).toBe('open');
  });

  test('reopenPromiseAgeOut reopens what one run dismissed and a person has not settled since, with the proof it carried; its dry run writes nothing', async () => {
    // The evidence pass stored a suggested proof on this promise and left it open.
    const suggested = { kind: 'visit_completed', strength: 'association', record_type: 'scheduled_service', record_id: randomUUID() };
    const stays = await callPromise({ fulfillment: JSON.stringify(suggested) });
    const settled = await callPromise();
    const earlier = await callPromise();
    const earlierRun = await run({ scope: (q) => q.where('cc.id', earlier.id) });
    const { runId } = await run();
    await db('call_commitments').where({ id: settled.id }).update({ human_state: 'dismissed' });

    const dry = await ageOut.reopenPromiseAgeOut({ run: runId });
    const held = await row(stays.id);
    expect([dry.found.total, dry.reopened, held.status, held.fulfillment.kind, held.fulfillment.prior]).toEqual([1, 0, 'dismissed', 'aged_out', suggested]);

    const applied = await ageOut.reopenPromiseAgeOut({ run: runId, apply: true });

    expect([applied.found.total, applied.reopened]).toEqual([1, 1]);
    const after = await row(stays.id);
    expect([after.status, after.human_state, after.fulfillment, after.fulfilled_at]).toEqual(['open', null, suggested, null]);
    expect((await row(settled.id)).status).toBe('dismissed');
    expect((await row(earlier.id)).fulfillment.run).toBe(earlierRun.runId);
    const audit = await db('audit_log').where({ action: 'promise_age_out.reopen' }).whereRaw("metadata->>'runId' = ?", [runId]).first('metadata');
    expect(audit.metadata.reopened).toBe(1);
  });

  test('reopenPromiseAgeOut puts back the alerts that run closed, unread again when the close marked them read; an alert closed before the run stays closed', async () => {
    const text = await staffText();
    const byText = await textPromise({ text });
    const byEmail = await emailPromise();
    const unread = await alert({ dedupeKey: `sms-commitment-source:${text.id}`, customerId: text.customerId, sms_log_id: text.id, commitment_id: byText.id, commitment_ids: [byText.id] });
    // The office read this alert two days before the run.
    const read = await alert({ dedupeKey: `email-commitment:${byEmail.id}`, email_id: byEmail.email_id, commitment_id: byEmail.id });
    await db('notifications').where({ id: read.id }).update({ read_at: ago(2) });
    // A person marked this older alert for the text promise done three days before the run.
    const doneBefore = await alert({ dedupeKey: `sms-commitment:${byText.id}`, customerId: text.customerId, sms_log_id: text.id, commitment_id: byText.id });
    await db('notifications').where({ id: doneBefore.id }).update({ done_at: ago(3), done_by: randomUUID(), read_at: ago(3) });
    const { runId } = await run({ scope: (q) => q.whereIn('cc.id', [byText.id, byEmail.id]) });
    expect([(await alertRow(unread.id)).done_by, (await alertRow(read.id)).done_by]).toEqual(['promise-age-out', 'promise-age-out']);

    const applied = await ageOut.reopenPromiseAgeOut({ run: runId, apply: true });

    expect([applied.reopened, applied.alertsReopened]).toEqual([2, 2]);
    const unreadAfter = await alertRow(unread.id);
    expect([unreadAfter.done_at, unreadAfter.done_by, unreadAfter.resolution, unreadAfter.read_at]).toEqual([null, null, null, null]);
    const readAfter = await alertRow(read.id);
    expect([readAfter.done_at, readAfter.done_by, readAfter.resolution, readAfter.read_at.getTime()]).toEqual([null, null, null, ago(2).getTime()]);
    expect((await alertRow(doneBefore.id)).done_at.getTime()).toBe(ago(3).getTime());
    const audit = await db('audit_log').where({ action: 'promise_age_out.reopen' }).whereRaw("metadata->>'runId' = ?", [runId]).first('metadata');
    expect([audit.metadata.reopened, audit.metadata.alertsReopened]).toEqual([2, 2]);
  });

  test("reopenPromiseAgeOut puts a text promise back on the customer's alert that stayed open: no ring, and the alert stays read", async () => {
    const first = await staffText();
    const second = await staffText({ who: first.owner });
    const aged = await textPromise({ text: first });
    const stillDue = await textPromise({ text: second, description: 'Call you tomorrow', due_at: ago(10) });
    const shared = await customerAlert(first.customerId, [stillDue, aged], [first, second]);
    await db('notifications').where({ id: shared.id }).update({ read_at: ago(2) });
    const { runId } = await run({ scope: (q) => q.where('cc.id', aged.id) });
    // The run took the expired promise off the alert and closed no row.
    const kept = await alertRow(shared.id);
    expect([kept.done_at, meta(kept).commitment_ids]).toEqual([null, [stillDue.id]]);

    const applied = await ageOut.reopenPromiseAgeOut({ run: runId, apply: true });

    expect([applied.reopened, applied.alertsReopened]).toEqual([1, 0]);
    const after = await alertRow(shared.id);
    expect(meta(after).commitment_ids).toEqual([stillDue.id, aged.id]);
    expect([after.done_at, after.read_at.getTime(), after.created_at.getTime(), meta(after).rungAt]).toEqual([null, ago(2).getTime(), kept.created_at.getTime(), undefined]);
  });

  test("reopenPromiseAgeOut reopens a customer's alert the run closed and lists every promise the run took off it", async () => {
    const first = await staffText();
    const second = await staffText({ who: first.owner });
    const one = await textPromise({ text: first });
    const two = await textPromise({ text: second });
    const shared = await customerAlert(first.customerId, [one, two], [first, second]);
    const { runId } = await run({ scope: (q) => q.whereIn('cc.id', [one.id, two.id]) });
    // The first dismissal rewrote the alert to the other promise; the second closed it.
    const closed = await alertRow(shared.id);
    expect([closed.done_by, meta(closed).commitment_ids.length]).toEqual(['promise-age-out', 1]);

    const applied = await ageOut.reopenPromiseAgeOut({ run: runId, apply: true });

    expect([applied.reopened, applied.alertsReopened]).toEqual([2, 1]);
    const after = await alertRow(shared.id);
    expect([after.done_at, after.done_by, after.read_at]).toEqual([null, null, null]);
    expect([...meta(after).commitment_ids].sort()).toEqual([one.id, two.id].sort());
    expect(await db('notifications').whereRaw("metadata->>'customerId' = ?", [first.customerId]).whereNull('done_at').pluck('id')).toEqual([shared.id]);
  });

  test('a run whose audit row is not written fails loudly, and it is still found and reopened from the promises it dismissed', async () => {
    const aged = await callPromise();
    const spy = jest.spyOn(require('../services/audit-log'), 'recordAuditEvent').mockRejectedValueOnce(new Error('audit_log is down'));
    let failure;
    try {
      failure = await run({ scope: (q) => q.where('cc.id', aged.id) }).then(() => null, (err) => err);
    } finally {
      spy.mockRestore();
    }
    const runId = made.runs[made.runs.length - 1];

    expect(failure.message).toBe(`run ${runId} dismissed 1 promise(s) and its audit row was not written: audit_log is down`);
    expect(require('../services/logger').info).toHaveBeenCalledWith(expect.stringContaining(`run ${runId} dismissed 1 promise(s)`));
    expect(await db('audit_log').whereRaw("metadata->>'runId' = ?", [runId]).first('id')).toBeUndefined();
    expect((await row(aged.id)).fulfillment.run).toBe(runId);
    const runs = await ageOut.listPromiseAgeOutRuns({ limit: 1000 });
    expect(runs.filter((listed) => listed.run === runId)).toEqual([{ run: runId, promises: 1 }]);

    const applied = await ageOut.reopenPromiseAgeOut({ run: runId, apply: true });

    expect(applied.reopened).toBe(1);
    const after = await row(aged.id);
    expect([after.status, after.fulfillment]).toEqual(['open', null]);
  });
});
