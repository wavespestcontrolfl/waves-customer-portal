#!/usr/bin/env node
// READ-ONLY — lists customers who regularly pay by check (invoices whose
// payment_method = 'check', recorded by the manual-payment path in
// admin-invoices.js) so the owner can flag them `pays_by_check` (no
// late-payment outreach — see contact-policy FLAG_BLOCKED_CHANNELS).
//
//   railway run --service Postgres node ops/agents/check-payers-report.js                 # last 12 months, ≥2 checks
//   railway run --service Postgres node ops/agents/check-payers-report.js --months=24 --min-checks=3
//
// Output: one line per customer — id, initials, checks / paid invoices in
// the window, check share, last check date, whether pays_by_check is already
// active — followed by the exact collections-flag.js command for each
// unflagged regular. Prints ids and initials only, never full names.
if (!process.env.DATABASE_PUBLIC_URL) {
  console.error('DATABASE_PUBLIC_URL is not set — run via: railway run --service Postgres node ops/agents/check-payers-report.js');
  process.exit(2);
}
const { Client } = require('pg');
function arg(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  const v = hit ? Number(hit.slice(name.length + 3)) : NaN;
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : dflt;
}
const MONTHS = arg('months', 12);
const MIN_CHECKS = arg('min-checks', 2);
const initials = (r) => `${(r.first_name || '?')[0]}.${(r.last_name || '?')[0]}.`;

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  try {
    const { rows } = await c.query(`
      with paid as (
        select i.customer_id,
               count(*) filter (where lower(coalesce(i.payment_method,'')) = 'check') as checks,
               count(*) as paid_invoices,
               -- ET calendar date (the timestamptz trap): render in Florida time
               max((i.paid_at at time zone 'America/New_York')::date) filter (where lower(coalesce(i.payment_method,'')) = 'check') as last_check_day
          from invoices i
         where i.status = 'paid'
           and i.paid_at >= now() - ($1 || ' months')::interval
           and i.deleted_at is null
           -- self-pay only: a third-party payer's check (payer-billed /
           -- statement invoices) says nothing about how THIS customer pays
           and i.payer_id is null
           and i.payer_statement_id is null
         group by i.customer_id
      )
      select p.customer_id, cu.first_name, cu.last_name, p.checks, p.paid_invoices, p.last_check_day,
             exists (select 1 from collections_flags f where f.customer_id = p.customer_id and f.flag = 'pays_by_check' and f.released_at is null) as flagged
        from paid p
        join customers cu on cu.id = p.customer_id and cu.deleted_at is null
       where p.checks >= $2
       order by p.checks desc, p.last_check_day desc
    `, [String(MONTHS), MIN_CHECKS]);
    console.log(`check payers — last ${MONTHS} months, ≥${MIN_CHECKS} checks: ${rows.length}`);
    console.log('customer_id                            | who   | checks/paid | share | last check (ET) | flagged');
    for (const r of rows) {
      const share = r.paid_invoices ? Math.round((Number(r.checks) / Number(r.paid_invoices)) * 100) : 0;
      const lastDay = r.last_check_day ? (r.last_check_day instanceof Date ? r.last_check_day.toISOString().slice(0, 10) : String(r.last_check_day).slice(0, 10)) : '—';
      console.log(`${r.customer_id} | ${initials(r).padEnd(5)} | ${String(r.checks).padStart(3)}/${String(r.paid_invoices).padEnd(4)} | ${String(share).padStart(3)}% | ${lastDay} | ${r.flagged ? 'yes' : 'no'}`);
    }
    const unflagged = rows.filter((r) => !r.flagged);
    if (unflagged.length) {
      console.log(`\nto flag the ${unflagged.length} unflagged regular(s) (dry-run first; add --execute to write):`);
      for (const r of unflagged) {
        console.log(`railway run --service Postgres node ops/agents/collections-flag.js --customer=${r.customer_id} --flag=pays_by_check --reason="pays by check (${r.checks} of ${r.paid_invoices} paid invoices in ${MONTHS}mo)"`);
      }
    }
  } finally {
    await c.end();
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
