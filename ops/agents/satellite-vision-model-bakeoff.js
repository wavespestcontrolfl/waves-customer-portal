#!/usr/bin/env node
/**
 * satellite-vision-model-bakeoff.js — READ-ONLY (stdout only; LIVE model calls)
 *
 * A/B of two (or more) Gemini model ids on the property lookup's SATELLITE
 * vision read — the one that feeds Tree & Shrub pricing (estimatedBedAreaSf,
 * estimatedTreeCount, estimatedPalmCount, shrubDensity, and the new
 * estimatedHedgeLinearFt). Owner ask 2026-10-21: is Gemini 4 Argon more
 * accurate than Gemini 3.8 Flash at measuring beds and counting ornamentals
 * before MODEL_GEMINI_VISION is flipped fleet-wide (owner ruling 2026-09-06:
 * one model for every image lane, so a flip is never satellite-only).
 *
 * Every model sees IDENTICAL input: the same five Google Static Maps tiles
 * (zoom 22/21/20/19/18, 640×640, satellite) the lookup fetches, the same
 * scale-line vision context and the same production prompt
 * (property-lookup-v2.js#buildSatelliteVisionPrompt). No county parcel
 * overlay and no property record — both differ from production, but both
 * models get the same handicap, which is what an A/B needs.
 *
 * Fixture (operator-written, kept OUT of the repo): a JSON array of
 *   { "id": "p01", "address": "123 Example St, Venice, FL 34285",
 *     "known": { "bedAreaSf": 900, "hedgeLinearFt": 160, "ornamentalTrees": 3,
 *                "palms": 4, "shrubDensity": "MODERATE" } }
 * `known` is whatever the owner measured on site or from the parcel; any key
 * may be omitted and is then skipped in the error table. Addresses print ONLY
 * with --show-addresses; the default output carries the fixture id.
 *
 *   railway run --service waves-customer-portal node ops/agents/satellite-vision-model-bakeoff.js \
 *     --fixture /tmp/ts-bakeoff.json --models <live GEMINI_VISION_BEST id>,gemini-4-argon \
 *     [--repeat 2] [--concurrency 2] [--ids p01,p02] [--limit N] [--json] [--show-addresses] \
 *     > /tmp/ts-bakeoff-results.md
 *
 * Needs GOOGLE_MAPS_API_KEY (or GOOGLE_API_KEY) for geocoding + tiles and
 * GEMINI_API_KEY (or GOOGLE_API_KEY) for the model calls. Every call is a
 * single-leg ad-hoc policy (no Sol fallback, no Claude leg), so a model id the
 * API rejects reports as a miss for that model rather than silently answering
 * on another provider.
 *
 * READ-ONLY is enforced, not asserted (lawn-visit-assessment-eval.js
 * precedent): the LLM ledger gates are deleted after server/config loads
 * (dotenv fills missing vars) and the run ABORTS if any still resolves
 * enabled, so no llm_dispatch_log rows are written. Nothing here touches the
 * database or S3, and no customer communication is reachable from this path.
 * Each fixture row costs (models × repeat) vision calls plus five tile
 * fetches; 20 properties × 2 models × 1 repeat ≈ 40 calls.
 */

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const FIELDS = ['bedAreaSf', 'hedgeLinearFt', 'ornamentalTrees', 'palms'];
const FIELD_FROM_ANALYSIS = {
  bedAreaSf: 'estimatedBedAreaSf',
  hedgeLinearFt: 'estimatedHedgeLinearFt',
  ornamentalTrees: 'estimatedTreeCount',
  palms: 'estimatedPalmCount',
};
const ZOOMS = [['micro', 22], ['ultra', 21], ['super', 20], ['close', 19], ['wide', 18]];
const LEDGER_GATES = ['GATE_LLM_DISPATCH_METRICS', 'GATE_LLM_CALL_LEDGER', 'GATE_LLM_CALL_TRACES'];

const positiveInt = (flag) => (raw) => {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) { console.error(`${flag} needs a positive whole number, got ${JSON.stringify(raw ?? null)}`); process.exit(2); }
  return n;
};
const list = (flag) => (raw) => {
  const items = String(raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!items.length || String(raw).startsWith('--')) { console.error(`${flag} needs a comma-separated list, got ${JSON.stringify(raw ?? null)}`); process.exit(2); }
  return items;
};
const ARG_SPECS = {
  '--fixture': { key: 'fixture', value: (raw) => { if (!raw || String(raw).startsWith('--')) { console.error('--fixture needs a path'); process.exit(2); } return String(raw); } },
  '--models': { key: 'models', value: list('--models') },
  '--repeat': { key: 'repeat', value: positiveInt('--repeat') },
  '--concurrency': { key: 'concurrency', value: positiveInt('--concurrency') },
  '--ids': { key: 'ids', value: list('--ids') },
  '--limit': { key: 'limit', value: positiveInt('--limit') },
  '--json': { key: 'json' },
  '--show-addresses': { key: 'showAddresses' },
  '--help': { key: 'help' },
};

