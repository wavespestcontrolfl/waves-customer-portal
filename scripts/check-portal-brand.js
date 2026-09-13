#!/usr/bin/env node
/**
 * Portal brand-consistency gate.
 *
 * Scans customer-facing React files and fails the build if any of the
 * regressions we just spent ~10 PRs cleaning up creep back in:
 *
 *   1. Raw emoji characters          (use <Icon name="..." /> instead)
 *   2. Hardcoded brand font strings  (import FONTS from theme-brand)
 *   3. Local palette declarations    (import COLORS from theme-brand)
 *   4. Font sizes under 14 (literal or FS token) and weights above 700 per the customer glass sheet —
 *      JSX camel-case properties AND kebab-case declarations inside embedded <style> templates
 *
 * Run: `node scripts/check-portal-brand.js` or `npm run check:portal-brand`.
 * Exit code 0 = clean, 1 = violations found.
 */

const fs = require('fs');
const path = require('path');

// =========================================================================
// What to scan
// =========================================================================
const ROOT = path.join(__dirname, '..');
// The policy is repo-wide — "nothing under 14px on a glass surface" (waves-design
// hard lines). The gate used to name seven directories, which meant the rule was
// only enforced where someone had remembered to add a path: SecurePlanChoice
// shipped 13px on /secure and the 09-07 audit's NotificationBell / InstallPrompt
// / NewsletterSignup findings were invisible to CI. Owner ruling C8
// (DECISIONS 2026-09-11) makes the scan repo-wide, so a NEW customer file is
// covered the moment it is written rather than when someone widens this list.
// What is genuinely not a customer surface is excluded below by name, and the
// legacy debt that this widening exposed is enumerated in LEGACY_BASELINE —
// visible and counted, instead of hidden behind a missing directory.
const SCAN_DIRS = [
  path.join(ROOT, 'client/src'),
];
// Files explicitly excluded — dev-only demos, theme tokens themselves, etc.
const EXCLUDED_FILES = new Set([
  'ButtonExamples.jsx',        // palette demo page
  // Print-only work-order document captured to PDF by the headless renderer
  // (?mode=pdf) — never shown on screen. Print typography runs ~8.5-10pt
  // like the industry WO formats it mirrors; the 16px screen floor doesn't
  // apply to paper (owner direction 2026-08-03).
  'ServiceReportDocument.jsx',
  // Same exemption, same rationale: the estimate document is the ?mode=pdf
  // print artifact (GATE_ESTIMATE_DOC_PDF), modeled on the service-report
  // work-order format above — never an on-screen surface.
  'EstimateProposalDocument.jsx',
  'AdminLoginPage.jsx', // admin surface that happens to live in pages/
  'TechCapturePreview.jsx', // tech-portal preview harness in pages/
]);
// theme-brand.js is NOT excluded. It exports customer tokens — BUTTON_BASE is
// spread into portal controls, GOLD_CTA into the estimate slot picker — so a
// wholesale exclusion would hide a weight regression in the shared tokens from
// the very gate that exists to catch it. Only `local-palette` is exempt there,
// because that file IS the palette every other file is told to import; every
// other rule applies, and what it carries today is in LEGACY_BASELINE.
const PALETTE_RULE_EXEMPT = 'client/src/theme-brand.js';
// Filename prefixes that belong to the admin/tech surfaces — separate design
// system (D palette + DM Sans + density-first, per admin brief), NOT subject
// to the customer brand rules this script enforces.
const NON_CUSTOMER_FILENAME_PREFIXES = ['Admin', 'Tech', 'Dispatch', 'Inventory', 'Revenue', 'Compliance', 'Protocol'];
// Any file inside these dirs is out of scope.
const EXCLUDED_DIR_HINTS = [
  '/admin/', '/tech/', '/dispatch/', '/equipment/',
  // Imported only by pages/admin/* — the Dispatch calendar, its mobile sheets
  // and the scheduling modals. Admin design system (D palette + DM Sans +
  // density-first), same as the prefixes above.
  '/schedule/',
  '/dashboard/',
  // Staff document library, mounted on a staff route and authored on D.
  '/staffDocuments/',
  // Developer visual-QA harnesses, never shipped to a customer — the same
  // exemption ButtonExamples.jsx already has by name.
  '/dev-preview/',
];

