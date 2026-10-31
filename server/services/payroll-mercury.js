/**
 * Mercury paychecks (owner plan A, 2026-10-30), dark behind GATE_PAYROLL_MERCURY_STATUS (reads, chips, warnings)
 * and GATE_PAYROLL_MERCURY_PAY (Send to Mercury, Send again). Needs GATE_PAYROLL (the route checks it).
 *
 * Waves works out each paycheck. For a bank-transfer paycheck this module asks Mercury for an APPROVAL REQUEST;
 * money leaves only when a different Mercury user approves it in the Mercury app. It never calls Mercury's direct
 * send and never sends the same request twice on its own: a request that may or may not have reached Mercury
 * becomes an `unknown` payment, and only the owner (Send again, after a fresh read of Mercury) starts a new
 * attempt. payroll_checks stay frozen: every payment fact lives in payroll_payments.
 *
 * Send: under the payroll advisory lock a `queued` row is inserted and COMMITTED for every eligible check, then the
 * request goes out. The partial unique index (one open or paid row per check) makes a double click or two
 * concurrent sends one row. The poller (payroll-mercury-poller.js) moves rows on from Mercury's answers.
 *
 * Nothing here logs or stores a token, an account or routing number, or a Mercury answer: only ids, states, cents
 * and a short error line. Sends nothing to a customer or staff member.
 */
const crypto = require('crypto');
const Joi = require('joi');
const db = require('../models/db');
const logger = require('./logger');
const { recordAuditEvent } = require('./audit-log');
const { PayrollError } = require('./payroll-w4');
const { lockPayrollMutations } = require('./payroll-lock');
const { previousBusinessDayIrs } = require('./payroll-tax-calendar');
const { createClient, MercuryError } = require('./mercury-client');
const alerts = require('./payroll-mercury-alerts');
const { etDateString } = require('../utils/datetime-et');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPEN_STATES = ['queued', 'requested', 'unknown', 'approved', 'sent', 'paper'];
// A payment in one of these states stops a void: money may be on its way.
const BLOCKING_STATES = ['queued', 'requested', 'unknown', 'approved', 'sent'];
const RETRY_STATES = ['failed', 'rejected', 'cancelled', 'returned'];
const KEY_STALE_DAYS = 38;
const SEND_AGAIN_LOOKBACK_DAYS = 7;
const MAX_ERROR = 200;
const EXTERNAL_MEMO = 'Waves pay';
const DAY_MS = 24 * 60 * 60 * 1000;

// Read at call time. The typeof guard keeps a test mock of feature-gates that lacks a reader working (off).
const gateOn = (name) => {
  const gates = require('../config/feature-gates');
  return typeof gates[name] === 'function' && gates[name]();
};
const mercuryStatusOn = () => gateOn('payrollMercuryStatusLive');
const mercuryPayOn = () => gateOn('payrollMercuryPayLive');

