#!/usr/bin/env node
/**
 * audit-existing-pages.js — runs uniqueness-gate retroactively against
 * the existing Astro service pages to surface current doorway risk
 * before any autonomous page ships.
 *
 * 316 service pages + 5 location pages already live in the Astro repo.
 * If many of them score as templated-swap content under the gate, the
 * gate's threshold needs tuning OR there's pre-existing risk worth
 * cleaning up before autonomous publishing amplifies it.
 *
 * Read-only. Reads from a local Astro clone (default
 * ~/Downloads/wavespestcontrol-astro) — override with --astro-dir.
 * Writes a markdown report to reports/page-audit-YYYY-MM-DD.md.
 *
 * Usage:
 *   node server/scripts/audit-existing-pages.js
 *   node server/scripts/audit-existing-pages.js --astro-dir=/path/to/astro --max-pairs=10
 *   node server/scripts/audit-existing-pages.js --collection=services --jaccard-floor=0.4
 *
 * No DB access — pure filesystem walk + Jaccard math.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { _internals } = require('../services/content/uniqueness-gate');
const { shingles, jaccard } = _internals;
const { THRESHOLDS } = require('../services/content/scoring-config');

const ARGS = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    if (!a.startsWith('--')) return [a, true];
    const [k, v] = a.slice(2).split('=');
    return [k, v === undefined ? true : v];
  })
);

const ASTRO_DIR = ARGS['astro-dir'] || path.join(os.homedir(), 'Downloads', 'wavespestcontrol-astro');
const COLLECTIONS = String(ARGS.collection || 'services,locations').split(',');
const JACCARD_FLOOR = parseFloat(ARGS['jaccard-floor'] || THRESHOLDS.uniquenessJaccardMax);
const MAX_PAIRS = parseInt(ARGS['max-pairs'] || 40, 10);
const OUTPUT_PATH = ARGS.output || path.join(__dirname, '..', '..', 'reports', `page-audit-${new Date().toISOString().slice(0, 10)}.md`);

// ── frontmatter splitter (lightweight) ──────────────────────────────

function splitFrontmatter(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) return { frontmatter: {}, body: raw };
  const lines = m[1].split(/\r?\n/);
  const fm = {};
  for (const line of lines) {
    const kv = /^([a-zA-Z0-9_]+):\s*(.*)$/.exec(line);
    if (kv) fm[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
  }
  return { frontmatter: fm, body: m[2] };
}

// ── service / city slug inference from filename ─────────────────────

const KNOWN_SERVICES = ['pest-control', 'lawn-care', 'mosquito-control', 'termite-control', 'termite-inspection', 'rodent-control', 'bed-bug-control', 'commercial-pest-control', 'tree-shrub', 'ant-control', 'lawn-aeration', 'lawn-fertilization'];
const KNOWN_CITIES = ['bradenton', 'lakewood-ranch', 'sarasota', 'venice', 'parrish', 'palmetto', 'north-port', 'port-charlotte', 'longboat-key', 'siesta-key', 'anna-maria', 'palmer-ranch', 'island-of-venice'];

function inferKey(filename) {
  const base = filename.replace(/\.mdx?$/, '');
  let service = KNOWN_SERVICES.find((s) => base.startsWith(s)) || null;
  let city = KNOWN_CITIES.find((c) => base.includes(c)) || null;
  return { service, city };
}

// ── load all pages from a collection ────────────────────────────────

function loadCollection(name) {
  const dir = path.join(ASTRO_DIR, 'src', 'content', name);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const file of fs.readdirSync(dir)) {
    if (!/\.mdx?$/.test(file)) continue;
    const full = path.join(dir, file);
    const raw = fs.readFileSync(full, 'utf8');
    const { frontmatter, body } = splitFrontmatter(raw);
    const { service, city } = inferKey(file);
    out.push({
      collection: name,
      filename: file,
      url: frontmatter.slug || `/${file.replace(/\.mdx?$/, '')}/`,
      title: frontmatter.title || file,
      service,
      city,
      body,
      shingles: shingles(body),
      char_count: body.length,
    });
  }
  return out;
}

// ── pairwise audit (within service-family) ──────────────────────────

function auditFamily(pages, jaccardFloor) {
  // Group by service.
  const byService = new Map();
  for (const p of pages) {
    if (!p.service) continue;
    if (!byService.has(p.service)) byService.set(p.service, []);
    byService.get(p.service).push(p);
  }

  const flagged = [];
  for (const [service, group] of byService) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        const sim = jaccard(a.shingles, b.shingles);
        if (sim >= jaccardFloor) {
          flagged.push({ service, a, b, similarity: sim });
        }
      }
    }
  }
  flagged.sort((x, y) => y.similarity - x.similarity);
  return flagged;
}

// ── main ────────────────────────────────────────────────────────────

(function main() {
  if (!fs.existsSync(ASTRO_DIR)) {
    console.error(`Astro dir not found: ${ASTRO_DIR}`);
    console.error('Pass --astro-dir=/path/to/wavespestcontrol-astro to override.');
    process.exit(1);
  }

  const allPages = [];
  for (const c of COLLECTIONS) {
    const pages = loadCollection(c);
    allPages.push(...pages);
  }

  const flagged = auditFamily(allPages, JACCARD_FLOOR);

  const out = [];
  const log = (s = '') => out.push(s);

  log(`# Existing Page Doorway Audit`);
  log('');
  log(`- **Generated:** ${new Date().toISOString()}`);
  log(`- **Astro root:** ${ASTRO_DIR}`);
  log(`- **Collections scanned:** ${COLLECTIONS.join(', ')}`);
  log(`- **Pages loaded:** ${allPages.length}`);
  log(`- **Jaccard threshold:** ${JACCARD_FLOOR} (per scoring-config.THRESHOLDS.uniquenessJaccardMax)`);
  log(`- **Flagged pairs (similarity ≥ threshold):** ${flagged.length}`);
  log('');

  if (!flagged.length) {
    log(`No pairs exceeded the threshold. Either the existing pages are sufficiently differentiated, or the threshold needs lowering for a meaningful audit.`);
  } else {
    log(`## Top ${Math.min(MAX_PAIRS, flagged.length)} similar pairs`);
    log('');
    log('| # | Service | Similarity | URL A | URL B |');
    log('|---|---|---|---|---|');
    flagged.slice(0, MAX_PAIRS).forEach((f, i) => {
      log(`| ${i + 1} | ${f.service} | **${f.similarity.toFixed(2)}** | \`${f.a.url}\` | \`${f.b.url}\` |`);
    });
    log('');
    log(`Pairs above the autonomous-engine's uniqueness floor (${JACCARD_FLOOR}) would be rejected by the uniqueness-gate if the engine tried to re-publish them. Pre-existing pairs here represent doorway risk in the live site.`);
    log('');
  }

  log(`## Per-service counts`);
  log('');
  log('| Service | Page count | Avg char count |');
  log('|---|---|---|');
  const svcCount = new Map();
  const svcChars = new Map();
  for (const p of allPages) {
    if (!p.service) continue;
    svcCount.set(p.service, (svcCount.get(p.service) || 0) + 1);
    svcChars.set(p.service, (svcChars.get(p.service) || 0) + p.char_count);
  }
  const services = Array.from(svcCount.keys()).sort();
  for (const s of services) {
    const n = svcCount.get(s);
    const avg = Math.round(svcChars.get(s) / n);
    log(`| ${s} | ${n} | ${avg.toLocaleString()} |`);
  }
  log('');

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, out.join('\n'));
  console.log(`Wrote ${OUTPUT_PATH} (${out.length} lines, ${flagged.length} flagged pair(s) across ${allPages.length} pages)`);
})();