// =========================================================================
// Legacy baseline — the debt the repo-wide scan exposed (owner ruling C8)
// =========================================================================
// Widening SCAN_DIRS to `client/src` surfaced 76 pre-existing violations in 21
// customer files. Excluding their directories is what hid them in the first
// place, so they are enumerated here instead, with the count each file is
// allowed to carry. The gate fails if a file exceeds its number, so this list
// can only shrink: you may not add a violation to a file that already has
// some, and a file not listed here gets zero tolerance. It also fails on a
// stale entry — clean up a file and the gate tells you to delete its line.
//
// These are NOT exemptions. They are R3 and R4 work in the Liquid Glass audit:
// - estimate/* is the ~35-item legacy cluster the old SCAN_DIRS comment
//   described (13px labels, ★ glyphs, the local W palette in tokens.js);
//   ReportShowcaseCard's 8.5–13px is a scaled-down phone mockup.
// - NotificationBell / NewsletterSignup are the 09-07 audit's own findings,
//   invisible to CI until now. Their weights are cleared; the undersized
//   labels are what is left. InstallPrompt and VanScene were weight-only and
//   are gone from this list entirely.
// - BrandFooter and AppShowcaseCard's 7.5px is App Store / Google Play badge
//   artwork reproduced as inline SVG — fixed proportions, not page type.
// - ServiceRecapModal carries emoji the Icon sweep has not reached. (Icon.jsx
//   itself is no longer listed: its one "violation" was the word-emoji inside
//   the comment describing that sweep, which the comment skip above retires.)
const LEGACY_BASELINE = {
  'client/src/App.jsx': { 'banned-font-size': 2 },
  'client/src/components/ActivityCard.jsx': { 'banned-font-size': 1 },
  'client/src/components/BrandFooter.jsx': { 'banned-font-size': 2 },
  'client/src/components/GlassNewsletterCard.jsx': { 'banned-font-size': 1 },
  'client/src/components/NewsletterSignup.jsx': { 'banned-font-size': 2 },
  'client/src/components/NotificationBell.jsx': { 'banned-font-size': 9 },
  'client/src/components/PestPressureCard.jsx': { 'banned-font-size': 6 },
  'client/src/components/ServiceRecapModal.jsx': { 'emoji': 8 },
  'client/src/components/StationMapCard.jsx': { 'banned-font-size': 3 },
  'client/src/components/estimate/AppShowcaseCard.jsx': { 'banned-font-size': 2 },
  'client/src/components/estimate/CustomerReviews.jsx': { 'emoji': 1 },
  'client/src/components/estimate/GoogleProfilesCard.jsx': { 'emoji': 1 },
  'client/src/components/estimate/InlineAutoPayCapture.jsx': { 'emoji': 1, 'font-family-literal': 1 },
  'client/src/components/estimate/PriceCard.jsx': { 'banned-font-size': 1 },
  'client/src/components/estimate/ProposalDetailCard.jsx': { 'banned-font-size': 1 },
  'client/src/components/estimate/ReportShowcaseCard.jsx': { 'banned-font-size': 14 },
  'client/src/components/estimate/glass/GlassEstimateExtras.jsx': { 'emoji': 3 },
  'client/src/components/estimate/glass/glass-components.css': { 'banned-font-size': 3 },
  'client/src/components/estimate/tokens.js': { 'local-palette': 1 },
  'client/src/index.css': { 'banned-font-size': 2 },
  'client/src/pages/ServiceOutlinePage.jsx': { 'banned-font-size': 3 },
  'client/src/styles/buttons.css': { 'banned-font-size': 2 },
  'client/src/styles/tokens.css': { 'banned-font-size': 1 },
  'client/src/theme-brand.js': { 'banned-font-size': 2 },
};

