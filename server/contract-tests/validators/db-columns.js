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

function stripAs(ref) {
  // '.select('foo as bar')' or '.select('table.col as alias')' → return just 'foo' or 'table.col'
  return ref.split(/\s+as\s+/i)[0].trim();
}

function extractFromSource(src) {
  const sourceTables = new Set();   // tables used as real query sources (db, from, into, join's first arg)
  const qualifierTables = new Set(); // tables that appear only as "table.col" qualifiers (likely join aliases)
  const columns = new Set();         // entries like "table.column" (filtered against actual tables later)
  const warnings = [];
  let rawFlagged = false;

  for (const p of PATTERNS) {
    let m;
    while ((m = p.re.exec(src)) !== null) {
      if (p.mode === 'table') sourceTables.add(m[1]);
      else if (p.mode === 'col') {
        const ref = stripAs(m[1]);
        if (!ref || ref === '*') continue;
        if (ref.includes('.')) {
          const [t, c] = ref.split('.');
          if (!c || c === '*') continue;
          qualifierTables.add(t);
          columns.add(`${t}.${c}`);
        }
        // bare column refs — skip (can't validate without knowing the table)
      } else if (p.mode === 'join') {
        sourceTables.add(m[1]);
        for (const rawRef of [m[2], m[3]]) {
          const ref = stripAs(rawRef);
          if (ref.includes('.')) {
            const [t, c] = ref.split('.');
            if (!c || c === '*') continue;
            qualifierTables.add(t);
            columns.add(`${t}.${c}`);
          }
        }
      } else if (p.mode === 'raw-flag') {
        rawFlagged = true;
      }
    }
  }
  if (rawFlagged) warnings.push('db.raw detected — add to manual-contracts.js if it references un-scanned tables/columns');
  return {
    sourceTables: [...sourceTables],
    qualifierTables: [...qualifierTables],
    columns: [...columns],
    warnings,
  };
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

  let sourceTables, qualifierTables, columns, warnings = [];
  if (tool.manualContract?.tables || tool.manualContract?.columns) {
    sourceTables = [...(tool.manualContract.tables || [])];
    qualifierTables = [];
    columns = [];
    const colMap = tool.manualContract.columns || {};
    for (const [t, cols] of Object.entries(colMap)) {
      if (!sourceTables.includes(t)) sourceTables.push(t);
      for (const c of cols) columns.push(`${t}.${c}`);
    }
  } else {
    if (!fileCache.has(tool.sourcePath)) {
      if (!fs.existsSync(tool.sourcePath)) {
        return { validator: 'db-columns', tool: tool.name, surface: tool.surface, pass: true, severity: 'info', errors: [], notes: ['source file not found — skipped'] };
      }
      fileCache.set(tool.sourcePath, extractFromSource(fs.readFileSync(tool.sourcePath, 'utf8')));
    }
    ({ sourceTables, qualifierTables, columns, warnings } = fileCache.get(tool.sourcePath));
  }

  const errors = [];
  const demoted = []; // column-qualifier tables that don't exist → treated as join aliases → warning

  for (const t of sourceTables) {
    if (!schemaMap.has(t)) errors.push(`table "${t}" does not exist in public schema`);
  }
  const sourceSet = new Set(sourceTables);
  for (const t of qualifierTables) {
    if (sourceSet.has(t)) continue; // already covered
    if (!schemaMap.has(t)) {
      demoted.push(`alias "${t}" not a real table (likely a join alias) — declare in manual-contracts.js if this is a real table`);
    }
  }
  for (const ref of columns) {
    const [t, c] = ref.split('.');
    if (c === '*') continue;
    const cols = schemaMap.get(t);
    if (!cols) continue; // table-level error or aliased — don't double-report
    if (!cols.has(c)) errors.push(`column "${t}.${c}" does not exist`);
  }

  const allWarnings = [...warnings, ...demoted];
  return {
    validator: 'db-columns',
    tool: tool.name,
    surface: tool.surface,
    pass: errors.length === 0,
    severity: errors.length ? 'critical' : (allWarnings.length ? 'warning' : 'info'),
    errors,
    warnings: allWarnings,
  };
}

module.exports = { run, _resetCaches: () => { schemaCache = null; fileCache.clear(); } };
