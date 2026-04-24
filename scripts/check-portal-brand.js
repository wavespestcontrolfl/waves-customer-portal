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
 *   4. Banned body font sizes (11, 13) per customer design brief
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
];
// Files explicitly excluded — dev-only demos, theme tokens themselves, etc.
const EXCLUDED_FILES = new Set([
  'ButtonExamples.jsx',        // palette demo page
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

const BANNED_FONT_SIZE_RX = /fontSize:\s*(11|13)\b/;

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
        msg: `fontSize: ${m[1]} — brief bans 11px (too small) and 13px (body floor is 16, labels should be 14 min)`,
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
