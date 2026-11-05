/**
 * Lead contact sync: GATE_LEAD_STATUS_FOLLOWS_CONTACT (owner 2026-11-04,
 * "WHY ARENT THESE UPDATED ... FOR ALL COMUNNICATION LINES").
 *
 * A lead row reads 'new' until one of three narrow writers moves it: the call
 * agent on a live conversation, a manual text from the Leads page, and an
 * assessment booking. A person who reached the lead any other way (a text from
 * the Comms tab or a phone, a call back, a Gmail reply, a visit booked for the
 * lead's customer) left it 'new', so the Leads page, Speed-to-Lead and the
 * "waiting for first contact" queue disagreed with reality.
 *
 * This sweep (every 10 minutes, scheduler.js) looks for POSITIVE contact AFTER
 * the lead's first_contact_at and moves the lead through the one writer that
 * already owns the transition, markLeadContactedFromEvidence (identity pin,
 * status claim under a row lock, first-response stamp, history row, funnel
 * bridge). The evidence, all of it positive:
 *   - staff_text: a text a PERSON sent (operatorReplySql) that was delivered
 *     (smsDeliveredSql) to the lead's phone; staff-contact.js, the one
 *     definition every contact witness shares. The lead auto-reply, the
 *     voicemail quote link and the missed-you text are automated and never match.
 *   - live_conversation: a completed call on the lead's phone that a person
 *     placed and spoke on (personCallBackSql), that a person answered
 *     (answered_by = 'human'), or that the call agent heard as a live
 *     conversation (a valid extraction, not voicemail, not spam). The same bar
 *     as call-recording-processor.js isLiveLeadConversation. A voicemail, a
 *     missed or failed call never counts. The call that created the lead is
 *     never its own evidence.
 *   - staff_email: a Gmail SENT row to the lead's address (personSentFilter).
 *   - visit_booked: a live top-level visit booked for the lead's own linked
 *     customer after first contact (the lead_contacted close rule's predicate).
 * Never 'won': the booking conversion owns that. Nothing here texts, calls,
 * emails or books anyone.
 *
 * Identity, never guess: a lead is skipped (and the reason counted and logged)
 * when another open lead shares its phone or email, when its customer has more
 * than one open lead (a visit cannot say which), when the contact row belongs
 * to a different customer than the lead, or when a person already returned the
 * lead to 'new' by hand (a 'Status: x -> new' history row: the documented
 * undo stands). Shadow mode judges the same way and writes nothing.
 */

const db = require('../models/db');
const logger = require('./logger');
const { leadStatusFollowsContactMode } = require('../config/feature-gates');
const { OPEN_LEAD_STATUSES } = require('./lead-statuses');
const { excludeInternalTestLeads } = require('./lead-waiting-queue');
const { phoneIdentityKey } = require('../utils/phone');
const { phoneIdentitySql } = require('./sms-response-policy');
const { operatorReplySql, smsDeliveredSql, personCallBackSql } = require('./staff-contact');
const { excludeUnresolvedSendReservations } = require('./messaging/review-ask-reservation');
const { whereNotSandboxCall } = require('./voice-agent/relay-protocol');
const { callEndedAtSql } = require('./sms-pending-conversations');
const { personSentFilter, resolveEmailCustomerLink, extractEmailAddresses } = require('./email/email-customer-link');
const { VISIT_NEVER_RAN_STATUSES } = require('./invoice-helpers');

const PERFORMED_BY = 'Lead contact sync';
// Only leads first touched this recently are judged: older ones are the daily
// staleness sweep's (lead-staleness.js parks a silent 'new' lead after 21 days).
const LOOKBACK_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
// One run judges at most SCAN_CAP leads (newest first) and moves at most
// WRITE_CAP, so a bad day cannot turn into a bulk rewrite.
const SCAN_CAP = 200;
const WRITE_CAP = 50;
// Witness rows read per kind in one run. Hitting it is logged, never silent.
const ROW_CAP = 5000;

const asDate = (value) => {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
};
const uniq = (list) => [...new Set(list.filter(Boolean))];

// A phone key only when it names one line: 10 NANP digits, or a +-prefixed
// international number. A fragment or free text names nobody.
function usablePhoneKey(raw) {
  const key = phoneIdentityKey(raw);
  if (!key) return null;
  if (/^\d{10}$/.test(key)) return key;
  return /^\+[1-9]\d{7,14}$/.test(key) ? key : null;
}

function leadEmail(raw) {
  const [first] = extractEmailAddresses(raw);
  return first || null;
}

