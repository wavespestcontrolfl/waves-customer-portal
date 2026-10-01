#!/usr/bin/env node
// READ-ONLY — everything open, in the shape of docs/admin-notifications.md section 2:
// area, severity, who may act, headline, why, link. For a Claude session that needs to know
// what it may fix on its own (`--who claude`) without reading alert text and guessing.
// Same reader as GET /api/admin/needs-me and the Intelligence Bar's needs_me tool
// (server/services/needs-me.js). No existing ops script authenticates against admin routes,
// so this reads the database directly, the way the other ops/agents scripts do.
//
//   railway run --service Postgres node ops/agents/needs-me.js
//   railway run --service Postgres node ops/agents/needs-me.js --who claude --area System
//   railway run --service Postgres node ops/agents/needs-me.js --detail
//   railway run --service Postgres node ops/agents/needs-me.js --json
//
// --who is exact: `claude` is what a session may fix alone, `either` (Claude drafts, a person
// approves) is listed only under `--who either`. --detail prints each alert's full finding
// under its row (an engineering digest's diagnosis may live only there); --json always has it.
//
// Run from the repo root. A `*` after who marks a row from an older alert whose area, who
// and subject are inferred. Alert text names customers: do not paste it into the repo.
if (!process.env.DATABASE_PUBLIC_URL) {
  console.error('DATABASE_PUBLIC_URL is not set — run via: railway run --service Postgres node ops/agents/needs-me.js …');
  process.exit(2);
}
// The app's knex reads DATABASE_URL; railway run injects the internal host, which is
// unreachable from a laptop — point it at the public URL, with TLS (same as gap-status.js).
process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
if (!/sslmode=/.test(process.env.DATABASE_URL) && !process.env.PGSSLMODE) process.env.PGSSLMODE = 'no-verify';
const path = require('path');
const db = require(path.join(__dirname, '..', '..', 'server', 'models', 'db'));
const { listNeedsMe } = require(path.join(__dirname, '..', '..', 'server', 'services', 'needs-me'));
const { AREAS, WHO } = require(path.join(__dirname, '..', '..', 'server', 'services', 'admin-alert-compose'));

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const at = process.argv.indexOf(`--${name}`);
  return at !== -1 ? process.argv[at + 1] : undefined;
}
const who = arg('who');
const area = arg('area');
const limit = arg('limit');
if (who !== undefined && !WHO.includes(who)) { console.error(`--who must be one of: ${WHO.join(', ')}`); process.exit(2); }
if (area !== undefined && !AREAS.includes(area)) { console.error(`--area must be one of: ${AREAS.join(', ')}`); process.exit(2); }

const cell = (text, width) => {
  const s = String(text ?? '').replace(/\s+/g, ' ');
  return (s.length > width ? `${s.slice(0, width - 1)}…` : s).padEnd(width);
};

(async () => {
  const result = await listNeedsMe({ who, area, limit });
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const cols = [['area', 10], ['severity', 9], ['who', 8], ['headline', 52], ['why', 60], ['link', 48]];
  console.log(cols.map(([name, width]) => name.padEnd(width)).join(' | '));
  for (const item of result.items) {
    const row = [item.area, item.severity, `${item.who}${item.derived ? '*' : ''}`, item.headline, item.why || (item.count != null ? `${item.count} open` : ''), item.link];
    console.log(row.map((text, i) => cell(text, cols[i][1])).join(' | ').trimEnd());
    if (process.argv.includes('--detail') && item.detail) console.log(item.detail.split('\n').map((l) => `    ${l}`).join('\n'));
  }
  console.log(`\n${result.items.length} shown of ${result.total} open. * = inferred from an older alert.`);
  for (const w of result.warnings) console.error(`warning: ${w.source}${w.generator ? ` (${w.generator})` : ''} ${w.error}`);
})().catch((err) => {
  console.error(`needs-me failed: ${err.message}`);
  process.exitCode = 1;
}).finally(() => db.destroy());