function parseArgs(argv) {
  const args = { models: null, repeat: 1, concurrency: 2, ids: null, limit: null, json: false, showAddresses: false };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].includes('=') ? argv[i].split(/=(.*)/s) : [argv[i], undefined];
    const spec = ARG_SPECS[flag];
    if (!spec) { console.error(`unknown flag ${argv[i]}`); process.exit(2); }
    if (!spec.value) { args[spec.key] = true; continue; }
    const raw = inline !== undefined ? inline : argv[++i];
    args[spec.key] = spec.value(raw);
  }
  if (args.help) {
    console.log('usage: node ops/agents/satellite-vision-model-bakeoff.js --fixture <file> --models a,b [--repeat N] [--concurrency N] [--ids a,b] [--limit N] [--json] [--show-addresses]');
    process.exit(0);
  }
  if (!args.fixture) { console.error('--fixture is required'); process.exit(2); }
  return args;
}

function assertNoLedgerWrites(gates, when) {
  if (gates.isEnabled('llmDispatchMetrics') || gates.gateEnvValue('GATE_LLM_CALL_LEDGER') || gates.gateEnvValue('GATE_LLM_CALL_TRACES')) {
    console.error(`ABORT (${when}): an LLM ledger gate resolved ENABLED — this run would write llm_dispatch_log rows. Unset ${LEDGER_GATES.join(' / ')} and re-run.`);
    process.exit(2);
  }
}

function loadFixture(file, args) {
  let rows;
  try { rows = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { console.error(`cannot read fixture ${file}: ${err.message}`); process.exit(2); }
  if (!Array.isArray(rows)) { console.error('fixture must be a JSON array'); process.exit(2); }
  rows = rows.filter((r) => r && typeof r.address === 'string' && r.address.trim());
  rows.forEach((r, i) => { if (!r.id) r.id = `p${String(i + 1).padStart(2, '0')}`; r.known = r.known && typeof r.known === 'object' ? r.known : {}; });
  if (args.ids) rows = rows.filter((r) => args.ids.includes(String(r.id)));
  if (args.limit) rows = rows.slice(0, args.limit);
  if (!rows.length) { console.error('fixture has no usable rows (need address; --ids/--limit may have filtered everything)'); process.exit(2); }
  return rows;
}

async function fetchTileBase64(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`static map ${res.status}`);
    return Buffer.from(await res.arrayBuffer()).toString('base64');
  } finally { clearTimeout(timer); }
}

// The lookup's five tiles, same URL template as performPropertyLookupCore.
async function fetchTiles(lat, lng, mapsKey) {
  const out = {};
  await Promise.all(ZOOMS.map(async ([name, zoom]) => {
    const url = `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}&zoom=${zoom}&size=640x640&maptype=satellite&format=png&key=${mapsKey}`;
    out[`_${name === 'micro' ? 'microClose' : name === 'ultra' ? 'ultraClose' : name === 'super' ? 'superClose' : name}B64`] = await fetchTileBase64(url).catch(() => null);
  }));
  return out;
}