// The 'new' leads this sweep judges: live, first touched inside the lookback,
// not internal/test. Newest first so a fresh lead is never starved by a pile.
function candidateLeadsQuery(dbi, now) {
  const query = dbi('leads')
    .where('status', 'new')
    .whereNull('deleted_at')
    .whereNull('converted_at')
    .whereNotNull('first_contact_at')
    .where('first_contact_at', '>=', new Date(now.getTime() - LOOKBACK_DAYS * DAY_MS));
  return excludeInternalTestLeads(query, dbi);
}

// ---- Witness reads: one bulk query per kind for the whole batch ----------
// Every loader returns WITNESSES in one shape, so the judging below is one loop
// over a table of kinds with no per-kind branches:
//   { type, id, at, startedAt, scope, key, customerId, originOf }
// `key` is `<scope>:<value>` (phone, email or customer), the identity the
// contact names; `customerId` is the customer the contact row itself carries.
const ms = (value) => asDate(value).getTime();
const witness = (type, scope, value, row, extra = {}) => ({
  type, id: String(row.id), at: ms(row.at), startedAt: ms(row.at), scope, key: `${scope}:${value}`,
  customerId: row.customer_id == null ? null : String(row.customer_id), originOf: [], ...extra,
});

async function staffTexts(dbi, peers, since) {
  const peer = phoneIdentitySql('os.to_phone');
  const rows = await excludeUnresolvedSendReservations(dbi('sms_log as os').where('os.direction', 'outbound'), 'os')
    .whereRaw(operatorReplySql('os'))
    .whereRaw(smsDeliveredSql('os'))
    .where('os.created_at', '>', since)
    .whereRaw(`${peer} = ANY(?)`, [peers])
    .orderBy('os.created_at', 'asc')
    .limit(ROW_CAP)
    .select('os.id', 'os.customer_id', 'os.created_at as at', dbi.raw(`${peer} as peer`));
  return rows.map((row) => witness('staff_text', 'phone', row.peer, row));
}

// Completed calls on a lead phone that reached a person or the call agent.
// Judged by when the call ENDED (callEndedAtSql, the Messages reader's
// definition): a row with no trustworthy end counts for nothing. The call
// that created a lead (metadata lead_id / relay_lead_id) is never its evidence.
async function connectedCalls(dbi, peers, since) {
  const ended = callEndedAtSql('cl');
  const peerSql = `(CASE WHEN cl.direction = 'inbound' THEN ${phoneIdentitySql('cl.from_phone')} ELSE ${phoneIdentitySql('cl.to_phone')} END)`;
  const rows = await whereNotSandboxCall(dbi('call_log as cl'), 'cl.source')
    .where('cl.status', 'completed')
    .whereIn('cl.direction', ['inbound', 'outbound'])
    .where('cl.created_at', '>', since)
    .whereRaw(`${peerSql} = ANY(?)`, [peers])
    .whereRaw(`${ended} IS NOT NULL`)
    .where((connected) => {
      connected
        .where((placed) => placed.where('cl.direction', 'outbound').whereRaw(personCallBackSql('cl')))
        .orWhere((answered) => answered.where('cl.direction', 'inbound').where('cl.answered_by', 'human'))
        .orWhere((agent) => agent
          .where('cl.processing_status', 'processed')
          .where('cl.v2_extraction_status', 'valid')
          .whereRaw("cl.ai_extraction_enriched->'meta'->>'is_voicemail' = 'false'")
          .whereRaw("COALESCE(cl.call_outcome, '') <> 'voicemail'")
          .whereRaw("COALESCE(cl.answered_by, '') <> 'voicemail'"));
    })
    .orderBy('cl.created_at', 'asc')
    .limit(ROW_CAP)
    .select(
      'cl.id', 'cl.customer_id', 'cl.created_at',
      dbi.raw(`${ended} as at`), dbi.raw(`${peerSql} as peer`),
      dbi.raw("cl.metadata->>'lead_id' as origin_lead_id"),
      dbi.raw("cl.metadata->>'relay_lead_id' as relay_lead_id"),
    );
  return rows.map((row) => witness('live_conversation', 'phone', row.peer, row, {
    startedAt: ms(row.created_at), originOf: [String(row.origin_lead_id), String(row.relay_lead_id)],
  }));
}

