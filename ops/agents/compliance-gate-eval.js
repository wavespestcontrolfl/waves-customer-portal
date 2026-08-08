#!/usr/bin/env node
/**
 * compliance-gate-eval.js — READ-ONLY
 *
 * Calibration harness for the semantic compliance gate
 * (server/services/content/compliance-gate.js).
 *
 * WHERE THE LABELS COME FROM. server/tests/content-guardrails.test.js is the
 * accumulated output of 23 adversarial Codex review rounds: several hundred
 * sentences, each asserted to either trip or not trip REENTRY_SAFETY_CLAIM /
 * BANNED_TOPIC. Every one was reproduced against the real rule before it was
 * written down, so the file is a labelled corpus, not a guess.
 *
 * The labels are read from the TEST ASSERTIONS, never from running the regex
 * gate. Deriving them from the regex would be circular — it would label the
 * exact cases the regex misses (the r23 clause-attachment family) as
 * "compliant", which is precisely what this harness exists to measure.
 *
 * MAKES LIVE LLM CALLS. Never runs in CI; invoke it deliberately. Reads only
 * fixture strings — no database, no customer records, no writes anywhere.
 *
 * Usage (from repo root):
 *   node ops/agents/compliance-gate-eval.js --document --all   # ACTIVATION RUN
 *   node ops/agents/compliance-gate-eval.js                    # 40-case sample
 *   node ops/agents/compliance-gate-eval.js --all              # full corpus
 *   node ops/agents/compliance-gate-eval.js --limit 80 --concurrency 6
 *   node ops/agents/compliance-gate-eval.js --code BANNED_TOPIC
 *
 * --document IS REQUIRED FOR AN ACTIVATION DECISION. Without it each call
 * carries one isolated sentence, which measures discrimination but not
 * long-document recall, and not whether a banned topic reads as offered-by-
 * Waves vs merely discussed — context production always supplies. The other
 * modes are for iterating on the prompt, not for deciding to flip the flag.
 */

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const TEST_FILE = path.join(REPO, 'server/tests/content-guardrails.test.js');
const CODES = ['REENTRY_SAFETY_CLAIM', 'BANNED_TOPIC'];

// No padding. The gate's floor is 12 chars and the extractor already discards
// literals shorter than that, so every case reaches the gate exactly as
// production would hand it over. An earlier version padded short fixtures to
// clear a 50-char floor, which meant calibration measured slightly different
// input than production sees — a small divergence, but the wrong kind in the
// one instrument that decides whether to enable a blocking gate.