// =========================================================================
// Rules
// =========================================================================
const EMOJI_RX = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}\u{1F000}-\u{1F2FF}]/u;

const BRAND_FONT_STRINGS = [
  'Inter', 'Montserrat', 'Anton', 'JetBrains Mono', 'Source Serif',
  'DM Sans', 'Instrument Serif', 'Luckiest Guy', 'Burbank Big',
];
const FONT_FAMILY_LITERAL_RX = new RegExp(
  'fontFamily:\\s*["\'][^"\']*(' + BRAND_FONT_STRINGS.map(s => s.replace(/\s/g, '\\s')).join('|') + ')[^"\']*["\']',
  'i'
);

const LOCAL_PALETTE_RX = /^(?:\s*(?:export\s+)?)const\s+(W|BRAND|PALETTE|THEME|COLORS|PALLETTE)\s*=\s*\{/;

// Every literal under the 14px floor (1–13, decimals included) anywhere in
// the value expression — `12`, `'12px'`, `compact ? 12 : 16` — the same reach
// as the weight rule. A fraction of a computed size (`size * 0.28`, `14.5`)
// is not a px literal and is left alone, nor is an arithmetic operand
// (`baseSize * 1.2`).
const BANNED_FONT_SIZE_RX = /fontSize:\s*[^,}\n]*?(?<![\w.-])(?<![*/+-]\s*)((?:[1-9]|1[0-3])(?:\.\d+)?)(?:px)?(?![\w.-])(?!\s*[*/])/;
// Token spellings of the same sizes (FS.micro / FS.caption were 11 / 12 until
// #3892 deleted them) — a live page must not reach under the floor by name.
const BANNED_FONT_TOKEN_RX = /fontSize:\s*FS\.(micro|caption)\b/;
// Tailwind utilities reach the same sizes by class name. `text-xs` is 12px and
// `text-[13px]` is a literal; the public service-outline page renders several.
// text-sm is 14 and stays legal. A responsive variant is still a render, so
// `md:text-xs` is matched the same as the bare class.
const BANNED_TW_CLASS_RX = /(?:^|[\s"'`])(?:[a-z]{2}:)?text-(xs|\[(?:[1-9]|1[0-3])(?:\.\d+)?px\])(?=$|[\s"'`])/;
// Customer glass sheet (owner 2026-09-03/05): weights stop at 700. 800/850/900
// literals render heavier on iPhone than on the Inter/Segoe fallbacks and read
// as a different face next to the sheet's 600/700; 650/750 are variable-font
// one-offs that snap unpredictably. Matched anywhere in the value expression
// (ternaries included) and by name: FW.heavy (800) was deleted with #3895.
const HEAVY_WEIGHT_RX = /fontWeight:\s*[^,}\n]*?\b(6[5-9]\d|7[1-9]\d|[89]\d\d|FW\.heavy)\b/;
// The same two rules for CSS authored inside a <style> template literal
// (kebab-case declarations): `font-size: 10px` / `font-weight: 800` used to
// pass the gate while the JSX spelling failed it.
const BANNED_CSS_FONT_SIZE_RX = /font-size:\s*((?:\d|1[0-3])(?:\.\d+)?)px\b/;
const HEAVY_CSS_WEIGHT_RX = /font-weight:\s*[^;}\n]*?\b(6[5-9]\d|7[1-9]\d|[89]\d\d)\b/;
// …and as SVG presentation attributes (`<text fontSize="10">`, `fontSize={10}`,
// `fontWeight="800"`) — the report charts label their axes this way.
const BANNED_ATTR_FONT_SIZE_RX = /\bfontSize=(?:"((?:[1-9]|1[0-3])(?:\.\d+)?)"|\{((?:[1-9]|1[0-3])(?:\.\d+)?)\})/;
const HEAVY_ATTR_WEIGHT_RX = /\bfontWeight=(?:"(6[5-9]\d|7[1-9]\d|[89]\d\d)"|\{(6[5-9]\d|7[1-9]\d|[89]\d\d)\})/;

