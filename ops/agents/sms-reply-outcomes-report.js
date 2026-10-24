#!/usr/bin/env node
// READ-ONLY
//
// sms-reply-outcomes-report.js — what customers did after each Waves text reply
// (GATE_SMS_REPLY_OUTCOMES, services/sms-reply-outcomes.js), by AI prompt version
// and by reply source (manual / ai_approved / ai_revised / ai_autosent / ai_gratitude).
//
//   railway run --service Postgres -- railway run --service waves-customer-portal \
//     node ops/agents/sms-reply-outcomes-report.js [--days=30] [--json]
//
// Per group: replies, confusion rate, opt-out rate, call-back rate, positive-close
// rate, silence rate. A group under 20 replies prints "(small sample)". Reads
// sms_reply_outcomes only; prints counts and rates, never message text.
if (require.main === module) {
  if (!process.env.DATABASE_PUBLIC_URL) {
    console.error('DATABASE_PUBLIC_URL is not set — run via: railway run --service Postgres -- railway run --service waves-customer-portal node ops/agents/sms-reply-outcomes-report.js');
    process.exit(2);
  }
  process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
  if (!/sslmode=/.test(process.env.DATABASE_URL) && !process.env.PGSSLMODE) process.env.PGSSLMODE = 'no-verify';
  process.env.LOG_LEVEL = 'error';
}

const path = require('path');

const pct = (r) => (r == null ? '-' : `${(100 * r).toFixed(1)}%`);

function line(label, g) {
  return `  ${String(label).padEnd(34)} ${String(g.count).padStart(5)}  confused ${pct(g.confusion_rate).padStart(6)}  opt-out ${pct(g.opt_out_rate).padStart(6)}`
    + `  call-back ${pct(g.call_back_rate).padStart(6)}  positive ${pct(g.positive_close_rate).padStart(6)}  silent ${pct(g.silent_rate).padStart(6)}${g.inconclusive ? '  (small sample)' : ''}`;
}

function formatReport(s) {
  const out = [`SMS reply outcomes, replies sent ${s.since.slice(0, 10)} to ${s.until.slice(0, 10)}`, line('all replies', s.overall)];
  out.push('', 'By prompt version (AI drafts; "(none)" = no AI draft behind the reply):');
  if (!s.by_prompt_version.length) out.push('  no measured replies in the window');
  for (const g of s.by_prompt_version) out.push(line(g.prompt_version, g));
  out.push('', 'By reply source:');
  for (const g of s.by_reply_source) out.push(line(g.reply_source, g));
  out.push('', 'By prompt version and reply source:');
  for (const g of s.by_prompt_version_and_source) out.push(line(`${g.prompt_version} / ${g.reply_source}`, g));
  return out.join('\n');
}

module.exports = { formatReport };

if (require.main === module) {
  const db = require(path.join(__dirname, '..', '..', 'server', 'models', 'db'));
  const { summarizeReplyOutcomes } = require(path.join(__dirname, '..', '..', 'server', 'services', 'sms-reply-outcomes'));
  const argv = process.argv.slice(2);
  const daysArg = argv.find((a) => a.startsWith('--days='));
  const days = daysArg ? Number(daysArg.slice(7)) : 30;
  if (!(days > 0 && days <= 365)) {
    console.error('--days must be between 1 and 365');
    process.exit(2);
  }
  summarizeReplyOutcomes({ dbh: db, days })
    .then((r) => console.log(argv.includes('--json') ? JSON.stringify(r, null, 2) : formatReport(r)))
    .then(() => db.destroy())
    .catch(async (err) => {
      console.error(`sms-reply-outcomes report failed (code ${err?.code || err?.name || 'unknown'})`);
      try { await db.destroy(); } catch { /* already closed */ }
      process.exit(1);
    });
}
