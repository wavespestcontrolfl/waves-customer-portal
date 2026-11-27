#!/usr/bin/env node
/**
 * Print the weekly buy list. READ ONLY: no alert, product, request or order is written.
 *
 *   node server/scripts/weekly-buy-list.js                    # the week containing today (counted from today)
 *   node server/scripts/weekly-buy-list.js --date 2026-12-07  # the week containing that day (counted from it)
 *   node server/scripts/weekly-buy-list.js --json             # raw list
 *
 * Rules: server/services/procurement/weekly-buy-list.js. The alert it feeds:
 * weekly-buy-alert.js (Monday-Saturday 7:00 AM ET).
 */
const { validCalendarDate } = require('../utils/datetime-et');

function parseArgs(argv) {
  const out = { json: false, now: new Date() };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') out.json = true;
    else if (arg === '--date' || arg.startsWith('--date=')) {
      const value = arg === '--date' ? argv[++i] : arg.slice('--date='.length);
      const day = validCalendarDate(value);
      if (!day) throw new Error(`--date needs a real date as YYYY-MM-DD, got "${value}"`);
      // Noon UTC is 7 or 8 AM Eastern on that same calendar day.
      out.now = new Date(`${day}T12:00:00Z`);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

function render(list) {
  const { detailFor, specFor } = require('../services/procurement/weekly-buy-alert');
  const groups = [...list.technicians, list.unassigned].filter((g) => g.items.length || g.warnings.length);
  const out = [`Weekly buy list, ${list.weekStart} to ${list.weekEnd}, counted from ${list.fromDate}. Read only.`, ''];
  if (!groups.length) out.push('Nothing to buy and no warnings.');
  for (const group of groups) out.push(specFor(group, list).spec.action, detailFor(group, list), '');
  return out.join('\n').trimEnd();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const db = require('../models/db');
  const { buildWeeklyBuyList } = require('../services/procurement/weekly-buy-list');
  try {
    const list = await buildWeeklyBuyList({ knex: db, now: args.now });
    process.stdout.write(`${args.json ? JSON.stringify(list, null, 2) : render(list)}\n`);
  } finally {
    await db.destroy();
  }
}

if (require.main === module) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}

module.exports = { parseArgs, render };