// =========================================================================
// Walk
// =========================================================================
function walk(dir) {
  let out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out = out.concat(walk(p));
      continue;
    }
    if (!entry.isFile()) continue;
    // CSS too: `buttons.css` is imported globally by index.css and carried
    // `font-weight: 800` and a 13px `.btn-nav` past a gate that called itself
    // repo-wide. The kebab-case rules below already exist for CSS authored
    // inside <style> templates and apply unchanged to a real stylesheet.
    if (!/\.(jsx?|tsx?|css)$/.test(entry.name)) continue;
    if (EXCLUDED_FILES.has(entry.name)) continue;
    // Test fixtures style stub components; they are not customer surfaces.
    if (/\.test\.[jt]sx?$/.test(entry.name)) continue;
    if (EXCLUDED_DIR_HINTS.some(h => p.includes(h))) continue;
    if (NON_CUSTOMER_FILENAME_PREFIXES.some(pre => entry.name.startsWith(pre))) continue;
    out.push(p);
  }
  return out;
}

// =========================================================================
// Check
// =========================================================================
// Baseline keys and report paths are repository-style, forward-slash. On
// Windows `path.relative` hands back `client\\src\\...`, which matches no
// entry, so every baselined file would be treated as zero-tolerance and the
// gate would fail on a clean tree. Normalise at both boundaries.
function relKey(filePath) {
  return path.relative(ROOT, filePath).split(path.sep).join('/');
}

// Which lines are ENTIRELY comment, so scanning them reports debt that does
// not exist: Icon.jsx's note about migrating the old portal's emoji keys to
// <Icon/>, and GlassEstimateExtras' "5-star reviews only" docblock, were both
// counted as raw-emoji violations -- the gate forbade DESCRIBING the sweep it
// asks for.
//
// This asks the parser rather than the line's prefix. A prefix test cannot
// tell a comment from rendered JSX text that merely starts with `//` -- inside
// a <pre>, say -- and skipping such a line would hide a real violation on a
// visible element, the exact masking this is meant to avoid.
//
// Two rules survive from the prefix version, because they are about intent
// rather than detection:
//   - only WHOLE-line comments are skipped. A line holding both code and a
//     comment is scanned in full, in both directions: a trailing `// note`
//     after code, and code trailing a `*/`.
//   - on a parse failure nothing is skipped. Scanning a comment costs a false
//     positive; skipping code costs a miss, and a miss is the worse failure.
// @babel/parser, not acorn: `walk()` accepts .ts and .tsx, and acorn cannot
// parse TypeScript. A parser that chokes on an extension the walker advertises
// means that file takes the failure path forever -- safe, since nothing is
// skipped, but it also means comment prose in it is reported as debt. One
// parser with the jsx + typescript plugins covers every extension accepted.
const { parse: babelParse } = require('@babel/parser');
const postcss = require('postcss');

// `{/* ... */}` is THE way to write a comment in JSX children, and the parser's
// range covers only the `/* ... */`. The braces are left over as non-whitespace,
// so the line reads as code and the comment gets scanned. When braces wrap a
// comment and nothing else, they are part of it; `{/* note */ x}` is an
// expression and stays scanned.
function expandJsxWrapper(text, start, end) {
  let a = start;
  let b = end;
  while (a > 0 && /\s/.test(text[a - 1])) a -= 1;
  while (b < text.length && /\s/.test(text[b])) b += 1;
  if (text[a - 1] === '{' && text[b] === '}') return [a - 1, b + 1];
  return [start, end];
}

