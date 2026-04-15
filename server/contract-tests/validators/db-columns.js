/**
 * DB-column validator — the money check.
 *
 * Regex-scans each tool's source file for Knex patterns and verifies the
 * referenced tables/columns exist in `information_schema.columns`. Tools
 * with a `manualContract` override skip extraction and use the declared
 * tables/columns instead.
 */

const fs = require('fs');
const path = require('path');
const db = require('../../models/db');

let schemaCache = null;          // Map<table, Set<column>>
const fileCache = new Map();     // Map<sourcePath, extracted refs>

const PATTERNS = [
  { label: 'db(table)',      re: /\bdb\(['"]([a-z_][a-z0-9_]*)['"]\s*\)/gi, mode: 'table' },
  { label: '.from(table)',   re: /\.from\(['"]([a-z_][a-z0-9_]*)['"]/gi,     mode: 'table' },
  { label: '.into(table)',   re: /\.into\(['"]([a-z_][a-z0-9_]*)['"]/gi,     mode: 'table' },
  { label: '.where(col)',    re: /\.where(?:Not|In|NotIn|Null|NotNull|Between|Raw|ILike|Like)?\(\s*['"]([a-z_][a-z0-9_.]*)['"]/gi, mode: 'col' },
  { label: '.whereObj',      re: /\.where\(\{\s*([a-z_][a-z0-9_]*)\s*:/gi,   mode: 'col' },
  { label: '.andWhere',      re: /\.andWhere\(\s*['"]([a-z_][a-z0-9_.]*)['"]/gi, mode: 'col' },
  { label: '.orWhere',       re: /\.orWhere\(\s*['"]([a-z_][a-z0-9_.]*)['"]/gi,  mode: 'col' },
  { label: '.select(col)',   re: /\.select\(\s*['"]([a-z_][a-z0-9_.]*(?:\s+as\s+\w+)?|\*)['"]/gi, mode: 'col' },
  { label: '.orderBy',       re: /\.orderBy\(\s*['"]([a-z_][a-z0-9_.]*)['"]/gi, mode: 'col' },
  { label: '.groupBy',       re: /\.groupBy\(\s*['"]([a-z_][a-z0-9_.]*)['"]/gi, mode: 'col' },
  { label: '.increment',     re: /\.(?:increment|decrement)\(\s*['"]([a-z_][a-z0-9_]*)['"]/gi, mode: 'col' },
  { label: '.join',          re: /\.(?:join|leftJoin|rightJoin|innerJoin|fullOuterJoin|crossJoin)\(\s*['"]([a-z_][a-z0-9_]*)['"]\s*,\s*['"]([a-z_][a-z0-9_.]*)['"]\s*,\s*['"]([a-z_][a-z0-9_.]*)['"]/gi, mode: 'join' },
  { label: 'db.raw',         re: /\bdb\.raw\(/g, mode: 'raw-flag' },
];

function extractFromSource(src) {
  const tables = new Set();
  const columns = new Set(); // entries like "table.column" or "*.column" (table unknown)
  const warnings = [];
  let rawFlagged = false;

  for (const p of PATTERNS) {
    let m;
    while ((m = p.re.exec(src)) !== null) {
      if (p.mode === 'table') tables.add(m[1]);
      else if (p.mode === 'col') {
        const ref = m[1];
        if (ref === '*') continue;
        if (ref.includes('.')) {
          const [t, c] = ref.split('.');
          tables.add(t);
          columns.add(`${t}.${c}`);
        } else {
          columns.add(`*.${ref}`);
        }
      } else if (p.mode === 'join') {
        tables.add(m[1]);
        for (const ref of [m[2], m[3]]) {
          if (ref.includes('.')) {
            const [t, c] = ref.split('.');
            tables.add(t);
            columns.add(`${t}.${c}`);
          } else columns.add(`*.${ref}`);
        }
      } else if (p.mode === 'raw-flag') {
        rawFlagged = true;
      }
    }
  }
  if (rawFlagged) warnings.push('db.raw detected — add to manual-contracts.js if it references un-scanned tables/columns');
  return { tables: [...tables], columns: [...columns], warnings };
}

async function loadSchema() {
  if (schemaCache) return schemaCache;
  try {
    const rows = await db.raw(`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
    `);
    const map = new Map();
    for (const r of rows.rows || rows) {
      const t = r.table_name, c = r.column_name;
      if (!map.has(t)) map.set(t, new Set());
      map.get(t).add(c);
    }
    schemaCache = map;
    return schemaCache;
  } catch (e) {
    schemaCache = null;
    throw new Error(`Could not load information_schema: ${e.message}`);
  }
}

async function run(tool) {
  const schemaMap = await loadSchema();

  let tables, columns, warnings;
  if (tool.manualContract?.tables || tool.manualContract?.columns) {
    tables = tool.manualContract.tables || [];
    columns = [];
    const colMap = tool.manualContract.columns || {};
    for (const [t, cols] of Object.entries(colMap)) {
      tables.includes(t) || tables.push(t);
      for (const c of cols) columns.push(`${t}.${c}`);
    }
    warnings = [];
  } else {
    if (!fileCache.has(tool.sourcePath)) {
      if (!fs.existsSync(tool.sourcePath)) {
        return { validator: 'db-columns', tool: tool.name, surface: tool.surface, pass: true, severity: 'info', errors: [], notes: ['source file not found — skipped'] };
      }
      fileCache.set(tool.sourcePath, extractFromSource(fs.readFileSync(tool.sourcePath, 'utf8')));
    }
    ({ tables, columns, warnings } = fileCache.get(tool.sourcePath));
  }

  const errors = [];
  for (const t of tables) {
    if (!schemaMap.has(t)) errors.push(`table "${t}" does not exist in public schema`);
  }
  for (const ref of columns) {
    const [t, c] = ref.split('.');
    if (t === '*') continue; // unknown-table column refs are noise — skip
    if (c === '*') continue;
    const cols = schemaMap.get(t);
    if (!cols) continue; // table already flagged above
    if (!cols.has(c)) errors.push(`column "${t}.${c}" does not exist`);
  }

  return {
    validator: 'db-columns',
    tool: tool.name,
    surface: tool.surface,
    pass: errors.length === 0,
    severity: errors.length ? 'critical' : (warnings.length ? 'warning' : 'info'),
    errors,
    warnings,
  };
}

module.exports = { run, _resetCaches: () => { schemaCache = null; fileCache.clear(); } };