// null / undefined / blank is "not read", never a measured zero — Number(null)
// is 0 (Codex #6398 r7; same guard as the production merge helper).
function numericRead(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

async function runCase({ row, models, repeat, lookup, dispatch, mapsKey }) {
  const geo = await lookup.geocodeAddress(row.address);
  const tiles = await fetchTiles(geo.lat, geo.lng, mapsKey);
  if (!tiles._closeB64 || !tiles._wideB64) throw new Error('tile fetch failed (close/wide missing)');
  const satellite = { lat: geo.lat, lng: geo.lng, ...tiles, _parcelOverlayApplied: false };
  const visionContext = lookup.buildVisionContext(satellite, null);
  const prompt = lookup.buildSatelliteVisionPrompt(row.address, null, visionContext);
  const images = [tiles._microCloseB64, tiles._ultraCloseB64, tiles._superCloseB64, tiles._closeB64, tiles._wideB64]
    .filter(Boolean).map((data) => ({ data, mimeType: 'image/png' }));

  const reads = [];
  for (const model of models) {
    for (let rep = 0; rep < repeat; rep++) {
      const started = Date.now();
      // The PRODUCTION contract decides what counts as an answer: the same
      // normalizer + validator the lookup runs on every read, through the
      // dispatcher's validate hook, so a syntactically valid JSON that drops
      // a required field is a MISS here exactly as it is in production
      // (Codex #6398) — never a silent "null measurement" the scorer skips.
      const outcome = await dispatch.dispatchWithFallback(
        { name: `bakeoff:${model}`, primary: { provider: 'gemini', model } },
        { text: prompt, images, jsonMode: true, maxTokens: 4096, thinkingLevel: 'LOW', timeoutMs: 120000, laneId: 'ops_satellite_bakeoff' },
        {
          validate: (candidate) => {
            candidate.json = lookup.normalizeSatelliteAnalysis(candidate.json);
            return lookup.isValidSatelliteVisionAnalysis(candidate.json) ? null : 'invalid_schema';
          },
        },
      );
      const ms = Date.now() - started;
      if (!outcome?.ok || !outcome.json || typeof outcome.json !== 'object') {
        reads.push({ model, rep, ok: false, ms, reason: outcome?.reason || outcome?.failures?.map((f) => f.reason).join(',') || 'no_json' });
        continue;
      }
      const a = outcome.json;
      reads.push({
        model, rep, ok: true, ms,
        usage: outcome.usage || null,
        values: Object.fromEntries(FIELDS.map((f) => [f, numericRead(a[FIELD_FROM_ANALYSIS[f]])])),
        shrubDensity: typeof a.shrubDensity === 'string' ? a.shrubDensity.toUpperCase() : null,
        confidence: numericRead(a.confidenceScore),
      });
    }
  }
  return { id: row.id, address: row.address, known: row.known, reads };
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try { results[i] = await fn(items[i]); } catch (err) { results[i] = { id: items[i].id, address: items[i].address, known: items[i].known, error: err.message || String(err), reads: [] }; }
      console.error(`  done ${i + 1}/${items.length} ${items[i].id}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// One field of one read against the fixture's known value. pctN counts only
// reads with a POSITIVE known value — a zero-truth property (no palms, no
// trees) has no percentage error, so it must not inflate the MAPE
// denominator and hide false positives (Codex #6398).
function scoreField(stat, truth, got) {
  if (truth === null || got === null) return;
  stat.n++; stat.absErr += Math.abs(got - truth); stat.bias += got - truth;
  if (truth > 0) {
    const pct = Math.abs(got - truth) / truth;
    stat.pctN++; stat.pctErr += pct;
    if (pct <= 0.25) stat.within25++;
  } else if (got === 0) {
    stat.within25++;
  }
}

// One model read of one case folded into that model's tally.
function scoreRead(m, c, r) {
  m.reads++; m.msTotal += r.ms;
  if (!r.ok) { m.misses++; return; }
  for (const f of FIELDS) scoreField(m.fields[f], numericRead(c.known[f]), r.values[f]);
  if (typeof c.known.shrubDensity === 'string') {
    m.shrubDensityKnown++;
    if (r.shrubDensity === c.known.shrubDensity.toUpperCase()) m.shrubDensityHits++;
  }
}

// Per model, per field: mean absolute error, mean absolute % error against
// the owner's known value, bias (signed mean error), and how many reads
// landed within 25% of truth. Only cases with a known value count.
function score(cases, models) {
  const out = {};
  for (const model of models) {
    const m = { reads: 0, misses: 0, msTotal: 0, fields: {}, shrubDensityHits: 0, shrubDensityKnown: 0 };
    for (const f of FIELDS) m.fields[f] = { n: 0, absErr: 0, pctN: 0, pctErr: 0, bias: 0, within25: 0 };
    for (const c of cases) {
      for (const r of c.reads) if (r.model === model) scoreRead(m, c, r);
    }
    out[model] = m;
  }
  return out;
}

function printReport(cases, models, scores, args) {
  const fmt = (x, d = 0) => (x === null || x === undefined || Number.isNaN(x) ? '—' : Number(x).toFixed(d));
  console.log(`# Satellite vision bake-off — ${cases.length} properties × ${models.join(' vs ')}${args.repeat > 1 ? ` × ${args.repeat} repeats` : ''}`);
  console.log('');
  console.log('Same five tiles, same scale context, same production prompt per model. Error is against the fixture\'s `known` values; a field with no known value is skipped.');
  console.log('');
  for (const model of models) {
    const m = scores[model];
    console.log(`## ${model} — ${m.reads} reads, ${m.misses} misses, avg ${fmt(m.reads ? m.msTotal / m.reads / 1000 : null, 1)} s/read`);
    console.log('field            n   MAE      MAPE (n>0)   bias     within ±25%');
    for (const f of FIELDS) {
      const s = m.fields[f];
      if (!s.n) { console.log(`${f.padEnd(15)} ${String(0).padStart(3)}   —`); continue; }
      // MAPE over positive-truth reads only; zero-truth reads still count in
      // MAE, bias and the ±25% column (a false positive on a zero shows there).
      const mape = s.pctN ? `${fmt((s.pctErr / s.pctN) * 100, 0)}% (${s.pctN})` : '— (0)';
      console.log(`${f.padEnd(15)} ${String(s.n).padStart(3)}   ${fmt(s.absErr / s.n, 1).padStart(7)}  ${mape.padStart(11)}  ${fmt(s.bias / s.n, 1).padStart(7)}   ${s.within25}/${s.n}`);
    }
    if (m.shrubDensityKnown) console.log(`shrubDensity match: ${m.shrubDensityHits}/${m.shrubDensityKnown}`);
    console.log('');
  }
  console.log('## Per property');
  const head = ['id', ...(args.showAddresses ? ['address'] : []), 'field', 'known', ...models];
  console.log(head.join(' | '));
  for (const c of cases) {
    if (c.error) { console.log(`${c.id} | ERROR ${c.error}`); continue; }
    for (const f of FIELDS) {
      const cells = models.map((model) => {
        const vals = c.reads.filter((r) => r.model === model).map((r) => (r.ok ? r.values[f] : 'miss'));
        return vals.map((v) => (v === null ? '—' : v)).join(' / ');
      });
      console.log([c.id, ...(args.showAddresses ? [c.address] : []), f, c.known[f] ?? '—', ...cells].join(' | '));
    }
    const dens = models.map((model) => c.reads.filter((r) => r.model === model).map((r) => (r.ok ? r.shrubDensity || '—' : 'miss')).join(' / '));
    console.log([c.id, ...(args.showAddresses ? [c.address] : []), 'shrubDensity', c.known.shrubDensity ?? '—', ...dens].join(' | '));
  }
  console.log('');
  console.log('Reading it: the model to run is the one with the lower MAPE and a bias near zero on bedAreaSf and ornamentalTrees — those two drive the T&S price. A flip is MODEL_GEMINI_VISION on Railway and moves every image lane (owner ruling 2026-09-06), so weigh the photo lanes too before flipping.');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // NO DB WRITES. server/config (dotenv) loads first so a deleted gate cannot
  // be refilled afterwards; then the ledger gates are cleared and verified.
  require(path.join(REPO, 'server/config'));
  for (const gate of LEDGER_GATES) delete process.env[gate];
  const gates = require(path.join(REPO, 'server/config/feature-gates'));
  assertNoLedgerWrites(gates, 'before imports');

  const mapsKey = process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_API_KEY;
  if (!mapsKey) { console.error('GOOGLE_MAPS_API_KEY (or GOOGLE_API_KEY) is required for geocoding + tiles — run via: railway run --service waves-customer-portal node ops/agents/satellite-vision-model-bakeoff.js …'); process.exit(2); }
  if (!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY)) { console.error('GEMINI_API_KEY (or GOOGLE_API_KEY) is required'); process.exit(2); }

  // No pinned defaults: a model id baked in here outlives a provider rename
  // or a registry swap and the script would silently benchmark a stale id
  // (Codex #6398 r7). The operator names the candidates; the live lookup
  // model is GEMINI_VISION_BEST in server/config/models.js.
  if (!Array.isArray(args.models) || args.models.length < 2) {
    const MODELS = require(path.join(REPO, 'server/config/models'));
    console.error(`--models needs at least two model ids, e.g. --models ${MODELS.GEMINI_VISION_BEST},gemini-4-argon (the first is the live lookup model, GEMINI_VISION_BEST)`);
    process.exit(2);
  }
  const models = args.models;
  // Requiring the route module loads the app graph; it is the only home of
  // the production prompt + scale context, and we never call its router.
  const lookup = require(path.join(REPO, 'server/routes/property-lookup-v2'))._private;
  const dispatch = require(path.join(REPO, 'server/services/llm/call'));
  assertNoLedgerWrites(gates, 'after imports');
  for (const fn of ['geocodeAddress', 'buildVisionContext', 'buildSatelliteVisionPrompt', 'normalizeSatelliteAnalysis', 'isValidSatelliteVisionAnalysis']) {
    if (typeof lookup[fn] !== 'function') { console.error(`property-lookup-v2._private.${fn} is not exported — the script needs updating`); process.exit(2); }
  }

  const rows = loadFixture(args.fixture, args);
  console.error(`bake-off: ${rows.length} properties × ${models.join(', ')} × ${args.repeat} repeat(s), concurrency ${args.concurrency}`);
  const cases = await mapLimit(rows, args.concurrency, (row) => runCase({ row, models, repeat: args.repeat, lookup, dispatch, mapsKey }));
  const scores = score(cases, models);
  if (args.json) {
    const redacted = args.showAddresses ? cases : cases.map(({ address, ...rest }) => rest);
    console.log(JSON.stringify({ models, repeat: args.repeat, scores, cases: redacted }, null, 2));
    return;
  }
  printReport(cases, models, scores, args);
}

module.exports = { score, numericRead, FIELDS };

if (require.main === module) {
  main().catch((err) => { console.error(err.stack || err.message || err); process.exit(1); });
}