// CSS comment spans, from postcss -- the parser this project's own build uses,
// so it defines what this repo's CSS means.
//
// This replaced a hand-written scanner. That scanner took four review findings
// in three rounds, every one a variant of "something that looks like a comment
// delimiter and is not": a quoted `content: "/*"`, an unquoted
// `url(data:...,/*)`, an escaped `url(foo\)/*)`, an escaped `\/*`. The count
// was rising, not falling, which is the signal to replace the mechanism rather
// than patch it again. postcss knows strings, url() tokens and escapes by
// construction.
//
// A file postcss rejects yields no ranges, so nothing is skipped and every
// line is scanned. That is the safe direction, and it is what happens to the
// one case postcss itself disagrees about (`\/*`, which it reads as an
// unclosed comment): conservative, never masking.
function cssCommentRanges(text, offset = 0) {
  const out = [];
  let root;
  try {
    root = postcss.parse(text);
  } catch {
    return out;
  }
  root.walkComments((c) => {
    const a = c.source && c.source.start && c.source.start.offset;
    const b = c.source && c.source.end && c.source.end.offset;
    if (typeof a === 'number' && typeof b === 'number') out.push([a + offset, b + offset]);
  });
  return out;
}

// `<style>{`...`}</style>` is the repo's embedded-CSS pattern, and Babel treats
// the CSS inside as template-string data -- its `/* ... */` never reaches
// `ast.comments`, so a whole-line note in there was reported as live debt.
//
// Only templates with NO interpolation qualify. A quasi is not independently
// valid CSS: with `prefix = 'url(foo'`, the template `.a { background:
// ${prefix}/*); }` has its `/*` inside URL data once combined, but the quasi
// after the interpolation starts at `/*` and postcss reads a comment running
// to the next `*/` -- masking every live rule in between. Reconstructing the
// lexer state across interpolations is not worth it: an interpolated style
// template simply keeps every line scanned.
//
// Scoped to <style> children for a second reason: running CSS comment
// detection over every template literal would let a line of ordinary template
// TEXT that happens to read `/* ... */` be skipped, which would also mask.
function styleTemplateNode(node) {
  if (node.type !== 'JSXElement') return null;
  const name = node.openingElement && node.openingElement.name;
  if (!name || name.type !== 'JSXIdentifier' || name.name !== 'style') return null;
  // Sibling JSX expressions also interpolate CSS: a prefix can open url()
  // before this template starts. Only a sole template has known context.
  const children = (node.children || []).filter((child) => child.type !== 'JSXText' || child.value.trim());
  if (children.length !== 1) return null;
  const child = children[0];
  const expr = child.type === 'JSXExpressionContainer' ? child.expression : null;
  return expr && expr.type === 'TemplateLiteral' && expr.expressions.length === 0 ? expr : null;
}

function styleTemplateRanges(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const n of node) styleTemplateRanges(n, out);
    return;
  }
  const tpl = node.type ? styleTemplateNode(node) : null;
  if (tpl) {
    for (const q of tpl.quasis || []) {
      if (typeof q.start === 'number' && typeof q.end === 'number') out.push([q.start, q.end]);
    }
  }
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue;
    styleTemplateRanges(node[key], out);
  }
}

// Babel's TypeScript and JSX grammars conflict: with both on, a valid `.ts`
// construct like `const n = <number>1` parses as JSX and the file is rejected,
// sending it down the scan-everything path forever. Pick by extension.
function pluginsFor(filePath) {
  if (/\.tsx$/.test(filePath)) return ['jsx', 'typescript'];
  if (/\.ts$/.test(filePath)) return ['typescript'];
  return ['jsx'];
}

