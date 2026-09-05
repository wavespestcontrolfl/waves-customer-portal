/**
 * In-memory knex-shaped store for the link-authority lanes (the bridge, the
 * owner queue). Just enough of the builder API for those modules; the pure
 * §6.3 decision they call is the real one. Emulates the constraints prod
 * enforces on the two tables the owner writes — seo_link_approvals and
 * seo_link_floor_waivers — so an insert prod would reject fails here too.
 */
const { canonicalProspectDomain } = require("../../services/seo/prospect-domain-lock");
const R = require("../../services/seo/link-registry");
const { canonicalEmail } = require("../../services/ads/ad-audience-consent");

let idSeq = 0;
const uid = () => `00000000-0000-4000-8000-${String(++idSeq).padStart(12, '0')}`;
const TABLES = ['seo_link_attempts', 'seo_link_domains', 'seo_link_acquisition_paths', 'seo_link_prospects', 'seo_link_placement_authorities', 'seo_link_floor_waivers', 'seo_link_approvals', 'seo_link_policy', 'seo_link_domain_sources',
  // the §13 customer-recipient exclusion's contact sources (link-outreach-mandate)
  'customers', 'notification_prefs', 'leads'];

function makeDb(seed = {}) {
  const tables = Object.fromEntries(TABLES.map((t) => [t, []]));
  for (const [t, rows] of Object.entries(seed)) tables[t] = rows.map((r) => ({ ...r }));
  const raws = [];
  // Dates compare by instant (a lease token round-trips through toISOString, the store keeps the Date)
  const eq = (l, r) => ((l instanceof Date || r instanceof Date) && l != null && r != null ? new Date(l).getTime() === new Date(r).getTime() : l === r);
  const op = (a, l, r) => (a === '<' ? l < r : a === '<=' ? l <= r : a === '>' ? l > r : a === '>=' ? l >= r : a === '<>' || a === '!=' ? !eq(l, r) : eq(l, r));
  function builder(table) {
    const rows = tables[table];
    if (!rows) throw new Error(`unknown table ${table}`);
    const st = { preds: [], order: null, limit: null, cols: null, count: false };
    const matches = (r) => st.preds.every((p) => p(r));
    const project = (r) => (!st.cols || st.cols.includes('*') ? { ...r } : Object.fromEntries(st.cols.map((c) => { const m = /^(\w+) as (\w+)$/.exec(c); return m ? [m[2], r[m[1]]] : [c, r[c]]; })));
    const resolve = () => {
      if (db._beforeResolve) db._beforeResolve(table, db);
      let out = rows.filter(matches);
      const sortKey = (v) => (v instanceof Date ? v.getTime() : typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) ? Date.parse(v) : String(v));
      if (st.order) out = [...out].sort((a, b) => (sortKey(a[st.order.col]) < sortKey(b[st.order.col]) ? -1 : 1) * (st.order.dir === 'desc' ? -1 : 1));
      if (st.limit != null) out = out.slice(0, st.limit);
      return out.map(project);
    };
    const q = {
      where(a, b, c) {
        if (typeof a === 'function') { const sub = builder(table); a.call(sub, sub); st.preds.push(sub._matches); }
        else if (typeof a === 'object') st.preds.push((r) => Object.entries(a).every(([k, v]) => eq(r[k], v)));
        else if (c !== undefined) st.preds.push((r) => op(b, r[a], c));
        else st.preds.push((r) => eq(r[a], b));
        return q;
      },
      _matches: matches,
      orWhere(...args) { const prior = [...st.preds]; const sub = builder(table); sub.where(...args); st.preds = [(r) => prior.every((p) => p(r)) || sub._matches(r)]; return q; },
      whereNot(col, value) { st.preds.push((r) => !eq(r[col], value)); return q; },
      count() { st.countRows = true; return q; },
      whereNull(col) { st.preds.push((r) => r[col] == null); return q; },
      whereNotNull(col) { st.preds.push((r) => r[col] != null); return q; },
      whereIn(col, arr) { st.preds.push((r) => arr.includes(r[col])); return q; },
      whereNotIn(col, arr) { st.preds.push((r) => !arr.includes(r[col])); return q; },
      whereRaw(sql, bindings = []) {
        // the stored-address form link-outreach-mandate compares in: lower-cased, every whitespace character removed
        const lower = (v) => String(v == null ? '' : v).replace(/\s+/g, '').toLowerCase();
        const STORED = "LOWER\\(REGEXP_REPLACE\\(\\?\\?, '\\\\s', '', 'g'\\)\\)";
        if (new RegExp(`^${STORED} = ANY\\(\\?\\)$`).test(sql)) st.preds.push((r) => bindings[1].includes(lower(r[bindings[0]])));
        else if (new RegExp(`^split_part\\(${STORED}, '@', 2\\) = ANY\\(\\?\\)$`).test(sql)) st.preds.push((r) => bindings[1].includes(lower(r[bindings[0]]).split('@')[1]));
        else if (new RegExp(`^split_part\\(${STORED}, '@', 2\\) = ANY\\(\\?\\) OR split_part\\(${STORED}, '@', 2\\) LIKE ANY\\(\\?\\)$`).test(sql)) st.preds.push((r) => { const host = lower(r[bindings[0]]).split('@')[1] || ''; return bindings[1].includes(host) || bindings[3].some((p) => host.endsWith(p.slice(1))); });
        else if (/gmail-canonical/.test(sql)) st.preds.push((r) => { const c = canonicalEmail(r[bindings[0]]); return Boolean(c) && bindings[1].includes(c.split('@')[1]) && bindings[3].includes(c.split('@')[0]); });
        else if (/split_part/.test(sql)) st.preds.push((r) => canonicalProspectDomain(r.target_domain) === bindings[0]);
        // the sender's ET-day attempt count (link-prospect-outreach dailySendCount): every initial AND follow-up attempt since `since`
        else if (/outreach_attempted_at >= \?/.test(sql)) {
          const since = new Date(bindings[0]).getTime();
          const attempted = (v) => v != null && new Date(v).getTime() >= since;
          st.count = (r) => (attempted(r.outreach_attempted_at) ? 1 : 0) + (attempted(r.follow_up_attempted_at) ? 1 : 0);
          st.preds.push((r) => st.count(r) > 0);
        }
        else if (/COALESCE\(link_type, ''\) NOT IN/.test(sql)) st.preds.push((r) => !bindings.includes(r.link_type || ''));
        // the domain admission guard (prospect-domain-lock notClosedConversation): a closure-stamped conversation is not in flight
        else if (/^\(conversation_closed_at IS NULL OR status NOT IN/.test(sql)) st.preds.push((r) => r.conversation_closed_at == null || !bindings.includes(r.status));
        else throw new Error(`unsupported whereRaw: ${sql}`);
        return q;
      },
      orderBy(col, dir = 'asc') { st.order = { col, dir }; return q; },
      limit(n) { st.limit = n; return q; },
      // `col as alias` projections (the recipient lookup selects `id as id` / `customer_id as id`)
      select(...cols) { const named = cols.filter((c) => typeof c === 'string'); st.cols = named.length ? named : null; return q; },
      forUpdate() { raws.push(`FOR UPDATE ${table}`); return q; },
      skipLocked() { return q; },
      async first(...cols) { if (cols.length) st.cols = cols; if (st.countRows) return { n: String(rows.filter(matches).length) }; if (st.count) return { c: String(rows.filter(matches).reduce((n, r) => n + st.count(r), 0)) }; return resolve()[0]; },
      // resolves to the affected count; `.returning('*')` yields the updated rows (the sender's CAS + finalize)
      update(patch) {
        const apply = () => { if (db._failUpdate === table) throw new Error(`injected failure on ${table}`); if (db._beforeUpdate) db._beforeUpdate(table, db); const hit = rows.filter(matches); for (const r of hit) Object.assign(r, patch); return hit; };
        let hit = null; const once = () => (hit || (hit = apply()));
        return { returning: async () => once().map((r) => ({ ...r })), then: (res, rej) => Promise.resolve().then(() => once().length).then(res, rej) };
      },
      insert(row) {
        const created = { id: uid(), ...row };
        if (table === 'seo_link_placement_authorities' && rows.some((r) => r.prospect_id === row.prospect_id && r.dimension === row.dimension && r.instance_key === row.instance_key)) throw new Error('duplicate key value violates unique constraint "seo_link_placement_authorities_prospect_id_dimension_instance_key_unique"');
        if (table === 'seo_link_placement_authorities' && rows.some((r) => r.prospect_id === row.prospect_id && r.dimension === row.dimension && r.instance_kind === row.instance_kind && r.ended_at == null)) throw new Error('duplicate key value violates unique constraint "seo_link_placement_authorities_open_instance_uniq"');
        if (table === "seo_link_approvals") checkApproval(created);
        if (table === "seo_link_floor_waivers") checkWaiver(created);
        rows.push(created);
        return { returning: async () => [{ ...created }], then: (res, rej) => Promise.resolve([{ ...created }]).then(res, rej) };
      },
      then(res, rej) { return Promise.resolve(resolve()).then(res, rej); },
    };
    return q;
  }
  const db = Object.assign((table) => builder(table), {
    _failUpdate: null,
    _beforeResolve: null,
    _beforeUpdate: null,
    raw: async (sql, bindings = []) => { raws.push(bindings.length ? `${sql} ${JSON.stringify(bindings)}` : sql); return {}; },
    transaction: async (cb) => cb(db),
    _tables: tables,
    _raws: raws,
  });
  return db;
}

