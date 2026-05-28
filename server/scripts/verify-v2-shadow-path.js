/**
 * Read-only verification that the v2 shadow extraction path works end-to-end
 * on REAL production transcripts. No DB writes, no side effects, no flag flip.
 *
 * Two-phase (avoids needing GEMINI key + public DB url in one context):
 *   Phase A (Postgres env):  DUMP_TO=/tmp/vx.json node verify-v2-shadow-path.js N
 *   Phase B (app env):       TRANSCRIPTS_FILE=/tmp/vx.json node verify-v2-shadow-path.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const fs = require('fs');
const CRP = require('../services/call-recording-processor');
const { canAutoRoute, computeDeterministicTriageFlags, mergeTriageFlags } = require('../services/call-triage-flags');

function dbConn() {
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  return require('knex')({
    client: 'pg',
    connection: url.includes('localhost') ? url : { connectionString: url, ssl: { rejectUnauthorized: false } },
  });
}

async function main() {
  const N = parseInt(process.argv[2] || '5', 10);

  if (process.env.DUMP_TO) {
    const db = dbConn();
    const rows = await db('call_log')
      .whereNotNull('transcription')
      .whereRaw('length(transcription) > 200')
      .where('processing_status', 'processed')
      .orderBy('created_at', 'desc')
      .limit(N)
      .select('id', 'transcription', 'from_phone', 'to_phone', 'direction', 'created_at');
    await db.destroy();
    fs.writeFileSync(process.env.DUMP_TO, JSON.stringify(rows));
    console.log(`Dumped ${rows.length} real transcripts to ${process.env.DUMP_TO}`);
    return;
  }

  if (!process.env.GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY not present — v2 extraction uses Gemini; run under the app service. Aborting (would otherwise report not_run for every call).');
    process.exit(1);
  }

  const rows = JSON.parse(fs.readFileSync(process.env.TRANSCRIPTS_FILE, 'utf8'));
  console.log(`Verifying v2 shadow extraction on ${rows.length} real transcripts (read-only)\n`);

  let valid = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const contactPhone = String(r.direction || '').startsWith('outbound') ? r.to_phone : r.from_phone;
    const t0 = Date.now();
    const res = await CRP._test.extractCallDataV2(r.transcription, contactPhone, {
      callId: r.id,
      // JSON round-trip turns the Date into a string; rehydrate it (in prod
      // this is a real Date from Knex). Guard against any unparseable value.
      callStartedAt: r.created_at && !isNaN(new Date(r.created_at)) ? new Date(r.created_at) : new Date(),
    });
    const ms = Date.now() - t0;
    if (res.status === 'valid') {
      valid++;
      const e = res.extraction;
      const flags = mergeTriageFlags(e.triage_flags, computeDeterministicTriageFlags(e));
      const route = canAutoRoute(e);
      // No customer PII (names/addresses) in logs — non-PII signals only.
      const hasName = !!(e.caller.first_name || e.caller.last_name);
      console.log(`[${i + 1}] ${r.id}  status=valid (${ms}ms)`);
      console.log(`     name_extracted=${hasName} | county=${e.property.service_address.county || '—'} | service=${e.service_request.primary_service_category}`);
      console.log(`     scheduling=${e.scheduling?.status || 'none'} | confidence=${e.confidence.overall} | sms_consent=${e.consent.sms_consent_given}`);
      console.log(`     would_auto_route=${route.allowed}${route.allowed ? '' : ' (' + (route.reason || '') + ')'} | flags=[${flags.join(', ')}]`);
    } else {
      console.log(`[${i + 1}] ${r.id}  status=${res.status} (${ms}ms)  errors=${JSON.stringify(res.errors?.slice?.(0, 2) || res.errors)}`);
    }
    console.log('');
  }

  console.log(`=== ${valid}/${rows.length} extracted valid against the live current extractor ===`);
}

main().catch((e) => { console.error(e); process.exit(1); });