function commentLineSet(text, filePath) {
  const lines = text.split('\n');
  const covered = new Set();
  const ranges = [];

  if (/\.css$/.test(filePath)) {
    for (const r of cssCommentRanges(text)) ranges.push(r);
  } else {
    let ast;
    try {
      ast = babelParse(text, {
        sourceType: 'unambiguous',
        allowReturnOutsideFunction: true,
        plugins: pluginsFor(filePath),
      });
    } catch {
      return covered; // unparseable: skip nothing, scan everything
    }
    for (const c of ast.comments || []) ranges.push(expandJsxWrapper(text, c.start, c.end));
    const styleQuasis = [];
    styleTemplateRanges(ast.program, styleQuasis);
    for (const [a, b] of styleQuasis) {
      for (const r of cssCommentRanges(text.slice(a, b), a)) ranges.push(r);
    }
  }
  if (!ranges.length) return covered;

  const lineStart = [];
  let off = 0;
  for (const line of lines) { lineStart.push(off); off += line.length + 1; }

  // A line counts as comment only when blanking every comment span on it
  // leaves nothing but whitespace.
  const spans = lines.map(() => []);
  for (const [a, b] of ranges) {
    for (let i = 0; i < lines.length; i += 1) {
      const s0 = lineStart[i];
      const e0 = s0 + lines[i].length;
      if (b <= s0 || a >= e0) continue;
      spans[i].push([Math.max(a, s0) - s0, Math.min(b, e0) - s0]);
    }
  }
  for (let i = 0; i < lines.length; i += 1) {
    if (!spans[i].length) continue;
    let rest = lines[i];
    for (const [a, b] of spans[i]) rest = rest.slice(0, a) + ' '.repeat(b - a) + rest.slice(b);
    if (!rest.trim()) covered.add(i + 1);
  }
  return covered;
}