// SENTENCE MODE MEASURES DISCRIMINATION, NOT PRODUCTION PERFORMANCE.
// Each corpus case is one isolated sentence, but production hands the gate a
// title, a full article-sized body, and every editable meta field in one call
// (Codex PR #3295 r4). Two things sentence mode cannot see:
//   - long-document recall: whether one violating clause is still found in
//     ~1500 words of compliant copy;
//   - context-dependent attribution: whether a banned topic is being OFFERED
//     by Waves or merely discussed, which is decided by surrounding text the
//     isolated sentence does not carry.
// --document embeds each fixture in a representative article shell so the call
// shape matches production. The shell is deliberately compliant and neutral;
// it changes the DOCUMENT, never the labelled sentence, and its own copy is
// asserted clean in sentence mode first (see SHELL_SELF_CHECK).
// SIZED TO PRODUCTION. content-brief-builder's WORD_COUNT_TARGET is 900–1500
// words for city-service and supporting-blog drafts (the two highest-volume
// autonomous actions), so a 150-word shell would still not exercise
// long-document recall — the thing document mode exists to measure. The shell
// below is ~900 words of compliant SWFL pest-control prose. Deliberately free
// of safety claims, EPA wording, fixed re-entry/drying figures, and every
// banned topic, and the whole thing is asserted clean before any run.
const DOC_SHELL_BEFORE = [
  'Southwest Florida homeowners in Manatee, Sarasota, and Charlotte counties deal with pest pressure year round. Warm winters and heavy summer rain keep populations active through months when much of the country gets a genuine break, and that changes what a sensible service schedule looks like. A plan built for a climate with hard freezes does not transfer here. The pests never fully stop, so the work is about steady suppression and catching conditions early rather than a single seasonal push.',
  'The questions we hear most often concern timing and expectations: when a visit happens, what the technician actually checks, how the interval shifts between the wet and dry seasons, and what a homeowner should watch for between visits. None of those have a single universal answer, because the right cadence depends on the structure, the landscaping around it, and what the last few inspections turned up.',
  'A visit starts with an inspection rather than an application. The technician walks the perimeter looking at entry points, weep holes, utility penetrations, door sweeps, and window seals. Inside, the focus is on the rooms where activity tends to show first: kitchens, bathrooms, laundry areas, and anywhere plumbing passes through a wall. Attics and crawl spaces get attention when the structure has them and access is reasonable.',
  'Conducive conditions matter as much as the pests themselves. Standing water in a bromeliad or a clogged gutter supports mosquito breeding far more reliably than anything drifting in from a neighbouring lot. Wood-to-soil contact gives subterranean termites a path that skips every barrier. Mulch piled against a foundation holds moisture where it does the most harm. Dense shrubs touching a wall act as a bridge over whatever is applied at ground level. Correcting those is often more durable than any product decision.',
  'Findings are documented so the next visit builds on the last one instead of starting over. That record is what turns a series of appointments into an actual program: a technician arriving in September can see what was noted in June, whether the recommended trimming happened, and whether the ant pressure on the west side responded or moved.',
  'Ants are the most common call in this region by a wide margin, and the species matters. Ghost ants trail along countertops and behave differently from the big-headed ants that push soil up through pavers, which behave differently again from carpenter ants working in damp wood. Treating all of them the same way produces inconsistent results, which is why identification comes before anything else.',
  'German cockroaches are an indoor population problem rather than an outdoor intrusion, and they respond to sanitation and harbourage changes as much as to any treatment. The larger roaches most homeowners see on a lanai are usually outdoor species that wandered in, and those call for a different response entirely.',
  'Mosquito pressure in Southwest Florida is driven overwhelmingly by container breeding on the property itself. Saucers under potted plants, tarps holding rainwater, boat covers, bird baths, and untreated bromeliads produce far more mosquitoes than the marsh half a mile away. Source reduction does more than anything else, and a walkthrough identifying those containers is usually the most productive part of a mosquito visit.',
  'Lawns here run on warm-season grasses — St. Augustine, Bahia, Zoysia, and Bermuda — and each has its own tolerances for shade, traffic, and mowing height. Most of the problems that get reported as insect damage turn out to be irrigation, disease, or a mower set too low. Chinch bug damage in St. Augustine looks a great deal like drought stress, and the two are commonly confused, so the diagnosis matters before anything else happens.',
  'County fertilizer ordinances in this part of the state restrict nitrogen application during the summer rainy season, which shapes what a lawn program can do and when. That is a regulatory constraint, not a preference, and any provider working here should be able to explain how their schedule accounts for it.',
];
const DOC_SHELL_AFTER = [
  'Seasonal timing matters more here than in most of the country. Subtropical humidity keeps activity high, so the interval between visits is set by observed pest pressure rather than by the calendar. A property backing onto a preserve behaves differently from one in the middle of a built-out subdivision, and the schedule should reflect that difference rather than a default.',
  'The rainy season changes the picture again. Heavy afternoon storms wash surfaces, flush harbourage, and refill every container on the property within an hour. That is why the wet months usually need a tighter interval than the dry ones, and why a plan that looked right in February may need revisiting in July.',
  'Between visits, the most useful thing a homeowner can do is watch and report. Sightings noted with a location and a rough time of day are far more actionable than a general impression that activity has increased. If something changes — a new trail, a swarm, damage that was not there last month — that information shapes the next visit more than any assumption made in advance.',
  'Structural maintenance quietly does a lot of the work. Door sweeps that actually contact the threshold, screens without tears, gutters that drain, and shrubs trimmed back from the wall all reduce pressure without anything being applied. Those are the recommendations most likely to still be paying off a year later.',
  'If you have questions about your service plan, or want to review what the last visit covered and why a particular recommendation was made, your technician can walk through the notes with you. The record exists to be used, and understanding why something was recommended tends to make it far likelier to get done.',
];
// Production sends a title and editable meta alongside the body; document mode
// must too, or it still measures a different payload than the publisher builds.
const DOC_SHELL_TITLE = 'Pest Control in Sarasota, FL: What to Expect Through the Year';
const DOC_SHELL_META = 'How pest pressure shifts across Southwest Florida seasons, what a technician checks on each visit, and which property conditions matter most in Manatee, Sarasota, and Charlotte counties.';
// The shell must never itself trip a code, or every document-mode case would
// be contaminated. Verified in sentence mode before any document run.
const SHELL_SELF_CHECK = [DOC_SHELL_TITLE, ...DOC_SHELL_BEFORE, ...DOC_SHELL_AFTER, DOC_SHELL_META].join('\n\n');

