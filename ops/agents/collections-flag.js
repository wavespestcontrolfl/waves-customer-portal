#!/usr/bin/env node
// MUTATES (dry-run default) — set or release a collections_flags row on a
// customer (do_not_call, do_not_collect, pays_by_check, collection_hold, …).
// The contact policy (server/services/collections/contact-policy.js) denies
// the channels each flag covers; setting one here is the owner's durable
// "never call / never collect" instruction. Writes go through the lane's own
// writer (outbound-voice/flags.js writeFlag / releaseFlag): idempotent, and
// release stamps released_at — never deletes (the row is the paper trail).
//
//   railway run --service Postgres node ops/agents/collections-flag.js --customer=<uuid> --flag=pays_by_check --reason="pays by check"            # dry run
//   railway run --service Postgres node ops/agents/collections-flag.js --customer=<uuid> --flag=pays_by_check --reason="pays by check" --execute
//   railway run --service Postgres node ops/agents/collections-flag.js --customer=<uuid> --flag=pays_by_check --release --execute
//   railway run --service Postgres node ops/agents/collections-flag.js --phone=9415551234 --flag=pays_by_check --execute   # exactly 10 digits, must resolve ONE customer
//
// Run from the repo root (resolves the server's modules). Output carries the
// customer id and initials only — never a full name.
if (!process.env.DATABASE_PUBLIC_URL) {
  console.error('DATABASE_PUBLIC_URL is not set — run via: railway run --service Postgres node ops/agents/collections-flag.js …');
  process.exit(2);
}
// The app's knex reads DATABASE_URL; railway run injects the internal host,
// which is unreachable from a laptop — point it at the public URL.
process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
const path = require('path');
const db = require(path.join(__dirname, '..', '..', 'server', 'models', 'db'));
const { writeFlag, releaseFlag, activeFlags } = require(path.join(__dirname, '..', '..', 'server', 'services', 'collections', 'outbound-voice', 'flags'));
const { FLAG_BLOCKED_CHANNELS } = require(path.join(__dirname, '..', '..', 'server', 'services', 'collections', 'contact-policy'));

const KNOWN_FLAGS = Object.keys(FLAG_BLOCKED_CHANNELS);

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

// A phone must be a real US number: exactly 10 digits, or 11 with a leading 1.
function normalizePhoneArg(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 10) return digits;
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return null;
}
const initials = (c) => `${(c.first_name || '?')[0]}.${(c.last_name || '?')[0]}.`;

(async () => {
  try {
    let customerId = customerArg;
    if (!customerId) {
      const digits = normalizePhoneArg(phoneArg);
      if (!digits) { console.error('--phone must be exactly 10 digits (or 11 with a leading 1)'); process.exit(2); }
      const rows = await db('customers')
        .whereNull('deleted_at')
        .whereRaw("right(regexp_replace(coalesce(phone,''), '\\D', '', 'g'), 10) = ?", [digits])
        .select('id', 'first_name', 'last_name');
      if (rows.length !== 1) {
        console.error(`phone resolved ${rows.length} customers — pass --customer=<uuid> instead`);
        process.exit(1);
      }
      customerId = rows[0].id;
    }
    const cust = await db('customers').where({ id: customerId }).whereNull('deleted_at').first('id', 'first_name', 'last_name');
    if (!cust) { console.error('customer not found'); process.exit(1); }
    const active = await activeFlags(customerId);
    console.log(`customer ${customerId} (${initials(cust)}) — active flags: ${active.length ? active.map((r) => r.flag).join(', ') : 'none'}`);

    const already = active.find((r) => r.flag === flag);
    if (RELEASE) {
      if (!already) { console.log(`nothing to release — ${flag} is not active`); return; }
      console.log(`${EXECUTE ? 'RELEASING' : 'would release'} ${flag} (set ${new Date(already.created_at).toISOString()} by ${already.created_by})`);
      if (EXECUTE) {
        const res = await releaseFlag({ customerId, flag });
        console.log(res.ok ? `released ${res.released}.` : `release FAILED: ${res.reason}`);
        if (!res.ok) process.exit(1);
      }
      return;
    }
    if (already) { console.log(`${flag} is already active (set ${new Date(already.created_at).toISOString()} by ${already.created_by}) — nothing to do`); return; }
    console.log(`${EXECUTE ? 'SETTING' : 'would set'} ${flag}${reason ? ` — reason: "${reason}"` : ''} (blocks: ${FLAG_BLOCKED_CHANNELS[flag].join(', ')})`);
    if (EXECUTE) {
      const res = await writeFlag({ customerId, flag, reason, createdBy: 'owner:ops-script' });
      console.log(res.ok ? (res.created ? 'set.' : 'already active (raced) — nothing written.') : `write FAILED: ${res.reason}`);
      if (!res.ok) process.exit(1);
    } else {
      console.log('dry run — add --execute to write.');
    }
  } finally {
    await db.destroy().catch(() => {});
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
