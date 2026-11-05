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

async function staffTexts(dbi, peers, since) {
  if (!peers.length) return [];
  const peer = phoneIdentitySql('os.to_phone');
  const rows = await excludeUnresolvedSendReservations(dbi('sms_log as os').where('os.direction', 'outbound'), 'os')
    .whereRaw(operatorReplySql('os'))
    .whereRaw(smsDeliveredSql('os'))
    .where('os.created_at', '>', since)
    .whereRaw(`${peer} = ANY(?)`, [peers])
    .orderBy('os.created_at', 'asc')
    .limit(ROW_CAP)
    .select('os.id', 'os.customer_id', 'os.created_at as at', dbi.raw(`${peer} as peer`));
  if (rows.length >= ROW_CAP) logger.warn('[lead-contact-sync] staff text read hit its row cap');
  return rows;
}

// Completed calls on a lead phone that reached a person or the call agent.
// Judged by when the call ENDED (callEndedAtSql, the Messages reader's
// definition): a row with no trustworthy end counts for nothing.
async function connectedCalls(dbi, peers, since) {
  if (!peers.length) return [];
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
  if (rows.length >= ROW_CAP) logger.warn('[lead-contact-sync] connected call read hit its row cap');
  return rows;
}

// Gmail SENT rows whose To/Cc/Bcc text carries one of the lead addresses.
// The text match is a prefilter; the parsed address list decides.
async function staffEmails(dbi, addresses, since) {
  if (!addresses.length) return [];
  const recipientText = "LOWER(CONCAT_WS(',', er.to_address, er.cc_address, er.bcc_address))";
  const rows = await dbi('emails as er')
    .whereRaw(personSentFilter('er'))
    .where('er.received_at', '>', since)
    .whereRaw(`EXISTS (SELECT 1 FROM unnest(?::text[]) AS a(addr) WHERE strpos(${recipientText}, a.addr) > 0)`, [addresses])
    .orderBy('er.received_at', 'asc')
    .limit(ROW_CAP)
    .select('er.id', 'er.gmail_thread_id', 'er.to_address', 'er.cc_address', 'er.bcc_address', 'er.received_at as at');
  if (rows.length >= ROW_CAP) logger.warn('[lead-contact-sync] staff email read hit its row cap');
  return rows;
}

// A booking someone made that is still on the books: not a visit that never
// ran, never a child the system generated on its own.
async function bookedVisits(dbi, customerIds, since) {
  if (!customerIds.length) return [];
  return dbi('scheduled_services as ss')
    .whereIn('ss.customer_id', customerIds)
    .where('ss.created_at', '>', since)
    .where((live) => live.whereNull('ss.status').orWhereNotIn('ss.status', VISIT_NEVER_RAN_STATUSES))
    .whereNull('ss.recurring_parent_id')
    .whereNull('ss.parent_service_id')
    .orderBy('ss.created_at', 'asc')
    .limit(ROW_CAP)
    .select('ss.id', 'ss.customer_id', 'ss.created_at as at');
}

// Open leads sharing identity with the batch: by phone, email or customer.
async function openLeadsSharing(dbi, { peers, emails, customerIds }) {
  if (!peers.length && !emails.length && !customerIds.length) return [];
  const peerSql = phoneIdentitySql('leads.phone');
  return dbi('leads')
    .whereIn('status', OPEN_LEAD_STATUSES)
    .whereNull('converted_at')
    .whereNull('deleted_at')
    .where((same) => {
      if (peers.length) same.orWhereRaw(`${peerSql} = ANY(?)`, [peers]);
      if (emails.length) same.orWhereRaw('LOWER(TRIM(leads.email)) = ANY(?)', [emails]);
      if (customerIds.length) same.orWhereIn('leads.customer_id', customerIds);
    })
    .select('id', 'customer_id', 'email', dbi.raw(`${peerSql} as peer`));
}

