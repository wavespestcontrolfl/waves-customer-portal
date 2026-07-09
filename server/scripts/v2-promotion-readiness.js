/**
 * v2 routing promotion-readiness report.
 *
 * Reads shadow v2 extractions (call_log.ai_extraction_enriched, written when
 * CALL_EXTRACTION_V2_ENABLED=true) and reports the exact criteria that must
 * pass before flipping CALL_EXTRACTION_V2_DRIVES_ROUTING=true:
 *
 *   1. 100+ shadow calls processed
 *   2. ≥95% schema validation success rate
 *   3. ≥95% agreement with the legacy v1 pipeline on appointment / no-appointment
 *   4. 0 would-be-auto-routed calls that would SMS without consent
 *   5. 0 phantom-appointment risks (v2 would auto-create on unvalidated address /
 *      low confidence / out-of-area — should be impossible given canAutoRoute,
 *      this is a backstop check)
 *   6. Every v1↔v2 disagreement listed for manual review
 *
 * Read-only. Output is aggregate counts + call-id (UUID) lists — no PII dumped.
 * Run: railway run -s Postgres node server/scripts/v2-promotion-readiness.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const { canAutoRoute, computeDeterministicTriageFlags, mergeTriageFlags, isInServiceAreaCounty } = require('../services/call-triage-flags');
const { checkTcpaConsent } = require('../services/call-routing-gates');
const { isV2Extraction } = require('../utils/extraction-compat');
const { PROMPT_HASH } = require('../services/prompts/call-extraction-v1');

const MIN_CALLS = 100;
const SCHEMA_PASS_THRESHOLD = 0.95;
const AGREEMENT_THRESHOLD = 0.95;

// The promotion gate must reflect ONLY the currently-deployed extractor.
// Shadow rows from a prior model/prompt (e.g. the pre-Gemini-Pro/JSON-mode
// extractor that 100% schema-failed) would otherwise dilute the metrics and
// let a stale ≥95% sample green-light a freshly-changed extractor. Mirror the
// processor's defaults; override via env if those change.
const CURRENT_MODEL = process.env.GEMINI_EXTRACTION_MODEL || 'gemini-2.5-pro';
const CURRENT_PROMPT_VERSION = PROMPT_HASH;

function dbConn() {
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  return require('knex')({
    client: 'pg',
    connection: url.includes('localhost') ? url : { connectionString: url, ssl: { rejectUnauthorized: false } },
  });
}

function parseJson(v) {
  if (!v) return null;
  return typeof v === 'string' ? JSON.parse(v) : v;
}

async function main() {
  const db = dbConn();

  // Key off v2_extraction_status (set on EVERY shadow-processed call) — not
  // ai_extraction_enriched, which is null on parse/schema failures. Otherwise
  // failures drop out of the denominator and the validation rate looks ~100%.
  // Exclude 'not_run' (extraction never attempted, e.g. no API key) from the
  // attempted-denominator so it doesn't unfairly tank the rate.
  //
  // CRITICAL: scope to the CURRENT extractor (model + prompt version). Stale
  // rows from a prior extractor must not feed the pass/fail gate.
  const baseQuery = () => db('call_log')
    .whereNotNull('v2_extraction_status')
    .whereNot('v2_extraction_status', 'not_run');

  const totalAttempted = parseInt((await baseQuery().count('* as n').first())?.n || 0, 10);

  // PREFIX match, not equality: the processor stamps a catalog-suffixed
  // version (`${PROMPT_HASH}-cat.<hash>`, see extractionPromptVersion) whenever
  // the bookable catalog is non-empty — which it always is in prod — so an
  // exact match on the bare hash matched ZERO rows and the gate reported "no
  // shadow extractions" forever. Catalog-content cohorts are deliberately
  // merged here: the base prompt+schema hash still fences real prompt changes,
  // and the model column above fences model swaps.
  const rows = await baseQuery()
    .where('ai_extraction_model', CURRENT_MODEL)
    .where((qb) => qb
      .where('ai_extraction_prompt_version', CURRENT_PROMPT_VERSION)
      .orWhereRaw('ai_extraction_prompt_version LIKE ?', [`${CURRENT_PROMPT_VERSION}-cat.%`]))
    .select('id', 'twilio_call_sid', 'ai_extraction_enriched', 'v2_extraction_status', 'created_at', 'from_phone', 'to_phone', 'direction');

  const staleExcluded = totalAttempted - rows.length;
  console.log(`Current extractor: model=${CURRENT_MODEL} prompt=${CURRENT_PROMPT_VERSION}`);
  if (staleExcluded > 0) {
    console.log(`Excluded ${staleExcluded} shadow row(s) from older extractor versions (not counted toward the gate).`);
  }

  if (rows.length === 0) {
    console.log(`\nNo shadow extractions from the current extractor yet (${totalAttempted} total from older versions).`);
    console.log('Confirm CALL_EXTRACTION_V2_ENABLED=true and wait for inbound calls on the deployed extractor.');
    await db.destroy();
    return;
  }

  // Which calls did the legacy v1 pipeline actually create an appointment for?
  // v1 marks scheduled_services.notes with "Call SID: <sid>". Count the row
  // regardless of current status — a later cancel/reschedule is a post-hoc
  // lifecycle change, not evidence that v1 declined to auto-create at the time.
  // Filtering those out would falsely read as "v1 didn't create" and skew the
  // v1↔v2 routing-decision agreement metric.
  const sids = rows.map((r) => r.twilio_call_sid).filter(Boolean);
  const appts = sids.length
    ? await db('scheduled_services')
        .where((q) => sids.forEach((s) => q.orWhere('notes', 'like', `%Call SID: ${s}%`)))
        .select('notes')
    : [];
  const v1CreatedSid = new Set();
  for (const a of appts) {
    const m = (a.notes || '').match(/Call SID: (\S+)/);
    if (m) v1CreatedSid.add(m[1].replace(/[.,]$/, ''));
  }

  const statusCounts = {};
  let validCount = 0;
  let agree = 0, disagree = 0;
  const disagreements = [];
  let wouldAutoRoute = 0, wouldTriage = 0;
  let smsWithoutConsent = 0;
  const phantomRisks = [];
  const triageReasonCounts = {};

  for (const r of rows) {
    statusCounts[r.v2_extraction_status || 'null'] = (statusCounts[r.v2_extraction_status || 'null'] || 0) + 1;

    const v2 = parseJson(r.ai_extraction_enriched);
    if (!(r.v2_extraction_status === 'valid' && v2 && isV2Extraction(v2))) continue;
    validCount++;

    // Match production: pass the call's contact phone (ANI) so the
    // caller_phone_missing gate behaves the same as the live routing path.
    const contactPhone = String(r.direction || '').startsWith('outbound') ? r.to_phone : r.from_phone;
    const routing = canAutoRoute(v2, { contactPhone });
    const v2WouldCreate = routing.allowed;
    const v1DidCreate = v1CreatedSid.has(r.twilio_call_sid);

    if (v2WouldCreate) wouldAutoRoute++; else wouldTriage++;

    if (v2WouldCreate === v1DidCreate) {
      agree++;
    } else {
      disagree++;
      disagreements.push({ id: r.id, v2WouldCreate, v1DidCreate, reason: routing.reason || 'allowed' });
    }

    // Criterion 4: would an auto-routed call fire SMS without consent?
    if (v2WouldCreate) {
      const tcpa = checkTcpaConsent(v2);
      if (tcpa.canSms && v2.consent?.sms_consent_given !== true) smsWithoutConsent++;

      // Criterion 5: phantom-appointment backstop — auto-route despite a risk signal.
      // Use the SAME county normalization production uses (isInServiceAreaCounty),
      // so "Sarasota County"/"sarasota" aren't flagged as phantom risks when the
      // live gate would treat them as in-area.
      const addr = v2.property?.service_address || {};
      const conf = v2.confidence || {};
      const outOfArea = addr.county && !isInServiceAreaCounty(addr.county);
      if (!addr.street_line_1 || (typeof conf.overall === 'number' && conf.overall < 0.7) || outOfArea) {
        phantomRisks.push({ id: r.id, street: !!addr.street_line_1, overall: conf.overall, county: addr.county });
      }
    } else {
      const flags = mergeTriageFlags(v2.triage_flags, computeDeterministicTriageFlags(v2, { contactPhone }));
      const reasons = flags.length ? flags : [routing.reason || 'routing_rejected'];
      for (const f of reasons) triageReasonCounts[f] = (triageReasonCounts[f] || 0) + 1;
    }
  }

  await db.destroy();

  const schemaPassRate = validCount / rows.length;
  const agreementRate = (agree + disagree) ? agree / (agree + disagree) : 0;

  const pass = (b) => (b ? 'PASS ✅' : 'FAIL ❌');
  console.log('\n══════════ v2 ROUTING PROMOTION READINESS ══════════\n');
  console.log(`Shadow extractions on record: ${rows.length}`);
  console.log('Status breakdown:', JSON.stringify(statusCounts));
  console.log('');
  console.log(`1. Sample size ≥ ${MIN_CALLS}          : ${pass(rows.length >= MIN_CALLS)}  (${rows.length})`);
  console.log(`2. Schema validation ≥ ${SCHEMA_PASS_THRESHOLD * 100}%     : ${pass(schemaPassRate >= SCHEMA_PASS_THRESHOLD)}  (${(schemaPassRate * 100).toFixed(1)}% — ${validCount}/${rows.length})`);
  console.log(`3. v1↔v2 agreement ≥ ${AGREEMENT_THRESHOLD * 100}%     : ${pass(agreementRate >= AGREEMENT_THRESHOLD)}  (${(agreementRate * 100).toFixed(1)}% — ${agree}/${agree + disagree})`);
  console.log(`4. 0 SMS-without-consent auto-routes : ${pass(smsWithoutConsent === 0)}  (${smsWithoutConsent})`);
  console.log(`5. 0 phantom-appointment risks      : ${pass(phantomRisks.length === 0)}  (${phantomRisks.length})`);
  console.log(`6. Disagreements reviewed           : ${disagreements.length === 0 ? 'none ✅' : disagreements.length + ' need manual review ⚠️'}`);

  console.log(`\nWould auto-route: ${wouldAutoRoute}   |   Would triage: ${wouldTriage}`);
  if (Object.keys(triageReasonCounts).length) {
    console.log('Triage reasons:', JSON.stringify(triageReasonCounts, null, 0));
  }

  if (disagreements.length) {
    // Criterion 6 requires EVERY mismatch be reviewable before promotion — print
    // them all, never a truncated subset. (In the regime where the report could
    // still pass, disagreements are ≤5% of the sample, so volume stays bounded.)
    console.log(`\n── v1↔v2 DISAGREEMENTS (${disagreements.length} — review all before promoting) ──`);
    for (const d of disagreements) {
      console.log(`  ${d.id}  v2_would_create=${d.v2WouldCreate} v1_did_create=${d.v1DidCreate} (${d.reason})`);
    }
  }
  if (phantomRisks.length) {
    console.log(`\n── PHANTOM-APPOINTMENT RISKS (${phantomRisks.length} — should be empty) ──`);
    for (const p of phantomRisks) {
      console.log(`  ${p.id}  hasStreet=${p.street} overall=${p.overall} county=${p.county}`);
    }
  }

  const allPass = rows.length >= MIN_CALLS && schemaPassRate >= SCHEMA_PASS_THRESHOLD &&
    agreementRate >= AGREEMENT_THRESHOLD && smsWithoutConsent === 0 && phantomRisks.length === 0;
  console.log(`\n${allPass ? '✅ ALL CRITERIA PASS — safe to flip CALL_EXTRACTION_V2_DRIVES_ROUTING=true (after reviewing disagreements).' : '⛔ NOT READY — criteria above still failing.'}\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
