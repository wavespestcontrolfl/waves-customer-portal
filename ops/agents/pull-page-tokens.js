// READ-ONLY: pull one recent live token per customer-facing token-gated page
// type, so those pages can be opened for visual review without minting
// anything. Prints a JSON object of { pageType: { token } | null | { err } }.
//
// Contract and service-outline tokens are HASHED in the DB and cannot be
// recovered this way — those pages need freshly minted links.
//
// Usage (repo root):
//   railway run --service Postgres node ops/agents/pull-page-tokens.js
if (!process.env.DATABASE_PUBLIC_URL) {
  console.error('DATABASE_PUBLIC_URL is not set — run via: railway run --service Postgres node ops/agents/pull-page-tokens.js');
  process.exit(1);
}
const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const out = {};
  const one = async (key, sql) => {
    try {
      const { rows } = await c.query(sql);
      out[key] = rows[0] || null;
    } catch (e) { out[key] = { err: e.message.slice(0, 90) }; }
  };
  // Each query mirrors its public loader's eligibility gates so the newest
  // matching row is actually renderable (estimate-public / pay-v2 /
  // prep-public / review-gate / card-public / public-*-diagnostic routes).
  await one('estimate', `SELECT token FROM estimates WHERE status IN ('sent','viewed') AND token IS NOT NULL AND archived_at IS NULL AND (expires_at IS NULL OR expires_at > NOW()) ORDER BY created_at DESC LIMIT 1`);
  await one('pay_unpaid', `SELECT token FROM invoices WHERE status NOT IN ('paid','void','canceled') AND token IS NOT NULL AND payer_statement_id IS NULL ORDER BY created_at DESC LIMIT 1`);
  await one('receipt_paid', `SELECT token FROM invoices WHERE status='paid' AND token IS NOT NULL AND payer_statement_id IS NULL ORDER BY created_at DESC LIMIT 1`);
  await one('statement', `SELECT token FROM payer_statements WHERE token IS NOT NULL ORDER BY created_at DESC LIMIT 1`);
  // Suppressed typed reports (typedReportDelivery set and != auto_send) are
  // rejected by the reports router's token param — skip them.
  await one('report', `SELECT report_view_token AS token FROM service_records WHERE report_view_token IS NOT NULL AND (structured_notes->>'typedReportDelivery' IS NULL OR structured_notes->>'typedReportDelivery' = 'auto_send') ORDER BY created_at DESC LIMIT 1`);
  await one('project_report', `SELECT report_token AS token FROM projects WHERE report_token IS NOT NULL ORDER BY created_at DESC LIMIT 1`);
  await one('prep', `SELECT prep_token AS token FROM projects WHERE prep_token IS NOT NULL AND (prep_expires_at IS NULL OR prep_expires_at > NOW()) ORDER BY created_at DESC LIMIT 1`);
  // Mirror the public loaders' gates (status='sent' + unexpired) or the
  // pulled URL 404s: public-lawn-diagnostic.js / public-pest-identifier.js.
  await one('lawn_report', `SELECT report_token AS token FROM lawn_diagnostics WHERE report_token IS NOT NULL AND status='sent' AND report_expires_at > NOW() ORDER BY created_at DESC LIMIT 1`);
  await one('pest_report', `SELECT report_token AS token FROM pest_identifications WHERE report_token IS NOT NULL AND status='sent' AND report_expires_at > NOW() ORDER BY created_at DESC LIMIT 1`);
  // Mirrors reschedule-public eligibility(): reschedulable status, ET
  // wall-clock date (server runs TZ=UTC), and same-day rows only while the
  // arrival window hasn't elapsed.
  await one('reschedule', `SELECT reschedule_token AS token FROM scheduled_services
    WHERE reschedule_token IS NOT NULL
      AND lower(status) IN ('pending','confirmed','rescheduled')
      AND (scheduled_date > (NOW() AT TIME ZONE 'America/New_York')::date
        OR (scheduled_date = (NOW() AT TIME ZONE 'America/New_York')::date
            AND COALESCE(window_end, window_start) > (NOW() AT TIME ZONE 'America/New_York')::time))
    ORDER BY scheduled_date ASC LIMIT 1`);
  await one('track', `SELECT track_view_token AS token FROM scheduled_services WHERE track_view_token IS NOT NULL AND track_token_expires_at > NOW() ORDER BY track_token_expires_at DESC LIMIT 1`);
  await one('rate', `SELECT token FROM review_requests WHERE token IS NOT NULL AND (expires_at IS NULL OR expires_at > NOW()) ORDER BY created_at DESC LIMIT 1`);
  await one('card', `SELECT cc.share_token AS token FROM customer_cards cc JOIN customers cu ON cu.id = cc.customer_id AND cu.deleted_at IS NULL WHERE cc.share_token IS NOT NULL ORDER BY cc.created_at DESC LIMIT 1`);
  // The quiz flow keys on the per-recipient engagement_token, not the send id
  // (newsletter-quiz.js recordQuizResponse).
  await one('newsletter', `SELECT engagement_token::text AS token FROM newsletter_send_deliveries WHERE engagement_token IS NOT NULL AND sent_at IS NOT NULL ORDER BY created_at DESC LIMIT 1`);
  console.log(JSON.stringify(out, null, 2));
  await c.end();
})().catch(e => { console.error(e.message); process.exit(1); });