// Gmail SENT rows whose To/Cc/Bcc text carries one of the lead addresses.
// The text match is a prefilter; the parsed address list decides. One witness
// per lead address named, carrying the customer the send links to.
async function staffEmails(dbi, addresses, since) {
  const recipientText = "LOWER(CONCAT_WS(',', er.to_address, er.cc_address, er.bcc_address))";
  const rows = await dbi('emails as er')
    .whereRaw(personSentFilter('er'))
    .where('er.received_at', '>', since)
    .whereRaw(`EXISTS (SELECT 1 FROM unnest(?::text[]) AS a(addr) WHERE strpos(${recipientText}, a.addr) > 0)`, [addresses])
    .orderBy('er.received_at', 'asc')
    .limit(ROW_CAP)
    .select('er.id', 'er.gmail_thread_id', 'er.to_address', 'er.cc_address', 'er.bcc_address', 'er.received_at as at');
  const named = await Promise.all(rows.map(async (row) => {
    const recipients = extractEmailAddresses([row.to_address, row.cc_address, row.bcc_address].filter(Boolean).join(','));
    const linked = await resolveEmailCustomerLink(dbi, row);
    return recipients.filter((addr) => addresses.includes(addr))
      .map((addr) => witness('staff_email', 'email', addr, { ...row, customer_id: linked }));
  }));
  return named.flat();
}

// A booking someone made that is still on the books: not a visit that never
// ran, never a child the system generated on its own. The customer is the
// lead's own by construction, so the witness carries no customer of its own.
async function bookedVisits(dbi, customerIds, since) {
  const rows = await dbi('scheduled_services as ss')
    .whereIn('ss.customer_id', customerIds)
    .where('ss.created_at', '>', since)
    .where((live) => live.whereNull('ss.status').orWhereNotIn('ss.status', VISIT_NEVER_RAN_STATUSES))
    .whereNull('ss.recurring_parent_id')
    .whereNull('ss.parent_service_id')
    .orderBy('ss.created_at', 'asc')
    .limit(ROW_CAP)
    .select('ss.id', 'ss.customer_id', 'ss.created_at as at');
  return rows.map((row) => witness('visit_booked', 'customer', row.customer_id, { ...row, customer_id: null }));
}

// Open leads sharing identity with the batch, as Map(key -> Set(lead ids)).
async function openLeadIdentities(dbi, { peers, emails, customerIds }) {
  const peerSql = phoneIdentitySql('leads.phone');
  const rows = await dbi('leads')
    .whereIn('status', OPEN_LEAD_STATUSES)
    .whereNull('converted_at')
    .whereNull('deleted_at')
    .where((same) => same
      .orWhereRaw(`${peerSql} = ANY(?)`, [peers])
      .orWhereRaw('LOWER(TRIM(leads.email)) = ANY(?)', [emails])
      .orWhereIn('leads.customer_id', customerIds))
    .select('id', 'customer_id', 'email', dbi.raw(`${peerSql} as peer`));
  const owners = new Map();
  for (const row of rows) {
    const keys = [`phone:${row.peer}`, `email:${leadEmail(row.email)}`, `customer:${row.customer_id}`];
    for (const key of keys) owners.set(key, (owners.get(key) || new Set()).add(String(row.id)));
  }
  return owners;
}

// Leads a person already returned to 'new' by hand. The history row the Leads
// page writes reads 'Status: <from> -> new' (with the arrow); that undo stands.
async function reopenedLeadIds(dbi, leadIds) {
  const rows = await dbi('lead_activities')
    .whereIn('lead_id', leadIds)
    .where('activity_type', 'status_change')
    .whereRaw("description LIKE '%→ new'")
    .distinct('lead_id');
  return new Set(rows.map((r) => String(r.lead_id)));
}

// ---- Judging --------------------------------------------------------------

// What a skipped lead is reported as, by the scope its ambiguous contact named.
const SHARED_REASON = { phone: 'shared_phone', email: 'shared_email', customer: 'multiple_open_leads_for_customer' };

/**
 * Judge a batch of 'new' leads. Read-only: returns Map(lead id -> verdict),
 * every lead with one: the earliest positive contact
 * ({ evidenceType, evidenceId, at }) or { skip: reason }. Each lead is judged
 * only on contact after its OWN first_contact_at.
 */