// Leads a person already returned to 'new' by hand. The history row the Leads
// page writes reads 'Status: <from> -> new' (with the arrow); that undo stands.
async function reopenedLeadIds(dbi, leadIds) {
  if (!leadIds.length) return new Set();
  const rows = await dbi('lead_activities')
    .whereIn('lead_id', leadIds)
    .where('activity_type', 'status_change')
    .whereRaw("description LIKE '%→ new'")
    .distinct('lead_id');
  return new Set(rows.map((r) => String(r.lead_id)));
}

// ---- Judging --------------------------------------------------------------

const sameCustomer = (leadCustomer, rowCustomer) => String(leadCustomer || '') === String(rowCustomer || '');

/**
 * Judge a batch of 'new' leads. Read-only: returns, per lead, either the
 * earliest positive contact ({ evidenceType, evidenceId, at }) or a skip
 * reason. `since` is the earliest first_contact_at in the batch; each lead is
 * then judged only on contact after its OWN first_contact_at.
 */
async function judgeLeads(dbi, leads) {
  const verdicts = new Map();
  if (!leads.length) return verdicts;
  const since = new Date(Math.min(...leads.map((l) => asDate(l.first_contact_at).getTime())));
  const idents = leads.map((lead) => ({
    lead,
    firstAt: asDate(lead.first_contact_at),
    peer: usablePhoneKey(lead.phone),
    email: leadEmail(lead.email),
    customerId: lead.customer_id ? String(lead.customer_id) : null,
  }));
  const peers = uniq(idents.map((i) => i.peer));
  const emails = uniq(idents.map((i) => i.email));
  const customerIds = uniq(idents.map((i) => i.customerId));

  const [texts, calls, mails, visits, sharing, reopened] = await Promise.all([
    staffTexts(dbi, peers, since),
    connectedCalls(dbi, peers, since),
    staffEmails(dbi, emails, since),
    bookedVisits(dbi, customerIds, since),
    openLeadsSharing(dbi, { peers, emails, customerIds }),
    reopenedLeadIds(dbi, leads.map((l) => l.id)),
  ]);

  const others = (ident, matches) => sharing.filter((row) => String(row.id) !== String(ident.lead.id) && matches(row));
  const emailLink = new Map();
  const linkOf = async (row) => {
    const key = String(row.id);
    if (!emailLink.has(key)) emailLink.set(key, await resolveEmailCustomerLink(dbi, row));
    return emailLink.get(key);
  };

  for (const ident of idents) {
    const { lead, firstAt, peer, email, customerId } = ident;
    const id = String(lead.id);
    if (reopened.has(id)) { verdicts.set(id, { skip: 'reopened_by_person' }); continue; }
    const afterFirst = (row) => asDate(row.at) && asDate(row.at).getTime() > firstAt.getTime();
    const candidates = [];
    let mismatch = false;
    let sharedPhone = false;
    let sharedEmail = false;
    let sharedCustomer = false;

    if (peer) {
      const phoneShared = others(ident, (row) => row.peer === peer).length > 0;
      for (const row of texts.filter((r) => r.peer === peer && afterFirst(r))) {
        if (row.customer_id && !sameCustomer(customerId, row.customer_id)) { mismatch = true; continue; }
        if (phoneShared) { sharedPhone = true; continue; }
        candidates.push({ evidenceType: 'staff_text', evidenceId: String(row.id), at: asDate(row.at) });
      }
      for (const row of calls.filter((r) => r.peer === peer && afterFirst(r) && asDate(r.created_at).getTime() > firstAt.getTime())) {
        if (String(row.origin_lead_id || '') === id || String(row.relay_lead_id || '') === id) continue;
        if (row.customer_id && !sameCustomer(customerId, row.customer_id)) { mismatch = true; continue; }
        if (phoneShared) { sharedPhone = true; continue; }
        candidates.push({ evidenceType: 'live_conversation', evidenceId: String(row.id), at: asDate(row.at) });
      }
    }

    if (email) {
      const emailShared = others(ident, (row) => leadEmail(row.email) === email).length > 0;
      for (const row of mails.filter(afterFirst)) {
        const recipients = extractEmailAddresses([row.to_address, row.cc_address, row.bcc_address].filter(Boolean).join(','));
        if (!recipients.includes(email)) continue;
        const linked = await linkOf(row);
        if (linked && !sameCustomer(customerId, linked)) { mismatch = true; continue; }
        if (emailShared) { sharedEmail = true; continue; }
        candidates.push({ evidenceType: 'staff_email', evidenceId: String(row.id), at: asDate(row.at) });
      }
    }

    if (customerId) {
      const customerShared = others(ident, (row) => row.customer_id && sameCustomer(customerId, row.customer_id)).length > 0;
      for (const row of visits.filter((r) => String(r.customer_id) === customerId && afterFirst(r))) {
        if (customerShared) { sharedCustomer = true; continue; }
        candidates.push({ evidenceType: 'visit_booked', evidenceId: String(row.id), at: asDate(row.at) });
      }
    }

    candidates.sort((a, b) => a.at.getTime() - b.at.getTime());
    if (candidates.length) verdicts.set(id, candidates[0]);
    else if (mismatch) verdicts.set(id, { skip: 'customer_mismatch' });
    else if (sharedPhone) verdicts.set(id, { skip: 'shared_phone' });
    else if (sharedEmail) verdicts.set(id, { skip: 'shared_email' });
    else if (sharedCustomer) verdicts.set(id, { skip: 'multiple_open_leads_for_customer' });
    else verdicts.set(id, { skip: 'no_contact_evidence' });
  }
  return verdicts;
}

