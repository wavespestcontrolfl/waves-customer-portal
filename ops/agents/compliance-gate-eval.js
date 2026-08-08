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
 *   node ops/agents/compliance-gate-eval.js                 # 40-case sample
 *   node ops/agents/compliance-gate-eval.js --all           # full corpus
 *   node ops/agents/compliance-gate-eval.js --limit 80 --concurrency 6
 *   node ops/agents/compliance-gate-eval.js --code BANNED_TOPIC
 */

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const TEST_FILE = path.join(REPO, 'server/tests/content-guardrails.test.js');
const CODES = ['REENTRY_SAFETY_CLAIM', 'BANNED_TOPIC'];

// The gate ignores bodies under 50 chars (a publish-time guard against empty
// drafts). Corpus sentences are often shorter, so each is padded with neutral,
// compliant filler. The filler states no safety claim and offers no service, so
// it cannot flip a verdict in either direction.
const FILLER = ' Waves Pest Control serves Manatee, Sarasota, and Charlotte counties in Southwest Florida.';

function parseArgs(argv) {
  const args = { limit: 40, concurrency: 4, all: false, code: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--all') args.all = true;
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
function extractCorpus(src) {
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
      if (multilineBody && literals.length > 0 && j > i) { closed = true; break; }
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

    for (const text of literals) cases.push({ text, code, shouldBlock });
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
  const selected = [...motivating, ...(args.all ? corpus : sample(corpus, args.limit))];

  console.log(`corpus: ${allCases.length} labelled cases parsed from ${path.relative(REPO, TEST_FILE)}`);
  console.log(`        + ${motivating.length} motivating cases (r21/r22/r23 + approved idiom), always run`);
  if (otherCode) console.log(`        ${otherCode} block(s) assert other guardrail codes — out of scope, not counted`);
  if (unparsed) console.log(`        ${unparsed} block(s) could not be parsed and are NOT counted — coverage is under-reported, never over-reported`);
  if (args.code) console.log(`filter: ${args.code} → ${corpus.length}`);
  console.log(`running: ${selected.length} case(s) at concurrency ${args.concurrency}${args.all ? '' : ` (sample; --all for every case)`}`);
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

  const results = await runPool(selected, args.concurrency, async (c) => {
    const body = c.text.length >= 50 ? c.text : c.text + FILLER;
    let semanticBlocked = null;
    let codeMatched = null;
    let checked = false;
    try {
      const r = await complianceGate.evaluate({ body });
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
    const regexBlocked = guardrails.evaluate({ body }, {}).findings.some((f) => f.code === c.code);
    return { ...c, semanticBlocked, codeMatched, regexBlocked, checked };
  });

  const usable = results.filter((r) => r.semanticBlocked !== null && r.checked);
  const failOpen = results.length - usable.length;

  const shouldBlock = usable.filter((r) => r.shouldBlock);
  const shouldPass = usable.filter((r) => !r.shouldBlock);
  const caught = shouldBlock.filter((r) => r.semanticBlocked).length;
  const falsePos = shouldPass.filter((r) => r.semanticBlocked).length;

  const pct = (n, d) => (d === 0 ? 'n/a' : `${((n / d) * 100).toFixed(1)}%`);

  console.log('\n─── semantic gate (blocking verdict, as production computes it) ───');
  console.log(`recall    ${caught}/${shouldBlock.length}  (${pct(caught, shouldBlock.length)}) — violations caught`);
  console.log(`precision ${shouldPass.length - falsePos}/${shouldPass.length}  (${pct(shouldPass.length - falsePos, shouldPass.length)}) — compliant copy left alone`);
  if (failOpen) console.log(`fail-open ${failOpen} case(s) returned unchecked (model unavailable) and are excluded`);

  // Reported separately because it does not affect whether content publishes —
  // a blocked draft is blocked either way — but a systematically swapped code
  // sends the wrong retry directive to the writer on redraft.
  const blockedCorrectly = shouldBlock.filter((r) => r.semanticBlocked);
  const rightCode = blockedCorrectly.filter((r) => r.codeMatched).length;
  console.log(`code accuracy ${rightCode}/${blockedCorrectly.length} (${pct(rightCode, blockedCorrectly.length)}) — of the violations it caught, how many it labelled with the expected code`);

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
}

// Only run when invoked directly — requiring this file (tests, tooling) must
// never fire live LLM calls as an import side effect.
if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { extractCorpus, sample, MOTIVATING_CASES };