// Mirrors assertComplianceClear: body plus the editable meta, joined as blocks,
// with the title passed as its own field. Same construction the publisher uses,
// so document mode exercises the payload production actually builds.
//
// The fixture ROTATES through the three customer-visible positions (Codex PR
// #3295 r6). Pinning it mid-body left title and trailing meta as fixed
// compliant constants, so the run could not establish recall for a violation in
// either — and a meta-description violation is the case that motivated the
// whole publishable-surface fix in r1. Rotation is by index so coverage spreads
// across the corpus without tripling the call count, and per-position metrics
// are reported so a position-specific weakness is visible rather than averaged
// away.
const DOC_POSITIONS = ['body', 'title', 'meta'];

function buildDocument(text, position) {
  const shellBody = [...DOC_SHELL_BEFORE, ...DOC_SHELL_AFTER];
  if (position === 'title') {
    return {
      title: text,
      body: `${shellBody.join('\n\n')}\n\n${DOC_SHELL_META}`,
      city: 'Sarasota',
      keyword: 'pest control sarasota fl',
      tag: 'Pest Control',
    };
  }
  if (position === 'meta') {
    return {
      title: DOC_SHELL_TITLE,
      body: `${shellBody.join('\n\n')}\n\n${text}`,
      city: 'Sarasota',
      keyword: 'pest control sarasota fl',
      tag: 'Pest Control',
    };
  }
  return {
    title: DOC_SHELL_TITLE,
    body: `${[...DOC_SHELL_BEFORE, text, ...DOC_SHELL_AFTER].join('\n\n')}\n\n${DOC_SHELL_META}`,
    city: 'Sarasota',
    keyword: 'pest control sarasota fl',
    tag: 'Pest Control',
  };
}

function shellWordCount() {
  return SHELL_SELF_CHECK.split(/\s+/).filter(Boolean).length;
}

function parseArgs(argv) {
  const args = {
    limit: 40, concurrency: 4, all: false, code: null, document: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--all') args.all = true;
    else if (a === '--document') args.document = true;
    else if (a === '--limit') args.limit = Number.parseInt(argv[++i], 10);
    else if (a === '--concurrency') args.concurrency = Number.parseInt(argv[++i], 10);
    else if (a === '--code') args.code = argv[++i];
  }
  return args;
}

/**
 * Walk the test file and pull out (sentence, code, shouldBlock) triples.
 *
 * Two shapes carry essentially all of the corpus:
 *   for (const body of [ 'a', 'b' ]) { ... expect(...'CODE'...).toBe(true|false)
 *   guardrails.evaluate({ body: 'a' }, ...) ... expect(...'CODE'...).toBe(true|false)
 * Anything else is counted as unparsed and REPORTED — a silently dropped case
 * would make coverage look better than it is.
 */