// seo_link_approvals CHECKs (migration 20260903000020), same-row only
function checkApproval(row) {
  const fail = (name) => { throw new Error(`new row for relation "seo_link_approvals" violates check constraint "seo_link_approvals_${name}_check"`); };
  for (const col of ["prospect_id", "path_id", "path_revision", "decision_inputs_hash", "money_action", "decision", "authority", "terms_snapshot", "dimension", "action", "instance_key", "approved_by"]) {
    if (row[col] === null || row[col] === undefined) throw new Error(`null value in column "${col}" of relation "seo_link_approvals" violates not-null constraint`);
  }
  if (!R.APPROVAL_DECISIONS.includes(row.decision)) fail("decision");
  if (!R.APPROVABLE_LEVELS.includes(row.authority)) fail("authority");
  if (!R.AUTHORITY_DIMENSIONS.includes(row.dimension)) fail("dimension");
  if (!R.APPROVAL_ACTIONS.includes(row.action)) fail("action");
  if (!(R.ACTIONS_BY_DIMENSION[row.dimension] || []).includes(row.action)) fail("dimension_action");
  if (row.money_action !== (row.dimension === "payment")) fail("money_action");
  const amt = row.approved_amount_cents ?? null; const max = row.max_payable_cents ?? null;
  const ok = (!(row.money_action && row.decision === "approved") || (amt !== null && amt > 0 && max !== null && max >= amt))
    && (row.decision === "approved" || (amt === null && max === null))
    && (row.money_action || (amt === null && max === null));
  if (!ok) fail("money_terms");
}
function checkWaiver(row) {
  for (const col of ["domain_id", "path_id", "overridden_floors", "decision_inputs_hash", "approved_by"]) {
    if (row[col] === null || row[col] === undefined) throw new Error(`null value in column "${col}" of relation "seo_link_floor_waivers" violates not-null constraint`);
  }
}

module.exports = { makeDb, uid, TABLES, checkApproval, checkWaiver };
