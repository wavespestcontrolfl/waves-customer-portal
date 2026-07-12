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
  await one('estimate', `SELECT token FROM estimates WHERE status IN ('sent','viewed') AND token IS NOT NULL ORDER BY created_at DESC LIMIT 1`);
  await one('pay_unpaid', `SELECT token FROM invoices WHERE status NOT IN ('paid','void','canceled') AND token IS NOT NULL ORDER BY created_at DESC LIMIT 1`);
  await one('receipt_paid', `SELECT token FROM invoices WHERE status='paid' AND token IS NOT NULL ORDER BY created_at DESC LIMIT 1`);
  await one('statement', `SELECT token FROM payer_statements WHERE token IS NOT NULL ORDER BY created_at DESC LIMIT 1`);
  await one('report', `SELECT report_view_token AS token FROM service_records WHERE report_view_token IS NOT NULL ORDER BY created_at DESC LIMIT 1`);
  await one('project_report', `SELECT report_token AS token FROM projects WHERE report_token IS NOT NULL ORDER BY created_at DESC LIMIT 1`);
  await one('prep', `SELECT prep_token AS token FROM projects WHERE prep_token IS NOT NULL ORDER BY created_at DESC LIMIT 1`);
  // Mirror the public loaders' gates (status='sent' + unexpired) or the
  // pulled URL 404s: public-lawn-diagnostic.js / public-pest-identifier.js.
  await one('lawn_report', `SELECT report_token AS token FROM lawn_diagnostics WHERE report_token IS NOT NULL AND status='sent' AND report_expires_at > NOW() ORDER BY created_at DESC LIMIT 1`);
  await one('pest_report', `SELECT report_token AS token FROM pest_identifications WHERE report_token IS NOT NULL AND status='sent' AND report_expires_at > NOW() ORDER BY created_at DESC LIMIT 1`);
  await one('reschedule', `SELECT reschedule_token AS token FROM scheduled_services WHERE reschedule_token IS NOT NULL AND scheduled_date >= CURRENT_DATE ORDER BY scheduled_date ASC LIMIT 1`);
  await one('track', `SELECT track_view_token AS token FROM scheduled_services WHERE track_view_token IS NOT NULL AND track_token_expires_at > NOW() ORDER BY track_token_expires_at DESC LIMIT 1`);
  await one('rate', `SELECT token FROM review_requests WHERE token IS NOT NULL ORDER BY created_at DESC LIMIT 1`);
  await one('card', `SELECT share_token AS token FROM customer_cards WHERE share_token IS NOT NULL ORDER BY created_at DESC LIMIT 1`);
  // The quiz flow keys on the per-recipient engagement_token, not the send id
  // (newsletter-quiz.js recordQuizResponse).
  await one('newsletter', `SELECT engagement_token::text AS token FROM newsletter_send_deliveries WHERE engagement_token IS NOT NULL AND sent_at IS NOT NULL ORDER BY created_at DESC LIMIT 1`);
  console.log(JSON.stringify(out, null, 2));
  await c.end();
})().catch(e => { console.error(e.message); process.exit(1); });