// Prose inside JS comments is NOT a fixture (Codex PR #3295 r3). The literal
// scan below collects every quoted string in a block, and this file's comments
// quote example phrases when explaining a rule — so `"safe UNTIL dry"` from a
// comment was entering the corpus as a labelled blocking case. Calibration
// would then spend a live call on text production never receives and fold its
// verdict into recall and precision.
// Truncates at a `//` that is OUTSIDE a string, and drops /* */ regions, so a
// URL ("https://…") or an apostrophe inside a fixture is untouched.
function stripJsComments(src) {
  const out = [];
  let inBlock = false;
  for (const raw of src.split('\n')) {
    let line = '';
    let quote = null;
    for (let i = 0; i < raw.length; i += 1) {
      const ch = raw[i];
      if (inBlock) {
        if (ch === '*' && raw[i + 1] === '/') { inBlock = false; i += 1; }
        continue;
      }
      if (quote) {
        line += ch;
        if (ch === '\\') { line += raw[i + 1] ?? ''; i += 1; continue; }
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') { quote = ch; line += ch; continue; }
      if (ch === '/' && raw[i + 1] === '/') break;
      if (ch === '/' && raw[i + 1] === '*') { inBlock = true; i += 1; continue; }
      line += ch;
    }
    out.push(line);
  }
  return out.join('\n');
}

function extractCorpus(rawSrc) {
  const src = stripJsComments(rawSrc);
  const lines = src.split('\n');
  const cases = [];
  let unparsed = 0;
  let otherCode = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const arrayStart = /for\s*\(const\s+body\s+of\s*\[/.test(line);
    // `body:` may sit on the SAME line as evaluate({ or on a following one —
    // multiline fixtures are a common shape in this file and were silently
    // skipped entirely, not even counted as unparsed, which biased the corpus
    // toward one-liners (Codex PR #3295 r1).
    const inlineBody = /evaluate\(\s*\{\s*body:\s*(['"`])/.test(line);
    const multilineBody = /evaluate\(\s*\{\s*$/.test(line)
      && /^\s*body:\s*(['"`])/.test(lines[i + 1] || '');
    if (!arrayStart && !inlineBody && !multilineBody) continue;

    // Collect literals until the block closes, then find the assertion that
    // governs them (the first code+boolean expectation after the block).
    const literals = [];
    let j = i;
    let depth = 0;
    let closed = false;
    for (; j < lines.length && j < i + 120; j += 1) {
      for (const ch of lines[j]) {
        if (ch === '[') depth += 1;
        else if (ch === ']') depth -= 1;
      }
      for (const m of lines[j].matchAll(/(['"])((?:\\.|(?!\1)[^\\])*)\1/g)) {
        const raw = m[2];
        // Skip code names, field names, and other non-prose tokens.
        if (CODES.includes(raw)) continue;
        if (raw.length < 12) continue;
        if (!/\s/.test(raw)) continue;
        literals.push(raw.replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
      }
      if (arrayStart && depth <= 0 && j > i) { closed = true; break; }
      if (inlineBody) { closed = true; break; }
      // A multiline draft object must be read to its CLOSING brace, not to its
      // first string (Codex PR #3295 r2). Stopping at the body captured the
      // compliant body of a meta-only fixture and labelled it shouldBlock:true
      // — a WRONG label, which is worse than a missing case: the gate would
      // correctly pass it and be scored as a recall hole. The publishable
      // fields are joined into one case below, mirroring what the gate is
      // actually handed at publish time.
      if (multilineBody && /^\s*\}(?:,|\s*\))/.test(lines[j]) && j > i) { closed = true; break; }
    }
    if (!closed || literals.length === 0) { unparsed += 1; continue; }

    let code = null;
    let sawAnyCode = false;
    let shouldBlock = null;
    for (let k = j; k < Math.min(j + 12, lines.length); k += 1) {
      const cm = lines[k].match(/code === '([A-Z_]+)'/);
      if (cm) {
        sawAnyCode = true;
        if (CODES.includes(cm[1]) && code === null) code = cm[1];
      }
      const bm = lines[k].match(/\.toBe\((true|false)\)/);
      if (code && bm) { shouldBlock = bm[1] === 'true'; break; }
    }
    if (!code || shouldBlock === null) {
      // A block asserting some OTHER guardrail code (price, brand token, …) is
      // simply out of scope, not a parse failure — counting it as unparsed
      // would overstate how much of the corpus we are missing.
      if (sawAnyCode) otherCode += 1; else unparsed += 1;
      continue;
    }

    if (multilineBody) {
      // ONE case per draft object: body + frontmatter meta are a single
      // publishable surface, and the assertion's verdict is about the surface
      // as a whole. Splitting them would attach a "blocks" label to whichever
      // half happens to be compliant.
      cases.push({ text: literals.join('\n\n'), code, shouldBlock });
    } else {
      for (const text of literals) cases.push({ text, code, shouldBlock });
    }
    i = j;
  }
  return { cases, unparsed, otherCode };
}

// The three rule defects that motivated this gate are NOT all in the test file
// — r23 was never fixed in regex, so no test asserts it. They are the reason
// the layer exists, so they are always evaluated regardless of --limit.
const MOTIVATING_CASES = [
  { text: 'The treatment is safe for pets and works after it dries. Your technician confirms the timing.', code: 'REENTRY_SAFETY_CLAIM', shouldBlock: true, tag: 'r23 clause-attachment' },
  { text: 'The treatment is safe until dry. Your technician confirms the timing.', code: 'REENTRY_SAFETY_CLAIM', shouldBlock: true, tag: 'r21 inverse polarity' },
  { text: 'The treatment is safe while wet and once dry. Your technician confirms the timing.', code: 'REENTRY_SAFETY_CLAIM', shouldBlock: true, tag: 'r22 wet conjunct' },
  { text: 'The treatment is safe once dry. Your technician confirms the timing.', code: 'REENTRY_SAFETY_CLAIM', shouldBlock: false, tag: 'approved idiom' },
  { text: 'The area is safe after it dries. Your technician confirms re-entry timing.', code: 'REENTRY_SAFETY_CLAIM', shouldBlock: false, tag: 'approved idiom (after)' },
];

function sample(cases, limit) {
  if (cases.length <= limit) return cases;
  const stride = cases.length / limit;
  const out = [];
  for (let i = 0; i < limit; i += 1) out.push(cases[Math.floor(i * stride)]);
  return out;
}

async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.max(1, concurrency) }, async () => {
    for (;;) {
      const idx = next++;
      if (idx >= items.length) return;
      results[idx] = await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const src = fs.readFileSync(TEST_FILE, 'utf8');
  const { cases: allCases, unparsed, otherCode } = extractCorpus(src);

  let corpus = allCases;
  if (args.code) corpus = corpus.filter((c) => c.code === args.code);
  // Motivating cases always run — they are the point of the exercise.
  const motivating = args.code ? MOTIVATING_CASES.filter((c) => c.code === args.code) : MOTIVATING_CASES;
  // Deduplicate by (text, code, verdict) — the motivating set overlaps the
  // extracted corpus, and the corpus itself restates several regression
  // fixtures across tests (Codex PR #3295 r4). Without this, a phrase is scored
  // two or three times and carries weight proportional to how often the test
  // file happens to repeat it, which is not a property of the phrase. Also
  // wasted live calls. Motivating cases come first so they survive the dedupe.
  const seen = new Set();
  const dedupe = (list) => list.filter((c) => {
    const key = `${c.code}|${c.shouldBlock}|${c.text.trim()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const selectedRaw = [...motivating, ...(args.all ? corpus : sample(corpus, args.limit))];
  const selected = dedupe(selectedRaw);
  const duplicates = selectedRaw.length - selected.length;

  console.log(`corpus: ${allCases.length} labelled cases parsed from ${path.relative(REPO, TEST_FILE)}`);
  console.log(`        + ${motivating.length} motivating cases (r21/r22/r23 + approved idiom), always run`);
  if (otherCode) console.log(`        ${otherCode} block(s) assert other guardrail codes — out of scope, not counted`);
  if (unparsed) console.log(`        ${unparsed} block(s) could not be parsed and are NOT counted — coverage is under-reported, never over-reported`);
  if (args.code) console.log(`filter: ${args.code} → ${corpus.length}`);
  if (duplicates) console.log(`        ${duplicates} duplicate case(s) collapsed — a phrase is scored once, not once per test that restates it`);
  console.log(`running: ${selected.length} case(s) at concurrency ${args.concurrency}${args.all ? '' : ` (sample; --all for every case)`}${args.document ? ' — DOCUMENT mode' : ''}`);
  console.log(`each case is one live LLM call — expect roughly ${Math.ceil(selected.length / args.concurrency)} sequential round-trips\n`);

  // ARM THE GATE FOR THIS PROCESS. It ships dark (off unless GATE_COMPLIANCE
  // is exactly 'true'), and calibration is what earns the right to turn it on —
  // so without this the documented command would make zero live calls, count
  // every case as fail-open, and print n/a. Set before the module is required,
  // since evaluate() reads the flag at call time but the module also snapshots
  // env-derived config at load (Codex PR #3295 r1).
  process.env.GATE_COMPLIANCE = 'true';

  const complianceGate = require(path.join(REPO, 'server/services/content/compliance-gate'));
  const guardrails = require(path.join(REPO, 'server/services/content/content-guardrails'));

  // Guard the instrument before trusting it: if the shell itself trips a code,
  // every document-mode verdict is contaminated and the run means nothing.
  if (args.document) {
    const shellCheck = await complianceGate.evaluate({ body: SHELL_SELF_CHECK });
    const shellFindings = (shellCheck.findings || []).filter((f) => f.severity === 'P0');
    if (shellFindings.length) {
      console.error('ABORT: the document shell itself trips a P0 — every document-mode result would be contaminated.');
      for (const f of shellFindings) console.error(`  ${f.code} ${f.message}`);
      process.exit(1);
    }
    // An UNCHECKED self-check is not a passed self-check (Codex PR #3295 r6).
    // The gate fails open, so a timed-out shell request returns no findings —
    // indistinguishable from a clean one. If the providers then recover for the
    // corpus calls, the run produces usable-looking numbers having never
    // established that the shared ~978-word shell is neutral, and a shell-level
    // P0 would contaminate every document verdict. Abort, don't warn.
    if (!shellCheck.checked) {
      console.error('ABORT: the document shell self-check returned UNCHECKED (fail-open — providers unavailable).');
      console.error('       An unverified shell cannot be assumed neutral; every document verdict would rest on it.');
      console.error('       Re-run when the providers are reachable.');
      process.exit(1);
    }
    console.log('document shell self-check: clean (checked)');
    console.log(`document payload: ~${shellWordCount()} shell words + the fixture, plus title and meta`);
    console.log('                  (production targets 900-1500 words for city-service / supporting-blog)\n');
  }

  const results = await runPool(selected, args.concurrency, async (c, idx) => {
    const position = args.document ? DOC_POSITIONS[idx % DOC_POSITIONS.length] : null;
    const payload = args.document ? buildDocument(c.text, position) : { body: c.text };
    const { body } = payload;
    let semanticBlocked = null;
    let codeMatched = null;
    let checked = false;
    try {
      const r = await complianceGate.evaluate(payload);
      checked = r.checked;
      // Measure what PRODUCTION does: it blocks on ANY P0, regardless of which
      // of the two codes the model chose. Requiring the code to match the
      // fixture would score a swapped-but-blocking P0 on compliant copy as a
      // pass (inflating precision) and a swapped P0 on violating copy as a hole
      // (understating recall) — neither matches the deployed behavior
      // (Codex PR #3295 r1). Code accuracy is reported separately below.
      semanticBlocked = !r.pass;
      codeMatched = r.findings.some((f) => f.severity === 'P0' && f.code === c.code);
    } catch (err) {
      semanticBlocked = null;
      console.error(`  ! ${err.message}`);
    }
    // The regex verdict is recorded for COMPARISON only — never as the label.
    // It must see the SAME publishable surface production gives it. Document
    // mode puts every third fixture in `payload.title` alone, and
    // content-guardrails scans titles via `frontmatter` (it builds
    // publishableText as body + the editable meta fields) — so passing
    // `{ body }` scored a title such as "We offer wildlife removal" as a regex
    // MISS on a rule the regex does enforce. That understated layered recall
    // and inflated the "caught by NEITHER" count the activation decision reads
    // (Codex PR #3295 r7). The meta block is already inside `body` here —
    // buildDocument appends it the way assertComplianceClear does — so the
    // title is the only field to add; passing meta again would double it.
    const regexDraft = payload.title ? { body, frontmatter: { title: payload.title } } : { body };
    const regexBlocked = guardrails.evaluate(regexDraft, {}).findings.some((f) => f.code === c.code);
    return { ...c, semanticBlocked, codeMatched, regexBlocked, checked, position };
  });

  // A fail-open case is NOT excluded from the metrics (Codex PR #3295 r3).
  // Production treats checked:false as a pass, so an unchecked violation is a
  // real hole — dropping it from the denominator would let selective failures
  // on the hardest inputs RAISE the reported recall. Scored as unblocked, which
  // is exactly what production does with it; the availability count is reported
  // separately so a bad run is still visible as a bad run.
  const usable = results.filter((r) => r.semanticBlocked !== null);
  const failOpen = usable.filter((r) => !r.checked).length;
  const errored = results.length - usable.length;

  const shouldBlock = usable.filter((r) => r.shouldBlock);
  const shouldPass = usable.filter((r) => !r.shouldBlock);
  const caught = shouldBlock.filter((r) => r.semanticBlocked).length;
  const falsePos = shouldPass.filter((r) => r.semanticBlocked).length;

  const pct = (n, d) => (d === 0 ? 'n/a' : `${((n / d) * 100).toFixed(1)}%`);

  console.log('\n─── semantic gate (blocking verdict, as production computes it) ───');
  console.log(`recall      ${caught}/${shouldBlock.length}  (${pct(caught, shouldBlock.length)}) — violations caught`);
  // BLOCK PRECISION is the activation number (Codex PR #3295 r6): of everything
  // the gate blocked, how much deserved it. What this line printed before was
  // SPECIFICITY — compliant cases left alone over all compliant cases — which
  // stays high whenever the corpus has many easy negatives, even while most
  // actual blocks are wrong. With 3 real catches and 2 false blocks, specificity
  // can read ~98% while only 60% of the parks are justified, and parks are the
  // cost the operator actually feels. Both are printed, correctly named.
  const blockedTotal = caught + falsePos;
  console.log(`precision   ${caught}/${blockedTotal}  (${pct(caught, blockedTotal)}) — of everything it BLOCKED, how much deserved it  <- the activation number`);
  console.log(`specificity ${shouldPass.length - falsePos}/${shouldPass.length}  (${pct(shouldPass.length - falsePos, shouldPass.length)}) — compliant copy left alone`);
  if (failOpen) {
    const failOpenViolations = shouldBlock.filter((r) => !r.checked).length;
    console.log(`fail-open ${failOpen} case(s) returned unchecked (model unavailable) — SCORED AS UNBLOCKED, matching production`);
    if (failOpenViolations) console.log(`          ${failOpenViolations} of them were violations, and count against recall above`);
    console.log('          a high count means the run is unreliable, not that the gate is bad — re-run before deciding');
  }
  if (errored) console.log(`errored   ${errored} case(s) threw and could not be scored at all`);

  // Reported separately because it does not affect whether content publishes —
  // a blocked draft is blocked either way — but a systematically swapped code
  // sends the wrong retry directive to the writer on redraft.
  const blockedCorrectly = shouldBlock.filter((r) => r.semanticBlocked);
  const rightCode = blockedCorrectly.filter((r) => r.codeMatched).length;
  console.log(`code accuracy ${rightCode}/${blockedCorrectly.length} (${pct(rightCode, blockedCorrectly.length)}) — of the violations it caught, how many it labelled with the expected code`);

  // Per-position breakdown: an averaged number hides a gate that reads the body
  // well and ignores the title, which is a realistic failure mode for a prompt
  // that describes "content" without naming where it lives.
  if (args.document) {
    console.log('\n─── by fixture position (rotated: body / title / meta) ───');
    for (const pos of DOC_POSITIONS) {
      const at = usable.filter((r) => r.position === pos);
      const atBlock = at.filter((r) => r.shouldBlock);
      const atPass = at.filter((r) => !r.shouldBlock);
      const atCaught = atBlock.filter((r) => r.semanticBlocked).length;
      const atFalse = atPass.filter((r) => r.semanticBlocked).length;
      console.log(`${pos.padEnd(6)} recall ${atCaught}/${atBlock.length} (${pct(atCaught, atBlock.length)})   false blocks ${atFalse}/${atPass.length}`);
    }
  }

  // The decision that matters: does the PAIR regress anywhere the regex alone
  // already succeeded? A semantic miss is acceptable where the regex catches
  // it; a case NEITHER layer catches is a real hole.
  const regexOnly = shouldBlock.filter((r) => r.regexBlocked && !r.semanticBlocked);
  const neither = shouldBlock.filter((r) => !r.regexBlocked && !r.semanticBlocked);
  const semanticOnly = shouldBlock.filter((r) => !r.regexBlocked && r.semanticBlocked);

  console.log('\n─── layered (regex OR semantic) ───');
  console.log(`caught by both/either  ${shouldBlock.length - neither.length}/${shouldBlock.length}`);
  console.log(`semantic ADDS          ${semanticOnly.length} case(s) the regex misses`);
  console.log(`regex still needed for ${regexOnly.length} case(s) the semantic layer misses`);
  console.log(`caught by NEITHER      ${neither.length} case(s)  <- real holes`);

  if (neither.length) {
    console.log('\nholes:');
    for (const r of neither.slice(0, 20)) console.log(`  [${r.code}] ${r.text.slice(0, 110)}`);
    if (neither.length > 20) console.log(`  … and ${neither.length - 20} more`);
  }
  if (falsePos) {
    console.log('\nfalse positives (compliant copy the semantic layer flagged P0):');
    for (const r of shouldPass.filter((x) => x.semanticBlocked).slice(0, 20)) {
      console.log(`  [${r.code}] ${r.text.slice(0, 110)}`);
    }
  }
  console.log('\nGate P0-blocks in production. If precision here is poor, ship advisory-only');
  console.log('(cap findings at P1) and tune the prompt before enabling the block.');
  if (!args.document) {
    console.log('\nNOTE: these are SENTENCE-level numbers. Production sends a title, a full');
    console.log('article-sized body, and all editable meta in ONE call, so this measures');
    console.log('discrimination — not long-document recall, and not whether a banned topic');
    console.log('reads as OFFERED vs merely discussed given surrounding context. Run');
    console.log('--document before using any of this to justify GATE_COMPLIANCE=true.');
  }
}

// Only run when invoked directly — requiring this file (tests, tooling) must
// never fire live LLM calls as an import side effect.
if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { extractCorpus, sample, MOTIVATING_CASES };