async function judgeLeads(dbi, leads) {
  const verdicts = new Map();
  if (!leads.length) return verdicts;
  const since = new Date(Math.min(...leads.map((l) => ms(l.first_contact_at))));
  const idents = leads.map((lead) => {
    const customerId = lead.customer_id ?? null;
    const keys = [`phone:${usablePhoneKey(lead.phone)}`, `email:${leadEmail(lead.email)}`, `customer:${customerId}`];
    return { id: String(lead.id), firstAt: ms(lead.first_contact_at), customerId: customerId && String(customerId), keys };
  });
  const peers = uniq(leads.map((l) => usablePhoneKey(l.phone)));
  const emails = uniq(leads.map((l) => leadEmail(l.email)));
  const customerIds = uniq(leads.map((l) => l.customer_id));

  const [texts, calls, mails, visits, owners, reopened] = await Promise.all([
    staffTexts(dbi, peers, since),
    connectedCalls(dbi, peers, since),
    staffEmails(dbi, emails, since),
    bookedVisits(dbi, customerIds, since),
    openLeadIdentities(dbi, { peers, emails, customerIds }),
    reopenedLeadIds(dbi, idents.map((i) => i.id)),
  ]);
  const byKey = new Map();
  for (const w of [...texts, ...calls, ...mails, ...visits]) byKey.set(w.key, [...(byKey.get(w.key) || []), w]);

  for (const { id, firstAt, customerId, keys } of idents) {
    const mine = keys.flatMap((key) => byKey.get(key) || [])
      .filter((w) => w.at > firstAt && w.startedAt > firstAt && !w.originOf.includes(id))
      .sort((a, b) => a.at - b.at);
    const skips = [];
    const usable = [];
    for (const w of mine) {
      if (w.customerId && w.customerId !== customerId) skips.push('customer_mismatch');
      else if ((owners.get(w.key)?.size || 0) > 1) skips.push(SHARED_REASON[w.scope]);
      else usable.push(w);
    }
    const first = usable[0];
    const evidence = first && { evidenceType: first.type, evidenceId: first.id, at: new Date(first.at) };
    verdicts.set(id, reopened.has(id) ? { skip: 'reopened_by_person' } : evidence || { skip: skips[0] || 'no_contact_evidence' });
  }
  return verdicts;
}

// What a verdict does in each mode. Shadow logs and reports success without a
// write; true moves the lead through the one writer that owns the transition.
const APPLY = {
  shadow: async (dbi, lead, verdict) => {
    logger.info(`[lead-contact-sync] shadow: lead ${lead.id} would move to contacted (${verdict.evidenceType})`);
    return { contacted: true };
  },
  true: (dbi, lead, verdict) => require('./lead-estimate-link').markLeadContactedFromEvidence({
    database: dbi,
    leadId: lead.id,
    customerId: lead.customer_id ?? null,
    evidenceType: verdict.evidenceType,
    evidenceId: verdict.evidenceId,
    performedBy: PERFORMED_BY,
    respondedAt: verdict.at,
  }),
};

const tally = (counts, key) => { counts[key] = (counts[key] || 0) + 1; };

/**
 * The sweep. `mode` defaults to the gate: 'off' does nothing, 'shadow' judges
 * and logs what would move (counts by evidence type), 'true' writes.
 */
async function runLeadContactSync(options = {}) {
  const { dbi, now, mode, scanCap, writeCap } = {
    dbi: db, now: new Date(), mode: leadStatusFollowsContactMode(), scanCap: SCAN_CAP, writeCap: WRITE_CAP, ...options,
  };
  if (!APPLY[mode]) return { skipped: 'gate_off' };

  const results = { mode, scanned: 0, candidates: 0, moved: 0, byEvidence: {}, skipped: {}, errors: 0, moves: [] };
  const leads = await candidateLeadsQuery(dbi, now)
    .orderBy('first_contact_at', 'desc').orderBy('id', 'desc').limit(scanCap)
    .select('id', 'customer_id', 'phone', 'email', 'first_contact_at');
  results.scanned = leads.length;
  const verdicts = await judgeLeads(dbi, leads);

  for (const lead of leads) {
    const verdict = verdicts.get(String(lead.id));
    if (verdict.skip) { tally(results.skipped, verdict.skip); continue; }
    results.candidates += 1;
    if (results.moved >= writeCap) { tally(results.skipped, 'write_cap'); continue; }
    try {
      const outcome = await APPLY[mode](dbi, lead, verdict);
      if (!outcome.contacted) { tally(results.skipped, outcome.reason); continue; }
      results.moved += 1;
      tally(results.byEvidence, verdict.evidenceType);
      results.moves.push({ leadId: lead.id, evidenceType: verdict.evidenceType });
    } catch (err) {
      results.errors += 1;
      logger.warn(`[lead-contact-sync] lead ${lead.id} left new: ${err.code || err.name || 'error'}`);
    }
  }

  logger.info(`[lead-contact-sync] mode=${mode} scanned=${results.scanned} moved=${results.moved} errors=${results.errors} byEvidence=${JSON.stringify(results.byEvidence)} skipped=${JSON.stringify(results.skipped)}`);
  return results;
}

module.exports = {
  runLeadContactSync,
  judgeLeads,
  candidateLeadsQuery,
  PERFORMED_BY,
  LOOKBACK_DAYS,
  _test: { usablePhoneKey, leadEmail },
};
