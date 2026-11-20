#!/usr/bin/env node
/**
 * Offline roof-style agreement check (owner 2026-11-19).
 *
 * Compares the stored roofStyleHint (county words) and roofTileStyle (satellite
 * photo read) against a hand-checked CSV, so the barrel-vs-flat tile reads can
 * be judged before anything prices off them. No network, no database.
 *
 * Usage: node scripts/roof-style-check.js <lookups.json> <known.csv>
 *   lookups.json  a JSON array of stored lookups (property_lookup_cache rows or
 *                 lookup results). Each needs an address (address,
 *                 normalized_address or formattedAddress) and the reads, as
 *                 roofStyleHint / roofTileStyle on the row, on its
 *                 enriched / enriched_snapshot / property_record / ai_analysis,
 *                 or on its propertyRecord / aiAnalysis.
 *   known.csv     header `address,known_style`; known_style is barrel, flat or
 *                 clay (barrel_tile, flat_tile, clay_tile are accepted).
 */
const fs = require('fs');

function normalizeAddress(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b\d{5}(?: \d{4})?\b\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeKnownStyle(value) {
  const text = String(value || '').trim().toLowerCase().replace(/_tile$/, '');
  return ['barrel', 'flat', 'clay'].includes(text) ? text : null;
}

function parseCsvLine(line) {
  const cells = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cell += '"'; i += 1; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { cells.push(cell); cell = ''; } else cell += ch;
  }
  cells.push(cell);
  return cells.map((c) => c.trim());
}

function parseKnownCsv(text) {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim());
  const [header, ...rows] = lines.map(parseCsvLine);
  const addressCol = (header || []).indexOf('address');
  const styleCol = (header || []).indexOf('known_style');
  if (addressCol < 0 || styleCol < 0) throw new Error('CSV needs an "address,known_style" header');
  const known = new Map();
  for (const row of rows) {
    const style = normalizeKnownStyle(row[styleCol]);
    if (style && row[addressCol]) known.set(normalizeAddress(row[addressCol]), style);
  }
  return known;
}

function firstDefined(sources, key) {
  for (const source of sources) {
    if (source && typeof source === 'object' && source[key] != null) return source[key];
  }
  return null;
}

function readLookup(row) {
  const sources = [
    row, row?.enriched, row?.enriched_snapshot, row?.property_record, row?.ai_analysis,
    row?.propertyRecord, row?.aiAnalysis,
  ];
  const address = row?.address || row?.normalized_address || row?.formattedAddress
    || firstDefined(sources, 'formattedAddress');
  const hint = String(firstDefined(sources, 'roofStyleHint') || '').replace(/_tile$/, '');
  const photo = String(firstDefined(sources, 'roofTileStyle') || '').toLowerCase();
  return {
    key: normalizeAddress(address),
    hint: ['barrel', 'flat', 'clay'].includes(hint) ? hint : null,
    photo: ['barrel', 'flat'].includes(photo) ? photo : null,
  };
}

function tally(pairs) {
  const covered = pairs.filter((p) => p.read);
  const agree = covered.filter((p) => p.read === p.known).length;
  return {
    known: pairs.length,
    covered: covered.length,
    agree,
    agreeOfCovered: covered.length ? agree / covered.length : null,
    agreeOfKnown: pairs.length ? agree / pairs.length : null,
  };
}

function compareStyles(lookups, known) {
  const hintPairs = [];
  const photoPairs = [];
  let unmatched = 0;
  const seen = new Set();
  for (const row of lookups) {
    const { key, hint, photo } = readLookup(row);
    if (!known.has(key)) continue;
    seen.add(key);
    hintPairs.push({ read: hint, known: known.get(key) });
    photoPairs.push({ read: photo, known: known.get(key) });
  }
  for (const key of known.keys()) if (!seen.has(key)) unmatched += 1;
  return { roofStyleHint: tally(hintPairs), roofTileStyle: tally(photoPairs), knownWithoutLookup: unmatched };
}

const pct = (v) => (v == null ? 'n/a' : `${(v * 100).toFixed(1)}%`);

function formatReport(result) {
  const line = (name, t) => `${name}: ${t.known} matched, ${t.covered} with a read, ${t.agree} agree`
    + ` (${pct(t.agreeOfCovered)} of reads, ${pct(t.agreeOfKnown)} of matched)`;
  return [
    line('roofStyleHint', result.roofStyleHint),
    line('roofTileStyle', result.roofTileStyle),
    `known addresses with no stored lookup: ${result.knownWithoutLookup}`,
  ].join('\n');
}

function main(argv) {
  const [jsonPath, csvPath] = argv;
  if (!jsonPath || !csvPath) {
    process.stderr.write('Usage: node scripts/roof-style-check.js <lookups.json> <known.csv>\n');
    return 2;
  }
  const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const lookups = Array.isArray(parsed) ? parsed : (parsed.rows || parsed.lookups || []);
  const known = parseKnownCsv(fs.readFileSync(csvPath, 'utf8'));
  process.stdout.write(`${formatReport(compareStyles(lookups, known))}\n`);
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { normalizeAddress, parseKnownCsv, readLookup, compareStyles, formatReport };