function checkFile(filePath) {
  const rel = relKey(filePath);
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.split('\n');
  const violations = [];

  // A line that is ENTIRELY a comment renders nothing, so scanning it reports
  // debt that does not exist: Icon.jsx's note about migrating the old portal's
  // emoji keys to <Icon/>, and GlassEstimateExtras' "5-star reviews only"
  // docblock, were both counted as raw-emoji violations -- the gate forbade
  // DESCRIBING the sweep it asks for. Only whole-line comments are skipped.
  // Anything sharing a line with code is scanned in full, in both directions:
  // a trailing `// note` after code, and code trailing a `*/` on the closing
  // line of a block. The rule is never to mask, so where the two overlap the
  // scanner wins and we accept the odd false positive on comment prose.
  const commentLines = commentLineSet(text, filePath);
  lines.forEach((line, i) => {
    const n = i + 1;
    if (commentLines.has(n)) return;

    if (EMOJI_RX.test(line)) {
      violations.push({
        rule: 'emoji',
        line: n,
        msg: `raw emoji character in JSX — use <Icon name="..." /> instead`,
        snippet: line.trim().slice(0, 140),
      });
    }
    // Report font-family literals outside the theme-brand file itself.
    if (!rel.endsWith('theme-brand.js') && FONT_FAMILY_LITERAL_RX.test(line)) {
      violations.push({
        rule: 'font-family-literal',
        line: n,
        msg: `hardcoded font-family string — import FONTS from '../theme-brand' and use FONTS.body / FONTS.heading / FONTS.display / FONTS.mono`,
        snippet: line.trim().slice(0, 140),
      });
    }
    if (LOCAL_PALETTE_RX.test(line) && rel !== PALETTE_RULE_EXEMPT) {
      violations.push({
        rule: 'local-palette',
        line: n,
        msg: `local palette declaration — import COLORS from '../theme-brand' instead of re-declaring brand hexes`,
        snippet: line.trim().slice(0, 140),
      });
    }
    if (BANNED_FONT_SIZE_RX.test(line)) {
      const m = line.match(BANNED_FONT_SIZE_RX);
      violations.push({
        rule: 'banned-font-size',
        line: n,
        msg: `fontSize: ${m[1]} — nothing under 14px on a customer surface (labels 14, body 16; owner sheet 2026-09-03)`,
        snippet: line.trim().slice(0, 140),
      });
    }
    if (BANNED_TW_CLASS_RX.test(line)) {
      const m = line.match(BANNED_TW_CLASS_RX);
      const label = m[1] === 'xs' ? 'text-xs (12px)' : `text-${m[1]}`;
      violations.push({
        rule: 'banned-font-size',
        line: n,
        msg: `${label} — nothing under 14px on a customer surface; text-sm (14px) is the floor (owner sheet 2026-09-03)`,
        snippet: line.trim().slice(0, 140),
      });
    }
    if (BANNED_FONT_TOKEN_RX.test(line)) {
      const m = line.match(BANNED_FONT_TOKEN_RX);
      violations.push({
        rule: 'banned-font-token',
        line: n,
        msg: `fontSize: FS.${m[1]} — that token is under the 14px floor; use FS.body`,
        snippet: line.trim().slice(0, 140),
      });
    }
    if (HEAVY_WEIGHT_RX.test(line)) {
      const m = line.match(HEAVY_WEIGHT_RX);
      violations.push({
        rule: 'heavy-weight',
        line: n,
        msg: `fontWeight: ${m[1]} — customer weights are 400 / 500 / 600 / 700 only (owner sheet 2026-09-03)`,
        snippet: line.trim().slice(0, 140),
      });
    }
    if (BANNED_CSS_FONT_SIZE_RX.test(line)) {
      const m = line.match(BANNED_CSS_FONT_SIZE_RX);
      violations.push({
        rule: 'banned-font-size',
        line: n,
        msg: `font-size: ${m[1]}px — nothing under 14px on a customer surface, embedded CSS included (owner sheet 2026-09-03)`,
        snippet: line.trim().slice(0, 140),
      });
    }
    if (BANNED_ATTR_FONT_SIZE_RX.test(line)) {
      const m = line.match(BANNED_ATTR_FONT_SIZE_RX);
      violations.push({
        rule: 'banned-font-size',
        line: n,
        msg: `fontSize=${m[1] || m[2]} — nothing under 14px on a customer surface, SVG text included (owner sheet 2026-09-03)`,
        snippet: line.trim().slice(0, 140),
      });
    }
    if (HEAVY_ATTR_WEIGHT_RX.test(line)) {
      const m = line.match(HEAVY_ATTR_WEIGHT_RX);
      violations.push({
        rule: 'heavy-weight',
        line: n,
        msg: `fontWeight=${m[1] || m[2]} — customer weights are 400 / 500 / 600 / 700 only, SVG text included (owner sheet 2026-09-03)`,
        snippet: line.trim().slice(0, 140),
      });
    }
    if (HEAVY_CSS_WEIGHT_RX.test(line)) {
      const m = line.match(HEAVY_CSS_WEIGHT_RX);
      violations.push({
        rule: 'heavy-weight',
        line: n,
        msg: `font-weight: ${m[1]} — customer weights are 400 / 500 / 600 / 700 only, embedded CSS included (owner sheet 2026-09-03)`,
        snippet: line.trim().slice(0, 140),
      });
    }
  });

  return violations;
}

// =========================================================================
// Main
// =========================================================================
function tally(violations) {
  const byRule = {};
  for (const v of violations) byRule[v.rule] = (byRule[v.rule] || 0) + 1;
  return byRule;
}

function reportRegressions(regressions) {
  const total = regressions.reduce((a, e) => a + e.over, 0);
  console.error(`[check-portal-brand] FAIL — ${total} violation${total === 1 ? '' : 's'} over baseline across ${regressions.length} file${regressions.length === 1 ? '' : 's'}:\n`);
  for (const { file, violations, allowed, rules } of regressions) {
    console.error(`  ${file}`);
    for (const rule of rules) {
      console.error(`    ${rule}: ${tally(violations)[rule] || 0} found, ${(allowed[rule] || 0)} allowed`);
    }
    for (const v of violations.filter((x) => rules.includes(x.rule))) {
      console.error(`    ${file}:${v.line}  [${v.rule}]  ${v.msg}`);
      console.error(`      > ${v.snippet}`);
    }
    console.error('');
  }
  console.error('Fix the violations above. Do not raise a LEGACY_BASELINE number to make this pass —');
  console.error('the list exists to shrink, and a customer surface has no floor under 14px or weight over 700.');
}

