/**
 * DB-column validator — the money check.
 *
 * Regex-scans each tool's source file for Knex patterns and verifies the
 * referenced tables/columns exist in `information_schema.columns`. Tools
 * with a `manualContract` override skip extraction and use the declared
 * tables/columns instead.
 */

const fs = require('fs');
const db = require('../../models/db');

let OVERRIDES = {};
try { OVERRIDES = require('../overrides/manual-contracts'); } catch { /* optional */ }
const GLOBAL = OVERRIDES._global || {};
const GLOBAL_OPTIONAL_TABLES = new Set(GLOBAL.optionalTables || []);
const GLOBAL_OPTIONAL_COLUMNS = GLOBAL.optionalColumns || {}; // { table: [col,...] }

let schemaCache = null;          // Map<table, Set<column>>
const fileCache = new Map();     // Map<sourcePath, extracted refs>

const PATTERNS = [
  // "table" or "table as alias" — the alias (group 2) is recorded so
  // qualifier refs like "alias.col" aren't misread as tables.
  { label: 'db(table)',      re: /\bdb\(['"]([a-z_][a-z0-9_]*)(?:\s+as\s+([a-z_][a-z0-9_]*))?['"]\s*\)/gi, mode: 'table' },
  { label: '.from(table)',   re: /\.from\(['"]([a-z_][a-z0-9_]*)(?:\s+as\s+([a-z_][a-z0-9_]*))?['"]/gi,     mode: 'table' },
  { label: '.into(table)',   re: /\.into\(['"]([a-z_][a-z0-9_]*)(?:\s+as\s+([a-z_][a-z0-9_]*))?['"]/gi,     mode: 'table' },
  { label: '.where(col)',    re: /\.where(?:Not|In|NotIn|Null|NotNull|Between|Raw|ILike|Like)?\(\s*['"]([a-z_][a-z0-9_.]*)['"]/gi, mode: 'col' },
  { label: '.whereObj',      re: /\.where\(\{\s*([a-z_][a-z0-9_]*)\s*:/gi,   mode: 'col' },
  { label: '.andWhere',      re: /\.andWhere\(\s*['"]([a-z_][a-z0-9_.]*)['"]/gi, mode: 'col' },
  { label: '.orWhere',       re: /\.orWhere\(\s*['"]([a-z_][a-z0-9_.]*)['"]/gi,  mode: 'col' },
  { label: '.select(col)',   re: /\.select\(\s*['"]([a-z_][a-z0-9_.]*(?:\s+as\s+\w+)?|\*)['"]/gi, mode: 'col' },
  { label: '.orderBy',       re: /\.orderBy\(\s*['"]([a-z_][a-z0-9_.]*)['"]/gi, mode: 'col' },
  { label: '.groupBy',       re: /\.groupBy\(\s*['"]([a-z_][a-z0-9_.]*)['"]/gi, mode: 'col' },
  { label: '.increment',     re: /\.(?:increment|decrement)\(\s*['"]([a-z_][a-z0-9_]*)['"]/gi, mode: 'col' },
  { label: '.join',          re: /\.(?:join|leftJoin|rightJoin|innerJoin|fullOuterJoin|crossJoin)\(\s*['"]([a-z_][a-z0-9_]*)(?:\s+as\s+([a-z_][a-z0-9_]*))?['"]\s*,\s*['"]([a-z_][a-z0-9_.]*)['"]\s*,\s*['"]([a-z_][a-z0-9_.]*)['"]/gi, mode: 'join' },
  { label: 'db.raw',         re: /\b(?:db|trx|knex)\s*\.raw\(/g, mode: 'raw-flag' },
  // Object-alias form: db({ p: 'payments' }) / .from({ c: 'customers' }) /
  // .leftJoin({ e: 'estimates' }, ...). Group 1 = alias, group 2 = table.
  // NOTE: the \b guards only the db( alternative — a leading \b before the
  // .method( alternative would reject chained calls at start-of-line or
  // after ')' (".leftJoin(" preceded by whitespace/paren has no boundary).
  { label: 'obj-alias',      re: /(?:\bdb\(|\.(?:from|into|join|leftJoin|rightJoin|innerJoin|fullOuterJoin|crossJoin)\()\s*\{\s*([a-z_][\w]*)\s*:\s*['"]([a-z_][a-z0-9_]*)['"]\s*\}/gi, mode: 'obj-table' },
];

// ── Raw-SQL table extraction ─────────────────────────────────────────────
// db.raw() bodies used to be a blanket "add to manual-contracts" warning —
// 151 tools carried it, which made the warning meaningless. Most raw SQL is
// statically readable: pull the string literal (including template literals),
// extract table tokens after FROM / JOIN / INTO / UPDATE, and validate them
// against information_schema like any other source table. Only genuinely
// dynamic SQL (interpolated/bound table position) keeps the warning.

// First string arg of db.raw(...) — template literal, single- or double-quoted.
const RAW_CALL = /\b(?:db|trx|knex)\s*\.raw\(\s*(`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g;
// CTE names ("WITH x AS (", ", y AS (") are query-local, not schema tables.
const CTE_NAMES = /(?:\bwith\s+(?:recursive\s+)?|,\s*)([a-z_][\w]*)\s+as\s*\(/gi;
// Token in table position. Captures identifiers (optionally schema-qualified
// or quoted), interpolations (${), knex bindings (? / ??), or subquery "(".
const TABLE_POS = /\b(?:from|join|into|update)\s+(\$\{|\?\??|\(|"?[a-z_][\w]*"?(?:\."?[a-z_][\w]*"?)?)/gi;
// SQL keywords that legally follow FROM/JOIN/UPDATE without being tables,
// plus set-returning functions (identifier immediately followed by "(").
const NOT_TABLES = new Set(['select', 'set', 'only', 'lateral', 'values', 'unnest', 'generate_series', 'jsonb_array_elements', 'json_array_elements', 'jsonb_each', 'json_each', 'regexp_split_to_table', 'string_to_table']);

// db.raw(SOME_CONST) — first arg is an identifier. Resolved against
// `const SOME_CONST = '...'` / backtick literals defined in the same file.
const RAW_IDENT_CALL = /\b(?:db|trx|knex)\s*\.raw\(\s*([A-Za-z_$][\w$]*)\s*[,)]/g;

function analyzeSqlString(sql, rawTables, rawAliases, rawColRefs) {
  // Returns true if a table position is interpolated/bound (dynamic).
  let dynamic = false;
  // Qualified column refs ("alias.col" / "table.col") — collected for
  // validation, but ONLY refs whose qualifier resolves to a table or alias
  // this file actually declares get validated (extractFromSource filters).
  // SQL string literals are blanked first so 'text.with.dots' can't match.
  if (rawColRefs) {
    const noLiterals = sql.replace(/'(?:[^'\\]|\\.)*'/g, "''");
    let q;
    const QUAL_COL = /\b([a-z_][\w]*)\.([a-z_][\w]*)\b/gi;
    while ((q = QUAL_COL.exec(noLiterals)) !== null) {
      rawColRefs.push([q[1].toLowerCase(), q[2].toLowerCase()]);
    }
  }
  // Bare "table" / "table as alias" fragment (e.g. .from(db.raw('sms_log as
  // reply'))) — a table reference with no query clause around it.
  const bare = /^\s*([a-z_][a-z0-9_]*)(?:\s+(?:as\s+)?([a-z_][\w]*))?\s*$/i.exec(sql);
  if (bare && !NOT_TABLES.has(bare[1].toLowerCase())) {
    rawTables.add(bare[1].toLowerCase());
    if (bare[2]) rawAliases.push([bare[2].toLowerCase(), bare[1].toLowerCase()]);
    return false;
  }
  const ctes = new Set();
  let c;
  CTE_NAMES.lastIndex = 0;
  while ((c = CTE_NAMES.exec(sql)) !== null) ctes.add(c[1].toLowerCase());
  let t;
  TABLE_POS.lastIndex = 0;
  while ((t = TABLE_POS.exec(sql)) !== null) {
    // "FROM" has non-table meanings: EXTRACT(field FROM expr), IS DISTINCT
    // FROM, TRIM(... FROM ...). The word before this match disambiguates.
    const before = /([a-z_]+)\s*$/i.exec(sql.slice(0, t.index));
    if (before && /^(epoch|year|month|week|day|dow|doy|isodow|isoyear|hour|minute|second|quarter|millisecond|microsecond|century|decade|timezone_hour|timezone_minute|distinct|both|leading|trailing)$/i.test(before[1])) continue;
    const tok = t[1];
    if (tok === '${' || tok === '?' || tok === '??') { dynamic = true; continue; }
    if (tok === '(') continue; // subquery — its own FROMs are scanned too
    const parts = tok.replace(/"/g, '').split('.');
    // Dotted token in table position: a real schema-qualified table is
    // "public.x" here; anything else ("c.created_at" inside a function's
    // FROM) is a column ref, not a table.
    if (parts.length === 2 && parts[0].toLowerCase() !== 'public') continue;
    const table = parts[parts.length - 1].toLowerCase();
    if (ctes.has(table) || NOT_TABLES.has(table)) continue;
    const rest = sql.slice(t.index + t[0].length);
    if (rest.startsWith('(')) continue; // function call
    rawTables.add(table);
    // "FROM customers c" / "JOIN x AS y" — record the alias→table pair so
    // qualifier refs like "c.name" validate against the aliased table.
    const a = /^\s+(?:as\s+)?([a-z_][\w]*)/i.exec(rest);
    if (a && !NOT_TABLES.has(a[1].toLowerCase()) && !['on', 'where', 'group', 'order', 'left', 'right', 'inner', 'join', 'using', 'set', 'limit', 'having', 'union', 'cross', 'full'].includes(a[1].toLowerCase())) {
      rawAliases.push([a[1].toLowerCase(), table]);
    }
  }
  return dynamic;
}

function extractRawSql(src) {
  const rawTables = new Set();
  const rawAliases = []; // [alias, table] pairs
  const rawColRefs = []; // [qualifier, column] pairs from qualified refs
  let dynamic = false;
  let literalCalls = 0;
  let m;
  RAW_CALL.lastIndex = 0;
  while ((m = RAW_CALL.exec(src)) !== null) {
    literalCalls += 1;
    // Expression fragments (COUNT(*), COALESCE(...) as x, intervals) carry
    // no FROM/JOIN — analyzeSqlString finds no table positions and they are
    // ignored, interpolated or not: only QUERY clauses can go stale.
    if (analyzeSqlString(m[1].slice(1, -1), rawTables, rawAliases, rawColRefs)) dynamic = true;
  }
  // db.raw(SOME_CONST): resolve the constant's literal in this file and
  // analyze it like an inline literal.
  let identCalls = 0;
  RAW_IDENT_CALL.lastIndex = 0;
  while ((m = RAW_IDENT_CALL.exec(src)) !== null) {
    identCalls += 1;
    const name = m[1];
    const def = new RegExp(`\\b${name}\\s*=\\s*(\`(?:[^\`\\\\]|\\\\.)*\`|'(?:[^'\\\\]|\\\\.)*'|"(?:[^"\\\\]|\\\\.)*")`).exec(src);
    if (def) {
      if (analyzeSqlString(def[1].slice(1, -1), rawTables, rawAliases, rawColRefs)) dynamic = true;
    } else {
      dynamic = true; // variable/parameter we can't resolve statically
    }
  }
  // Raw calls that are neither string/number literals nor bare identifiers
  // (concatenation, function calls, member expressions) are unanalyzable.
  const numericCalls = (src.match(/\b(?:db|trx|knex)\s*\.raw\(\s*\d+(?:\.\d+)?\s*[,)]/g) || []).length;
  const totalRawCalls = (src.match(/\b(?:db|trx|knex)\s*\.raw\(/g) || []).length;
  if (totalRawCalls > literalCalls + identCalls + numericCalls) dynamic = true;
  return { rawTables: [...rawTables], rawAliases, rawColRefs, dynamic };
}

function stripAs(ref) {
  // '.select('foo as bar')' or '.select('table.col as alias')' → return just 'foo' or 'table.col'
  return ref.split(/\s+as\s+/i)[0].trim();
}

function extractFromSource(src) {
  const sourceTables = new Set();   // tables used as real query sources (db, from, into, join's first arg)
  const qualifierTables = new Set(); // tables that appear only as "table.col" qualifiers (likely join aliases)
  // alias → Set of tables it stands for (same letter can alias different
  // tables in different queries within one file) — columns qualified by an
  // alias are validated against the union of its candidate tables.
  const aliasTables = new Map();
  const addAlias = (alias, table) => {
    const k = alias.toLowerCase();
    if (!aliasTables.has(k)) aliasTables.set(k, new Set());
    if (table) aliasTables.get(k).add(table.toLowerCase());
  };
  const columns = new Set();         // entries like "table.column" (filtered against actual tables later)
  const warnings = [];
  let rawFlagged = false;

  for (const p of PATTERNS) {
    let m;
    while ((m = p.re.exec(src)) !== null) {
      if (p.mode === 'table') {
        sourceTables.add(m[1]);
        if (m[2]) addAlias(m[2], m[1]);
      }
      else if (p.mode === 'obj-table') {
        addAlias(m[1], m[2]);
        sourceTables.add(m[2]);
      }
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
        if (m[2]) addAlias(m[2], m[1]);
        for (const rawRef of [m[3], m[4]]) {
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
  let rawTables = [];
  if (rawFlagged) {
    const raw = extractRawSql(src);
    rawTables = raw.rawTables;
    for (const [a, t] of raw.rawAliases) addAlias(a, t);
    // Qualified refs from raw SQL: validate only those whose qualifier is a
    // declared alias or a table this file queries — unknown qualifiers
    // (CTEs, subquery aliases, pg_catalog) are ignored, never guessed at.
    const rawTableSet = new Set(rawTables);
    for (const [q, c] of raw.rawColRefs) {
      if (aliasTables.has(q) || rawTableSet.has(q) || sourceTables.has(q)) {
        columns.add(`${q}.${c}`);
      }
    }
    if (raw.dynamic) {
      warnings.push('dynamic db.raw SQL (interpolated/bound table position or unresolvable arg) — declare its tables in manual-contracts.js');
    }
  }
  const aliasMap = {};
  for (const [a, ts] of aliasTables) aliasMap[a] = [...ts];
  return {
    sourceTables: [...sourceTables],
    qualifierTables: [...qualifierTables],
    aliasMap,
    rawTables,
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

  let sourceTables, qualifierTables, aliasMap = {}, rawTables = [], columns, warnings = [];
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
    ({ sourceTables, qualifierTables, aliasMap = {}, rawTables = [], columns, warnings } = fileCache.get(tool.sourcePath));
  }

  const errors = [];
  const demoted = []; // suspicious-but-tolerable findings → warning
  const notes = [];   // by-design tolerations (declared optional) → informational only
  const toolOptionalTables = new Set([...(tool.manualContract?.optionalTables || []), ...GLOBAL_OPTIONAL_TABLES]);
  const toolOptionalColumns = { ...GLOBAL_OPTIONAL_COLUMNS, ...(tool.manualContract?.optionalColumns || {}) };

  for (const t of sourceTables) {
    if (!schemaMap.has(t)) {
      if (toolOptionalTables.has(t)) notes.push(`optional table "${t}" missing — tolerated (declared optional)`);
      else errors.push(`table "${t}" does not exist in public schema`);
    }
  }
  for (const t of rawTables) {
    if (!schemaMap.has(t)) {
      if (toolOptionalTables.has(t)) notes.push(`optional table "${t}" (raw SQL) missing — tolerated (declared optional)`);
      else errors.push(`table "${t}" (referenced in raw SQL) does not exist in public schema`);
    }
  }
  const sourceSet = new Set(sourceTables);
  for (const t of qualifierTables) {
    if (sourceSet.has(t)) continue; // already covered
    if (aliasMap[t]) continue;      // declared "as <alias>" — resolved in the column pass
    if (!schemaMap.has(t)) {
      if (toolOptionalTables.has(t)) continue;
      demoted.push(`alias "${t}" not a real table (likely a join alias) — declare in manual-contracts.js if this is a real table`);
    }
  }
  for (const ref of columns) {
    const [t, c] = ref.split('.');
    if (c === '*') continue;
    if (toolOptionalTables.has(t)) continue;
    let cols = schemaMap.get(t);
    let label = t;
    if (!cols && aliasMap[t]) {
      // Alias-qualified ref: validate against the UNION of its candidate
      // tables (one letter can alias different tables across queries in a
      // file) — a column existing in any candidate passes; in none, fails.
      const candidates = aliasMap[t].filter((ct) => schemaMap.has(ct));
      if (candidates.length === 0) continue; // candidate tables already errored at table level
      if (candidates.some((ct) => schemaMap.get(ct).has(c))) continue;
      if (candidates.some((ct) => (toolOptionalColumns[ct] || []).includes(c))) {
        notes.push(`optional column "${t}.${c}" missing — tolerated`);
        continue;
      }
      cols = new Set(); // fall through to report with the alias expansion
      label = `${t} → ${candidates.join('|')}`;
    }
    if (!cols) continue; // table-level error — don't double-report
    if (!cols.has(c)) {
      const optCols = toolOptionalColumns[t] || [];
      if (optCols.includes(c)) notes.push(`optional column "${t}.${c}" missing — tolerated`);
      else errors.push(`column "${label}.${c}" does not exist`);
    }
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
    notes,
  };
}

module.exports = { run, _resetCaches: () => { schemaCache = null; fileCache.clear(); } };
