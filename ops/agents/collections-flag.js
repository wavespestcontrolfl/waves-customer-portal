#!/usr/bin/env node
// MUTATES (dry-run default) — set or release a collections_flags row on a
// customer (do_not_call, do_not_collect, pays_by_check, collection_hold, …).
// The contact policy (server/services/collections/contact-policy.js) denies
// the channels each flag covers; setting one here is the owner's durable
// "never call / never collect" instruction. Release = stamp released_at,
// never delete (the row is the paper trail).
//
//   railway run --service Postgres node ops/agents/collections-flag.js --customer=<uuid> --flag=pays_by_check --reason="pays by check"           # dry run
//   railway run --service Postgres node ops/agents/collections-flag.js --customer=<uuid> --flag=pays_by_check --reason="pays by check" --execute
//   railway run --service Postgres node ops/agents/collections-flag.js --customer=<uuid> --flag=pays_by_check --release --execute
//   railway run --service Postgres node ops/agents/collections-flag.js --phone=9415551234 --flag=pays_by_check --execute   # resolves ONE customer by phone
//
// Prints the customer's current active flags first. Idempotent: an active
// flag of the same kind is reported, not duplicated. No names in output
// beyond what the operator typed.
if (!process.env.DATABASE_PUBLIC_URL) {
  console.error('DATABASE_PUBLIC_URL is not set — run via: railway run --service Postgres node ops/agents/collections-flag.js …');
  process.exit(2);
}
const { Client } = require('pg');

const KNOWN_FLAGS = ['do_not_collect', 'collection_hold', 'attorney_represented', 'bankruptcy', 'wrong_number',
  'do_not_call', 'do_not_text', 'do_not_email', 'automated_voice_consent_revoked', 'pays_by_check'];

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}
const EXECUTE = process.argv.includes('--execute');
const RELEASE = process.argv.includes('--release');
const flag = arg('flag');
const reason = arg('reason') || null;
const customerArg = arg('customer');
const phoneArg = arg('phone');

if (!flag || !KNOWN_FLAGS.includes(flag)) {
  console.error(`--flag must be one of: ${KNOWN_FLAGS.join(', ')}`);
  process.exit(2);
}
if (!customerArg && !phoneArg) {
  console.error('--customer=<uuid> or --phone=<10 digits> is required');
  process.exit(2);
}

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  try {
    let customerId = customerArg;
    if (!customerId) {
      const digits = String(phoneArg).replace(/\D/g, '').slice(-10);
      const { rows } = await c.query(
        "select id, first_name, last_name from customers where deleted_at is null and right(regexp_replace(coalesce(phone,''), '\\D', '', 'g'), 10) = $1",
        [digits],
      );
      if (rows.length !== 1) {
        console.error(`phone resolved ${rows.length} customers — pass --customer=<uuid> instead`);
        process.exit(1);
      }
      customerId = rows[0].id;
    }
    const cust = await c.query('select id, first_name, last_name from customers where id = $1 and deleted_at is null', [customerId]);
    if (!cust.rows.length) { console.error('customer not found'); process.exit(1); }
    const who = `${cust.rows[0].first_name || ''} ${cust.rows[0].last_name || ''}`.trim();
    const active = await c.query('select flag, reason, created_by, created_at from collections_flags where customer_id = $1 and released_at is null order by created_at', [customerId]);
    console.log(`customer ${customerId} (${who}) — active flags: ${active.rows.length ? active.rows.map((r) => r.flag).join(', ') : 'none'}`);

    const already = active.rows.find((r) => r.flag === flag);
    if (RELEASE) {
      if (!already) { console.log(`nothing to release — ${flag} is not active`); return; }
      console.log(`${EXECUTE ? 'RELEASING' : 'would release'} ${flag} (set ${already.created_at.toISOString()} by ${already.created_by})`);
      if (EXECUTE) {
        await c.query('update collections_flags set released_at = now() where customer_id = $1 and flag = $2 and released_at is null', [customerId, flag]);
        console.log('released.');
      }
      return;
    }
    if (already) { console.log(`${flag} is already active (set ${already.created_at.toISOString()} by ${already.created_by}) — nothing to do`); return; }
    console.log(`${EXECUTE ? 'SETTING' : 'would set'} ${flag}${reason ? ` — reason: "${reason}"` : ''}`);
    if (EXECUTE) {
      await c.query(
        'insert into collections_flags (customer_id, flag, reason, created_by) values ($1, $2, $3, $4)',
        [customerId, flag, reason ? String(reason).slice(0, 500) : null, 'owner:ops-script'],
      );
      console.log('set.');
    } else {
      console.log('dry run — add --execute to write.');
    }
  } finally {
    await c.end();
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