function reportSlack(slack) {
  console.error(`\n[check-portal-brand] baseline is behind the code — ${slack.length} entr${slack.length === 1 ? 'y has' : 'ies have'} fewer violations than allowed. Lower the allowance to what is actually left, or delete the line at zero:`);
  for (const { file, found, allowed } of slack) {
    const shape = Object.keys(found).length
      ? `{ ${Object.keys(found).sort().map((r) => `${r}: ${found[r]}`).join(', ')} }`
      : null;
    console.error(shape
      ? `  lower   '${file}': ${shape},   (was { ${Object.keys(allowed).sort().map((r) => `${r}: ${allowed[r]}`).join(', ')} })`
      : `  delete  '${file}',            (was allowed, now clean)`);
  }
}

function main() {
  let files = [];
  for (const d of SCAN_DIRS) files = files.concat(walk(d));

  const found = new Map();
  for (const f of files) {
    const v = checkFile(f);
    if (v.length) found.set(relKey(f), v);
  }

  // The allowance is per RULE, not a single total. A total lets a change swap
  // one violation for another of a different kind and stay green — clear an
  // undersized label in NotificationBell, add an 800-weight control, count
  // unchanged, nothing fires. Per-rule counts make that a heavy-weight
  // regression. (A same-rule swap inside an already-dirty file still passes;
  // the file is scheduled for cleanup and its count cannot grow.)
  const regressions = [];
  let carried = 0;
  for (const [file, violations] of found) {
    const allowed = LEGACY_BASELINE[file] || {};
    const counts = tally(violations);
    const over = Object.keys(counts).filter((r) => counts[r] > (allowed[r] || 0));
    if (over.length) {
      regressions.push({
        file,
        violations,
        allowed,
        rules: over,
        over: over.reduce((a, r) => a + (counts[r] - (allowed[r] || 0)), 0),
      });
    } else {
      carried += violations.length;
    }
  }

  // Under the allowance fails too. An allowance left above what the file
  // actually carries is headroom for the cleaned-up violations to come back
  // silently — drop NotificationBell's undersized labels from 11 to 1 and the
  // entry would still wave ten through. The numbers have to follow the code
  // down, and the line has to go once the file is clean, which is what keeps
  // this a ratchet rather than a permanent exemption list.
  const slack = [];
  for (const [file, allowed] of Object.entries(LEGACY_BASELINE)) {
    const counts = found.has(file) ? tally(found.get(file)) : {};
    if (Object.keys(allowed).some((r) => (counts[r] || 0) < allowed[r])) {
      slack.push({ file, found: counts, allowed });
    }
  }

  if (!regressions.length && !slack.length) {
    const n = Object.keys(LEGACY_BASELINE).length;
    const debt = carried ? ` — ${carried} baselined violation${carried === 1 ? '' : 's'} in ${n} legacy file${n === 1 ? '' : 's'} still to clear` : '';
    console.log(`[check-portal-brand] clean — scanned ${files.length} files, no new violations${debt}.`);
    process.exit(0);
  }

  if (regressions.length) reportRegressions(regressions);
  if (slack.length) reportSlack(slack);
  process.exit(1);
}

// Run as a CLI; importable for tests. The comment-skip and the
// both-directions baseline are the two behaviours that have silently broken
// this gate before, so they get a test rather than a comment.
if (require.main === module) main();

module.exports = { checkFile, commentLineSet, LEGACY_BASELINE };
