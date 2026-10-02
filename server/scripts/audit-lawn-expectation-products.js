#!/usr/bin/env node
/**
 * Read-only audit: every product name applied on a lawn visit, checked against
 * the lawn expectations table (server/config/lawn-expectations.js).
 *
 * The expectations engine is keyed by the EXACT catalog product name and fails
 * closed, so a name that is not in the table silently gets no "what to expect"
 * line. This lists each distinct product name used on lawn visits and reports:
 *   MAPPED        the name maps to an expectations family
 *   EXPLICIT_NULL the name is recorded as "no line" on purpose
 *   UNMAPPED      the name is in neither list: decide it, then add a row key
 *                 or an explicit null to the config
 *
 * Exit code 1 when any UNMAPPED name exists, so it can gate a check. Never
 * writes: the query runs in a READ ONLY transaction.
 *
 * Usage:
 *   node server/scripts/audit-lawn-expectation-products.js
 *   node server/scripts/audit-lawn-expectation-products.js --since-days 365 --json
 *   node server/scripts/audit-lawn-expectation-products.js --database-url postgres://...
 *   (falls back to DATABASE_URL; the script builds its own connection and never
 *   loads models/db.js)
 *   node server/scripts/audit-lawn-expectation-products.js --names-file names.txt
 *
 * `--names-file` skips the database and audits one product name per line
 * (a line may carry a trailing tab and a use count).
 */

const fs = require('fs');
const { classifyLawnProduct, classifyLawnProductStatus } = require('../services/service-report/lawn-expectations');

const DEFAULT_SINCE_DAYS = 90;

/**
 * Pure classification of a list of { name, uses } rows.
 * @param {Array<{name: string, uses?: number}>} rows
 * @returns {{ rows: Array<{name:string, uses:number, status:string, family:string|null, modeLock:string|null}>, counts: {mapped:number, explicit_null:number, unmapped:number}, unmapped: string[] }}
 */
function auditLawnExpectationProducts(rows = []) {
  const merged = new Map();
  for (const row of rows) {
    const name = String(row?.name == null ? '' : row.name).replace(/\s+/g, ' ').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    const uses = Number(row.uses) || 0;
    const prior = merged.get(key);
    if (prior) prior.uses += uses;
    else merged.set(key, { name, uses });
  }
  const out = [];
  for (const { name, uses } of merged.values()) {
    const status = classifyLawnProductStatus(name);
    const klass = status === 'mapped' ? classifyLawnProduct(name) : null;
    out.push({
      name,
      uses,
      status,
      family: klass?.family || null,
      modeLock: klass?.modeLock || null,
    });
  }
  out.sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name));
  const counts = { mapped: 0, explicit_null: 0, unmapped: 0 };
  for (const r of out) counts[r.status] += 1;
  return {
    rows: out,
    counts,
    unmapped: out.filter((r) => r.status === 'unmapped').map((r) => r.name),
  };
}

/**
 * Read-only: distinct product names applied on completed lawn visits since
 * `sinceDays` days ago, with use counts.
 */
async function loadLawnProductNames(db, { sinceDays = DEFAULT_SINCE_DAYS } = {}) {
  return db.transaction(async (trx) => {
    await trx.raw('SET TRANSACTION READ ONLY');
    const { rows } = await trx.raw(
      `SELECT sp.product_name AS name, COUNT(*)::int AS uses
         FROM service_products sp
         JOIN service_records sr ON sr.id = sp.service_record_id
        WHERE sr.service_line = 'lawn'
          AND sr.status = 'completed'
          AND sr.service_date >= (CURRENT_DATE - ?::int)
          AND NULLIF(TRIM(sp.product_name), '') IS NOT NULL
        GROUP BY sp.product_name
        ORDER BY uses DESC, name`,
      [sinceDays],
    );
    return rows;
  }, { readOnly: true });
}

function parseNamesFile(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, uses] = line.split('\t');
      return { name: name.trim(), uses: Number(uses) || 1 };
    });
}

function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : null;
}

function formatReport(result) {
  const lines = [];
  lines.push(`Lawn product names: ${result.rows.length}`
    + `  mapped ${result.counts.mapped}`
    + `  explicit null ${result.counts.explicit_null}`
    + `  UNMAPPED ${result.counts.unmapped}`);
  for (const r of result.rows) {
    const label = r.status === 'mapped'
      ? `MAPPED        ${r.family}${r.modeLock ? ` (${r.modeLock} only)` : ''}`
      : (r.status === 'explicit_null' ? 'EXPLICIT_NULL' : 'UNMAPPED');
    lines.push(`${String(r.uses).padStart(5)}  ${label.padEnd(34)} ${r.name}`);
  }
  return lines.join('\n');
}

/**
 * Own read-only knex connection. Built only from the URL given on the command
 * line or DATABASE_URL, after args are parsed: this script never loads
 * models/db.js or knexfile.js, so nothing can connect to a preconfigured
 * database behind the operator's back.
 */
function createAuditKnex(databaseUrl) {
  const url = String(databaseUrl || '').trim();
  if (!url || url === 'undefined' || url === 'null') {
    throw new Error('No database: pass --database-url or set DATABASE_URL (or use --names-file).');
  }
  const knex = require('knex');  
  return knex({
    client: 'pg',
    connection: {
      connectionString: url,
      ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false },
    },
    pool: { min: 0, max: 2 },
  });
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const json = argv.includes('--json');
  const namesFile = argValue(argv, '--names-file');
  const sinceDays = Number(argValue(argv, '--since-days')) || DEFAULT_SINCE_DAYS;
  const databaseUrl = argValue(argv, '--database-url') || env.DATABASE_URL;

  let source;
  let db = null;
  try {
    if (namesFile) {
      source = parseNamesFile(fs.readFileSync(namesFile, 'utf8'));
    } else {
      db = createAuditKnex(databaseUrl);
      source = await loadLawnProductNames(db, { sinceDays });
    }
    const result = auditLawnExpectationProducts(source);
    console.log(json ? JSON.stringify(result, null, 2) : formatReport(result));
    if (result.counts.unmapped > 0) process.exitCode = 1;
  } finally {
    if (db) await db.destroy();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exitCode = 1;
  });
}

module.exports = {
  auditLawnExpectationProducts,
  loadLawnProductNames,
  createAuditKnex,
  main,
  parseNamesFile,
  formatReport,
  DEFAULT_SINCE_DAYS,
};