const actorOf = (actor) => (actor && typeof actor === 'object' ? actor.id : actor) || null;
const requireUuid = (id, what) => {
  if (!UUID_RE.test(String(id || ''))) throw new PayrollError(404, `${what} not found.`);
  return String(id);
};
const audit = (trx, actorId, action, resourceType, resourceId, metadata) => recordAuditEvent({
  trx, critical: true, actor_type: 'admin', actor_id: actorId, action, resource_type: resourceType, resource_id: resourceId, metadata,
});
const money = (cents) => `$${(Number(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ---- Dates (ET calendar days as YYYY-MM-DD text)

const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const weekdayOf = (ymd) => new Date(`${ymd}T00:00:00Z`).getUTCDay();
const dayLabel = (ymd) => new Date(`${ymd}T12:00:00Z`)
  .toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

/**
 * The day (5 PM ET) the owner must approve by so the pay lands on the pay date: the Wednesday before it. When the
 * pay date is the 1st of a month the business day before it, because an early landing would move wages into the
 * prior month. Pure.
 */
function approveBy(payDate) {
  if (payDate.slice(8, 10) === '01') return { date: previousBusinessDayIrs(payDate), rule: 'first_of_month' };
  let day = addDays(payDate, -1);
  while (weekdayOf(day) !== 3) day = addDays(day, -1);
  return { date: day, rule: 'wednesday' };
}

// ---- Payment view

function canSendAgainOf(row) {
  if (RETRY_STATES.includes(row.state)) return 'yes';
  return row.state === 'unknown' ? 'confirm' : null;
}

function serializePayment(row, { payOn }) {
  const again = payOn ? canSendAgainOf(row) : null;
  return {
    id: row.id,
    attempt: Number(row.attempt),
    state: row.state,
    amountCents: Number(row.amount_cents),
    postedOn: row.posted_on ? String(row.posted_on).slice(0, 10) : null,
    checkNumber: row.check_number || null,
    error: row.error || null,
    canSendAgain: again,
  };
}

// The latest row of each check (highest attempt).
async function latestPayments(conn, checkIds) {
  if (!checkIds.length) return new Map();
  const rows = await conn('payroll_payments').whereIn('check_id', checkIds)
    .orderBy([{ column: 'check_id' }, { column: 'attempt', order: 'asc' }])
    .select('id', 'check_id', 'attempt', 'state', 'amount_cents', 'check_number', 'error', 'resolution',
      conn.raw("to_char(posted_on, 'YYYY-MM-DD') as posted_on"));
  const latest = new Map();
  for (const row of rows) latest.set(row.check_id, row);
  return latest;
}

/**
 * What the pay run view adds with the status gate on: per check its latest payment, and a summary the Send button
 * reads. No Mercury call: this only reads the database and the env.
 */
async function viewForChecks(conn, run, rows) {
  const payOn = mercuryPayOn();
  const latest = await latestPayments(conn, rows.map((row) => row.id));
  const configured = createClient().configured;
  const byCheck = new Map();
  const missingRecipient = [];
  let eligible = 0;
  const recipients = new Map((await conn('technicians').whereIn('id', rows.map((row) => row.technician_id)).select('id', 'mercury_recipient_id'))
    .map((tech) => [tech.id, tech.mercury_recipient_id]));
  for (const row of rows) {
    const payment = latest.get(row.id) || null;
    const bank = row.pay_method === 'bank_transfer';
    const settledNone = !payment || RETRY_STATES.includes(payment.state);
    const view = payment ? serializePayment(payment, { payOn }) : null;
    byCheck.set(row.id, {
      ...(view || {}),
      ...(view ? {} : { state: 'none' }),
      canPaper: bank && settledNone && Number(row.net_cents) > 0,
      canSendAgain: view ? view.canSendAgain : null,
    });
    if (bank && !payment && Number(row.net_cents) > 0) {
      if (recipients.get(row.technician_id)) eligible += 1; else missingRecipient.push(row.employee_name);
    }
  }
  return {
    byCheck,
    summary: {
      payEnabled: payOn, configured, eligibleCount: eligible, missingRecipient,
      canSend: payOn && configured && run.status === 'finalized' && eligible > 0,
    },
  };
}

// ---- Gate and client guards

function requireReady(client, { pay }) {
  if (!mercuryStatusOn() || (pay && !mercuryPayOn())) throw new PayrollError(404, 'Not found.');
  if (!client.configured) throw new PayrollError(409, 'Mercury is not set up yet. The key and the account must be added first.');
}

// A failed Mercury read as a PayrollError. A refused key also rings its bell.
async function readFailure(err) {
  if (err instanceof MercuryError && err.kind === 'auth') {
    await alerts.raiseKeyAlert();
    return new PayrollError(502, 'Mercury refused the key. A second person must make a new one.');
  }
  return new PayrollError(502, 'Could not read Mercury. Try again.');
}

// ---- Send

const failureText = (err) => `Mercury refused the request${err.status ? ` (HTTP ${err.status})` : ''}${err.code ? `: ${err.code}` : ''}`.slice(0, MAX_ERROR);

async function insertQueued(trx, { check, recipientId, accountId, actorId }) {
  const id = crypto.randomUUID();
  const top = await trx('payroll_payments').where({ check_id: check.id }).max('attempt as top').first();
  const attempt = Number(top && top.top ? top.top : 0) + 1;
  await trx('payroll_payments').insert({
    id,
    check_id: check.id,
    attempt,
    state: 'queued',
    idempotency_key: crypto.randomUUID(),
    note: `waves-pay:${id}`,
    amount_cents: Number(check.net_cents),
    recipient_id: recipientId,
    account_id: accountId,
    created_by: actorId,
  });
  return trx('payroll_payments').where({ id }).first();
}

// POST the request for a queued row and record what came back. A lost answer is `unknown`: never sent again here.
async function dispatch(row, client, conn = db) {
  let patch;
  try {
    const answer = await client.requestSendMoney({
      recipientId: row.recipient_id,
      amountCents: Number(row.amount_cents),
      idempotencyKey: row.idempotency_key,
      note: row.note,
      externalMemo: EXTERNAL_MEMO,
    });
    patch = { state: 'requested', mercury_request_id: answer.requestId, error: null };
  } catch (err) {
    if (err instanceof MercuryError && (err.kind === 'rejected' || err.kind === 'auth')) {
      patch = { state: 'failed', error: err.kind === 'auth' ? `Mercury refused the key${err.status ? ` (HTTP ${err.status})` : ''}` : failureText(err), resolved_at: conn.fn.now() };
      if (err.kind === 'auth') await alerts.raiseKeyAlert();
    } else {
      patch = { state: 'unknown', error: 'Mercury did not answer. The request may or may not have reached it.' };
    }
  }
  try {
    await conn('payroll_payments').where({ id: row.id, state: 'queued' }).update({ ...patch, updated_at: conn.fn.now() });
  } catch (err) {
    // The row stays queued; the poller turns a stale queued row into unknown. Report it as unknown now.
    logger.error(`[payroll-mercury] payment ${row.id} outcome not saved (${(err && (err.code || err.name)) || 'error'})`);
    return { state: 'unknown', error: 'The result could not be saved.' };
  }
  if (patch.state === 'failed') await alerts.raisePaymentAlert('failed', { ...row, ...patch });
  return { state: patch.state, error: patch.error || null };
}

// What Send would do for a run's bank-transfer checks. Read under the caller's connection.
async function planSend(conn, runId) {
  const checks = await conn('payroll_checks as c').join('technicians as t', 't.id', 'c.technician_id')
    .where({ 'c.run_id': runId, 'c.status': 'finalized', 'c.pay_method': 'bank_transfer' })
    .orderBy('c.employee_name')
    .select('c.id', 'c.employee_name', 'c.net_cents', 'c.technician_id', 't.mercury_recipient_id');
  const existing = new Map();
  if (checks.length) {
    const rows = await conn('payroll_payments').whereIn('check_id', checks.map((c) => c.id)).select('check_id', 'state');
    for (const row of rows) existing.set(row.check_id, row.state);
  }
  const eligible = [];
  const skipped = [];
  for (const check of checks) {
    const base = { checkId: check.id, name: check.employee_name, netCents: Number(check.net_cents) };
    let reason = null;
    if (existing.has(check.id)) reason = `already_has_payment:${existing.get(check.id)}`;
    else if (Number(check.net_cents) <= 0) reason = 'no_pay';
    else if (!check.mercury_recipient_id) reason = 'no_recipient';
    if (reason) skipped.push({ ...base, outcome: 'skipped', reason });
    else eligible.push({ ...base, check, recipientId: check.mercury_recipient_id });
  }
  return { eligible, skipped };
}

async function sendRun(runId, actor, { client = createClient(), conn = db } = {}) {
  requireUuid(runId, 'Pay run');
  requireReady(client, { pay: true });
  const actorId = actorOf(actor);
  const { queued, skipped } = await conn.transaction(async (trx) => {
    await lockPayrollMutations(trx);
    const run = await trx('payroll_runs').where({ id: runId }).forUpdate().first('id', 'status');
    if (!run) throw new PayrollError(404, 'Pay run not found.');
    if (run.status !== 'finalized') throw new PayrollError(409, 'Finalize the pay run before sending it to Mercury.');
    const plan = await planSend(trx, runId);
    const rows = [];
    for (const item of plan.eligible) {
      rows.push({ row: await insertQueued(trx, { check: item.check, recipientId: item.recipientId, accountId: client.accountId, actorId }), item });
    }
    if (rows.length) await audit(trx, actorId, 'payroll.mercury_send_queued', 'payroll_runs', runId, { run_id: runId, payment_count: rows.length });
    return { queued: rows, skipped: plan.skipped };
  });
  // The rows are committed. Now the requests, one at a time; each check stands alone.
  const results = [...skipped];
  for (const { row, item } of queued) {
    const outcome = await dispatch(row, client, conn);
    results.push({ checkId: item.checkId, name: item.name, netCents: item.netCents, outcome: outcome.state, ...(outcome.error ? { message: outcome.error } : {}) });
  }
  return results;
}

// ---- Warnings before Send (never a block)

async function unpaidPayrollTaxCents(conn) {
  const rows = await conn('tax_filing_calendar').where('source_key', 'like', 'payroll:%')
    .whereNotIn('status', ['filed', 'paid']).select('amount_due');
  return rows.reduce((sum, row) => sum + Math.round(Number(row.amount_due || 0) * 100), 0);
}

async function fundingWarning(conn, client, { payrollCents, ownRequestIds }) {
  try {
    const [{ availableCents }, requests, taxCents] = await Promise.all([
      client.getBalance(), client.listRequests({ status: 'pendingApproval' }), unpaidPayrollTaxCents(conn),
    ]);
    const otherCents = requests.filter((r) => !ownRequestIds.has(r.requestId)).reduce((sum, r) => sum + r.amountCents, 0);
    const need = payrollCents + otherCents + taxCents;
    return {
      kind: 'funding', short: availableCents < need, availableCents, payrollCents, otherRequestsCents: otherCents, taxCents, needCents: need,
      text: `Mercury shows ${money(availableCents)} available. This run needs ${money(payrollCents)}, other open requests ${money(otherCents)}, and unpaid payroll taxes ${money(taxCents)}: ${money(need)} in all.`,
    };
  } catch (err) {
    if (err instanceof MercuryError && err.kind === 'auth') await alerts.raiseKeyAlert();
    return { kind: 'funding', short: null, text: 'Could not read the Mercury balance. Check it in Mercury before you approve.' };
  }
}

async function keyWarning(conn, now) {
  const last = await conn('payroll_payments').whereNotNull('mercury_request_id').max('created_at as at').first();
  if (!last || !last.at) return { kind: 'key', stale: true, first: true, text: 'First payment: check the Mercury key still allows payment requests.' };
  const days = Math.floor((now.getTime() - new Date(last.at).getTime()) / DAY_MS);
  const stale = days > KEY_STALE_DAYS;
  return {
    kind: 'key', stale, first: false, days,
    text: stale
      ? `The last payment request was ${days} days ago. Mercury lowers an unused key after 45 days: check the key.`
      : `The last payment request was ${days} days ago.`,
  };
}

/**
 * The confirm step's three warnings for a finalized run: funding, key health and the approve-by day. Reads Mercury
 * (balance, open requests). Never blocks: every part can fail on its own and says so in words.
 */
async function sendPreview(runId, { client = createClient(), conn = db, now = new Date() } = {}) {
  requireUuid(runId, 'Pay run');
  requireReady(client, { pay: false });
  const run = await conn('payroll_runs').where({ id: runId })
    .first('id', 'status', conn.raw("to_char(pay_date, 'YYYY-MM-DD') as pay_date"));
  if (!run) throw new PayrollError(404, 'Pay run not found.');
  if (run.status !== 'finalized') throw new PayrollError(409, 'Finalize the pay run first.');
  const plan = await planSend(conn, runId);
  const ownRequestIds = new Set((await conn('payroll_payments as p').join('payroll_checks as c', 'c.id', 'p.check_id')
    .where('c.run_id', runId).whereNotNull('p.mercury_request_id').select('p.mercury_request_id')).map((r) => r.mercury_request_id));
  const payrollCents = plan.eligible.reduce((sum, item) => sum + item.netCents, 0);
  const by = approveBy(run.pay_date);
  const [funding, key] = await Promise.all([fundingWarning(conn, client, { payrollCents, ownRequestIds }), keyWarning(conn, now)]);
  return {
    runId,
    payDate: run.pay_date,
    eligible: plan.eligible.map(({ checkId, name, netCents }) => ({ checkId, name, netCents })),
    skipped: plan.skipped,
    approveBy: {
      date: by.date, rule: by.rule,
      text: `Approve in Mercury by ${dayLabel(by.date)} at 5 PM ET so the pay lands on ${dayLabel(run.pay_date)}${by.rule === 'first_of_month' ? ' (not earlier: an early landing would move wages into the prior month)' : ''}.`,
    },
    funding,
    key,
  };
}

// ---- Send again

const sendAgainSchema = Joi.object({ confirmNothingWaiting: Joi.boolean().default(false) });

function validate(schema, input) {
  const { value, error } = schema.validate(input || {}, { abortEarly: true, convert: true, allowUnknown: false });
  if (error) throw new PayrollError(400, error.details[0].message);
  return value;
}

async function loadSendableCheck(conn, checkId) {
  const check = await conn('payroll_checks as c').join('technicians as t', 't.id', 'c.technician_id')
    .join('payroll_runs as r', 'r.id', 'c.run_id')
    .where('c.id', checkId)
    .first('c.id', 'c.status', 'c.pay_method', 'c.net_cents', 'c.employee_name', 'c.run_id', 'r.status as run_status', 't.mercury_recipient_id');
  if (!check) throw new PayrollError(404, 'Paycheck not found.');
  if (check.status !== 'finalized' || check.run_status !== 'finalized') throw new PayrollError(409, 'The pay run must be final.');
  if (check.pay_method !== 'bank_transfer') throw new PayrollError(409, 'This paycheck is not a bank transfer.');
  if (Number(check.net_cents) <= 0) throw new PayrollError(409, 'This paycheck has no pay to send.');
  return check;
}

// True when Mercury shows a live request or a transaction of this amount to this recipient in the last 7 days.
async function mercuryHoldsSameAmount(client, { recipientId, amountCents, now }) {
  const since = now.getTime() - SEND_AGAIN_LOOKBACK_DAYS * DAY_MS;
  const recent = (iso) => Boolean(iso) && new Date(iso).getTime() >= since;
  const [requests, transactions] = await Promise.all([
    client.listRequests(),
    client.listTransactions({ start: etDateString(new Date(since)) }),
  ]);
  const requestHit = requests.some((r) => r.recipientId === recipientId && r.amountCents === amountCents
    && recent(r.createdAt) && !['rejected', 'cancelled'].includes(r.status));
  const transactionHit = transactions.some((t) => t.counterpartyId === recipientId && t.amountCents === amountCents
    && recent(t.createdAt) && !['failed', 'cancelled', 'blocked'].includes(t.status));
  return requestHit || transactionHit;
}

async function sendAgain(checkId, input, actor, { client = createClient(), conn = db, now = new Date() } = {}) {
  requireUuid(checkId, 'Paycheck');
  const v = validate(sendAgainSchema, input);
  requireReady(client, { pay: true });
  const actorId = actorOf(actor);
  const check = await loadSendableCheck(conn, checkId);
  if (!check.mercury_recipient_id) throw new PayrollError(409, 'Save the Mercury recipient id for this employee first.');
  const before = (await latestPayments(conn, [checkId])).get(checkId);
  if (!before) throw new PayrollError(409, 'Nothing was sent yet. Use Send to Mercury.');
  const mode = canSendAgainOf(before);
  if (!mode) throw new PayrollError(409, 'This payment is still open. Wait for it to finish, or reject it in Mercury first.');
  if (mode === 'confirm') {
    if (!v.confirmNothingWaiting) throw new PayrollError(409, 'Confirm that nothing is waiting in Mercury first.');
    let held;
    try {
      held = await mercuryHoldsSameAmount(client, { recipientId: check.mercury_recipient_id, amountCents: Number(check.net_cents), now });
    } catch (err) { throw await readFailure(err); }
    if (held) throw new PayrollError(409, 'Mercury already shows a request or payment of this amount to this person in the last 7 days. Check Mercury first.');
  }
  const queued = await conn.transaction(async (trx) => {
    await lockPayrollMutations(trx);
    const now_ = await trx('payroll_payments').where({ check_id: checkId }).orderBy('attempt', 'desc').forUpdate().first();
    if (!now_ || now_.id !== before.id || now_.state !== before.state) throw new PayrollError(409, 'This payment changed. Reload and look again.');
    if (now_.state === 'unknown') {
      await trx('payroll_payments').where({ id: now_.id }).update({
        state: 'failed', resolved_at: trx.fn.now(), updated_at: trx.fn.now(),
        resolution: 'Owner confirmed nothing was waiting in Mercury and sent again',
      });
    }
    const row = await insertQueued(trx, { check, recipientId: check.mercury_recipient_id, accountId: client.accountId, actorId });
    await audit(trx, actorId, 'payroll.mercury_send_again', 'payroll_checks', checkId, { check_id: checkId, payment_id: row.id, attempt: row.attempt });
    return row;
  });
  await alerts.closePaymentBells(before.id, 'A new attempt was started');
  const outcome = await dispatch(queued, client, conn);
  return { checkId, paymentId: queued.id, attempt: Number(queued.attempt), outcome: outcome.state, ...(outcome.error ? { message: outcome.error } : {}) };
}

// ---- Paid by paper check instead

const paperSchema = Joi.object({
  checkNumber: Joi.string().trim().pattern(/^[\x20-\x7E]+$/).min(1).max(30).required()
    .messages({ 'string.pattern.base': 'Check number has characters that are not allowed', 'any.required': 'Enter the check number' }),
});

async function recordPaper(checkId, input, actor, { conn = db } = {}) {
  requireUuid(checkId, 'Paycheck');
  if (!mercuryStatusOn()) throw new PayrollError(404, 'Not found.');
  const v = validate(paperSchema, input);
  const actorId = actorOf(actor);
  const payment = await conn.transaction(async (trx) => {
    await lockPayrollMutations(trx);
    const check = await trx('payroll_checks as c').join('payroll_runs as r', 'r.id', 'c.run_id').where('c.id', checkId).forUpdate('c')
      .first('c.id', 'c.status', 'c.pay_method', 'c.net_cents', 'r.status as run_status');
    if (!check) throw new PayrollError(404, 'Paycheck not found.');
    if (check.status !== 'finalized' || check.run_status !== 'finalized') throw new PayrollError(409, 'The pay run must be final.');
    if (check.pay_method !== 'bank_transfer') throw new PayrollError(409, 'This paycheck is already a paper check. Use its check number box.');
    if (Number(check.net_cents) <= 0) throw new PayrollError(409, 'This paycheck has no pay.');
    const latest = await trx('payroll_payments').where({ check_id: checkId }).orderBy('attempt', 'desc').forUpdate().first();
    if (latest && OPEN_STATES.includes(latest.state)) {
      throw new PayrollError(409, latest.state === 'paper'
        ? 'A paper check is already recorded for this paycheck.'
        : 'A Mercury payment is still open for this paycheck. Reject it in Mercury first, or wait for it to fail.');
    }
    const id = crypto.randomUUID();
    await trx('payroll_payments').insert({
      id, check_id: checkId, attempt: latest ? Number(latest.attempt) + 1 : 1, state: 'paper', check_number: v.checkNumber,
      amount_cents: Number(check.net_cents), created_by: actorId, resolved_at: trx.fn.now(), resolution: 'Paid by paper check instead',
    });
    await audit(trx, actorId, 'payroll.mercury_paper_recorded', 'payroll_checks', checkId, { check_id: checkId, payment_id: id });
    return { id, previousId: latest ? latest.id : null };
  });
  if (payment.previousId) await alerts.closePaymentBells(payment.previousId, 'Paid by paper check instead');
  return { checkId, paymentId: payment.id, checkNumber: v.checkNumber };
}

// ---- Void guard

// Voiding a run is refused while a payment of one of its checks may have money on the way.
async function assertNoOpenPayments(trx, checkIds) {
  if (!checkIds.length) return;
  const open = await trx('payroll_payments').whereIn('check_id', checkIds).whereIn('state', BLOCKING_STATES).first('id');
  if (open) {
    throw new PayrollError(409, 'A Mercury payment for this run is not settled. Reject it in Mercury first, or record that the money came back.');
  }
}

// ---- Recipient id on a technician

const recipientSchema = Joi.object({
  recipientId: Joi.string().trim().allow('', null).pattern(UUID_RE).default(null)
    .messages({ 'string.pattern.base': 'The Mercury recipient id looks wrong. Copy it again from Mercury.' }),
});

async function setMercuryRecipient(technicianId, input, actor, { client = createClient(), conn = db } = {}) {
  requireUuid(technicianId, 'Technician');
  if (!mercuryStatusOn()) throw new PayrollError(404, 'Not found.');
  const v = validate(recipientSchema, input);
  const recipientId = v.recipientId ? String(v.recipientId).toLowerCase() : null;
  const actorId = actorOf(actor);
  // The check is a read of Mercury done before the write: only the payee's name comes back, never numbers.
  let recipientName = null;
  if (recipientId && client.configured) {
    try {
      const found = await client.getRecipient(recipientId);
      if (found.status === 'deleted') throw new PayrollError(400, 'That Mercury recipient was deleted. Pick another.');
      recipientName = found.name || null;
    } catch (err) {
      if (err instanceof PayrollError) throw err;
      if (err instanceof MercuryError && err.kind === 'not_found') throw new PayrollError(400, 'Mercury has no recipient with that id.');
      throw await readFailure(err);
    }
  }
  await conn.transaction(async (trx) => {
    const tech = await trx('technicians').where({ id: technicianId }).forUpdate().first('id', 'employment_type');
    if (!tech) throw new PayrollError(404, 'Technician not found.');
    if (tech.employment_type !== 'w2') throw new PayrollError(409, 'The Mercury recipient is for W-2 employees.');
    try {
      await trx('technicians').where({ id: technicianId }).update({ mercury_recipient_id: recipientId, updated_at: trx.fn.now() });
    } catch (err) {
      if (err && err.code === '23505') throw new PayrollError(409, 'Another employee already uses that Mercury recipient.');
      throw err;
    }
    await audit(trx, actorId, 'payroll.mercury_recipient_set', 'technicians', technicianId, { technician_id: technicianId, cleared: !recipientId });
  });
  return { id: technicianId, mercuryRecipientId: recipientId, recipientName, verified: Boolean(recipientName) };
}

module.exports = {
  OPEN_STATES, BLOCKING_STATES, RETRY_STATES, KEY_STALE_DAYS,
  mercuryStatusOn, mercuryPayOn, approveBy, dayLabel, canSendAgainOf, failureText,
  viewForChecks, latestPayments, planSend, dispatch,
  sendRun, sendPreview, sendAgain, recordPaper, assertNoOpenPayments, setMercuryRecipient,
};
