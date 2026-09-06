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
const SCAN_DIRS = [
  path.join(ROOT, 'client/src/pages'),
  path.join(ROOT, 'client/src/components/billing'),
  path.join(ROOT, 'client/src/components/customer'),
  path.join(ROOT, 'client/src/components/brand'),
  // Customer-facing /book widgets — the 13px chips fixed on the 07-07 portal
  // audit (F-057) lived here unscanned. components/estimate is NOT listed:
  // it carries ~35 legacy violations (13px labels, star glyphs, W tokens)
  // that need their own cleanup pass before the gate can cover it.
  path.join(ROOT, 'client/src/components/booking'),
  // The V2 report bodies (lawn / pest / mosquito / cockroach / tree & shrub)
  // and the gauge primitives — swept onto the sheet with #3895.
  path.join(ROOT, 'client/src/components/report'),
  // Portal-only components (cancel flow, cancelled plan): the button-weight
  // rule removal on #3971 exposed 800/850 weights here that the gate could
  // not see.
  path.join(ROOT, 'client/src/components/portal'),
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
// Filename prefixes that belong to the admin/tech surfaces — separate design
// system (D palette + DM Sans + density-first, per admin brief), NOT subject
// to the customer brand rules this script enforces.
const NON_CUSTOMER_FILENAME_PREFIXES = ['Admin', 'Tech', 'Dispatch', 'Inventory', 'Revenue', 'Compliance', 'Protocol'];
// Any file inside these dirs is out of scope.
const EXCLUDED_DIR_HINTS = ['/admin/', '/tech/', '/dispatch/', '/equipment/'];

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
    if (!/\.(jsx?|tsx?)$/.test(entry.name)) continue;
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
function checkFile(filePath) {
  const rel = path.relative(ROOT, filePath);
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.split('\n');
  const violations = [];

  lines.forEach((line, i) => {
    const n = i + 1;

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
    if (LOCAL_PALETTE_RX.test(line)) {
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
function main() {
  let files = [];
  for (const d of SCAN_DIRS) files = files.concat(walk(d));

  const perFile = [];
  let total = 0;
  for (const f of files) {
    const v = checkFile(f);
    if (v.length) {
      perFile.push({ file: path.relative(ROOT, f), violations: v });
      total += v.length;
    }
  }

  if (!total) {
    console.log(`[check-portal-brand] clean — scanned ${files.length} files, zero violations.`);
    process.exit(0);
  }

  console.error(`[check-portal-brand] FAIL — ${total} violation${total === 1 ? '' : 's'} across ${perFile.length} file${perFile.length === 1 ? '' : 's'}:\n`);
  for (const { file, violations } of perFile) {
    console.error(`  ${file}`);
    for (const v of violations) {
      console.error(`    ${file}:${v.line}  [${v.rule}]  ${v.msg}`);
      console.error(`      > ${v.snippet}`);
    }
    console.error('');
  }
  console.error(`Fix the violations above, or justify with a per-line disable if the codebase adopts one.`);
  process.exit(1);
}

main();
