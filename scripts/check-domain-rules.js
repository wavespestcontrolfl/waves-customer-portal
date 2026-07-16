#!/usr/bin/env node
/**
 * Domain-rules gate.
 *
 * Mechanical enforcement for the CLAUDE.md hard rules that used to be
 * prose-only. Each rule here has burned us (or will) as a silent drift:
 *
 *   1. anthropic-model-ids — "Never hardcode model IDs." Anthropic model
 *      literals (claude-*) may only appear in server/config/models.js and
 *      server/services/llm/deep.js. Everything else imports a tier
 *      (DEEP / FLAGSHIP / WORKHORSE / FAST / VOICE / VISION), so a model
 *      swap stays an env-var flip, never a code hunt. (Cross-provider
 *      OpenAI/Gemini defaults are intentionally NOT gated here: per-service
 *      models are a documented exception — see call-recording-processor.)
 *
 *   2. deep-via-helper — "Every DEEP call site MUST go through
 *      server/services/llm/deep.js (createDeepMessage)." fable-5 emits
 *      thinking blocks ahead of the text block and can refuse benign
 *      pesticide-adjacent content; the helper strips/retries in one place.
 *      Any file referencing MODELS.DEEP without the helper is a latent
 *      content[0].text parsing bug.
 *
 *   3. square-processor — "Stripe is the payment processor. Square is
 *      fully phased out." Payment-processor patterns only — this codebase
 *      says "square feet" constantly, so the bare word is NOT flagged.
 *      Legacy import migrations/scripts are outside the scan scope.
 *
 *   4. banned-vendors — "All automation and site infra is native." No
 *      Zapier / Make (make.com, Integromat, MAKE_* env keys — the bare word
 *      "Make" is English and can't be flagged) / Elementor / NitroPack /
 *      RankMath in portal code.
 *
 * Scope: the whole production server tree (server/) + client/src.
 * Tests, mocks, fixtures, migrations, seeds, contract-tests, one-off
 * scripts, and ops tooling are NOT scanned — they legitimately pin model
 * IDs in assertions and reference Square-era import history.
 *
 * Run: `node scripts/check-domain-rules.js` or `npm run check:domain-rules`.
 * Exit code 0 = clean, 1 = violations found.
 * Runs in Railway `prebuild` and the CI gates job.
 */

const fs = require('fs');
const path = require('path');

// =========================================================================
// What to scan
// =========================================================================
const ROOT = path.join(__dirname, '..');
const SCAN_DIRS = [
  path.join(ROOT, 'server'),
  path.join(ROOT, 'client/src'),
];
const SCAN_FILES = [];
const EXTENSIONS = new Set(['.js', '.jsx']);
const EXCLUDE_PATTERNS = [
  /\.test\.jsx?$/,
  /__mocks__/,
  /node_modules/,
  // Non-runtime server subtrees: assertions pin model IDs, migrations and
  // import scripts carry Square-era history.
  /server\/tests\//,
  /server\/scripts\//,
  /server\/contract-tests\//,
  /server\/fixtures\//,
  /server\/models\/migrations\//,
  /server\/models\/seeds\//,
];

const rel = (f) => path.relative(ROOT, f);

// =========================================================================
// Rules
// =========================================================================
// Each rule: { id, message, allowlist: Set<relative path>, check(file, src) -> [{line, excerpt}] }