/**
 * The sweep. `mode` defaults to the gate: 'off' does nothing, 'shadow' judges
 * and logs what would move (counts by evidence type), 'true' writes.
 */
async function runLeadContactSync({ dbi = db, now = new Date(), mode = leadStatusFollowsContactMode(), scanCap = SCAN_CAP, writeCap = WRITE_CAP } = {}) {
  if (mode === 'off') return { skipped: 'gate_off' };

  const results = { mode, scanned: 0, candidates: 0, moved: 0, byEvidence: {}, skipped: {}, errors: 0, moves: [] };
  const leads = await candidateLeadsQuery(dbi, now)
    .orderBy('first_contact_at', 'desc').orderBy('id', 'desc').limit(scanCap)
    .select('id', 'customer_id', 'phone', 'email', 'first_contact_at', 'response_time_minutes');
  results.scanned = leads.length;
  const verdicts = await judgeLeads(dbi, leads);

  for (const lead of leads) {
    const verdict = verdicts.get(String(lead.id));
    if (!verdict || verdict.skip) {
      const reason = verdict?.skip || 'no_contact_evidence';
      results.skipped[reason] = (results.skipped[reason] || 0) + 1;
      if (reason !== 'no_contact_evidence') logger.info(`[lead-contact-sync] lead ${lead.id} left new: ${reason}`);
      continue;
    }
    results.candidates += 1;
    if (results.moved >= writeCap) { results.skipped.write_cap = (results.skipped.write_cap || 0) + 1; continue; }
    if (mode === 'shadow') {
      results.moved += 1;
      results.byEvidence[verdict.evidenceType] = (results.byEvidence[verdict.evidenceType] || 0) + 1;
      logger.info(`[lead-contact-sync] shadow: lead ${lead.id} would move to contacted (${verdict.evidenceType})`);
      continue;
    }
    try {
      const outcome = await require('./lead-estimate-link').markLeadContactedFromEvidence({
        database: dbi,
        leadId: lead.id,
        customerId: lead.customer_id ?? null,
        evidenceType: verdict.evidenceType,
        evidenceId: verdict.evidenceId,
        performedBy: PERFORMED_BY,
        respondedAt: verdict.at,
      });
      if (outcome.contacted) {
        results.moved += 1;
        results.byEvidence[verdict.evidenceType] = (results.byEvidence[verdict.evidenceType] || 0) + 1;
        results.moves.push({ leadId: lead.id, evidenceType: verdict.evidenceType });
      } else {
        results.skipped[outcome.reason] = (results.skipped[outcome.reason] || 0) + 1;
      }
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
