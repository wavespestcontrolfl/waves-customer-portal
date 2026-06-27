// Healthy-but-quiet customer surface — shared SQL fragment + row mapping, kept
// here so the /admin/health/quiet route stays thin and the (only) non-SQL
// logic is unit-testable.

// Last meaningful touch = most recent COMPLETED service OR INBOUND SMS for the
// joined `customers as c`. Automated outbound messages deliberately don't count
// — they don't make a customer feel cared for. A never-touched customer floors
// to epoch (sorts first / shows as "never").
const LAST_TOUCH_SQL = `GREATEST(
  COALESCE((SELECT MAX(sr.service_date) FROM service_records sr WHERE sr.customer_id = c.id AND sr.status = 'completed'), TIMESTAMP 'epoch'),
  COALESCE((SELECT MAX(sl.created_at) FROM sms_log sl WHERE sl.customer_id = c.id AND sl.direction = 'inbound'), TIMESTAMP 'epoch')
)`;

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

module.exports = { LAST_TOUCH_SQL, resolveQuietDays, mapQuietRow };
