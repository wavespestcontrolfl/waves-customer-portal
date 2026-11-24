#!/usr/bin/env node
/**
 * Print suggested reorder limits for every active product, next to the
 * hand-set ones. READ ONLY: no product, restock request or order is written.
 *
 *   node server/scripts/suggest-reorder-limits.js            # table
 *   node server/scripts/suggest-reorder-limits.js --csv      # spreadsheet
 *   node server/scripts/suggest-reorder-limits.js --json     # raw rows
 *   --lead-days=3 --buffer-days=7 --reorder-days=21 --all (include no-usage rows)
 *
 * Rules: server/services/procurement/reorder-limit-suggestions.js
 */
const OPTION_FLAGS = { 'lead-days': 'leadDays', 'buffer-days': 'bufferDays', 'reorder-days': 'reorderDays' };

function parseArgs(argv) {
  const out = { format: 'table', all: false, options: {} };
  for (const arg of argv) {
    if (arg === '--csv') out.format = 'csv';
    else if (arg === '--json') out.format = 'json';
    else if (arg === '--all') out.all = true;
    else {
      const m = arg.match(/^--([a-z-]+)=(\d+(?:\.\d+)?)$/);
      if (m && OPTION_FLAGS[m[1]]) out.options[OPTION_FLAGS[m[1]]] = Number(m[2]);
      else throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return out;
}

const COLUMNS = [
  ['name', 'Product'], ['unit', 'Unit'], ['onHand', 'On hand'], ['dailyUse', 'Use/day'], ['basis', 'Based on'],
  ['currentThreshold', 'Threshold now'], ['suggestedThreshold', 'Threshold suggested'],
  ['currentReorder', 'Reorder now'], ['suggestedReorder', 'Reorder suggested'], ['packSize', 'Pack'],
  ['autoReorder', 'Auto'], ['vendor', 'Vendor'], ['status', 'Status'], ['note', 'Note'],
];

const cell = (v) => (v == null ? '' : typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v));
const { csvRow } = require('../services/csv-generators'); // formula-injection guard + quoting

function render(result, { format, all }) {
  // Hidden by default: nothing to suggest and nothing recorded (no use, or no
  // stock unit and no usage rows either).
  const idle = (r) => r.status === 'no_usage' || (r.status === 'no_unit' && !r.usageRecords);
  const rows = all ? result.products : result.products.filter((r) => !idle(r));
  if (format === 'json') return JSON.stringify({ ...result, products: rows }, null, 2);
  if (format === 'csv') {
    return [
      ...(result.forecastError ? [csvRow([`Warning: ${result.forecastError}`])] : []),
      csvRow(COLUMNS.map((c) => c[1])),
      ...rows.map((r) => csvRow(COLUMNS.map(([k]) => cell(r[k])))),
    ].join('\n');
  }
  const tableCols = COLUMNS.filter(([k]) => k !== 'note');
  const widths = tableCols.map(([k, h]) => Math.min(36, Math.max(h.length, ...rows.map((r) => cell(r[k]).length))));
  const dash = (v) => (v === '' ? '-' : v);
  const line = (vals) => vals.map((v, i) => v.slice(0, widths[i]).padEnd(widths[i])).join('  ');
  const o = result.options;
  const head = [
    `Suggested reorder limits, ${result.today} (lead ${o.leadDays} d, buffer ${o.bufferDays} d, reorder ${o.reorderDays} d). Read only.`,
    result.forecastError ? `Lawn forecast: ${result.forecastError}` : null,
    `${rows.length} products shown; ${result.products.length - rows.length} with no use or no stock unit hidden (--all shows them).`,
    '',
    line(tableCols.map((c) => c[1])),
  ].filter((x) => x != null);
  const notes = rows.filter((r) => r.note).map((r) => `- ${r.name}: ${r.note}`);
  return [...head, ...rows.map((r) => line(tableCols.map(([k]) => dash(cell(r[k]))))), '', ...(notes.length ? ['Notes:', ...notes] : [])].join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const db = require('../models/db');
  const { buildReorderLimitSuggestions } = require('../services/procurement/reorder-limit-suggestions');
  try {
    const result = await buildReorderLimitSuggestions({ knex: db, options: args.options });
    process.stdout.write(`${render(result, args)}\n`);
  } finally {
    await db.destroy();
  }
}

if (require.main === module) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}

module.exports = { parseArgs, render };
