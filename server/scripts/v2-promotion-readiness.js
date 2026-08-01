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
const {
  canAutoRoute, computeDeterministicTriageFlags, mergeTriageFlags, isInServiceAreaCounty,
  dispatchesToOnFileAddress,
} = require('../services/call-triage-flags');
const { checkTcpaConsent } = require('../services/call-routing-gates');
const { isV2Extraction } = require('../utils/extraction-compat');
const { PROMPT_HASH } = require('../services/prompts/call-extraction-v1');
const MODELS = require('../config/models');

const MIN_CALLS = 100;
const SCHEMA_PASS_THRESHOLD = 0.95;
const AGREEMENT_THRESHOLD = 0.95;
const MIN_FALLBACK_ROWS = 5;

// The promotion gate must reflect ONLY the currently-deployed extractor.
// Shadow rows from a prior model/prompt (e.g. the pre-Gemini-Pro/JSON-mode
// extractor that 100% schema-failed) would otherwise dilute the metrics and
// let a stale ≥95% sample green-light a freshly-changed extractor. Mirror the
// processor's route resolution; override via env if those change.
// Mirrors the processor's PER-PROVIDER route resolution exactly:
// CALL_EXTRACTION_MODEL is the OpenAI leg's override ONLY — under a
// gemini/anthropic rollback a lingering OpenAI override must not make this
// gate evaluate the wrong cohort.
const RAW_ROUTE_PROVIDER = process.env.CALL_EXTRACTION_PROVIDER || 'openai';
const ROUTE_PROVIDER = ['openai', 'anthropic', 'gemini'].includes(RAW_ROUTE_PROVIDER) ? RAW_ROUTE_PROVIDER : 'openai';
if (ROUTE_PROVIDER !== RAW_ROUTE_PROVIDER) {
  console.error(`CALL_EXTRACTION_PROVIDER "${RAW_ROUTE_PROVIDER}" is not openai|anthropic|gemini — mirroring the processor's openai fallback.`);
}
const ROUTE_MODEL_FOR = {
  openai: process.env.CALL_EXTRACTION_MODEL || 'gpt-5.6-sol',
  anthropic: MODELS.CALL_EXTRACTION_ANTHROPIC,
  gemini: process.env.GEMINI_EXTRACTION_MODEL || 'gemini-2.5-pro',
};
const CURRENT_PRIMARY = ROUTE_MODEL_FOR[ROUTE_PROVIDER] || ROUTE_MODEL_FOR.openai;
// The query covers the WHOLE route (fallback rows stamp the fallback
// model), but the gate itself scores the primary cohort alone — see below.
const CURRENT_ROUTE_MODELS = [...new Set([
  CURRENT_PRIMARY,
  ROUTE_PROVIDER === 'anthropic' ? ROUTE_MODEL_FOR.openai : MODELS.CALL_EXTRACTION_ANTHROPIC,
])];
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

  // The processor stamps a catalog-suffixed version
  // (`${PROMPT_HASH}-cat.<hash>`, see extractionPromptVersion) whenever the
  // bookable catalog is non-empty — which it always is in prod — so the old
  // exact match on the bare hash matched ZERO rows and the gate reported "no
  // shadow extractions" forever. Compute the LIVE catalog's version the same
  // way the processor does and match THAT (not a bare `-cat.%` prefix, which
  // would fold stale catalog cohorts into the current gate).
  const { loadBookableCallServices } = require('../services/call-booking-catalog');
  const liveCatalogNames = (await loadBookableCallServices(db)).map((s) => s.name).filter(Boolean);
  const { extractionPromptVersion } = require('../services/prompts/call-extraction-v1');
  const LIVE_PROMPT_VERSION = extractionPromptVersion(liveCatalogNames);
  const allRouteRows = await baseQuery()
    .whereIn('ai_extraction_model', CURRENT_ROUTE_MODELS)
    .whereIn('ai_extraction_prompt_version', [...new Set([CURRENT_PROMPT_VERSION, LIVE_PROMPT_VERSION])])
    .select('id', 'twilio_call_sid', 'ai_extraction_enriched', 'ai_extraction_validation_errors', 'v2_extraction_status', 'created_at', 'from_phone', 'to_phone', 'direction', 'ai_extraction_model', 'ai_extraction_prompt_version', 'ai_address_validation', 'customer_id');

  // Cohort boundary: rows are attributed by MODEL, so after a route change
  // a previous primary's rows could masquerade as current-route executions
  // (the gemini kill switch is the sharp case — historical 2.5-pro rows are
  // NOT executions of the restored route). Auto-bound the cohort to the
  // contiguous run since the newest row produced by a model OUTSIDE the
  // current route; pass --since <ISO date> to override for flips where the
  // old primary remains in the route (e.g. it became the new fallback).
  const sinceIdx = process.argv.indexOf('--since');
  let cohortSince = sinceIdx >= 0 ? new Date(process.argv[sinceIdx + 1]) : null;
  if (cohortSince && Number.isNaN(cohortSince.getTime())) {
    console.error(`--since is not a parseable date: ${process.argv[sinceIdx + 1]}`);
    process.exit(1);
  }
  if (!cohortSince) {
    const lastForeign = await baseQuery()
      .whereNotIn('ai_extraction_model', CURRENT_ROUTE_MODELS)
      .max('created_at as t')
      .first();
    cohortSince = lastForeign?.t ? new Date(lastForeign.t) : null;
    if (cohortSince) {
      console.log(`Cohort auto-bounded to rows after ${cohortSince.toISOString()} (last row from a model outside the current route). Override with --since.`);
    } else {
      // A role flip WITHIN the same model pair (primary↔fallback swap) is
      // mechanically indistinguishable by stamps — only the operator knows
      // the flip time. Say so loudly instead of pretending the cohort is
      // clean.
      console.log('⚠️  No cohort boundary found. If you swapped primary/fallback WITHIN the current model pair, historical rows are misattributed — re-run with --since <flip time> before trusting this verdict.');
    }
  }
  const boundedRouteRows = cohortSince
    ? allRouteRows.filter((r) => new Date(r.created_at) > cohortSince)
    : allRouteRows;

  // Effective-verdict reconstruction for RECOVERED addresses (codex round-11
  // P2): the processor deliberately persists the ORIGINAL unresolvable
  // verdict in ai_address_validation while ROUTING with the recovery's
  // accepting result — the durable trace of that split is the
  // address_recovered card. Auditing with the stored verdict alone reports
  // triage for calls production auto-created, depressing v1↔v2 agreement.
  // Recovery adopts only when it confirmed exactly ONE real in-area premise,
  // so 'corrected' + inServiceArea is the faithful reconstruction.
  //
  // The card must speak for the CURRENT pass (codex final-round P2). A call
  // recovered once and later reprocessed WITHOUT a successful recovery keeps
  // its old card — a bare existence check would let that stale row turn the
  // latest unverified verdict into 'corrected', count an unvalidated address
  // as auto-routable, and skew the promotion gate PERMISSIVE. The processor
  // stamps the card with the same provenance the call_log row carries, so
  // only an exact model+prompt match reconstructs. Cards written before that
  // stamp shipped are excluded (fail-closed = stricter gate) and both counts
  // are printed below — never silently dropped.
  const rowById = new Map(boundedRouteRows.map((r) => [r.id, r]));
  const recoveryCards = await db('triage_items')
    .whereIn('call_log_id', boundedRouteRows.map((r) => r.id))
    .where({ reason_code: 'address_recovered' })
    .select('call_log_id', 'payload');
  const recoveredCallIds = new Set();
  let unstampedRecoveryCards = 0;
  let staleRecoveryCards = 0;
  for (const card of recoveryCards) {
    // Card payloads are operator-visible jsonb; a malformed one must not
    // crash the whole readiness run — it just fails to prove its pass.
    let p = {};
    try { p = parseJson(card.payload) || {}; } catch { p = {}; }
    const row = rowById.get(card.call_log_id);
    if (!p.extraction_model || !p.extraction_prompt_version) { unstampedRecoveryCards++; continue; }
    if (p.extraction_model !== row?.ai_extraction_model
      || p.extraction_prompt_version !== row?.ai_extraction_prompt_version) { staleRecoveryCards++; continue; }
    recoveredCallIds.add(card.call_log_id);
  }

  // On-file-address fail-open context (codex round-12 P2): production routes
  // established customers with failOpen + callerAni + knownCustomer
  // { hasAddress } (call-recording-processor ~5356), letting a caller who
  // did not restate their on-file address auto-route. Auditing without that
  // context scores those production auto-creates as blocked. Mirror the same
  // env gate production reads; hasAddress from the linked customer row.
  const auditFailOpen = process.env.GATE_CALL_FAIL_OPEN_BOOKING === 'true';
  const linkedCustomerIds = [...new Set(boundedRouteRows.map((r) => r.customer_id).filter(Boolean))];
  const customersWithAddress = new Set(linkedCustomerIds.length
    ? (await db('customers').whereIn('id', linkedCustomerIds).whereNotNull('address_line1').where('address_line1', '!=', '').select('id')).map((c) => c.id)
    : []);

  // The GATE scores the PRIMARY leg alone — pooling both legs would let a
  // healthy primary mask a small failing fallback cohort, or pass a route
  // whose fallback has zero assessed rows. The fallback cohort is reported
  // separately below and is never silently folded into the gate.
  const fallbackModel = CURRENT_ROUTE_MODELS.find((m) => m !== CURRENT_PRIMARY) || null;
  const fallbackRows = fallbackModel ? boundedRouteRows.filter((r) => r.ai_extraction_model === fallbackModel) : [];
  const rows = boundedRouteRows.filter((r) => r.ai_extraction_model === CURRENT_PRIMARY);

  const staleExcluded = totalAttempted - allRouteRows.length;
  console.log(`Current extractor route: primary=${CURRENT_PRIMARY} fallback=${fallbackModel || 'n/a'} prompt=${CURRENT_PROMPT_VERSION}`);
  if (staleExcluded > 0) {
    console.log(`Excluded ${staleExcluded} shadow row(s) from older extractor versions (not counted toward the gate).`);
  }

  // Guard on the WHOLE bounded cohort — zero primary rows with a populated
  // fallback cohort means every primary attempt failed (fallback rescued
  // them all), which must surface as a 0% primary pass rate below, not as
  // "nothing ran".
  if (boundedRouteRows.length === 0) {
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
  // From the WHOLE route — semantic scoring iterates allRouteRows, so a
  // fallback-produced call needs its real v1 outcome too, not a default
  // v1DidCreate=false.
  const sids = boundedRouteRows.map((r) => r.twilio_call_sid).filter(Boolean);
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
  // Auto-routes that trip a raw risk signal but dispatch to the customer's
  // on-file address under the fail-open ruling — reported, never gating.
  const failOpenRoutes = [];
  const triageReasonCounts = {};

  // Safety/semantic criteria (v1↔v2 agreement, SMS consent, phantom risk)
  // run over valid outputs from the ENTIRE route — fallback-produced
  // extractions are exactly what production routes from during primary
  // failures, so they must clear the same checks. Reliability accounting
  // (statusCounts / validCount / schema-pass) stays primary-scoped.
  for (const r of boundedRouteRows) {
    const isPrimaryRow = r.ai_extraction_model === CURRENT_PRIMARY;
    if (isPrimaryRow) {
      statusCounts[r.v2_extraction_status || 'null'] = (statusCounts[r.v2_extraction_status || 'null'] || 0) + 1;
    }

    const v2 = parseJson(r.ai_extraction_enriched);
    if (!(r.v2_extraction_status === 'valid' && v2 && isV2Extraction(v2))) continue;
    if (isPrimaryRow) validCount++;

    // Match production: pass the call's contact phone (ANI) so the
    // caller_phone_missing gate behaves the same as the live routing path,
    // AND the stored AV verdict — since the central address-trust gate
    // (2026-08-01) every call without a verdict returns address_not_validated,
    // so omitting it makes the audit report zero production-equivalent
    // auto-routes and the readiness comparison meaningless (codex round-10 P1
    // on PR #3119).
    const contactPhone = String(r.direction || '').startsWith('outbound') ? r.to_phone : r.from_phone;
    const storedAv = parseJson(r.ai_address_validation);
    const effectiveAv = recoveredCallIds.has(r.id)
      ? { status: 'corrected', inServiceArea: true, county: storedAv?.county || null, normalized: storedAv?.normalized || null, reconstructed_from: 'address_recovered' }
      : storedAv;
    const knownCustomer = (r.customer_id && customersWithAddress.has(r.customer_id))
      ? { hasAddress: true }
      : (r.customer_id ? {} : null);
    const routing = canAutoRoute(v2, {
      contactPhone,
      addressValidation: effectiveAv,
      failOpen: auditFailOpen,
      callerAni: contactPhone,
      knownCustomer,
    });
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
      //
      // Judged on the address the call would actually DISPATCH to, not the raw
      // model fields (codex final-round P1). Two production-safe routes are
      // invisible to the raw view, and both were newly reachable once this
      // audit started passing the effective AV + on-file context:
      //   • a corrected in-area AV verdict SUPERSEDES a stale out-of-area
      //     model county, and supplies the street AV resolved;
      //   • an established customer dispatches to the on-file address, so no
      //     newly-stated street is expected and the <0.7 fail-open is the
      //     owner's deliberate ruling, not a phantom.
      // Those are still COUNTED — into failOpenRoutes, printed separately —
      // so widening the routing contract can never silently empty this
      // backstop. Anything out-of-area stays a phantom risk regardless.
      const addr = v2.property?.service_address || {};
      const conf = v2.confidence || {};
      const avPositive = !!effectiveAv
        && ['validated_accept', 'corrected'].includes(String(effectiveAv.status || ''))
        && effectiveAv.inServiceArea === true;
      const dispatchStreet = addr.street_line_1 || (avPositive ? effectiveAv.normalized?.street_line_1 : null);
      // The SHARED predicate, not a local "has an address on file" test
      // (codex round-19 P1): production's exemption also requires that the
      // caller did NOT state an address on this call. Testing only for a
      // customer address on file moved low-confidence and street-less
      // NEW-address routes into the non-gating bucket too — hiding exactly
      // the auto-routes criterion 5 exists to catch, and letting a promotion
      // pass on them.
      const onFileDispatch = dispatchesToOnFileAddress(v2, { failOpen: auditFailOpen, knownCustomer });
      const outOfArea = !avPositive && addr.county && !isInServiceAreaCounty(addr.county);
      const lowConfidence = typeof conf.overall === 'number' && conf.overall < 0.7;
      if (!dispatchStreet || lowConfidence || outOfArea) {
        const entry = {
          id: r.id,
          street: !!dispatchStreet,
          overall: conf.overall,
          county: addr.county,
          av: effectiveAv?.status || null,
        };
        if (onFileDispatch && !outOfArea) failOpenRoutes.push(entry);
        else phantomRisks.push(entry);
      }
    } else {
      const flags = mergeTriageFlags(v2.triage_flags, computeDeterministicTriageFlags(v2, { contactPhone }));
      const reasons = flags.length ? flags : [routing.reason || 'routing_rejected'];
      for (const f of reasons) triageReasonCounts[f] = (triageReasonCounts[f] || 0) + 1;
    }
  }

  await db.destroy();

  // Every fallback-stamped row IS a primary failure (the fallback only runs
  // after the primary leg failed transport or schema) — so the primary's
  // schema-pass denominator must include them, or a fallback-rescued
  // primary reads as a clean 100%.
  const primaryAttempts = rows.length + fallbackRows.length;
  const schemaPassRate = primaryAttempts ? validCount / primaryAttempts : 0;
  const agreementRate = (agree + disagree) ? agree / (agree + disagree) : 0;

  const pass = (b) => (b ? 'PASS ✅' : 'FAIL ❌');
  console.log('\n══════════ v2 ROUTING PROMOTION READINESS ══════════\n');
  console.log(`Shadow extractions on record (primary leg ${CURRENT_PRIMARY}): ${rows.length}`);
  console.log('Status breakdown:', JSON.stringify(statusCounts));
  if (fallbackModel) {
    const fbValid = fallbackRows.filter((r) => r.v2_extraction_status === 'valid').length;
    if (fallbackRows.length === 0) {
      console.log(`Fallback leg ${fallbackModel}: 0 shadow rows — UNASSESSED. An outage failover would run an untested model; bake it off (or eyeball its first shadow rows) before relying on it.`);
    } else {
      console.log(`Fallback leg ${fallbackModel}: ${fallbackRows.length} row(s), ${fbValid} valid (${Math.round((fbValid / fallbackRows.length) * 100)}% schema-pass) — each one is also a PRIMARY failure and counts against the primary schema-pass denominator below.`);
    }
  }
  console.log('');
  console.log(`1. Sample size ≥ ${MIN_CALLS}          : ${pass(primaryAttempts >= MIN_CALLS)}  (${primaryAttempts} attempts)`);
  console.log(`2. Schema validation ≥ ${SCHEMA_PASS_THRESHOLD * 100}%     : ${pass(schemaPassRate >= SCHEMA_PASS_THRESHOLD)}  (${(schemaPassRate * 100).toFixed(1)}% — ${validCount}/${primaryAttempts})`);
  console.log(`3. v1↔v2 agreement ≥ ${AGREEMENT_THRESHOLD * 100}%     : ${pass(agreementRate >= AGREEMENT_THRESHOLD)}  (${(agreementRate * 100).toFixed(1)}% — ${agree}/${agree + disagree})`);
  console.log(`4. 0 SMS-without-consent auto-routes : ${pass(smsWithoutConsent === 0)}  (${smsWithoutConsent})`);
  console.log(`5. 0 phantom-appointment risks      : ${pass(phantomRisks.length === 0)}  (${phantomRisks.length})`);
  if (failOpenRoutes.length) {
    console.log(`   ↳ ${failOpenRoutes.length} auto-route(s) excluded as on-file fail-open dispatches (not phantom — listed below).`);
  }
  if (unstampedRecoveryCards || staleRecoveryCards) {
    console.log(`   ↳ address_recovered cards NOT used to reconstruct a verdict: ${unstampedRecoveryCards} unstamped (pre-2026-08-01 history), ${staleRecoveryCards} from a different extraction pass.`);
  }
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
      console.log(`  ${p.id}  hasStreet=${p.street} overall=${p.overall} county=${p.county} av=${p.av}`);
    }
  }
  if (failOpenRoutes.length) {
    console.log(`\n── ON-FILE FAIL-OPEN DISPATCHES (${failOpenRoutes.length} — reviewed, not gating) ──`);
    for (const p of failOpenRoutes) {
      console.log(`  ${p.id}  hasStreet=${p.street} overall=${p.overall} county=${p.county} av=${p.av}`);
    }
  }

  // The fallback leg must be ASSESSED before the route is called safe:
  // production routes from it during a primary outage, so an untested (or
  // failing) fallback blocks the verdict. Threshold is deliberately small —
  // fallback rows only accrue when the primary fails, so demanding a large
  // sample would deadlock a healthy primary; the pre-swap bake-off plus a
  // handful of live rescues is the assessment bar.
  // A fallback-stamped row is inherently a fallback SUCCESS (both-legs-failed
  // rows stamp the primary), so the denominator must add failed fallback
  // attempts — derived from the per-leg failure lists the extractor persists
  // in ai_extraction_validation_errors on failed rows.
  const failedFallbackAttempts = boundedRouteRows.filter((r) => {
    if (r.v2_extraction_status === 'valid' || r.ai_extraction_model !== CURRENT_PRIMARY) return false;
    const errs = parseJson(r.ai_extraction_validation_errors);
    return Array.isArray(errs) && errs.some((e) => e && e.model === fallbackModel);
  }).length;
  const fbValidCount = fallbackRows.filter((r) => r.v2_extraction_status === 'valid').length;
  const fbAttempts = fallbackRows.length + failedFallbackAttempts;
  const fallbackAssessed = fbAttempts >= MIN_FALLBACK_ROWS
    && fbValidCount / fbAttempts >= SCHEMA_PASS_THRESHOLD;
  console.log(`6. Fallback leg assessed (≥ ${MIN_FALLBACK_ROWS} attempts @ ≥ ${SCHEMA_PASS_THRESHOLD * 100}% valid): ${pass(fallbackAssessed)}  (${fbValidCount}/${fbAttempts}${failedFallbackAttempts ? ` incl. ${failedFallbackAttempts} failed attempt(s)` : ''})`);

  const allPass = primaryAttempts >= MIN_CALLS && schemaPassRate >= SCHEMA_PASS_THRESHOLD &&
    agreementRate >= AGREEMENT_THRESHOLD && smsWithoutConsent === 0 && phantomRisks.length === 0 &&
    fallbackAssessed;
  console.log(`\n${allPass ? '✅ ALL CRITERIA PASS — safe to flip CALL_EXTRACTION_V2_DRIVES_ROUTING=true (after reviewing disagreements).' : '⛔ NOT READY — criteria above still failing.'}\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