// Model-ID shapes only ("claude-" + family or version), so prose like
// "Claude-powered" or the claude-api skill name never false-positives.
const ANTHROPIC_MODEL_ID = /claude-(fable|mythos|opus|sonnet|haiku|instant|[0-9])[\w.-]*/gi;
// All the ways the DEEP tier gets imported — MODELS.DEEP, a direct
// require('...config/models').DEEP, or destructuring { DEEP } from the
// registry (agronomic-wiki.js uses the direct-require form).
const DEEP_TIER_REFS = [
  /MODELS\.DEEP\b/,
  /models(?:\.js)?['"`]\s*\)\s*\.DEEP\b/,
  /\{[^}]*\bDEEP\b[^}]*\}\s*=\s*require\(\s*['"][^'"]*models/,
];
const DEEP_HELPER_REF = /createDeepMessage|llm\/deep/;
const SQUARE_PATTERNS = [
  /squareup/gi,
  /square_(customer|payment|invoice|order|location|token|txn|checkout)/gi,
  /SQUARE_[A-Z][A-Z_]+/g,
  /\bSquare (API|SDK|webhook|checkout|terminal|POS|payment)/gi,
  // SDK usage: require('square') / import ... from 'square' / SquareClient.
  /require\(\s*['"]square['"]\s*\)/gi,
  /from\s+['"]square['"]/gi,
  /\bSquareClient\b/g,
];
// Bare "Make" (the vendor) is not greppable — it's an English word — so the
// vendor is caught via its domain, its old name, and its env-key shapes.
const BANNED_VENDOR_NAMES = /\b(zapier|elementor|nitropack|rankmath|integromat|make\.com)\b/gi;
const BANNED_VENDOR_ENV_KEYS = /\bMAKE_(?:WEBHOOK|API|SCENARIO)[A-Z_]*\b/g;

function matchLines(src, regex) {
  const hits = [];
  const lines = src.split('\n');
  lines.forEach((text, i) => {
    regex.lastIndex = 0;
    const m = regex.exec(text);
    if (m) hits.push({ line: i + 1, excerpt: text.trim().slice(0, 120) });
  });
  return hits;
}

const RULES = [
  {
    id: 'anthropic-model-ids',
    message:
      'Hardcoded Anthropic model ID. Import a tier (DEEP/FLAGSHIP/WORKHORSE/FAST/VOICE/VISION) from server/config/models.js instead.',
    allowlist: new Set(['server/config/models.js', 'server/services/llm/deep.js']),
    check(file, src) {
      return matchLines(src, ANTHROPIC_MODEL_ID);
    },
  },
  {
    id: 'deep-via-helper',
    message:
      'File references MODELS.DEEP but not createDeepMessage / llm/deep. Every DEEP call site must go through server/services/llm/deep.js (thinking-block stripping + refusal fallback).',
    allowlist: new Set(['server/config/models.js', 'server/services/llm/deep.js']),
    check(file, src) {
      if (!DEEP_TIER_REFS.some((p) => p.test(src))) return [];
      if (DEEP_HELPER_REF.test(src)) return [];
      return DEEP_TIER_REFS.flatMap((p) => matchLines(src, new RegExp(p.source, 'g')));
    },
  },
  {
    id: 'square-processor',
    message:
      'Square payment-processor reference. Stripe is the only payment processor — Square is fully phased out (CLAUDE.md rule 8).',
    allowlist: new Set(),
    check(file, src) {
      return SQUARE_PATTERNS.flatMap((p) => matchLines(src, p));
    },
  },
  {
    id: 'banned-vendors',
    message:
      'Banned external automation/CMS vendor. All automation and site infra is native (CLAUDE.md rule 9).',
    allowlist: new Set(),
    check(file, src) {
      return [...matchLines(src, BANNED_VENDOR_NAMES), ...matchLines(src, BANNED_VENDOR_ENV_KEYS)];
    },
  },
];

// =========================================================================
// Walk + report
// =========================================================================
function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (EXCLUDE_PATTERNS.some((p) => p.test(full))) continue;
    if (e.isDirectory()) walk(full, out);
    else if (EXTENSIONS.has(path.extname(e.name))) out.push(full);
  }
  return out;
}

const files = SCAN_DIRS.reduce((acc, d) => walk(d, acc), []).concat(
  SCAN_FILES.filter((f) => fs.existsSync(f)),
);

let violations = 0;
for (const file of files) {
  const relPath = rel(file);
  const src = fs.readFileSync(file, 'utf8');
  for (const rule of RULES) {
    if (rule.allowlist.has(relPath)) continue;
    for (const hit of rule.check(file, src)) {
      violations += 1;
      console.error(`${relPath}:${hit.line}  [${rule.id}]`);
      console.error(`    ${hit.excerpt}`);
      console.error(`    ${rule.message}\n`);
    }
  }
}

if (violations) {
  console.error(`check:domain-rules — ${violations} violation(s) in ${files.length} scanned files.`);
  process.exit(1);
}
console.log(`check:domain-rules — clean (${files.length} files scanned).`);
