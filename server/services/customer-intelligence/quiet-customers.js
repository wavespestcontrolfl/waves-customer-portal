// Healthy-but-quiet customer surface — shared SQL fragment + row mapping, kept
// here so the /admin/health/quiet route stays thin and the (only) non-SQL
// logic is unit-testable.

const { operatorReplySql, smsDeliveredSql, personCallBackSql } = require('../staff-contact');
const { personSentFilter } = require('../email/email-customer-link');

// Last meaningful touch = most recent COMPLETED service OR INBOUND SMS for the
// joined `customers as c`. Automated outbound messages deliberately don't count
// — they don't make a customer feel cared for. A never-touched customer floors
// to epoch (sorts first / shows as "never").
const LAST_TOUCH_SQL = `GREATEST(
  COALESCE((SELECT MAX(sr.service_date) FROM service_records sr WHERE sr.customer_id = c.id AND sr.status = 'completed'), TIMESTAMP 'epoch'),
  COALESCE((SELECT MAX(sl.created_at) FROM sms_log sl WHERE sl.customer_id = c.id AND sl.direction = 'inbound'), TIMESTAMP 'epoch')
)`;

// Newest PERSON touch for the customer row `customerAlias` (customers.id), served
// as "last contact" behind GATE_CUSTOMER_LAST_TOUCH by the Intelligence Bar
// customer search, the admin MCP and the admin customer directory. NULL when the
// customer has none. It differs from LAST_TOUCH_SQL above, which is the quiet
// list's "meaningful touch" (completed visit or inbound text only, floored to
// epoch): this one also counts a text a person sent that was delivered, a call a
// person placed and spoke on, an inbound call a human answered and inbound mail
// (never a Gmail SENT row), and it stays NULL instead of flooring. Automated
// outbound texts, bare call rows and call durations never count. emails.customer_id
// alone is not sender proof (the classifier also links a row by display NAME), so
// the sender must be the customer's address on file; a From header can still be
// forged, so mail Gmail filed as spam or the spam blocker quarantined never counts.
// The value is display-only: nothing sends, pauses or scores from it. Recruiting
// `job_%` texts are not customer context. Correlated MAX per source, keyed on
// customer_id (indexed on all four tables). A visit has a date only, so it counts
// at noon: the same calendar day in Eastern and UTC. A NULL status is a legacy
// completed visit, as the directory's visit count and the detail visitStats read it.
function contactTouchSql(customerAlias = 'c') {
  const cid = `${customerAlias}.id`;
  return `GREATEST(
  (SELECT MAX(sl.created_at) FROM sms_log sl WHERE sl.customer_id = ${cid}
    AND ((sl.direction = 'inbound' AND (sl.message_type IS NULL OR sl.message_type NOT LIKE 'job\\_%'))
      OR (sl.direction = 'outbound' AND ${operatorReplySql('sl')} AND ${smsDeliveredSql('sl')}))),
  (SELECT MAX(cl.created_at) FROM call_log cl WHERE cl.customer_id = ${cid}
    AND ((cl.direction = 'outbound' AND ${personCallBackSql('cl')})
      OR (cl.direction = 'inbound' AND cl.answered_by = 'human'))),
  (SELECT MAX(em.received_at) FROM emails em WHERE em.customer_id = ${cid}
    AND LOWER(em.from_address) = LOWER(TRIM(${customerAlias}.email))
    AND NOT COALESCE((${personSentFilter('em')}), FALSE)
    AND NOT COALESCE(jsonb_exists(em.label_ids::jsonb, 'SPAM'), FALSE) AND em.quarantined_at IS NULL),
  (SELECT (MAX(sr.service_date) + TIME '12:00')::timestamptz FROM service_records sr WHERE sr.customer_id = ${cid}
    AND COALESCE(sr.status, 'completed') = 'completed')
)`;
}

// Days of silence before a healthy customer is "quiet". Env-tunable; floored at
// a week so a misconfiguration can't flag the whole book.
function resolveQuietDays(env = process.env) {
  const n = parseInt(env.HEALTH_QUIET_DAYS || '45', 10);
  return Math.max(7, Number.isFinite(n) && n > 0 ? n : 45);
}

// Shape one query row for the client. days_since_touch is null when the customer
// has never had a meaningful touch (last_touch_at floored to epoch).
function mapQuietRow(r, nowMs) {
  const touchMs = r.last_touch_at ? new Date(r.last_touch_at).getTime() : 0;
  const daysSinceTouch = touchMs > 0 ? Math.floor((nowMs - touchMs) / 86400000) : null;
  return {
    id: r.id,
    first_name: r.first_name,
    last_name: r.last_name,
    waveguard_tier: r.waveguard_tier,
    phone: r.phone,
    city: r.city,
    monthly_rate: r.monthly_rate != null ? parseFloat(r.monthly_rate) : null,
    overall_score: r.overall_score,
    score_grade: r.score_grade,
    churn_risk: r.churn_risk,
    last_service_at: r.last_service_at,
    last_inbound_at: r.last_inbound_at,
    days_since_touch: daysSinceTouch,
  };
}

module.exports = { LAST_TOUCH_SQL, contactTouchSql, resolveQuietDays, mapQuietRow };
