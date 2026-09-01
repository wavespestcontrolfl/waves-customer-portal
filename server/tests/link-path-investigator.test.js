/**
 * Step-3 path investigator (plan §5): selector priorities, the gated/dryRun
 * no-ops, the deterministic currency gate + cents wiring, per-dimension §3.2
 * revision bumps, path upsert idempotency, minimal supersession, the ≤8 fetch
 * cap, repair-retry on schema failure, and the domain finish (best path,
 * score, agent_state verdict). In-memory knex-shaped store — the real unique
 * identity (active (domain_id, path_key)) is enforced by the fake.
 */

jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));
const { isEnabled } = require('../config/feature-gates');
const MODELS = require('../config/models');
const investigator = require('../services/seo/link-path-investigator');
const { investigatePaths, MAX_FETCHES_PER_DOMAIN, SUBMISSION_VERIFY_BUDGET, TERMS_FETCH_BUDGET, _internals } = investigator;

// ---------------------------------------------------------------------------
// In-memory knex-shaped store
// ---------------------------------------------------------------------------
let idSeq = 0;
const uid = () => `00000000-0000-4000-8000-${String(++idSeq).padStart(12, '0')}`;

function makeDb(seed = {}) {
  const tables = {
    seo_link_domains: [], seo_link_acquisition_paths: [], seo_link_domain_sources: [],
    seo_competitor_backlinks: [], seo_link_prospects: [], seo_link_attempts: [],
    ...seed,
  };
  const stripAlias = (expr) => {
    const m = String(expr).match(/^(\S+)\s+as\s+(\S+)$/i);
    return m ? { table: m[1], alias: m[2] } : { table: expr, alias: null };
  };

  function builder(tableExpr) {
    const { table, alias } = stripAlias(tableExpr);
    const state = { table, alias, preds: [], join: null, select: null, order: [], limit: null, dedupe: false };
    // Joined rows are { base, joined, byAlias } — a column reference resolves
    // by its prefix (either side, either join direction); un-prefixed columns
    // read the base table. A `db.ref('x.y')` value resolves the same way.
    const colVal = (row, col) => {
      const c = String(col);
      if (state.join) {
        if (c.includes('.')) {
          const [pfx, name] = c.split('.');
          return (row.byAlias[pfx] || row.base)[name];
        }
        return row.base[c];
      }
      const name = c.includes('.') ? c.split('.')[1] : c;
      return row[name];
    };
    const val = (row, get, v) => (v && typeof v === 'object' && v.__ref ? get(row, v.__ref) : v);
    const cmp = (op, l, r) => (op === '<=' ? l <= r : op === '<' ? l < r : op === '>' ? l > r : op === '>=' ? l >= r : l === r);
    const matches = (row) => state.preds.every((p) => p(row, colVal));
    const baseRows = () => {
      if (!state.join) return tables[table].filter(matches);
      const { table: jt, alias: ja } = stripAlias(state.join.tableExpr);
      const side = (ref) => { const [pfx, col] = String(ref).split('.'); return { onBase: pfx === alias || pfx === table, col }; };
      const s1 = side(state.join.on1); const s2 = side(state.join.on2);
      const baseCol = s1.onBase ? s1.col : s2.col;
      const joinCol = s1.onBase ? s2.col : s1.col;
      const joined = tables[table].flatMap((b) => tables[jt]
        .filter((j) => j[joinCol] === b[baseCol])
        .map((j) => ({ base: b, joined: j, byAlias: { [alias || table]: b, [ja || jt]: j } })));
      return joined.filter(matches);
    };
    const resolve = () => {
      let rows = baseRows();
      if (state.join) {
        // aggregate order (MIN/MAX(col) asc/desc) sorts the joined rows first,
        // so the dedupe below keeps each group's extreme in group order
        for (const o of [...state.order].reverse()) {
          const m = o.raw && o.raw.match(/^(MIN|MAX)\(([\w.]+)\)\s*(asc|desc)?$/i);
          if (!m) continue;
          const desc = (m[1].toUpperCase() === 'MAX') === !/asc/i.test(m[3] || '');
          rows = [...rows].sort((a, b) => (new Date(colVal(a, m[2])) - new Date(colVal(b, m[2]))) * (desc ? -1 : 1));
        }
        // projection: explicit prefixed columns → one row per distinct tuple
        // (GROUP BY); otherwise the base rows, deduped by id
        const projected = (state.select || []).filter((c) => typeof c === 'string' && c.includes('.') && !c.endsWith('.*'));
        const seen = new Set();
        if (projected.length) {
          rows = rows.map((r) => Object.fromEntries(projected.map((c) => [c.split('.')[1], colVal(r, c)])))
            .filter((r) => { const k = JSON.stringify(r); return seen.has(k) ? false : (seen.add(k), true); });
        } else {
          rows = rows.map((r) => r.base).filter((d) => (seen.has(d.id) ? false : (seen.add(d.id), true)));
        }
      }
      for (const o of [...state.order].reverse()) {
        if (o.raw && /owner_seed/.test(o.raw)) {
          rows = [...rows].sort((a, b) => (a.discovery_priority === 'owner_seed' ? 0 : 1) - (b.discovery_priority === 'owner_seed' ? 0 : 1));
        } else if (o.col) {
          const name = o.col.includes('.') ? o.col.split('.')[1] : o.col;
          rows = [...rows].sort((a, b) => (new Date(a[name]) - new Date(b[name])) * (o.dir === 'desc' ? -1 : 1));
        }
      }
      if (state.limit != null) rows = rows.slice(0, state.limit);
      return rows.map((r) => ({ ...r }));
    };
    const q = {
      where(a, b, c) {
        if (typeof a === 'function') {
          // grouped where: OR-combined like knex's callback builder
          const preds = [];
          const sub = {
            whereNull(col) { preds.push((row, get) => get(row, col) == null); return sub; },
            whereNot(col, val) { preds.push((row, get) => get(row, col) !== val); return sub; },
            orWhere(col, op, v) {
              preds.push(v === undefined
                ? (row, get) => get(row, col) === op
                : (row, get) => cmp(op, get(row, col), val(row, get, v)));
              return sub;
            },
          };
          a(sub);
          state.preds.push((row, get) => preds.some((p) => p(row, get)));
          return q;
        }
        if (typeof a === 'object') state.preds.push((row, get) => Object.entries(a).every(([k, v]) => get(row, k) === v));
        else if (c !== undefined) state.preds.push((row, get) => cmp(b, get(row, a), val(row, get, c)));
        else state.preds.push((row, get) => get(row, a) === b);
        return q;
      },
      whereNull(col) { state.preds.push((row, get) => get(row, col) == null); return q; },
      whereIn(col, arr) { state.preds.push((row, get) => arr.includes(get(row, col))); return q; },
      whereNotIn(col, arr) { state.preds.push((row, get) => !arr.includes(get(row, col))); return q; },
      join(tableExpr, on1, on2) { state.join = { tableExpr, on1, on2 }; return q; },
      forUpdate() { return q; },
      groupBy() { return q; },
      select(...cols) { state.select = cols; return q; },
      orderBy(col, dir) { state.order.push({ col, dir }); return q; },
      orderByRaw(raw) { state.order.push({ raw }); return q; },
      limit(n) { state.limit = n; return q; },
      async first() { return resolve()[0]; },
      async update(patch) {
        const hit = tables[table].filter(matches);
        for (const row of hit) Object.assign(row, patch);
        return hit.length;
      },
      insert(row) {
        return {
          onConflict: () => ({
            async ignore() {
              if (table === 'seo_link_acquisition_paths') {
                const dup = tables[table].some((r) => r.domain_id === row.domain_id && r.path_key === row.path_key && r.superseded_by == null);
                if (dup) return [];
              }
              tables[table].push({ id: uid(), revision: 1, revision_payment: 1, revision_communication: 1, revision_execution: 1, ...row });
              return [];
            },
          }),
        };
      },
      then(res, rej) { return Promise.resolve(resolve()).then(res, rej); },
    };
    return q;
  }
  const db = (t) => builder(t);
  db.raw = (sql) => ({ __raw: sql });
  db.ref = (col) => ({ __ref: col });
  db.transaction = async (cb) => {
    const trx = (t) => builder(t);
    trx.raw = db.raw;
    trx.ref = db.ref;
    return cb(trx);
  };
  db._tables = tables;
  return db;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const NOW = new Date('2026-08-31T12:00:00Z');
const domainRow = (over = {}) => ({
  id: uid(), domain: 'example.com', source: 'competitor_gap', discovery_priority: 'normal',
  agent_state: 'new', domain_rating: 40, spam_score: 5, organic_traffic: 1000,
  competitors_linked: 3, best_path_id: null, score: null, score_reasons: null,
  watch_recheck_at: null, created_at: new Date('2026-08-01T00:00:00Z'), ...over,
});
const modelPath = (over = {}) => ({
  acquisition_type: 'paid_listing', submission_url: 'https://example.com/join',
  account_required: true, email_verification: true, payment_required: true,
  legal_attestation: false, agent_completable: true,
  terms_accepted_by_send: false, execution_after_send: true,
  link_type: 'directory', expected_rel: 'dofollow', expected_indexability: 'indexable',
  expected_persistence: 'durable', confidence: 0.7, fee_scope: 'per_location',
  renewal_period: 'annual', price_text: 'USD 95 / year', price_page_url: 'https://example.com/join',
  renewal_price_text: 'USD 95', renewal_price_page_url: 'https://example.com/join',
  currency_evidence: { marker: 'USD', kind: 'quote', page_url: 'https://example.com/join' },
  merchant_binding: null, legal_terms_url: null, replaces_path_id: null,
  reasons: 'paid directory listing', quotes: ['USD 95 / year'], ...over,
});
const verdictOf = (paths, verdict = 'qualified') => ({ verdict, watch_reason: verdict === 'watching' ? 'closed today' : null, paths });

const okFetch = async (url) => ({ status: 200, finalUrl: url, contentType: 'text/html; charset=utf-8', html: `<html><body>Directory listing page with membership details and vendor information. Join for USD 95 / year — ${url}. Applications are reviewed within five business days.</body></html>`, blocked: false, truncated: false });
const passthrough = (name, fn) => fn();
const runOpts = (db, over = {}) => ({
  now: NOW, exclusive: passthrough, fetchPage: okFetch,
  llmDispatch: async () => ({ ok: true, json: verdictOf([modelPath()]) }),
  ...over,
});

beforeEach(() => { isEnabled.mockReturnValue(true); });

// ---------------------------------------------------------------------------
describe('currency gate (§5) — deterministic, evidence-only', () => {
  const { deriveCurrency, centsFor } = _internals;
  test.each([
    ['USD in the quote', { price_text: 'USD 95 / year' }, 'USD'],
    ['US$ in the quote', { price_text: 'US$95' }, 'USD'],
    ['bare $ is NOT proof', { price_text: '$95 / year' }, 'unknown'],
    ['no marker at all', { price_text: '95 per year' }, 'unknown'],
    ['euro symbol', { price_text: '€95' }, 'foreign'],
    ['pound symbol', { price_text: '£95' }, 'foreign'],
    ['C$ prefix', { price_text: 'C$95' }, 'foreign'],
    ['CAD code', { price_text: '95 CAD' }, 'foreign'],
    ['A$ prefix', { price_text: 'A$95' }, 'foreign'],
    ['MXN code', { price_text: 'MXN 95' }, 'foreign'],
    ['no price at all', {}, 'unknown'],
    ['observed jsonld USD beats a bare $', { price_text: '$95', currency_evidence: { marker: 'USD', kind: 'jsonld_price_currency', page_url: null } }, 'USD'],
    ['observed processor CAD', { price_text: '$95', currency_evidence: { marker: 'CAD', kind: 'processor_currency', page_url: null } }, 'foreign'],
    ['conflicting markers fail closed', { price_text: 'USD 95 (approx €88)' }, 'unknown'],
    ['renewal-quote marker counts', { price_text: '$95', renewal_price_text: 'renews at USD 95' }, 'USD'],
  ])('%s → %s', (_label, path, expected) => {
    expect(deriveCurrency(path)).toBe(expected);
  });

  test('cents come from parsePriceTextCents and only under USD', () => {
    expect(centsFor('USD', 'USD 95 / year')).toBe(9500);
    expect(centsFor('USD', 'USD 10.50')).toBe(1050);
    expect(centsFor('USD', 'USD 10.075')).toBeNull(); // >2 fraction digits → price-entry card
    expect(centsFor('unknown', '$95')).toBeNull();
    expect(centsFor('foreign', '€95')).toBeNull();
  });
});

describe('§3.2 per-dimension revision bumps', () => {
  const { changedInputs, PAYMENT_INPUTS, COMMUNICATION_INPUTS, EXECUTION_INPUTS } = _internals;
  const base = {
    estimated_cost_cents: 9500, renewal_cost_cents: null, renewal_period: 'annual', currency: 'USD',
    fee_scope: 'per_location', payment_required: true, legal_attestation: false, legal_terms_hash: null,
    merchant_binding: null, link_type: 'directory', expected_rel: 'dofollow',
    terms_accepted_by_send: false, execution_after_send: true,
    account_required: true, email_verification: true, agent_completable: true,
  };
  test('a price change is payment-only', () => {
    const next = { ...base, estimated_cost_cents: 12000 };
    expect(changedInputs(base, next, PAYMENT_INPUTS)).toBe(true);
    expect(changedInputs(base, next, COMMUNICATION_INPUTS)).toBe(false);
    expect(changedInputs(base, next, EXECUTION_INPUTS)).toBe(false);
  });
  test('a lane change is communication-only', () => {
    const next = { ...base, link_type: 'citation' };
    expect(changedInputs(base, next, PAYMENT_INPUTS)).toBe(false);
    expect(changedInputs(base, next, COMMUNICATION_INPUTS)).toBe(true);
    expect(changedInputs(base, next, EXECUTION_INPUTS)).toBe(false);
  });
  test('an account-required change is execution-only', () => {
    const next = { ...base, account_required: false };
    expect(changedInputs(base, next, PAYMENT_INPUTS)).toBe(false);
    expect(changedInputs(base, next, COMMUNICATION_INPUTS)).toBe(false);
    expect(changedInputs(base, next, EXECUTION_INPUTS)).toBe(true);
  });
  test('a terms-hash change bumps ALL THREE dimensions (§3.2)', () => {
    const next = { ...base, legal_terms_hash: 'abc123' };
    expect(changedInputs(base, next, PAYMENT_INPUTS)).toBe(true);
    expect(changedInputs(base, next, COMMUNICATION_INPUTS)).toBe(true);
    expect(changedInputs(base, next, EXECUTION_INPUTS)).toBe(true);
  });
  test('a pg-jsonb round trip of merchant_binding is NOT a change', () => {
    const binding = { checkout_origin: 'https://pay.example.com', processor: { host: 'stripe.com', merchant_account_id: 'acct_1' }, issuer_merchant_descriptor: 'EXAMPLE' };
    const stored = { ...base, merchant_binding: JSON.stringify({ processor: binding.processor, issuer_merchant_descriptor: binding.issuer_merchant_descriptor, checkout_origin: binding.checkout_origin }) };
    const next = { ...base, merchant_binding: JSON.stringify(binding) };
    expect(changedInputs(stored, next, PAYMENT_INPUTS)).toBe(false);
  });
});

describe('gated / dryRun', () => {
  test('gated: selection reported, zero fetches, zero LLM calls, zero writes', async () => {
    isEnabled.mockReturnValue(false);
    const d = domainRow();
    const db = makeDb({ seo_link_domains: [d] });
    const fetcher = jest.fn();
    const llm = jest.fn();
    const r = await investigatePaths(db, runOpts(db, { fetchPage: fetcher, llmDispatch: llm }));
    expect(r).toMatchObject({ gated: true, selected: 1, investigated: 0, fetches: 0, llmCalls: 0 });
    expect(fetcher).not.toHaveBeenCalled();
    expect(llm).not.toHaveBeenCalled();
    expect(db._tables.seo_link_domains[0].agent_state).toBe('new');
  });
  test('dryRun: would-counts only, zero writes', async () => {
    const db = makeDb({ seo_link_domains: [domainRow()] });
    const r = await investigatePaths(db, runOpts(db, { dryRun: true }));
    // maxima, not the happy path: candidate cap + probe/terms budgets, and one repair retry per call (Codex PR r5 P2)
    expect(r).toMatchObject({ dryRun: true, selected: 1, wouldFetch: MAX_FETCHES_PER_DOMAIN + SUBMISSION_VERIFY_BUDGET + TERMS_FETCH_BUDGET, wouldCall: 2, investigated: 0 });
    expect(db._tables.seo_link_acquisition_paths).toHaveLength(0);
    expect(db._tables.seo_link_domains[0].agent_state).toBe('new');
  });
});

describe('selector (§5 — path-based, not only domain-based)', () => {
  const { selectTargets } = _internals;
  test('owner seeds jump the queue; watching only when due; never-investigated paths are state-less refreshes', async () => {
    const seed = domainRow({ domain: 'seed.com', discovery_priority: 'owner_seed', created_at: new Date('2026-08-20') });
    const older = domainRow({ domain: 'older.com', created_at: new Date('2026-08-05') });
    const watchingDue = domainRow({ domain: 'due.com', agent_state: 'watching', watch_recheck_at: new Date('2026-08-30') });
    const watchingNotDue = domainRow({ domain: 'notdue.com', agent_state: 'watching', watch_recheck_at: new Date('2026-09-30') });
    const acquiredBaseline = domainRow({ domain: 'acquired.com', agent_state: 'acquired' });
    const path = { id: uid(), domain_id: acquiredBaseline.id, path_key: 'unknown:-', superseded_by: null, last_investigated_at: null };
    const db = makeDb({ seo_link_domains: [seed, older, watchingDue, watchingNotDue, acquiredBaseline], seo_link_acquisition_paths: [path] });
    const targets = await selectTargets(db, { limit: 10, now: NOW });
    // owner seed first, then the merged claim pool by created_at (due.com is
    // older than older.com), then the state-less refresh
    expect(targets.map((t) => [t.domain.domain, t.claimState])).toEqual([
      ['seed.com', true], ['due.com', true], ['older.com', true], ['acquired.com', false],
    ]);
  });

  test('an owner-seed watching-due domain jumps a full page of normal new rows (Codex PR r1 P2)', async () => {
    const normals = Array.from({ length: 5 }, (_, i) => domainRow({ domain: `n${i}.com`, created_at: new Date('2026-08-02') }));
    const seedWatch = domainRow({ domain: 'seedwatch.com', agent_state: 'watching', discovery_priority: 'owner_seed', watch_recheck_at: new Date('2026-08-30') });
    const db = makeDb({ seo_link_domains: [...normals, seedWatch] });
    const targets = await selectTargets(db, { limit: 3, now: NOW });
    expect(targets[0].domain.domain).toBe('seedwatch.com');
  });
  test('explicit domainIds bypass the queue; acquired ids are path refreshes', async () => {
    const a = domainRow({ domain: 'a.com' });
    const b = domainRow({ domain: 'b.com', agent_state: 'acquired' });
    const db = makeDb({ seo_link_domains: [a, b] });
    const targets = await selectTargets(db, { domainIds: [a.id, b.id], limit: 50, now: NOW });
    expect(targets.map((t) => [t.domain.domain, t.claimState])).toEqual([['a.com', true], ['b.com', false]]);
  });
});

describe('full run', () => {
  test('happy path: paid USD path written with derived cents, domain finished qualified with best path + score', async () => {
    const d = domainRow();
    const db = makeDb({ seo_link_domains: [d] });
    const llm = jest.fn(async (route, payload) => {
      expect(route).toEqual({ provider: 'anthropic', model: MODELS.WORKHORSE });
      expect(payload.jsonMode).toBe(true);
      expect(payload.text).toContain('example.com');
      return { ok: true, json: verdictOf([modelPath()]) };
    });
    const r = await investigatePaths(db, runOpts(db, { llmDispatch: llm }));
    expect(r).toMatchObject({ investigated: 1, qualified: 1, pathsWritten: 1, llmCalls: 1, failed: [] });
    const path = db._tables.seo_link_acquisition_paths[0];
    expect(path).toMatchObject({
      domain_id: d.id, acquisition_type: 'paid_listing', currency: 'USD',
      estimated_cost_cents: 9500, renewal_cost_cents: 9500, fee_scope: 'per_location',
      baseline: false, path_key: 'paid_listing:https://example.com/join',
    });
    expect(path.last_investigated_at).toEqual(NOW);
    const dom = db._tables.seo_link_domains[0];
    expect(dom.agent_state).toBe('qualified');
    expect(dom.best_path_id).toBe(path.id);
    expect(dom.score).toBeGreaterThan(0);
    expect(dom.score_reasons).toContain('paid_listing');
  });

  test('the fetch cap holds at ≤8 per domain even with many candidates', async () => {
    const d = domainRow();
    const touches = Array.from({ length: 12 }, (_, i) => ({ domain_id: d.id, source: 'list_import', source_detail: `https://example.com/page-${i}`, source_ref: null }));
    const db = makeDb({ seo_link_domains: [d], seo_link_domain_sources: touches });
    const fetcher = jest.fn(okFetch);
    const r = await investigatePaths(db, runOpts(db, { fetchPage: fetcher }));
    // candidate-page fetches respect the cap; resolveOnly existence probes ride their own budget
    const pageCalls = fetcher.mock.calls.filter(([, opts]) => !(opts && opts.resolveOnly)).length;
    expect(pageCalls).toBeLessThanOrEqual(MAX_FETCHES_PER_DOMAIN);
    expect(r.fetches).toBeLessThanOrEqual(MAX_FETCHES_PER_DOMAIN + investigator.TERMS_FETCH_BUDGET + investigator.SUBMISSION_VERIFY_BUDGET);
  });

  test('an unfetched same-host submission URL needs a resolveOnly existence probe; unreachable ⇒ confidence 0 (Codex r9 P1)', async () => {
    const d = domainRow();
    // exhaust the page budget so the model-reported URL is outside coverage
    const touches = Array.from({ length: 12 }, (_, i) => ({ domain_id: d.id, source: 'list_import', source_detail: `https://example.com/page-${i}`, source_ref: null }));
    const db = makeDb({ seo_link_domains: [d], seo_link_domain_sources: touches });
    const reachable = jest.fn(okFetch);
    await investigatePaths(db, runOpts(db, { fetchPage: reachable, llmDispatch: async () => ({ ok: true, json: verdictOf([modelPath()]) }) }));
    const probeCall = reachable.mock.calls.find(([u, opts]) => u === 'https://example.com/join' && opts && opts.resolveOnly);
    expect(probeCall).toBeTruthy();
    expect(Number(db._tables.seo_link_acquisition_paths[0].confidence)).toBe(0.7); // probe succeeded — claim stands

    // same setup, but the reported URL does not exist
    const d2 = domainRow({ domain: 'other.com' });
    const touches2 = Array.from({ length: 12 }, (_, i) => ({ domain_id: d2.id, source: 'list_import', source_detail: `https://other.com/page-${i}`, source_ref: null }));
    const db2 = makeDb({ seo_link_domains: [d2], seo_link_domain_sources: touches2 });
    const unreachable = jest.fn(async (url, opts) => (opts && opts.resolveOnly
      ? { status: 404, finalUrl: url, html: null, blocked: false }
      : okFetch(url)));
    const ghost = modelPath({ submission_url: 'https://other.com/ghost-join' });
    await investigatePaths(db2, runOpts(db2, { fetchPage: unreachable, llmDispatch: async () => ({ ok: true, json: verdictOf([ghost]) }) }));
    const p2 = db2._tables.seo_link_acquisition_paths[0];
    expect(p2.confidence).toBe(0); // never a best path, never past a §6.3 floor
    expect(JSON.parse(p2.investigation).submission_verification).toBe('status_404');
    // a transient probe failure is NOT a verdict — the row stays unstamped
    // so a later pass retries instead of hiding it for 90 days (Codex r3 P1)
    expect(p2.last_investigated_at).toBeNull();
    expect(db2._tables.seo_link_domains[0].agent_state).toBe('watching'); // qualified with no executable path downgrades
  });

  test('a URL-less outreach path IS domain-covered: a negative verdict retires it and clears best_path_id (Codex r13 P1)', async () => {
    // full probe coverage already earned — the close may proceed
    const d = domainRow({ agent_state: 'investigating', best_path_id: null, probe_coverage_mask: (1 << 13) - 1 });
    const outreachPath = {
      id: uid(), domain_id: d.id, acquisition_type: 'editorial_outreach', submission_url: null,
      path_key: 'editorial_outreach:-', superseded_by: null, baseline: false, confidence: 0.8,
      last_investigated_at: new Date('2026-06-01'), investigation: JSON.stringify({}),
      revision: 1, revision_payment: 1, revision_communication: 1, revision_execution: 1,
    };
    const db = makeDb({ seo_link_domains: [d], seo_link_acquisition_paths: [outreachPath] });
    await investigatePaths(db, runOpts(db, { llmDispatch: async () => ({ ok: true, json: verdictOf([], 'not_reproducible') }) }));
    const p = db._tables.seo_link_acquisition_paths[0];
    expect(p.confidence).toBe(0);
    expect(JSON.parse(p.investigation).disproven_reason).toMatch(/not_reproducible/);
    const dom = db._tables.seo_link_domains[0];
    expect(dom.agent_state).toBe('not_reproducible');
    expect(dom.best_path_id).toBeNull(); // never a contradictory actionable best path
  });

  test('a probe that soft-redirects to another same-host page proves nothing about the claimed URL (Codex r15 P1)', async () => {
    const d = domainRow();
    const touches = Array.from({ length: 12 }, (_, i) => ({ domain_id: d.id, source: 'list_import', source_detail: `https://example.com/page-${i}`, source_ref: null }));
    const db = makeDb({ seo_link_domains: [d], seo_link_domain_sources: touches });
    // the hallucinated /ghost-join resolves… to the homepage
    const homeRedirect = jest.fn(async (url, opts) => (opts && opts.resolveOnly
      ? { status: 200, finalUrl: 'https://example.com/', html: null, blocked: false }
      : okFetch(url)));
    const ghost = modelPath({ submission_url: 'https://example.com/ghost-join' });
    await investigatePaths(db, runOpts(db, { fetchPage: homeRedirect, llmDispatch: async () => ({ ok: true, json: verdictOf([ghost]) }) }));
    const p = db._tables.seo_link_acquisition_paths[0];
    expect(p.confidence).toBe(0);
    expect(JSON.parse(p.investigation).submission_verification).toBe('redirected_off_claim');
    // …while an https upgrade / trailing-slash redirect of the SAME page still verifies
    const okUpgrade = jest.fn(async (url, opts) => (opts && opts.resolveOnly
      ? { status: 301, finalUrl: `${url.replace('http://', 'https://')}/`, html: null, blocked: false }
      : okFetch(url)));
    const d2 = domainRow({ domain: 'other.com' });
    const touches2 = Array.from({ length: 12 }, (_, i) => ({ domain_id: d2.id, source: 'list_import', source_detail: `https://other.com/page-${i}`, source_ref: null }));
    const db2 = makeDb({ seo_link_domains: [d2], seo_link_domain_sources: touches2 });
    const upgraded = modelPath({ submission_url: 'http://other.com/join-up' });
    await investigatePaths(db2, runOpts(db2, { fetchPage: okUpgrade, llmDispatch: async () => ({ ok: true, json: verdictOf([upgraded]) }) }));
    expect(Number(db2._tables.seo_link_acquisition_paths[0].confidence)).toBe(0.7);
  });

  test('an omitted path OUTSIDE this pass\'s fetch coverage is preserved, never disproven (Codex r9 P1)', async () => {
    const d = domainRow({ agent_state: 'investigating' });
    const uncovered = {
      id: uid(), domain_id: d.id, acquisition_type: 'paid_listing', submission_url: 'https://example.com/deep/hidden-join',
      path_key: 'paid_listing:https://example.com/deep/hidden-join', superseded_by: null, baseline: false,
      confidence: 0.6, last_investigated_at: new Date('2026-06-01'), investigation: JSON.stringify({}),
      revision: 1, revision_payment: 1, revision_communication: 1, revision_execution: 1,
    };
    const db = makeDb({ seo_link_domains: [d], seo_link_acquisition_paths: [uncovered] });
    // its page never loads this pass — coverage is absent, not negative
    const fetcher = jest.fn(async (url, opts) => (url.includes('hidden-join')
      ? { status: 500, finalUrl: url, html: null, blocked: false, error: 'http_500' }
      : okFetch(url)));
    await investigatePaths(db, runOpts(db, { fetchPage: fetcher, llmDispatch: async () => ({ ok: true, json: verdictOf([modelPath()]) }) }));
    const kept = db._tables.seo_link_acquisition_paths.find((p) => p.id === uncovered.id);
    expect(Number(kept.confidence)).toBe(0.6); // untouched
    expect(JSON.parse(kept.investigation).disproven_at).toBeUndefined();
    // and it is NOT stamped investigated — it stays eligible for a later pass (Codex r12 P1)
    expect(kept.last_investigated_at).toEqual(new Date('2026-06-01'));
  });

  test('every caller is clamped to the run ceiling — a huge limit cannot order thousands of model calls (Codex r12 P1)', async () => {
    const many = Array.from({ length: 520 }, (_, i) => domainRow({ domain: `d${i}.com` }));
    const db = makeDb({ seo_link_domains: many });
    const r = await investigatePaths(db, runOpts(db, { dryRun: true, limit: 100000 }));
    expect(r.selected).toBe(500);
  });

  test('off-domain hint URLs are never fetched', async () => {
    const d = domainRow();
    const db = makeDb({
      seo_link_domains: [d],
      seo_link_domain_sources: [{ domain_id: d.id, source: 'x', source_detail: 'https://evil.internal/land', source_ref: null }],
    });
    const fetcher = jest.fn(okFetch);
    await investigatePaths(db, runOpts(db, { fetchPage: fetcher }));
    for (const [url] of fetcher.mock.calls) expect(url).toMatch(/^https:\/\/(www\.)?example\.com/);
  });

  test('schema failure → ONE repair retry with the errors; second failure records and leaves the domain investigating', async () => {
    const d = domainRow();
    const db = makeDb({ seo_link_domains: [d] });
    const bad = { verdict: 'qualified', paths: [] }; // qualified needs ≥1 path
    const llm = jest.fn(async () => ({ ok: true, json: bad }));
    const r = await investigatePaths(db, runOpts(db, { llmDispatch: llm }));
    expect(llm).toHaveBeenCalledTimes(2);
    expect(llm.mock.calls[1][1].text).toContain('failed validation');
    expect(r.llmCalls).toBe(2);
    expect(r.investigated).toBe(0);
    expect(r.failed).toEqual([expect.objectContaining({ id: d.id, reason: expect.stringContaining('llm_invalid') })]);
    const dom = db._tables.seo_link_domains[0];
    expect(dom.agent_state).toBe('investigating'); // retried by a later sweep…
    // …but DEFERRED, never first in line again next hour (Codex r11 P1)
    expect(dom.investigate_failures).toBe(1);
    expect(dom.investigate_after).toEqual(new Date(NOW.getTime() + _internals.INVESTIGATE_BACKOFF_BASE_MS));
  });

  test('a deferred domain is not selected until due; the failure ceiling parks it watching (Codex r11 P1)', async () => {
    const { selectTargets } = _internals;
    const deferred = domainRow({ domain: 'deferred.com', agent_state: 'investigating', investigate_after: new Date('2026-09-01') });
    const due = domainRow({ domain: 'due.com', agent_state: 'investigating', investigate_after: new Date('2026-08-30') });
    const db = makeDb({ seo_link_domains: [deferred, due] });
    const targets = await selectTargets(db, { limit: 10, now: NOW });
    expect(targets.map((t) => t.domain.domain)).toEqual(['due.com']);

    // ceiling: the next failure parks the domain on the watching cadence
    const atCeiling = domainRow({ domain: 'broken.com', agent_state: 'investigating', investigate_failures: 5 });
    const db2 = makeDb({ seo_link_domains: [atCeiling] });
    await investigatePaths(db2, runOpts(db2, { llmDispatch: async () => ({ ok: false, reason: 'anthropic_500' }) }));
    const dom = db2._tables.seo_link_domains[0];
    expect(dom.agent_state).toBe('watching');
    expect(dom.watch_recheck_at).toEqual(new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000));
    expect(dom.investigate_after).toBeNull();
    expect(dom.score_reasons).toMatch(/6 consecutive investigation failures/);
  });

  test('a successful investigation resets the failure backoff', async () => {
    const d = domainRow({ agent_state: 'investigating', investigate_failures: 3, investigate_after: new Date('2026-08-30') });
    const db = makeDb({ seo_link_domains: [d] });
    await investigatePaths(db, runOpts(db));
    const dom = db._tables.seo_link_domains[0];
    expect(dom.agent_state).toBe('qualified');
    expect(dom.investigate_failures).toBe(0);
    expect(dom.investigate_after).toBeNull();
  });

  test('repair retry succeeding on the second call still investigates', async () => {
    const d = domainRow();
    const db = makeDb({ seo_link_domains: [d] });
    const llm = jest.fn()
      .mockResolvedValueOnce({ ok: false, reason: 'empty_json' })
      .mockResolvedValueOnce({ ok: true, json: verdictOf([modelPath()]) });
    const r = await investigatePaths(db, runOpts(db, { llmDispatch: llm }));
    expect(r).toMatchObject({ investigated: 1, llmCalls: 2, failed: [] });
  });

  test('not_reproducible verdict closes the domain honestly; unknown/not_reproducible path types are never rows', async () => {
    // full probe coverage already earned — the close may proceed
    const d = domainRow({ probe_coverage_mask: (1 << 13) - 1 });
    const db = makeDb({ seo_link_domains: [d] });
    const paths = [modelPath({ acquisition_type: 'unknown', payment_required: false, fee_scope: null })];
    const r = await investigatePaths(db, runOpts(db, { llmDispatch: async () => ({ ok: true, json: verdictOf(paths, 'not_reproducible') }) }));
    expect(r).toMatchObject({ investigated: 1, notReproducible: 1, pathsWritten: 0 });
    expect(db._tables.seo_link_acquisition_paths).toHaveLength(0);
    expect(db._tables.seo_link_domains[0].agent_state).toBe('not_reproducible');
  });

  test('watching verdict parks with a recheck date and the reason on the row', async () => {
    const d = domainRow();
    const db = makeDb({ seo_link_domains: [d] });
    await investigatePaths(db, runOpts(db, { llmDispatch: async () => ({ ok: true, json: verdictOf([], 'watching') }) }));
    const dom = db._tables.seo_link_domains[0];
    expect(dom.agent_state).toBe('watching');
    expect(dom.watch_recheck_at).toEqual(new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000));
    expect(dom.score_reasons).toContain('closed today');
  });

  test('re-running the same answer is idempotent: one row, no revision bump', async () => {
    const d = domainRow();
    const db = makeDb({ seo_link_domains: [d] });
    await investigatePaths(db, runOpts(db));
    await investigatePaths(db, runOpts(db, { domainIds: [d.id] }));
    expect(db._tables.seo_link_acquisition_paths).toHaveLength(1);
    const p = db._tables.seo_link_acquisition_paths[0];
    expect([p.revision, p.revision_payment, p.revision_communication, p.revision_execution]).toEqual([1, 1, 1, 1]);
  });

  test('a changed price on the same path bumps revision + revision_payment ONLY', async () => {
    const d = domainRow();
    const db = makeDb({ seo_link_domains: [d] });
    await investigatePaths(db, runOpts(db));
    const repriced = modelPath({ price_text: 'USD 120 / year', renewal_price_text: 'USD 120', quotes: ['USD 120 / year'] });
    const fetch120 = async (url) => ({ status: 200, finalUrl: url, contentType: 'text/html', html: `<html><body>Directory listing page with membership details and vendor information. Join for USD 120 / year — ${url}. Applications are reviewed within five business days.</body></html>`, blocked: false, truncated: false });
    await investigatePaths(db, runOpts(db, { domainIds: [d.id], fetchPage: fetch120, llmDispatch: async () => ({ ok: true, json: verdictOf([repriced]) }) }));
    const p = db._tables.seo_link_acquisition_paths[0];
    expect(p.estimated_cost_cents).toBe(12000);
    expect([p.revision, p.revision_payment, p.revision_communication, p.revision_execution]).toEqual([2, 2, 1, 1]);
  });

  test('explicit-predecessor supersession: old path marked superseded, placements repointed', async () => {
    const d = domainRow();
    const oldPath = {
      id: uid(), domain_id: d.id, acquisition_type: 'paid_listing', submission_url: 'https://example.com/old-join',
      path_key: 'paid_listing:https://example.com/old-join', superseded_by: null, last_investigated_at: null,
      revision: 1, revision_payment: 1, revision_communication: 1, revision_execution: 1,
    };
    const placement = { id: uid(), domain_id: d.id, path_id: oldPath.id, status: 'prospect' };
    const db = makeDb({ seo_link_domains: [d], seo_link_acquisition_paths: [oldPath], seo_link_prospects: [placement] });
    const replacing = modelPath({ replaces_path_id: oldPath.id });
    // deterministic predecessor evidence: the old URL is GONE this pass
    const goneFetch = async (url, opts) => (url.includes('/old-join')
      ? { status: 404, finalUrl: url, html: null, blocked: false }
      : okFetch(url));
    const r = await investigatePaths(db, runOpts(db, { fetchPage: goneFetch, llmDispatch: async () => ({ ok: true, json: verdictOf([replacing]) }) }));
    expect(r.superseded).toBe(1);
    const old = db._tables.seo_link_acquisition_paths.find((p) => p.id === oldPath.id);
    const fresh = db._tables.seo_link_acquisition_paths.find((p) => p.id !== oldPath.id);
    expect(old.superseded_by).toBe(fresh.id);
    expect(old.superseded_at).toEqual(NOW);
    expect(db._tables.seo_link_prospects[0].path_id).toBe(fresh.id);
  });

  test('legal paths get their terms hash from the RESERVED budget — the probe list cannot starve it (Codex r1 P1)', async () => {
    const d = domainRow();
    // enough hints that the candidate loop exhausts the page cap by itself
    const touches = Array.from({ length: 12 }, (_, i) => ({ domain_id: d.id, source: 'list_import', source_detail: `https://example.com/page-${i}`, source_ref: null }));
    const db = makeDb({ seo_link_domains: [d], seo_link_domain_sources: touches });
    const legal = modelPath({ legal_attestation: true, legal_terms_url: 'https://example.com/terms' });
    const agreement = `<html><body>Membership agreement. ${'By joining you agree to the listing terms and renewal policy. '.repeat(8)}</body></html>`;
    const fetcher = jest.fn(async (url) => (url.includes('/terms')
      ? { status: 200, finalUrl: url, contentType: 'text/html', html: agreement, blocked: false, truncated: false }
      : okFetch(url)));
    const r = await investigatePaths(db, runOpts(db, { fetchPage: fetcher, llmDispatch: async () => ({ ok: true, json: verdictOf([legal]) }) }));
    expect(fetcher.mock.calls.map(([u]) => u)).toContain('https://example.com/terms');
    const p = db._tables.seo_link_acquisition_paths[0];
    expect(p.legal_terms_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.fetches).toBeLessThanOrEqual(MAX_FETCHES_PER_DOMAIN + investigator.TERMS_FETCH_BUDGET);
  });

  test('off-host model URLs are never fetched or persisted — they move to the evidence (Codex r1 P1)', async () => {
    const d = domainRow();
    const db = makeDb({ seo_link_domains: [d] });
    const injected = modelPath({
      submission_url: 'https://evil.example.net/join',
      legal_attestation: true,
      legal_terms_url: 'https://evil.example.net/terms',
    });
    const fetcher = jest.fn(okFetch);
    const r = await investigatePaths(db, runOpts(db, { fetchPage: fetcher, llmDispatch: async () => ({ ok: true, json: verdictOf([injected]) }) }));
    for (const [url] of fetcher.mock.calls) expect(url).not.toContain('evil.example.net');
    // a deterministic rejection never becomes a row (writing it under
    // `paid_listing:-` could overwrite a legitimate URL-less identity —
    // Codex PR r4 P1); the qualified verdict downgrades with nothing left
    expect(r.pathsWritten).toBe(0);
    expect(db._tables.seo_link_acquisition_paths).toHaveLength(0);
    expect(db._tables.seo_link_domains[0].best_path_id).toBeNull();
    expect(db._tables.seo_link_domains[0].agent_state).toBe('watching');
    // a subdomain of the investigated host IS bound
    expect(_internals.hostBound('example.com', 'https://members.example.com/join')).toBe(true);
    expect(_internals.hostBound('example.com', 'https://notexample.com/join')).toBe(false);
    // userinfo can NOT spoof the host past the guard (Codex r6 P1) — real URL
    // parsing; credentials, foreign schemes and malformed URLs are rejected
    expect(_internals.hostBound('example.com', 'https://example.com:secret@evil.test/join')).toBe(false);
    expect(_internals.hostBound('example.com', 'https://user@example.com/join')).toBe(false);
    expect(_internals.hostBound('example.com', 'ftp://example.com/join')).toBe(false);
    expect(_internals.hostBound('example.com', 'not a url')).toBe(false);
    expect(_internals.hostBound('example.com', 'https://example.com:8443/join')).toBe(true); // an explicit port is fine
  });

  test('a negative re-investigation invalidates the stale executable path and clears best_path_id (Codex r1 P1)', async () => {
    // full probe coverage already earned — the close may proceed
    const d = domainRow({ agent_state: 'investigating', best_path_id: null, probe_coverage_mask: (1 << 13) - 1 });
    const oldPath = {
      id: uid(), domain_id: d.id, acquisition_type: 'paid_listing', submission_url: 'https://example.com/join',
      path_key: 'paid_listing:https://example.com/join', superseded_by: null, baseline: false,
      confidence: 0.7, last_investigated_at: new Date('2026-06-01'), investigation: JSON.stringify({ reasons: 'old pass' }),
      revision: 1, revision_payment: 1, revision_communication: 1, revision_execution: 1,
    };
    const db = makeDb({ seo_link_domains: [d], seo_link_acquisition_paths: [oldPath] });
    const r = await investigatePaths(db, runOpts(db, { llmDispatch: async () => ({ ok: true, json: verdictOf([], 'not_reproducible') }) }));
    expect(r.notReproducible).toBe(1);
    const stale = db._tables.seo_link_acquisition_paths[0];
    expect(stale.confidence).toBe(0);
    const evidence = JSON.parse(stale.investigation);
    expect(evidence.reasons).toBe('old pass'); // prior evidence kept
    expect(evidence.disproven_reason).toMatch(/not_reproducible/);
    const dom = db._tables.seo_link_domains[0];
    expect(dom.agent_state).toBe('not_reproducible');
    expect(dom.best_path_id).toBeNull(); // a zero-value path never becomes best
  });

  test('an unverified price claim fails closed: quote not on the cited page ⇒ unknown currency, null cents (Codex r2 P1)', async () => {
    const d = domainRow();
    const db = makeDb({ seo_link_domains: [d] });
    // the fetched page quotes USD 95; the model claims USD 500
    const inflated = modelPath({ price_text: 'USD 500 / year', renewal_price_text: null, renewal_price_page_url: null, currency_evidence: { marker: 'USD', kind: 'quote', page_url: 'https://example.com/join' } });
    await investigatePaths(db, runOpts(db, { llmDispatch: async () => ({ ok: true, json: verdictOf([inflated]) }) }));
    const p = db._tables.seo_link_acquisition_paths[0];
    expect(p.currency).toBe('unknown');
    expect(p.estimated_cost_cents).toBeNull();
    const evidence = JSON.parse(p.investigation);
    expect(evidence.price_text).toBe('USD 500 / year'); // claim preserved for the owner card
    expect(evidence.price_verification).toMatchObject({ price_text: 'not_on_fetched_page' });
  });

  test('jsonld currency evidence verifies against the RAW html of the cited fetched page', async () => {
    const d = domainRow();
    const db = makeDb({ seo_link_domains: [d] });
    const jsonldFetch = async (url) => ({ status: 200, finalUrl: url, contentType: 'text/html', html: `<html><script type="application/ld+json">{"@type":"Offer","price":"95","priceCurrency":"USD"}</script><body>Directory listing page with membership details and vendor information. Join for $95 / year — ${url}. Applications are reviewed within five business days.</body></html>`, blocked: false, truncated: false });
    const path = modelPath({ price_text: '$95 / year', renewal_price_text: null, renewal_price_page_url: null, currency_evidence: { marker: 'USD', kind: 'jsonld_price_currency', page_url: 'https://example.com/join' } });
    await investigatePaths(db, runOpts(db, { fetchPage: jsonldFetch, llmDispatch: async () => ({ ok: true, json: verdictOf([path]) }) }));
    const p = db._tables.seo_link_acquisition_paths[0];
    expect(p.currency).toBe('USD'); // bare-$ quote + VERIFIED jsonld marker
    expect(p.estimated_cost_cents).toBe(9500);
  });

  test('processor_currency evidence is unverifiable from a static fetch and never proves USD in step 3', async () => {
    const { verifyPriceEvidence } = _internals;
    const pages = [{ url: 'https://example.com/join', text: 'join for $95 / year', html: '<html>join for $95 / year</html>' }];
    const v = verifyPriceEvidence(pages, { price_text: '$95 / year', price_page_url: 'https://example.com/join', currency_evidence: { marker: 'USD', kind: 'processor_currency', page_url: 'https://example.com/join' } });
    expect(v.price_text).toBe('$95 / year'); // the quote itself is on the page
    expect(v.currency_evidence).toBeNull();
    expect(v.verification.currency_evidence).toBe('processor_currency_unverifiable_static');
  });

  test('supersession also fires when the replacement path ALREADY exists in place (Codex r8 P1)', async () => {
    const d = domainRow();
    const oldPath = {
      id: uid(), domain_id: d.id, acquisition_type: 'paid_listing', submission_url: 'https://example.com/old-join',
      path_key: 'paid_listing:https://example.com/old-join', superseded_by: null, baseline: false, confidence: 0.5,
      last_investigated_at: null, revision: 1, revision_payment: 1, revision_communication: 1, revision_execution: 1,
    };
    const existingReplacement = {
      id: uid(), domain_id: d.id, acquisition_type: 'paid_listing', submission_url: 'https://example.com/join',
      path_key: 'paid_listing:https://example.com/join', superseded_by: null, baseline: false, confidence: 0.7,
      last_investigated_at: null, revision: 1, revision_payment: 1, revision_communication: 1, revision_execution: 1,
    };
    const placement = { id: uid(), domain_id: d.id, path_id: oldPath.id, status: 'prospect' };
    const db = makeDb({ seo_link_domains: [d], seo_link_acquisition_paths: [oldPath, existingReplacement], seo_link_prospects: [placement] });
    const replacing = modelPath({ replaces_path_id: oldPath.id }); // same key as existingReplacement → update branch
    const goneFetch = async (url) => (url.includes('/old-join')
      ? { status: 410, finalUrl: url, html: null, blocked: false }
      : okFetch(url));
    const r = await investigatePaths(db, runOpts(db, { fetchPage: goneFetch, llmDispatch: async () => ({ ok: true, json: verdictOf([replacing]) }) }));
    expect(r.superseded).toBe(1);
    const old = db._tables.seo_link_acquisition_paths.find((p) => p.id === oldPath.id);
    expect(old.superseded_by).toBe(existingReplacement.id);
    expect(db._tables.seo_link_prospects[0].path_id).toBe(existingReplacement.id);
    expect(db._tables.seo_link_acquisition_paths).toHaveLength(2); // no third row
  });

  test('a redirect that leaves the domain is rejected as model input and evidence (Codex r3 P1)', async () => {
    const d = domainRow();
    const db = makeDb({ seo_link_domains: [d] });
    // /submit and /terms redirect off-domain; everything else loads on-host
    const redirecting = async (url) => (url.includes('/submit') || url.includes('/terms')
      ? { status: 200, finalUrl: 'https://evil.example.net/landing', contentType: 'text/html', html: '<html>Off-site content</html>', blocked: false, truncated: false }
      : okFetch(url));
    const legal = modelPath({ legal_attestation: true, legal_terms_url: 'https://example.com/terms' });
    const llm = jest.fn(async (route, payload) => {
      expect(payload.text).not.toContain('evil.example.net'); // off-site page never reaches the prompt
      expect(payload.text).not.toContain('Off-site content');
      return { ok: true, json: verdictOf([legal]) };
    });
    await investigatePaths(db, runOpts(db, { fetchPage: redirecting, llmDispatch: llm }));
    const p = db._tables.seo_link_acquisition_paths[0];
    expect(p.legal_terms_hash).toBeNull(); // the terms redirect is not this domain's agreement
    const evidence = JSON.parse(p.investigation);
    expect(evidence.fetch_errors).toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'offsite_redirect' })]));
  });

  test('an evidence-less pass (every fetch failed) spends NO model call and backs off (Codex PR r2 P1)', async () => {
    const d = domainRow();
    const db = makeDb({ seo_link_domains: [d] });
    const failing = jest.fn(async (url) => ({ status: null, finalUrl: null, html: null, blocked: false, error: 'dns_error' }));
    const llm = jest.fn();
    const r = await investigatePaths(db, runOpts(db, { fetchPage: failing, llmDispatch: llm }));
    expect(llm).not.toHaveBeenCalled();
    expect(r.failed).toEqual([expect.objectContaining({ reason: 'no_page_evidence' })]);
    const dom = db._tables.seo_link_domains[0];
    expect(dom.agent_state).toBe('investigating'); // never closed on its name alone
    expect(dom.investigate_after).toEqual(new Date(NOW.getTime() + _internals.INVESTIGATE_BACKOFF_BASE_MS));
  });

  test('the model claiming a SUBSTRING of the page price is not verification (Codex PR r2 P1)', () => {
    const { verifyPriceEvidence } = _internals;
    const pages = [{ url: 'https://example.com/join', text: 'membership costs usd 950 per year', html: '<html/>', truncated: false }];
    const v = verifyPriceEvidence(pages, { price_text: 'USD 95', price_page_url: 'https://example.com/join' });
    expect(v.price_text).toBeNull(); // USD 95 must not verify against USD 950
    const exact = verifyPriceEvidence(pages, { price_text: 'USD 950', price_page_url: 'https://example.com/join' });
    expect(exact.price_text).toBe('USD 950');
  });

  test('a claim inside LEFT-side thousands separators is not verification (Codex PR r3 P1)', () => {
    const { verifyPriceEvidence } = _internals;
    const pages = [{ url: 'https://example.com/join', text: 'annual membership usd 1,950 per year', html: '<html/>', truncated: false }];
    const v = verifyPriceEvidence(pages, { price_text: '950', price_page_url: 'https://example.com/join' });
    expect(v.price_text).toBeNull(); // "950" must not verify against "1,950"
    const whole = verifyPriceEvidence(pages, { price_text: 'usd 1,950', price_page_url: 'https://example.com/join' });
    expect(whole.price_text).toBe('usd 1,950');
  });

  test('a currency marker must stand as a complete token — "95 USDT" never proves USD (Codex PR r3 P1)', () => {
    const { verifyPriceEvidence } = _internals;
    const pages = [{ url: 'https://example.com/join', text: 'listing price: 95 usdt per year', html: '<html/>', truncated: false }];
    const v = verifyPriceEvidence(pages, {
      price_text: '95 usdt', price_page_url: 'https://example.com/join',
      currency_evidence: { marker: 'usd', kind: 'quote', page_url: 'https://example.com/join' },
    });
    expect(v.price_text).toBe('95 usdt'); // the quote itself is on the page
    expect(v.currency_evidence).toBeNull(); // but 'usd' inside 'usdt' is no marker
    expect(v.verification.currency_evidence).toBe('marker_not_in_verified_quote');
  });

  test('a terms fetch that soft-redirects to another page never hashes it as the agreement (Codex PR r3 P1)', async () => {
    const d = domainRow();
    const db = makeDb({ seo_link_domains: [d] });
    const long = `<html><body>${'Agreement clause text that is long enough to pass the substantive floor. '.repeat(6)}</body></html>`;
    const homeRedirect = async (url) => (url.includes('/terms')
      ? { status: 200, finalUrl: 'https://example.com/', contentType: 'text/html', html: long, blocked: false, truncated: false }
      : okFetch(url));
    const legal = modelPath({ legal_attestation: true, legal_terms_url: 'https://example.com/terms' });
    await investigatePaths(db, runOpts(db, { fetchPage: homeRedirect, llmDispatch: async () => ({ ok: true, json: verdictOf([legal]) }) }));
    expect(db._tables.seo_link_acquisition_paths[0].legal_terms_hash).toBeNull();
  });

  test('a content-empty page shell is existence, not coverage — its omissions disprove nothing (Codex PR r3 P1)', async () => {
    const d = domainRow({ agent_state: 'investigating' });
    const stalePath = {
      id: uid(), domain_id: d.id, acquisition_type: 'paid_listing', submission_url: 'https://example.com/join',
      path_key: 'paid_listing:https://example.com/join', superseded_by: null, baseline: false, confidence: 0.7,
      last_investigated_at: new Date('2026-05-01'), investigation: JSON.stringify({}),
      revision: 1, revision_payment: 1, revision_communication: 1, revision_execution: 1,
    };
    const db = makeDb({ seo_link_domains: [d], seo_link_acquisition_paths: [stalePath] });
    const shellFetch = async (url) => (url.includes('/join')
      ? { status: 200, finalUrl: url, contentType: 'text/html', html: '<html><script src="app.js"></script><body></body></html>', blocked: false, truncated: false }
      : okFetch(url));
    const other = modelPath({ acquisition_type: 'business_claim', submission_url: 'https://example.com/register', payment_required: false, fee_scope: null, price_text: null, price_page_url: null, renewal_price_text: null, renewal_price_page_url: null, currency_evidence: null, renewal_period: null });
    await investigatePaths(db, runOpts(db, { fetchPage: shellFetch, llmDispatch: async () => ({ ok: true, json: verdictOf([other]) }) }));
    const stale = db._tables.seo_link_acquisition_paths.find((p) => p.id === stalePath.id);
    expect(Number(stale.confidence)).toBe(0.7); // the model observed nothing on the shell
    expect(stale.last_investigated_at).toEqual(new Date('2026-05-01'));
  });

  test('a terminal not_reproducible verdict defers to watching while an uncovered positive path remains (Codex PR r3 P1)', async () => {
    const d = domainRow({ agent_state: 'investigating' });
    const uncovered = {
      id: uid(), domain_id: d.id, acquisition_type: 'paid_listing', submission_url: 'https://example.com/deep/hidden-join',
      path_key: 'paid_listing:https://example.com/deep/hidden-join', superseded_by: null, baseline: false, confidence: 0.6,
      last_investigated_at: new Date('2026-06-01'), investigation: JSON.stringify({}),
      revision: 1, revision_payment: 1, revision_communication: 1, revision_execution: 1,
    };
    const db = makeDb({ seo_link_domains: [d], seo_link_acquisition_paths: [uncovered] });
    const fetcher = async (url, opts) => (url.includes('hidden-join')
      ? { status: 500, finalUrl: url, html: null, blocked: false, error: 'http_500' }
      : okFetch(url));
    await investigatePaths(db, runOpts(db, { fetchPage: fetcher, llmDispatch: async () => ({ ok: true, json: verdictOf([], 'not_reproducible') }) }));
    const dom = db._tables.seo_link_domains[0];
    expect(dom.agent_state).toBe('watching'); // never closed while a path stands unexamined
    expect(dom.score_reasons).toMatch(/terminal verdict deferred/);
    expect(dom.best_path_id).toBe(uncovered.id); // no contradiction: state defers instead
  });

  test('an owner-seed refresh outranks a full page of normal new rows (Codex PR r3 P2)', async () => {
    const { selectTargets } = _internals;
    const normals = Array.from({ length: 5 }, (_, i) => domainRow({ domain: `n${i}.com`, created_at: new Date('2026-08-02') }));
    const seedAcquired = domainRow({ domain: 'seedref.com', agent_state: 'acquired', discovery_priority: 'owner_seed' });
    const path = { id: uid(), domain_id: seedAcquired.id, path_key: 'unknown:-', superseded_by: null, last_investigated_at: null };
    const db = makeDb({ seo_link_domains: [...normals, seedAcquired], seo_link_acquisition_paths: [path] });
    const targets = await selectTargets(db, { limit: 3, now: NOW });
    expect(targets[0].domain.domain).toBe('seedref.com');
    expect(targets[0].claimState).toBe(false);
  });

  test('the score is computed from the LOCKED row, not the pre-fetch snapshot (Codex PR r3 P1)', async () => {
    const d = domainRow(); // DR 40 at selection
    const db = makeDb({ seo_link_domains: [d] });
    const llm = jest.fn(async () => {
      db._tables.seo_link_domains[0].domain_rating = 80; // enrichment lands mid-flight
      return { ok: true, json: verdictOf([modelPath()]) };
    });
    await investigatePaths(db, runOpts(db, { llmDispatch: llm }));
    const dom = db._tables.seo_link_domains[0];
    expect(dom.score_reasons).toContain('DR 80');
    expect(dom.score).toBe(Math.max(0, Math.min(100, Math.round(0.6 * 80 + 0.2 * Math.min(100, 3 * 10) + 20 * 0.7 - 0.4 * 5))));
  });

  test('a TRUNCATED candidate page proves existence but never coverage (Codex PR r2 P1)', async () => {
    const d = domainRow({ agent_state: 'investigating' });
    const stalePath = {
      id: uid(), domain_id: d.id, acquisition_type: 'paid_listing', submission_url: 'https://example.com/join',
      path_key: 'paid_listing:https://example.com/join', superseded_by: null, baseline: false, confidence: 0.7,
      last_investigated_at: new Date('2026-05-01'), investigation: JSON.stringify({}),
      revision: 1, revision_payment: 1, revision_communication: 1, revision_execution: 1,
    };
    const db = makeDb({ seo_link_domains: [d], seo_link_acquisition_paths: [stalePath] });
    const truncFetch = jest.fn(async (url, opts) => ({ ...(await okFetch(url)), truncated: url.includes('/join') }));
    // the model omits the stale path (its page was only PARTIALLY seen)
    const other = modelPath({ acquisition_type: 'business_claim', submission_url: 'https://example.com/register', payment_required: false, fee_scope: null, price_text: null, price_page_url: null, renewal_price_text: null, renewal_price_page_url: null, currency_evidence: null, renewal_period: null });
    await investigatePaths(db, runOpts(db, { fetchPage: truncFetch, llmDispatch: async () => ({ ok: true, json: verdictOf([other]) }) }));
    const stale = db._tables.seo_link_acquisition_paths.find((p) => p.id === stalePath.id);
    expect(Number(stale.confidence)).toBe(0.7); // NOT disproven — the model never saw past the cut
    expect(stale.last_investigated_at).toEqual(new Date('2026-05-01')); // NOT stamped
    // …but a truncated fetch still proves the URL exists: no extra resolveOnly probe needed
    expect(truncFetch.mock.calls.some(([u, o]) => u === 'https://example.com/join' && o && o.resolveOnly)).toBe(false);
  });

  test('refresh selection honors owner actions: rejected never re-fetches, watching waits for its recheck (Codex PR r2 P1)', async () => {
    const { selectTargets } = _internals;
    const rejected = domainRow({ domain: 'rejected.com', agent_state: 'rejected' });
    const watchingNotDue = domainRow({ domain: 'later.com', agent_state: 'watching', watch_recheck_at: new Date('2026-09-30') });
    const paths = [rejected, watchingNotDue].map((dom) => ({
      id: uid(), domain_id: dom.id, path_key: 'unknown:-', superseded_by: null, last_investigated_at: null,
    }));
    const db = makeDb({ seo_link_domains: [rejected, watchingNotDue], seo_link_acquisition_paths: paths });
    expect(await selectTargets(db, { limit: 10, now: NOW })).toHaveLength(0);
  });

  test('an unenriched domain scores with the unknown-DR fallback, never DR 0 (Codex PR r2 P2)', () => {
    const { scoreDomain } = _internals;
    const { score, reasons } = scoreDomain({ domain_rating: null, spam_score: null, competitors_linked: 0 }, { acquisition_type: 'self_service_free', confidence: 0.5 });
    expect(reasons).toContain('DR unknown');
    expect(score).toBe(Math.round(0.6 * 20 + 20 * 0.5)); // fallback 20, not 0
  });

  test('extended foreign-currency markers, with ambiguous ISO codes case-sensitive (Codex PR r2 P2)', () => {
    const { deriveCurrency } = _internals;
    expect(deriveCurrency({ price_text: 'AED 350 / year' })).toBe('foreign');
    expect(deriveCurrency({ price_text: '95 THB' })).toBe('foreign');
    expect(deriveCurrency({ price_text: '950 php' })).toBe('foreign');
    expect(deriveCurrency({ price_text: '95 cad' })).toBe('foreign');
    expect(deriveCurrency({ price_text: 'TRY 95' })).toBe('foreign');
    expect(deriveCurrency({ price_text: 'try our plans: $95' })).toBe('unknown'); // lowercase 'try' is English
    expect(deriveCurrency({ price_text: 'all plans $95' })).toBe('unknown'); // lowercase 'all' is English
    // the classifier carries the COMPLETE active ISO-4217 set (Codex PR r5 P2)…
    expect(deriveCurrency({ price_text: 'NGN 95000' })).toBe('foreign');
    expect(deriveCurrency({ price_text: 'AFN 4000 / year' })).toBe('foreign');
    expect(deriveCurrency({ price_text: '95 irr' })).toBe('foreign');
    expect(deriveCurrency({ price_text: 'KGS 950' })).toBe('foreign');
    expect(deriveCurrency({ price_text: 'YER 95' })).toBe('foreign');
    // …with EVERY word-colliding code case-sensitive, not just TRY/ALL/TOP
    expect(deriveCurrency({ price_text: 'GEL 95' })).toBe('foreign');
    expect(deriveCurrency({ price_text: 'hair gel listing $95' })).toBe('unknown');
    expect(deriveCurrency({ price_text: 'PEN 95 / year' })).toBe('foreign');
    expect(deriveCurrency({ price_text: 'a pen and pad for $9' })).toBe('unknown');
    expect(deriveCurrency({ price_text: 'cup of coffee $5' })).toBe('unknown');
    expect(deriveCurrency({ price_text: 'CUP 95' })).toBe('foreign');
    expect(deriveCurrency({ price_text: 'XCG 95' })).toBe('foreign'); // 2025 Caribbean guilder (Codex PR r6 P2)
    // ANY USD/foreign conflict fails closed, whichever side each marker is on (Codex PR r7 P2)
    expect(deriveCurrency({ price_text: 'USD 95', currency_evidence: { marker: 'CAD' } })).toBe('unknown');
    expect(deriveCurrency({ price_text: 'CAD 95', currency_evidence: { marker: 'USD' } })).toBe('unknown');
    // the remaining circulating currency symbols (Codex PR r8 P2)
    expect(deriveCurrency({ price_text: '\u20b195' })).toBe('foreign'); // ₱
    expect(deriveCurrency({ price_text: '\u20bd 950' })).toBe('foreign'); // ₽
    expect(deriveCurrency({ price_text: '\u0e3f95' })).toBe('foreign'); // ฿
    expect(deriveCurrency({ price_text: '\u20aa95' })).toBe('foreign'); // ₪
    expect(deriveCurrency({ price_text: '\u20ba95' })).toBe('foreign'); // ₺
  });

  test('an empty terms shell is never hashed; a hash-less legal path never outranks a valid alternative (Codex PR r2 P1)', async () => {
    const d = domainRow();
    const db = makeDb({ seo_link_domains: [d] });
    // the terms page is a client-rendered script shell — canonicalizes to nothing
    const shellFetch = async (url) => (url.includes('/terms')
      ? { status: 200, finalUrl: url, contentType: 'text/html', html: '<html><script src="app.js"></script><body></body></html>', blocked: false, truncated: false }
      : okFetch(url));
    const legalHigh = modelPath({ legal_attestation: true, legal_terms_url: 'https://example.com/terms', confidence: 0.9 });
    const freeLow = modelPath({
      acquisition_type: 'self_service_free', submission_url: 'https://example.com/register', payment_required: false,
      fee_scope: null, account_required: false, email_verification: false, confidence: 0.4,
      price_text: null, price_page_url: null, renewal_price_text: null, renewal_price_page_url: null,
      currency_evidence: null, renewal_period: null,
    });
    await investigatePaths(db, runOpts(db, { fetchPage: shellFetch, llmDispatch: async () => ({ ok: true, json: verdictOf([legalHigh, freeLow]) }) }));
    const legal = db._tables.seo_link_acquisition_paths.find((p) => p.acquisition_type === 'paid_listing');
    const free = db._tables.seo_link_acquisition_paths.find((p) => p.acquisition_type === 'self_service_free');
    expect(legal.legal_terms_hash).toBeNull(); // empty shell never binds acceptance
    expect(db._tables.seo_link_domains[0].best_path_id).toBe(free.id); // the VALID lower-confidence path wins
  });

  test('existing paths outrank hint URLs in the fetch order — a hint-rich domain cannot starve its due path (Codex PR r2 P1)', async () => {
    const d = domainRow();
    const stale = {
      id: uid(), domain_id: d.id, acquisition_type: 'paid_listing', submission_url: 'https://example.com/deep/hidden-join',
      path_key: 'paid_listing:https://example.com/deep/hidden-join', superseded_by: null, baseline: false, confidence: 0.6,
      last_investigated_at: null, revision: 1, revision_payment: 1, revision_communication: 1, revision_execution: 1,
    };
    const touches = Array.from({ length: 10 }, (_, i) => ({ domain_id: d.id, source: 'list_import', source_detail: `https://example.com/page-${i}`, source_ref: null }));
    const db = makeDb({ seo_link_domains: [d], seo_link_acquisition_paths: [stale], seo_link_domain_sources: touches });
    const fetcher = jest.fn(okFetch);
    await investigatePaths(db, runOpts(db, { fetchPage: fetcher }));
    const pageFetches = fetcher.mock.calls.filter(([, o]) => !(o && o.resolveOnly)).map(([u]) => u);
    expect(pageFetches).toContain('https://example.com/deep/hidden-join'); // fetched despite 10 hints
  });

  test('a claim lost during the network window aborts every write (Codex r3 P1)', async () => {
    const d = domainRow();
    const db = makeDb({ seo_link_domains: [d] });
    // an admin rejects the domain while the model call is in flight
    const llm = jest.fn(async () => {
      db._tables.seo_link_domains[0].agent_state = 'rejected';
      return { ok: true, json: verdictOf([modelPath()]) };
    });
    const r = await investigatePaths(db, runOpts(db, { llmDispatch: llm }));
    expect(r.staleClaims).toBe(1);
    expect(r.investigated).toBe(0);
    expect(r.pathsWritten).toBe(0);
    expect(db._tables.seo_link_acquisition_paths).toHaveLength(0);
    expect(db._tables.seo_link_domains[0].agent_state).toBe('rejected'); // the admin's state stands
  });

  test('a FREE path never persists cents, even with a verified USD quote in sight (Codex r16 P1)', async () => {
    const d = domainRow();
    const db = makeDb({ seo_link_domains: [d] });
    const free = modelPath({
      acquisition_type: 'self_service_account', payment_required: false, fee_scope: null,
      renewal_period: null, // price fields still carry the observed quote as evidence
    });
    await investigatePaths(db, runOpts(db, { llmDispatch: async () => ({ ok: true, json: verdictOf([free]) }) }));
    const p = db._tables.seo_link_acquisition_paths[0];
    expect(p.payment_required).toBe(false);
    expect(p.estimated_cost_cents).toBeNull();
    expect(p.renewal_cost_cents).toBeNull();
    expect(JSON.parse(p.investigation).price_text).toBe('USD 95 / year'); // observation kept as evidence only
  });

  test('the claim itself is compare-and-set: a state change between selection and claim abandons the domain unfetched (Codex r4 P1)', async () => {
    const d = domainRow();
    const db = makeDb({ seo_link_domains: [d] });
    const fetcher = jest.fn(okFetch);
    const llm = jest.fn();
    // the admin rejects the domain between selection and the exclusive run
    const raceExclusive = (name, fn) => { db._tables.seo_link_domains[0].agent_state = 'rejected'; return fn(); };
    const r = await investigatePaths(db, runOpts(db, { exclusive: raceExclusive, fetchPage: fetcher, llmDispatch: llm }));
    expect(r.staleClaims).toBe(1);
    expect(fetcher).not.toHaveBeenCalled();
    expect(llm).not.toHaveBeenCalled();
    expect(db._tables.seo_link_domains[0].agent_state).toBe('rejected');
  });

  test('a TRUNCATED agreement body is never hashed — partial terms must not bind acceptance (Codex r7 P1)', async () => {
    const d = domainRow();
    const db = makeDb({ seo_link_domains: [d] });
    const legal = modelPath({ legal_attestation: true, legal_terms_url: 'https://example.com/terms' });
    const fetcher = jest.fn(async (url) => ({ ...(await okFetch(url)), truncated: url.includes('/terms') }));
    await investigatePaths(db, runOpts(db, { fetchPage: fetcher, llmDispatch: async () => ({ ok: true, json: verdictOf([legal]) }) }));
    expect(db._tables.seo_link_acquisition_paths[0].legal_terms_hash).toBeNull();
  });

  test('the terms budget caps ATTEMPTS — failed fetches spend it too (Codex r4 P1)', async () => {
    const d = domainRow();
    const db = makeDb({ seo_link_domains: [d] });
    const paths = Array.from({ length: 6 }, (_, i) => modelPath({
      submission_url: `https://example.com/join-${i}`,
      legal_attestation: true,
      legal_terms_url: `https://example.com/terms-${i}`,
    }));
    const fetcher = jest.fn(async (url) => (url.includes('/terms')
      ? { status: 500, finalUrl: url, html: null, blocked: false, error: 'http_500' }
      : okFetch(url)));
    await investigatePaths(db, runOpts(db, { fetchPage: fetcher, llmDispatch: async () => ({ ok: true, json: verdictOf(paths) }) }));
    const termsCalls = fetcher.mock.calls.filter(([u]) => u.includes('/terms')).length;
    expect(termsCalls).toBe(investigator.TERMS_FETCH_BUDGET);
  });

  test('a hallucinated replaces_path_id of a LIVE path is rejected — supersession needs deterministic evidence (Codex PR r1 P1)', async () => {
    const d = domainRow();
    const livePath = {
      id: uid(), domain_id: d.id, acquisition_type: 'paid_listing', submission_url: 'https://example.com/old-join',
      path_key: 'paid_listing:https://example.com/old-join', superseded_by: null, baseline: false, confidence: 0.5,
      last_investigated_at: null, revision: 1, revision_payment: 1, revision_communication: 1, revision_execution: 1,
    };
    const placement = { id: uid(), domain_id: d.id, path_id: livePath.id, status: 'prospect' };
    const db = makeDb({ seo_link_domains: [d], seo_link_acquisition_paths: [livePath], seo_link_prospects: [placement] });
    // every page (the predecessor's included) loads FINE — no gone/redirect evidence
    const replacing = modelPath({ replaces_path_id: livePath.id });
    const r = await investigatePaths(db, runOpts(db, { llmDispatch: async () => ({ ok: true, json: verdictOf([replacing]) }) }));
    expect(r.superseded).toBe(0);
    const old = db._tables.seo_link_acquisition_paths.find((p) => p.id === livePath.id);
    expect(old.superseded_by).toBeNull();
    expect(db._tables.seo_link_prospects[0].path_id).toBe(livePath.id); // placements never repointed
    const written = db._tables.seo_link_acquisition_paths.find((p) => p.id !== livePath.id);
    expect(JSON.parse(written.investigation).replaces_rejected).toMatchObject({ id: livePath.id });
  });

  test('a predecessor redirecting to the successor URL IS deterministic supersession evidence', async () => {
    const d = domainRow();
    const oldPath = {
      id: uid(), domain_id: d.id, acquisition_type: 'paid_listing', submission_url: 'https://example.com/old-join',
      path_key: 'paid_listing:https://example.com/old-join', superseded_by: null, baseline: false, confidence: 0.5,
      last_investigated_at: null, revision: 1, revision_payment: 1, revision_communication: 1, revision_execution: 1,
    };
    const db = makeDb({ seo_link_domains: [d], seo_link_acquisition_paths: [oldPath] });
    const redirectFetch = async (url) => (url.includes('/old-join')
      ? { status: 200, finalUrl: 'https://example.com/join', contentType: 'text/html', html: '<html>Join for USD 95 / year</html>', blocked: false, truncated: false }
      : okFetch(url));
    const replacing = modelPath({ replaces_path_id: oldPath.id });
    const r = await investigatePaths(db, runOpts(db, { fetchPage: redirectFetch, llmDispatch: async () => ({ ok: true, json: verdictOf([replacing]) }) }));
    expect(r.superseded).toBe(1);
    expect(db._tables.seo_link_acquisition_paths.find((p) => p.id === oldPath.id).superseded_by).toBeTruthy();
  });

  test('a state-less refresh still retires a COVERED omitted path — path truth is lane-independent (Codex PR r1 P1)', async () => {
    const d = domainRow({ agent_state: 'acquired', best_path_id: null });
    const stalePath = {
      id: uid(), domain_id: d.id, acquisition_type: 'paid_listing', submission_url: 'https://example.com/join',
      path_key: 'paid_listing:https://example.com/join', superseded_by: null, baseline: false, confidence: 0.7,
      last_investigated_at: new Date('2026-05-01'), investigation: JSON.stringify({}),
      revision: 1, revision_payment: 1, revision_communication: 1, revision_execution: 1,
    };
    const db = makeDb({ seo_link_domains: [d], seo_link_acquisition_paths: [stalePath] });
    // the page loads (covered) but the model reports a DIFFERENT path only
    const other = modelPath({ acquisition_type: 'business_claim', submission_url: 'https://example.com/register', payment_required: false, fee_scope: null, price_text: null, price_page_url: null, renewal_price_text: null, renewal_price_page_url: null, currency_evidence: null, renewal_period: null });
    await investigatePaths(db, runOpts(db, { llmDispatch: async () => ({ ok: true, json: verdictOf([other]) }) }));
    const stale = db._tables.seo_link_acquisition_paths.find((p) => p.id === stalePath.id);
    expect(stale.confidence).toBe(0);
    expect(JSON.parse(stale.investigation).disproven_at).toBeTruthy();
    expect(db._tables.seo_link_domains[0].agent_state).toBe('acquired'); // aggregate stays lane-owned
  });

  test('a failed state-less refresh backs off too, without touching the lane-owned state (Codex PR r1 P1)', async () => {
    const d = domainRow({ agent_state: 'acquired' });
    const baseline = {
      id: uid(), domain_id: d.id, acquisition_type: 'unknown', submission_url: null, baseline: true,
      path_key: 'unknown:-', superseded_by: null, last_investigated_at: null,
      revision: 1, revision_payment: 1, revision_communication: 1, revision_execution: 1,
    };
    const db = makeDb({ seo_link_domains: [d], seo_link_acquisition_paths: [baseline] });
    const r = await investigatePaths(db, runOpts(db, { llmDispatch: async () => ({ ok: false, reason: 'empty_json' }) }));
    expect(r.failed).toHaveLength(1);
    const dom = db._tables.seo_link_domains[0];
    expect(dom.agent_state).toBe('acquired'); // never re-parked
    expect(dom.investigate_failures).toBe(1);
    expect(dom.investigate_after).toEqual(new Date(NOW.getTime() + _internals.INVESTIGATE_BACKOFF_BASE_MS));
    // and the selector honors the deferral for refresh targets
    const again = await _internals.selectTargets(db, { limit: 10, now: NOW });
    expect(again).toHaveLength(0);
  });

  test('a refresh whose domain changed state mid-flight aborts all writes too (Codex r14 P1)', async () => {
    const d = domainRow({ agent_state: 'acquired' });
    const baseline = {
      id: uid(), domain_id: d.id, acquisition_type: 'unknown', submission_url: null, baseline: true,
      path_key: 'unknown:-', superseded_by: null, last_investigated_at: null,
      revision: 1, revision_payment: 1, revision_communication: 1, revision_execution: 1,
    };
    const db = makeDb({ seo_link_domains: [d], seo_link_acquisition_paths: [baseline] });
    const llm = jest.fn(async () => {
      db._tables.seo_link_domains[0].agent_state = 'rejected'; // admin acts mid-flight
      return { ok: true, json: verdictOf([modelPath()]) };
    });
    const r = await investigatePaths(db, runOpts(db, { llmDispatch: llm }));
    expect(r.staleClaims).toBe(1);
    expect(r.pathsWritten).toBe(0);
    expect(db._tables.seo_link_acquisition_paths).toHaveLength(1); // nothing written
    expect(db._tables.seo_link_acquisition_paths[0].last_investigated_at).toBeNull(); // nothing stamped
    expect(db._tables.seo_link_domains[0].agent_state).toBe('rejected');
  });

  test('a rejected off-host claim can never overwrite a legitimate URL-less path of the same type (Codex PR r4 P1)', async () => {
    const d = domainRow({ agent_state: 'investigating' });
    const outreach = {
      id: uid(), domain_id: d.id, acquisition_type: 'editorial_outreach', submission_url: null,
      path_key: 'editorial_outreach:-', superseded_by: null, baseline: false, confidence: 0.8,
      last_investigated_at: new Date('2026-08-01'), investigation: JSON.stringify({ reasons: 'legit' }),
      revision: 1, revision_payment: 1, revision_communication: 1, revision_execution: 1,
    };
    const db = makeDb({ seo_link_domains: [d], seo_link_acquisition_paths: [outreach] });
    const bare = { payment_required: false, fee_scope: null, price_text: null, price_page_url: null, renewal_price_text: null, renewal_price_page_url: null, currency_evidence: null, renewal_period: null };
    const legit = modelPath({ acquisition_type: 'editorial_outreach', link_type: 'editorial', submission_url: null, confidence: 0.8, ...bare });
    const injected = modelPath({ acquisition_type: 'editorial_outreach', link_type: 'editorial', submission_url: 'https://evil.example.net/pitch', confidence: 0.1, ...bare });
    await investigatePaths(db, runOpts(db, { llmDispatch: async () => ({ ok: true, json: verdictOf([legit, injected]) }) }));
    const kept = db._tables.seo_link_acquisition_paths.find((p) => p.id === outreach.id);
    expect(Number(kept.confidence)).toBe(0.8); // the discarded claim never took the ':-' identity
    expect(db._tables.seo_link_acquisition_paths).toHaveLength(1);
  });

  test('a page longer than the prompt excerpt is existence, not coverage (Codex PR r4 P1)', async () => {
    const d = domainRow({ agent_state: 'investigating' });
    const stalePath = {
      id: uid(), domain_id: d.id, acquisition_type: 'paid_listing', submission_url: 'https://example.com/join',
      path_key: 'paid_listing:https://example.com/join', superseded_by: null, baseline: false, confidence: 0.7,
      last_investigated_at: new Date('2026-05-01'), investigation: JSON.stringify({}),
      revision: 1, revision_payment: 1, revision_communication: 1, revision_execution: 1,
    };
    const db = makeDb({ seo_link_domains: [d], seo_link_acquisition_paths: [stalePath] });
    const longPage = `<html><body>${'Long page content. '.repeat(500)}</body></html>`; // > 6000 canonical chars
    const longFetch = async (url) => (url.includes('/join')
      ? { status: 200, finalUrl: url, contentType: 'text/html', html: longPage, blocked: false, truncated: false }
      : okFetch(url));
    const other = modelPath({ acquisition_type: 'business_claim', submission_url: 'https://example.com/register', payment_required: false, fee_scope: null, price_text: null, price_page_url: null, renewal_price_text: null, renewal_price_page_url: null, currency_evidence: null, renewal_period: null });
    await investigatePaths(db, runOpts(db, { fetchPage: longFetch, llmDispatch: async () => ({ ok: true, json: verdictOf([other]) }) }));
    const stale = db._tables.seo_link_acquisition_paths.find((p) => p.id === stalePath.id);
    expect(Number(stale.confidence)).toBe(0.7); // the model saw only a prefix — no disproof
    expect(stale.last_investigated_at).toEqual(new Date('2026-05-01'));
  });

  test('investigator-owned aggregates re-decide on refresh: disproven qualified closes; rediscovered not_reproducible reopens (Codex PR r4 P1)', async () => {
    // full probe coverage already earned — the close may proceed
    const d = domainRow({ agent_state: 'qualified', probe_coverage_mask: (1 << 13) - 1 });
    const stale = {
      id: uid(), domain_id: d.id, acquisition_type: 'paid_listing', submission_url: 'https://example.com/join',
      path_key: 'paid_listing:https://example.com/join', superseded_by: null, baseline: false, confidence: 0.7,
      last_investigated_at: new Date('2026-05-01'), investigation: JSON.stringify({}),
      revision: 1, revision_payment: 1, revision_communication: 1, revision_execution: 1,
    };
    const db = makeDb({ seo_link_domains: [d], seo_link_acquisition_paths: [stale] });
    await investigatePaths(db, runOpts(db, { llmDispatch: async () => ({ ok: true, json: verdictOf([], 'not_reproducible') }) }));
    expect(db._tables.seo_link_domains[0].agent_state).toBe('not_reproducible');
    expect(db._tables.seo_link_domains[0].best_path_id).toBeNull();

    const d2 = domainRow({ domain: 'other.com', agent_state: 'not_reproducible' });
    const old2 = {
      id: uid(), domain_id: d2.id, acquisition_type: 'paid_listing', submission_url: 'https://other.com/join',
      path_key: 'paid_listing:https://other.com/join', superseded_by: null, baseline: false, confidence: 0,
      last_investigated_at: new Date('2026-05-01'), investigation: JSON.stringify({}),
      revision: 1, revision_payment: 1, revision_communication: 1, revision_execution: 1,
    };
    const db2 = makeDb({ seo_link_domains: [d2], seo_link_acquisition_paths: [old2] });
    const found = modelPath({ submission_url: 'https://other.com/join', price_text: null, price_page_url: null, renewal_price_text: null, renewal_price_page_url: null, currency_evidence: null });
    await investigatePaths(db2, runOpts(db2, { llmDispatch: async () => ({ ok: true, json: verdictOf([found]) }) }));
    expect(db2._tables.seo_link_domains[0].agent_state).toBe('qualified');
    expect(db2._tables.seo_link_domains[0].best_path_id).toBeTruthy();
  });

  test('composite provenance details yield their embedded URLs as candidates (Codex PR r4 P1)', () => {
    const { candidateUrls } = _internals;
    const urls = candidateUrls('example.com', {
      touches: [{ source_detail: 'paste:2026-09-01 https://example.com/custom-apply' }],
      competitorUrls: [], existingPaths: [],
    });
    expect(urls).toContain('https://example.com/custom-apply');
  });

  test('a quote beyond the prompt excerpt never verifies — the model did not see it (Codex PR r5 P1)', () => {
    const { verifyPriceEvidence } = _internals;
    const filler = 'Directory copy about local vendors and categories. '.repeat(130); // > 6000 canonical chars
    const text = `${filler} Join for USD 95 / year.`;
    const page = { url: 'https://example.com/join', excerpt: text.slice(0, 6000), text, html: '' };
    const v = verifyPriceEvidence([page], modelPath());
    expect(v.price_text).toBeNull();
    expect(v.currency_evidence).toBeNull();
    expect(v.verification.price_text).toBe('not_on_fetched_page');
  });

  test('terms-budget overflow leaves later legal paths unstamped and keeps their prior hash (Codex PR r5 P1)', async () => {
    const d = domainRow();
    const priorHash = 'a'.repeat(64);
    const existing = {
      id: uid(), domain_id: d.id, acquisition_type: 'paid_listing', submission_url: 'https://example.com/join-c',
      path_key: 'paid_listing:https://example.com/join-c', superseded_by: null, baseline: false, confidence: 0.7,
      legal_attestation: true, legal_terms_hash: priorHash,
      last_investigated_at: new Date('2026-08-01'), investigation: JSON.stringify({ legal_terms_url: 'https://example.com/terms-c' }),
      revision: 1, revision_payment: 1, revision_communication: 1, revision_execution: 1,
    };
    const db = makeDb({ seo_link_domains: [d], seo_link_acquisition_paths: [existing] });
    const legal = (n) => modelPath({ submission_url: `https://example.com/join-${n}`, legal_attestation: true, legal_terms_url: `https://example.com/terms-${n}` });
    // a, b spend the whole terms budget (attempts); c never gets one
    await investigatePaths(db, runOpts(db, { llmDispatch: async () => ({ ok: true, json: verdictOf([legal('a'), legal('b'), legal('c')]) }) }));
    const kept = db._tables.seo_link_acquisition_paths.find((p) => p.id === existing.id);
    expect(kept.legal_terms_hash).toBe(priorHash); // never erased on a local budget limit
    expect(kept.last_investigated_at).toBeNull(); // unstamped — the rotation retries it next pass
  });

  test('a dead predecessor never repoints placements onto an UNOBSERVED successor (Codex PR r5 P1)', async () => {
    const d = domainRow();
    const oldPath = {
      id: uid(), domain_id: d.id, acquisition_type: 'paid_listing', submission_url: 'https://example.com/old-join',
      path_key: 'paid_listing:https://example.com/old-join', superseded_by: null, baseline: false, confidence: 0.7,
      last_investigated_at: new Date('2026-05-01'), investigation: JSON.stringify({}),
      revision: 1, revision_payment: 1, revision_communication: 1, revision_execution: 1,
    };
    const placement = { id: uid(), domain_id: d.id, path_id: oldPath.id, status: 'prospect' };
    const db = makeDb({ seo_link_domains: [d], seo_link_acquisition_paths: [oldPath], seo_link_prospects: [placement] });
    // predecessor is gone (404) — but the claimed successor fails its own probe
    const replacing = modelPath({ submission_url: 'https://example.com/new-join', price_page_url: 'https://example.com/new-join', renewal_price_page_url: 'https://example.com/new-join', replaces_path_id: oldPath.id });
    const fetcher = async (url) => ((url.includes('/old-join') || url.includes('/new-join'))
      ? { status: 404, finalUrl: url, html: null, blocked: false }
      : okFetch(url));
    const r = await investigatePaths(db, runOpts(db, { fetchPage: fetcher, llmDispatch: async () => ({ ok: true, json: verdictOf([replacing]) }) }));
    expect(r.superseded).toBe(0);
    const old = db._tables.seo_link_acquisition_paths.find((p) => p.id === oldPath.id);
    expect(old.superseded_by).toBeNull();
    expect(db._tables.seo_link_prospects[0].path_id).toBe(oldPath.id); // placements stay
    const successor = db._tables.seo_link_acquisition_paths.find((p) => p.path_key === 'paid_listing:https://example.com/new-join');
    expect(JSON.parse(successor.investigation).replaces_rejected).toEqual({ id: oldPath.id, reason: 'successor_unobserved' });
  });

  test('an attempted-but-failed terms fetch never erases a previously valid hash (local Codex P1)', async () => {
    const d = domainRow();
    const priorHash = 'b'.repeat(64);
    const existing = {
      id: uid(), domain_id: d.id, acquisition_type: 'paid_listing', submission_url: 'https://example.com/join',
      path_key: 'paid_listing:https://example.com/join', superseded_by: null, baseline: false, confidence: 0.7,
      legal_attestation: true, legal_terms_hash: priorHash,
      last_investigated_at: new Date('2026-08-01'), investigation: JSON.stringify({ legal_terms_url: 'https://example.com/terms' }),
      revision: 1, revision_payment: 1, revision_communication: 1, revision_execution: 1,
    };
    const db = makeDb({ seo_link_domains: [d], seo_link_acquisition_paths: [existing] });
    const legal = modelPath({ legal_attestation: true, legal_terms_url: 'https://example.com/terms' });
    const fetcher = async (url) => (url.includes('/terms')
      ? { status: 500, finalUrl: url, html: null, blocked: false, error: 'http_500' }
      : okFetch(url));
    await investigatePaths(db, runOpts(db, { fetchPage: fetcher, llmDispatch: async () => ({ ok: true, json: verdictOf([legal]) }) }));
    const kept = db._tables.seo_link_acquisition_paths.find((p2) => p2.id === existing.id);
    expect(kept.legal_terms_hash).toBe(priorHash); // a transient failure is not a verdict on the agreement
    expect(kept.last_investigated_at).toBeNull(); // unstamped — retried on rotation
  });

  test('a non-text agreement body is never hashed — a PDF cannot bind acceptance (Codex PR r5 P1)', async () => {
    const d = domainRow();
    const db = makeDb({ seo_link_domains: [d] });
    const legal = modelPath({ legal_attestation: true, legal_terms_url: 'https://example.com/terms.pdf' });
    const binaryish = `%PDF-1.7 ${'obj stream xref trailer startxref '.repeat(20)}`; // decodes long, means nothing
    const fetcher = async (url) => (url.includes('/terms.pdf')
      ? { status: 200, finalUrl: url, contentType: 'application/pdf', html: binaryish, blocked: false, truncated: false }
      : okFetch(url));
    await investigatePaths(db, runOpts(db, { fetchPage: fetcher, llmDispatch: async () => ({ ok: true, json: verdictOf([legal]) }) }));
    const p = db._tables.seo_link_acquisition_paths[0];
    expect(p.legal_terms_hash).toBeNull();
  });

  test('a run whose every page is a script shell spends no model call and defers (Codex PR r6 P1)', async () => {
    const d = domainRow();
    const db = makeDb({ seo_link_domains: [d] });
    const shellFetch = async (url) => ({ status: 200, finalUrl: url, contentType: 'text/html', html: '<html><script src="app.js"></script><body></body></html>', blocked: false, truncated: false });
    const llm = jest.fn(async () => ({ ok: true, json: verdictOf([], 'not_reproducible') }));
    const r = await investigatePaths(db, runOpts(db, { fetchPage: shellFetch, llmDispatch: llm }));
    expect(llm).not.toHaveBeenCalled(); // no substantive content — a verdict would judge the NAME
    expect(r.failed).toEqual([expect.objectContaining({ reason: 'no_substantive_page_evidence' })]);
    expect(db._tables.seo_link_domains[0].agent_state).toBe('investigating'); // claimed, never CLOSED on a shell-only pass
    expect(db._tables.seo_link_domains[0].investigate_after).toBeTruthy(); // backoff, not an hourly re-spend
  });

  test('a transient-verification watching downgrade rechecks on the backoff horizon, not 30 days (Codex PR r6 P1)', async () => {
    const d = domainRow();
    const db = makeDb({ seo_link_domains: [d] });
    // the only path's submission URL fails its existence probe → unstamped,
    // confidence 0, no best path → qualified downgrades to watching
    const claimed = modelPath({ submission_url: 'https://example.com/hidden-join', price_page_url: 'https://example.com/hidden-join', renewal_price_page_url: 'https://example.com/hidden-join' });
    const fetcher = async (url) => (url.includes('/hidden-join')
      ? { status: 404, finalUrl: url, html: null, blocked: false }
      : okFetch(url));
    await investigatePaths(db, runOpts(db, { fetchPage: fetcher, llmDispatch: async () => ({ ok: true, json: verdictOf([claimed]) }) }));
    const dom = db._tables.seo_link_domains[0];
    expect(dom.agent_state).toBe('watching');
    const horizon = new Date(dom.watch_recheck_at).getTime() - NOW.getTime();
    expect(horizon).toBeLessThanOrEqual(investigator._internals.INVESTIGATE_BACKOFF_BASE_MS); // near-term retry
  });

  test('an unrelated JSON-LD USD offer never upgrades a bare-dollar quote (Codex PR r6 P1)', () => {
    const { verifyPriceEvidence } = _internals;
    const text = `Directory listing page with membership details. Join for $95 / year. ${'More copy about categories and vendors. '.repeat(3)}`;
    const html = `<html><script type="application/ld+json">{"@type":"Offer","price":"500","priceCurrency":"USD"}</script><body>${text}</body></html>`;
    const page = { url: 'https://example.com/join', excerpt: text, text, html };
    const v = verifyPriceEvidence([page], modelPath({ price_text: '$95 / year', renewal_price_text: null, renewal_price_page_url: null, currency_evidence: { marker: 'USD', kind: 'jsonld_price_currency', page_url: 'https://example.com/join' } }));
    expect(v.currency_evidence).toBeNull(); // the offer's own price must match the verified quote
    expect(v.verification.currency_evidence).toBe('jsonld_offer_not_bound_to_verified_quote');
  });

  test('an existing path echoed WITHOUT content coverage is neither overwritten nor stamped (Codex PR r6 P1)', async () => {
    const d = domainRow({ agent_state: 'investigating' });
    const existing = {
      id: uid(), domain_id: d.id, acquisition_type: 'paid_listing', submission_url: 'https://example.com/unreadable-join',
      path_key: 'paid_listing:https://example.com/unreadable-join', superseded_by: null, baseline: false, confidence: 0.9,
      estimated_cost_cents: 12000, last_investigated_at: new Date('2026-08-15'), investigation: JSON.stringify({ reasons: 'covered last pass' }),
      revision: 1, revision_payment: 1, revision_communication: 1, revision_execution: 1,
    };
    const db = makeDb({ seo_link_domains: [d], seo_link_acquisition_paths: [existing] });
    // its page times out this pass — the model still echoes the path from
    // the prompt's identity list, with drifted fields
    const echoed = modelPath({ submission_url: 'https://example.com/unreadable-join', confidence: 0.2, price_text: 'USD 5 / year', quotes: ['USD 5 / year'] });
    const fetcher = async (url) => (url.includes('/unreadable-join')
      ? { status: null, finalUrl: null, html: null, blocked: false, error: 'timeout' }
      : okFetch(url));
    await investigatePaths(db, runOpts(db, { fetchPage: fetcher, llmDispatch: async () => ({ ok: true, json: verdictOf([echoed]) }) }));
    const kept = db._tables.seo_link_acquisition_paths.find((p2) => p2.id === existing.id);
    expect(Number(kept.confidence)).toBe(0.9); // no observation, no replacement
    expect(Number(kept.estimated_cost_cents)).toBe(12000);
    expect(kept.last_investigated_at).toBeNull(); // marked DUE (Codex PR r15 P1) — a recent stamp must not hide the unread page for 90 days
  });

  test('an abbreviated numeric continuation never verifies the truncated quote (Codex PR r7 P1)', () => {
    const { verifyPriceEvidence } = _internals;
    const mk = (body) => {
      const text = `Directory listing page with membership details and vendor information. ${body}. Applications are reviewed within five business days.`;
      return [{ url: 'https://example.com/join', excerpt: text, text, html: '' }];
    };
    // the claim is the exact substring the page carries — the NEGATIVES must
    // fail on the boundary logic, not on a quote that is simply absent
    const claim = (pages, quote = 'USD 95') => verifyPriceEvidence(pages, modelPath({ price_text: quote, renewal_price_text: null, renewal_price_page_url: null, currency_evidence: null })).price_text;
    expect(claim(mk('Join for USD 95k per placement'))).toBeNull(); // 95k is not 95
    expect(claim(mk('Join for USD 95 million sponsorships served'))).toBeNull(); // spelled multiplier
    expect(claim(mk('Join for USD 95 / year'), 'USD 95 / year')).toBe('USD 95 / year'); // the real quote still verifies
  });

  test('a binary 2xx body is never page evidence — no prompt, no coverage, no disproof (Codex PR r7 P1)', async () => {
    const d = domainRow({ agent_state: 'investigating' });
    const stale = {
      id: uid(), domain_id: d.id, acquisition_type: 'paid_listing', submission_url: 'https://example.com/join',
      path_key: 'paid_listing:https://example.com/join', superseded_by: null, baseline: false, confidence: 0.7,
      last_investigated_at: new Date('2026-05-01'), investigation: JSON.stringify({}),
      revision: 1, revision_payment: 1, revision_communication: 1, revision_execution: 1,
    };
    const db = makeDb({ seo_link_domains: [d], seo_link_acquisition_paths: [stale] });
    const binary = `%PDF-1.7 ${'obj stream xref trailer startxref '.repeat(10)}`;
    const fetcher = async (url) => (url.includes('/join')
      ? { status: 200, finalUrl: url, contentType: 'application/pdf', html: binary, blocked: false, truncated: false }
      : okFetch(url));
    const other = modelPath({ acquisition_type: 'business_claim', submission_url: 'https://example.com/register', payment_required: false, fee_scope: null, price_text: null, price_page_url: null, renewal_price_text: null, renewal_price_page_url: null, currency_evidence: null, renewal_period: null });
    await investigatePaths(db, runOpts(db, { fetchPage: fetcher, llmDispatch: async () => ({ ok: true, json: verdictOf([other]) }) }));
    const kept = db._tables.seo_link_acquisition_paths.find((p2) => p2.id === stale.id);
    expect(Number(kept.confidence)).toBe(0.7); // the PDF page proves nothing about the path
    expect(kept.last_investigated_at).toEqual(new Date('2026-05-01'));
  });

  test('the probe list rotates with the pass offset (Codex PR r7 P1)', () => {
    const { candidateUrls } = _internals;
    const at = (off) => candidateUrls('example.com', { probeOffset: off }).slice(1); // drop the homepage
    expect(at(0)).not.toEqual(at(1)); // a later pass leads with a different probe
    expect(new Set(at(0))).toEqual(new Set(at(1))); // same full set, different order
    expect(at(0)).toEqual(at(_internals.PROBE_PATHS ? _internals.PROBE_PATHS.length : 13)); // full cycle returns
  });

  test('a terminal close is deferred ONCE while capped candidates remain, then closes (Codex PR r7 P1)', async () => {
    const d = domainRow();
    const db = makeDb({ seo_link_domains: [d] });
    const llm = async () => ({ ok: true, json: verdictOf([], 'not_reproducible') });
    await investigatePaths(db, runOpts(db, { llmDispatch: llm }));
    const dom = db._tables.seo_link_domains[0];
    expect(dom.agent_state).toBe('watching'); // the probe tail was never fetched — not closed yet
    expect(dom.score_reasons).toContain('unfetched candidate URLs remain');
    const horizon = new Date(dom.watch_recheck_at).getTime() - NOW.getTime();
    expect(horizon).toBeLessThanOrEqual(6 * 60 * 60 * 1000); // near-term re-pass, not 30 days
    dom.watch_recheck_at = NOW; // due now
    await investigatePaths(db, runOpts(db, { domainIds: [d.id], llmDispatch: llm }));
    expect(db._tables.seo_link_domains[0].agent_state).toBe('not_reproducible'); // second terminal verdict closes
  });

  test('a legal path whose terms URL the model omitted keeps its prior hash, unstamped (Codex PR r7 P1)', async () => {
    const d = domainRow();
    const priorHash = 'c'.repeat(64);
    const existing = {
      id: uid(), domain_id: d.id, acquisition_type: 'paid_listing', submission_url: 'https://example.com/join',
      path_key: 'paid_listing:https://example.com/join', superseded_by: null, baseline: false, confidence: 0.7,
      legal_attestation: true, legal_terms_hash: priorHash,
      last_investigated_at: new Date('2026-08-01'), investigation: JSON.stringify({}),
      revision: 1, revision_payment: 1, revision_communication: 1, revision_execution: 1,
    };
    const db = makeDb({ seo_link_domains: [d], seo_link_acquisition_paths: [existing] });
    const echoed = modelPath({ legal_attestation: true, legal_terms_url: null });
    await investigatePaths(db, runOpts(db, { llmDispatch: async () => ({ ok: true, json: verdictOf([echoed]) }) }));
    const kept = db._tables.seo_link_acquisition_paths.find((p2) => p2.id === existing.id);
    expect(kept.legal_terms_hash).toBe(priorHash); // no URL, no observation, no erase
    expect(kept.last_investigated_at).toBeNull(); // unstamped for the rotated retry
  });

  test('a pass leaving unverified paths backs the domain off instead of hourly re-selection (Codex PR r7 P1)', async () => {
    const d = domainRow();
    const db = makeDb({ seo_link_domains: [d] });
    // the only path's URL fails its probe → written unstamped
    const claimed = modelPath({ submission_url: 'https://example.com/hidden-join', price_page_url: 'https://example.com/hidden-join', renewal_price_page_url: 'https://example.com/hidden-join' });
    const fetcher = async (url) => (url.includes('/hidden-join')
      ? { status: 404, finalUrl: url, html: null, blocked: false }
      : okFetch(url));
    await investigatePaths(db, runOpts(db, { fetchPage: fetcher, llmDispatch: async () => ({ ok: true, json: verdictOf([claimed]) }) }));
    const dom = db._tables.seo_link_domains[0];
    expect(dom.investigate_after).toBeTruthy(); // never-stamped path must not re-select hourly
    expect(new Date(dom.investigate_after).getTime()).toBeGreaterThan(NOW.getTime());
  });

  test('a fragment-only submission URL change bumps revision_execution (Codex PR r7 P2)', async () => {
    const { upsertPath } = _internals;
    const d = domainRow();
    const existing = {
      id: uid(), domain_id: d.id, acquisition_type: 'paid_listing', submission_url: 'https://example.com/join#basic',
      path_key: 'paid_listing:https://example.com/join', superseded_by: null, baseline: false, confidence: 0.7,
      last_investigated_at: new Date('2026-08-01'), investigation: JSON.stringify({}),
      revision: 1, revision_payment: 1, revision_communication: 1, revision_execution: 1,
    };
    const db = makeDb({ seo_link_domains: [d], seo_link_acquisition_paths: [existing] });
    const row = { ...existing, submission_url: 'https://example.com/join#premium' };
    delete row.id;
    await db.transaction(async (trx) => upsertPath(trx, d.id, { ...row }, { now: NOW }));
    const kept = db._tables.seo_link_acquisition_paths.find((p2) => p2.id === existing.id);
    expect(Number(kept.revision_execution)).toBe(2); // a runner executes a different client-side flow
    expect(Number(kept.revision)).toBe(2);
  });

  test('a model-claimed merchant binding never persists — evidence only, and a runner-verified one survives (Codex PR r8 P1)', async () => {
    const d = domainRow();
    const db = makeDb({ seo_link_domains: [d] });
    const binding = { checkout_origin: 'https://example.com/checkout', processor: { host: 'checkout.stripe.com', merchant_account_id: 'acct_evil123' }, issuer_merchant_descriptor: null };
    const claimed = modelPath({ merchant_binding: binding });
    await investigatePaths(db, runOpts(db, { llmDispatch: async () => ({ ok: true, json: verdictOf([claimed]) }) }));
    const row = db._tables.seo_link_acquisition_paths[0];
    expect(row.merchant_binding).toBeNull(); // static investigation observes no checkout
    const ev = JSON.parse(row.investigation);
    expect(ev.merchant_binding_claim).toEqual(binding);
    expect(ev.merchant_binding_verification).toBe('unverified_static_step3');

    // a runner-verified binding on the existing row survives re-investigation
    row.merchant_binding = JSON.stringify({ merchant_account_id: 'acct_real', observed: true });
    row.last_investigated_at = new Date('2026-05-01');
    d.agent_state = 'qualified';
    d.probe_coverage_mask = (1 << 13) - 1;
    await investigatePaths(db, runOpts(db, { domainIds: [d.id], llmDispatch: async () => ({ ok: true, json: verdictOf([claimed]) }) }));
    const kept = db._tables.seo_link_acquisition_paths[0];
    expect(JSON.parse(kept.merchant_binding).merchant_account_id).toBe('acct_real');
  });

  test('a JSON-LD offer on a DIFFERENT page never validates the quote (Codex PR r8 P1)', () => {
    const { verifyPriceEvidence } = _internals;
    const joinText = `Directory listing page with membership details. Join for $95 / year. ${'Copy. '.repeat(10)}`;
    const storeText = `Store page with products. ${'Copy. '.repeat(10)}`;
    const pages = [
      { url: 'https://example.com/join', excerpt: joinText, text: joinText, html: `<html><body>${joinText}</body></html>` },
      { url: 'https://example.com/store', excerpt: storeText, text: storeText, html: `<html><script type="application/ld+json">{"@type":"Offer","price":"95","priceCurrency":"USD"}</script><body>${storeText}</body></html>` },
    ];
    const v = verifyPriceEvidence(pages, modelPath({ price_text: '$95 / year', price_page_url: 'https://example.com/join', renewal_price_text: null, renewal_price_page_url: null, currency_evidence: { marker: 'USD', kind: 'jsonld_price_currency', page_url: 'https://example.com/store' } }));
    expect(v.currency_evidence).toBeNull(); // the quote and the offer never occur together
    expect(v.verification.currency_evidence).toBe('jsonld_offer_not_bound_to_verified_quote');
  });

  test('AggregateOffer lowPrice binds currency; an undeclared-currency offer never does (Codex PR r9 P1)', () => {
    const { verifyPriceEvidence } = _internals;
    const text = `Directory listing page with membership details. Join for $95 / year. ${'Copy. '.repeat(10)}`;
    const page = (ld) => [{ url: 'https://example.com/join', excerpt: text, text, html: `<html><script type="application/ld+json">${ld}</script><body>${text}</body></html>` }];
    const claim = (pages) => verifyPriceEvidence(pages, modelPath({ price_text: '$95 / year', renewal_price_text: null, renewal_price_page_url: null, currency_evidence: { marker: 'USD', kind: 'jsonld_price_currency', page_url: 'https://example.com/join' } }));
    // the shared price-scan collector handles AggregateOffer.lowPrice
    expect(claim(page('{"@type":"AggregateOffer","lowPrice":"95","priceCurrency":"USD"}')).currency_evidence).not.toBeNull();
    // …but its USD DEFAULT for currency-less markup is not evidence
    expect(claim(page('{"@type":"Offer","price":"95"}')).currency_evidence).toBeNull();
  });

  test('a canonical http→https redirect covers BOTH URL aliases; a soft-redirect covers neither claim (Codex PR r9 P1)', async () => {
    const d = domainRow({ agent_state: 'investigating' });
    const httpPath = {
      id: uid(), domain_id: d.id, acquisition_type: 'paid_listing', submission_url: 'http://example.com/join',
      path_key: 'paid_listing:http://example.com/join', superseded_by: null, baseline: false, confidence: 0.7,
      last_investigated_at: null, investigation: JSON.stringify({}),
      revision: 1, revision_payment: 1, revision_communication: 1, revision_execution: 1,
    };
    const db = makeDb({ seo_link_domains: [d], seo_link_acquisition_paths: [httpPath] });
    const upgraded = async (url) => (url.startsWith('http://example.com/join')
      ? okFetch(url.replace('http://', 'https://')) // canonical scheme redirect
      : okFetch(url));
    const reported = modelPath({ submission_url: 'https://example.com/join', price_page_url: 'https://example.com/join', renewal_price_page_url: 'https://example.com/join' });
    await investigatePaths(db, runOpts(db, { fetchPage: upgraded, llmDispatch: async () => ({ ok: true, json: verdictOf([reported]) }) }));
    const old = db._tables.seo_link_acquisition_paths.find((p2) => p2.id === httpPath.id);
    // the followed canonical redirect covered the http alias: the original
    // path is stamped (no eternal re-selection) and, being omitted from the
    // verdict, retired — never a live duplicate beside the https row
    expect(old.last_investigated_at).not.toBeNull();
    expect(Number(old.confidence)).toBe(0);
  });

  test('the terms budget rotates: an un-hashed third legal path is not starved forever (Codex PR r9 P1)', async () => {
    const termsFetches = [];
    const agreement = `<html><body>Membership agreement. ${'By joining you agree to the listing terms and renewal policy. '.repeat(8)}</body></html>`;
    const fetcher = async (url) => {
      if (url.includes('/terms-')) { termsFetches.push(url); return { status: 200, finalUrl: url, contentType: 'text/html', html: agreement, blocked: false, truncated: false }; }
      return okFetch(url);
    };
    const legal = (n) => modelPath({ submission_url: `https://example.com/join-${n}`, legal_attestation: true, legal_terms_url: `https://example.com/terms-${n}` });
    const verdict = async () => ({ ok: true, json: verdictOf([legal('a'), legal('b'), legal('c')]) });
    const run = async (now) => {
      const d = domainRow();
      const db = makeDb({ seo_link_domains: [d] });
      await investigatePaths(db, { ...runOpts(db, { fetchPage: fetcher, llmDispatch: verdict }), now });
    };
    await run(NOW);
    await run(new Date(NOW.getTime() + 60 * 60 * 1000)); // one sweep later
    await run(new Date(NOW.getTime() + 2 * 60 * 60 * 1000));
    const attempted = new Set(termsFetches.map((u) => u.slice(-1)));
    expect([...attempted].sort()).toEqual(['a', 'b', 'c']); // every terms URL got its attempt across passes
  });

  test('truncated range and qualifier price claims never verify (Codex PR r9 P1)', () => {
    const { verifyPriceEvidence } = _internals;
    const mk = (body) => {
      const text = `Directory listing page with membership details and vendor information. ${body}. Applications are reviewed within five business days.`;
      return [{ url: 'https://example.com/join', excerpt: text, text, html: '' }];
    };
    const claim = (pages, quote = 'USD 95') => verifyPriceEvidence(pages, modelPath({ price_text: quote, renewal_price_text: null, renewal_price_page_url: null, currency_evidence: null })).price_text;
    expect(claim(mk('Listings cost USD 95\u2013150 per year'))).toBeNull(); // en-dash range
    expect(claim(mk('Listings cost USD 95-150 per year'))).toBeNull(); // hyphen range
    expect(claim(mk('Listings from USD 95 per year'))).toBeNull(); // starting price
    expect(claim(mk('Listings starting at USD 95 per year'))).toBeNull();
    expect(claim(mk('Listings cost USD 95 / year'), 'USD 95 / year')).toBe('USD 95 / year'); // the plain quote still verifies
  });

  test('the terms rotation start avalanches — a 6h-stride retry cannot pin the same two of three URLs (Codex PR r10 P1)', async () => {
    const termsFetches = [];
    const agreement = `<html><body>Membership agreement. ${'By joining you agree to the listing terms and renewal policy. '.repeat(8)}</body></html>`;
    const fetcher = async (url) => {
      if (url.includes('/terms-')) { termsFetches.push(url); return { status: 200, finalUrl: url, contentType: 'text/html', html: agreement, blocked: false, truncated: false }; }
      return okFetch(url);
    };
    const legal = (n) => modelPath({ submission_url: `https://example.com/join-${n}`, legal_attestation: true, legal_terms_url: `https://example.com/terms-${n}` });
    const verdict = async () => ({ ok: true, json: verdictOf([legal('a'), legal('b'), legal('c')]) });
    // 8 passes exactly six hours apart — the failure-backoff stride
    for (let i = 0; i < 8; i++) {
      const d = domainRow();
      const db = makeDb({ seo_link_domains: [d] });
      await investigatePaths(db, { ...runOpts(db, { fetchPage: fetcher, llmDispatch: verdict }), now: new Date(NOW.getTime() + i * 6 * 60 * 60 * 1000) });
    }
    const attempted = new Set(termsFetches.map((u) => u.slice(-1)));
    expect([...attempted].sort()).toEqual(['a', 'b', 'c']);
  });

  test('an invalid host defers with backoff BEFORE any claim — no hourly re-selection (Codex PR r10 P1)', async () => {
    const d = domainRow({ domain: '' });
    const db = makeDb({ seo_link_domains: [d] });
    const llm = jest.fn();
    const r = await investigatePaths(db, runOpts(db, { llmDispatch: llm }));
    expect(r.failed).toEqual([expect.objectContaining({ reason: 'invalid_host' })]);
    expect(llm).not.toHaveBeenCalled();
    const dom = db._tables.seo_link_domains[0];
    expect(Number(dom.investigate_failures)).toBe(1); // the pre-claim defer actually landed
    expect(dom.investigate_after).toBeTruthy();
  });

  test('a deterministic 404 on a path URL is disproof — the dead path retires and stamps (Codex PR r10 P1)', async () => {
    const d = domainRow({ agent_state: 'qualified', probe_coverage_mask: (1 << 13) - 1 });
    const dead = {
      id: uid(), domain_id: d.id, acquisition_type: 'paid_listing', submission_url: 'https://example.com/join',
      path_key: 'paid_listing:https://example.com/join', superseded_by: null, baseline: false, confidence: 0.7,
      last_investigated_at: new Date('2026-05-01'), investigation: JSON.stringify({}),
      revision: 1, revision_payment: 1, revision_communication: 1, revision_execution: 1,
    };
    const db = makeDb({ seo_link_domains: [d], seo_link_acquisition_paths: [dead] });
    d.best_path_id = dead.id;
    const fetcher = async (url) => (url.includes('/join')
      ? { status: 404, finalUrl: url, html: null, blocked: false }
      : okFetch(url));
    await investigatePaths(db, runOpts(db, { fetchPage: fetcher, llmDispatch: async () => ({ ok: true, json: verdictOf([], 'not_reproducible') }) }));
    const p = db._tables.seo_link_acquisition_paths.find((p2) => p2.id === dead.id);
    expect(Number(p.confidence)).toBe(0);
    expect(JSON.parse(p.investigation).disproven_reason).toBe('submission URL returned 404/410');
    expect(p.last_investigated_at).not.toBeNull(); // stamped — no eternal re-selection
    expect(db._tables.seo_link_domains[0].best_path_id).toBeNull();
    expect(db._tables.seo_link_domains[0].agent_state).toBe('not_reproducible'); // closes instead of a 30-day watching park
  });

  test('a hint-rich domain defers terminal closure until EVERY probe has been offered (Codex PR r11 P1)', async () => {
    const d = domainRow();
    // 5 hints: each pass fits homepage + 5 hints + 2 probes — the probe tail
    // needs many passes, and closure must wait for all 13
    const touches = Array.from({ length: 5 }, (_, i) => ({ domain_id: d.id, source: 'list_import', source_detail: `https://example.com/hint-${i}`, source_ref: null }));
    const db = makeDb({ seo_link_domains: [d], seo_link_domain_sources: touches });
    const fetched = new Set();
    const fetcher = jest.fn(async (url) => { fetched.add(url); return okFetch(url); });
    const llm = async () => ({ ok: true, json: verdictOf([], 'not_reproducible') });
    let passes = 0;
    while (db._tables.seo_link_domains[0].agent_state !== 'not_reproducible' && passes < 12) {
      const dom = db._tables.seo_link_domains[0];
      dom.watch_recheck_at = new Date(NOW.getTime() + passes * 6 * 60 * 60 * 1000); // due
      await investigatePaths(db, { ...runOpts(db, { fetchPage: fetcher, llmDispatch: llm }), now: new Date(NOW.getTime() + passes * 6 * 60 * 60 * 1000), domainIds: [dom.id] });
      passes += 1;
    }
    expect(db._tables.seo_link_domains[0].agent_state).toBe('not_reproducible'); // it DOES close in the end
    const probePaths = ['/submit', '/add-listing', '/join', '/membership', '/members', '/vendors', '/sponsors', '/advertise', '/directory', '/resources', '/contact', '/signup', '/register'];
    for (const pp of probePaths) expect(fetched.has(`https://example.com${pp}`)).toBe(true); // every probe ran first
    expect(passes).toBeGreaterThan(2); // the close genuinely waited for coverage
  });

  test('hints can never take the reserved probe slots — even a hint-saturated domain probes and closes (Codex PR r11+r12 P1)', async () => {
    const d = domainRow();
    // 12 hints would exhaust every slot without the reservation
    const touches = Array.from({ length: 12 }, (_, i) => ({ domain_id: d.id, source: 'list_import', source_detail: `https://example.com/hint-${i}`, source_ref: null }));
    const db = makeDb({ seo_link_domains: [d], seo_link_domain_sources: touches });
    const fetched = new Set();
    const fetcher = async (url) => { fetched.add(url); return okFetch(url); };
    const llm = async () => ({ ok: true, json: verdictOf([], 'not_reproducible') });
    let passes = 0;
    while (db._tables.seo_link_domains[0].agent_state !== 'not_reproducible' && passes < 12) {
      const dom = db._tables.seo_link_domains[0];
      dom.watch_recheck_at = new Date(NOW.getTime() + passes * 6 * 60 * 60 * 1000);
      await investigatePaths(db, { ...runOpts(db, { fetchPage: fetcher, llmDispatch: llm }), now: new Date(NOW.getTime() + passes * 6 * 60 * 60 * 1000), domainIds: [dom.id] });
      passes += 1;
    }
    expect(db._tables.seo_link_domains[0].agent_state).toBe('not_reproducible'); // bounded — it closes
    // the reserve guaranteed real probe attempts despite the hint flood
    expect([...fetched].some((u) => u === 'https://example.com/register')).toBe(true);
  });

  test('worded and currency-prefixed ranges never verify the truncated bound (Codex PR r11 P1)', () => {
    const { verifyPriceEvidence } = _internals;
    const mk = (body) => {
      const text = `Directory listing page with membership details and vendor information. ${body}. Applications are reviewed within five business days.`;
      return [{ url: 'https://example.com/join', excerpt: text, text, html: '' }];
    };
    const claim = (pages, quote = 'USD 95') => verifyPriceEvidence(pages, modelPath({ price_text: quote, renewal_price_text: null, renewal_price_page_url: null, currency_evidence: null })).price_text;
    expect(claim(mk('Listings cost USD 95 to USD 150 per year'))).toBeNull(); // worded range
    expect(claim(mk('Listings cost USD 95\u2013USD 150 per year'))).toBeNull(); // dash + repeated marker
    expect(claim(mk('Listings cost USD 95 to $150 per year'))).toBeNull(); // symbol upper bound
    expect(claim(mk('Join for USD 95 to get listed today'))).toBe('USD 95'); // "to" + a non-price word is NOT a range
    // a cadence suffix on the lower bound must not hide the range (Codex PR r12 P1)
    expect(claim(mk('Listings cost USD 95/year \u2013 USD 150/year'), 'USD 95/year')).toBeNull();
    expect(claim(mk('Listings cost USD 95/year to USD 150/year'), 'USD 95/year')).toBeNull();
    expect(claim(mk('Join for USD 95 / year \u2014 cancel anytime'), 'USD 95 / year')).toBe('USD 95 / year'); // dash + words is not a range
  });

  test('a verdict AT the response cap disproves nothing by omission (Codex PR r11 P1)', async () => {
    const d = domainRow({ agent_state: 'investigating' });
    const mkPath = (n) => ({
      id: uid(), domain_id: d.id, acquisition_type: 'paid_listing', submission_url: `https://example.com/join-${n}`,
      path_key: `paid_listing:https://example.com/join-${n}`, superseded_by: null, baseline: false, confidence: 0.7,
      last_investigated_at: new Date('2026-08-01'), investigation: JSON.stringify({}),
      revision: 1, revision_payment: 1, revision_communication: 1, revision_execution: 1,
    });
    const existing = Array.from({ length: 7 }, (_, i) => mkPath(i));
    const db = makeDb({ seo_link_domains: [d], seo_link_acquisition_paths: existing });
    // the model echoes six (the schema cap) — the seventh is covered but CANNOT fit
    const echoed = existing.slice(0, 6).map((e) => modelPath({ submission_url: e.submission_url, price_page_url: e.submission_url, renewal_price_page_url: e.submission_url }));
    await investigatePaths(db, runOpts(db, { llmDispatch: async () => ({ ok: true, json: verdictOf(echoed) }) }));
    const seventh = db._tables.seo_link_acquisition_paths.find((p2) => p2.id === existing[6].id);
    expect(Number(seventh.confidence)).toBe(0.7); // omission at the cap proves nothing
  });

  test('a transient probe failure is not coverage — bounded retries then park for review, never a close (Codex PR r13+r15 P1)', async () => {
    const d = domainRow();
    const db = makeDb({ seo_link_domains: [d] });
    const submitAttempts = [];
    const fetcher = async (url) => {
      if (url === 'https://example.com/submit') { submitAttempts.push(url); return { status: null, finalUrl: null, html: null, blocked: false, error: 'timeout' }; }
      return okFetch(url);
    };
    const llm = async () => ({ ok: true, json: verdictOf([], 'not_reproducible') });
    // run past the failure ceiling — the domain must NEVER close on a route
    // that only ever timed out; it parks watching for review instead
    for (let i = 0; i < 10; i++) {
      const dom = db._tables.seo_link_domains[0];
      dom.watch_recheck_at = new Date(NOW.getTime() + i * 6 * 60 * 60 * 1000);
      await investigatePaths(db, { ...runOpts(db, { fetchPage: fetcher, llmDispatch: llm }), now: new Date(NOW.getTime() + i * 6 * 60 * 60 * 1000), domainIds: [dom.id] });
      const st = db._tables.seo_link_domains[0];
      if (st.agent_state === 'not_reproducible' || /parked for review/.test(String(st.score_reasons))) break;
    }
    const dom = db._tables.seo_link_domains[0];
    expect(dom.agent_state).toBe('watching'); // parked for review — no-progress is not proof of absence
    expect(dom.score_reasons).toContain('parked for review');
    expect(submitAttempts.length).toBeGreaterThan(1); // the timeout was RETRIED, never counted as coverage
  });

  test('an echoed path whose URL is definitively gone retires stamped — no six-hour model-call loop (Codex PR r13 P1)', async () => {
    const d = domainRow({ agent_state: 'investigating' });
    const dead = {
      id: uid(), domain_id: d.id, acquisition_type: 'paid_listing', submission_url: 'https://example.com/join',
      path_key: 'paid_listing:https://example.com/join', superseded_by: null, baseline: false, confidence: 0.7,
      last_investigated_at: new Date('2026-05-01'), investigation: JSON.stringify({}),
      revision: 1, revision_payment: 1, revision_communication: 1, revision_execution: 1,
    };
    const db = makeDb({ seo_link_domains: [d], seo_link_acquisition_paths: [dead] });
    const fetcher = async (url) => (url.includes('/join')
      ? { status: 404, finalUrl: url, html: null, blocked: false }
      : okFetch(url));
    // the model keeps ECHOING the dead path (it rides the prompt's identity list)
    const echoed = modelPath({ submission_url: 'https://example.com/join', price_page_url: 'https://example.com/join', renewal_price_page_url: 'https://example.com/join' });
    await investigatePaths(db, runOpts(db, { fetchPage: fetcher, llmDispatch: async () => ({ ok: true, json: verdictOf([echoed]) }) }));
    const p = db._tables.seo_link_acquisition_paths.find((p2) => p2.id === dead.id);
    expect(Number(p.confidence)).toBe(0); // 404 on the URL is a verdict, echo or not
    expect(p.last_investigated_at).not.toBeNull(); // stamped — never re-selects every backoff
    expect(JSON.parse(p.investigation).disproven_reason).toBe('submission URL returned 404/410');
  });

  test('a covered probe entering as a path alias never displaces uncovered probes (Codex PR r14 P1)', () => {
    const { candidateUrls } = _internals;
    // bit 0 (/submit) covered, and /submit ALSO rides in as an existing path
    const urls = candidateUrls('example.com', {
      existingPaths: [{ submission_url: 'https://example.com/submit' }],
      probeMask: 1,
    });
    expect(urls.indexOf('https://example.com/join')).toBeLessThan(urls.indexOf('https://example.com/submit')); // uncovered first
  });

  test('a CONCLUDED generation resets probe coverage; the deferral chain keeps it (Codex PR r14 P1)', async () => {
    // concluded: a qualified close writes mask 0 — a recheck months later re-earns coverage
    const d = domainRow({ probe_coverage_mask: 42 });
    const db = makeDb({ seo_link_domains: [d] });
    await investigatePaths(db, runOpts(db));
    expect(Number(db._tables.seo_link_domains[0].probe_coverage_mask)).toBe(0);
    // deferral chain: a tail-deferred terminal pass carries its mask forward
    const d2 = domainRow({ domain: 'other.com' });
    const db2 = makeDb({ seo_link_domains: [d2] });
    await investigatePaths(db2, runOpts(db2, { llmDispatch: async () => ({ ok: true, json: verdictOf([], 'not_reproducible') }) }));
    expect(db2._tables.seo_link_domains[0].agent_state).toBe('watching');
    expect(Number(db2._tables.seo_link_domains[0].probe_coverage_mask)).toBeGreaterThan(0);
  });

  test('an unreachable https apex falls back to www/http origins (Codex PR r14 P2)', async () => {
    const d = domainRow();
    const db = makeDb({ seo_link_domains: [d] });
    const fetched = [];
    const fetcher = async (url) => {
      fetched.push(url);
      if (url === 'https://example.com') return { status: null, finalUrl: null, html: null, blocked: false, error: 'tls_error' };
      if (url.startsWith('https://www.example.com')) return okFetch(url);
      if (url.startsWith('http://')) return okFetch(url);
      return { status: null, finalUrl: null, html: null, blocked: false, error: 'tls_error' };
    };
    const r = await investigatePaths(db, runOpts(db, { fetchPage: fetcher }));
    expect(fetched).toContain('https://www.example.com'); // the origin variant was tried
    expect(r.investigated).toBe(1); // the www page carried the run — no evidence-less failure
  });

  test('a CHANGED terms URL that failed verification clears the old hash — never a stale attestation (local Codex r14 P1)', async () => {
    const d = domainRow();
    const existing = {
      id: uid(), domain_id: d.id, acquisition_type: 'paid_listing', submission_url: 'https://example.com/join',
      path_key: 'paid_listing:https://example.com/join', superseded_by: null, baseline: false, confidence: 0.7,
      legal_attestation: true, legal_terms_hash: 'd'.repeat(64),
      last_investigated_at: new Date('2026-08-01'), investigation: JSON.stringify({ legal_terms_url: 'https://example.com/terms-old' }),
      revision: 1, revision_payment: 1, revision_communication: 1, revision_execution: 1,
    };
    const db = makeDb({ seo_link_domains: [d], seo_link_acquisition_paths: [existing] });
    const echoed = modelPath({ legal_attestation: true, legal_terms_url: 'https://example.com/terms-new' });
    const fetcher = async (url) => (url.includes('/terms-new')
      ? { status: 500, finalUrl: url, html: null, blocked: false, error: 'http_500' }
      : okFetch(url));
    await investigatePaths(db, runOpts(db, { fetchPage: fetcher, llmDispatch: async () => ({ ok: true, json: verdictOf([echoed]) }) }));
    const kept = db._tables.seo_link_acquisition_paths.find((p2) => p2.id === existing.id);
    expect(kept.legal_terms_hash).toBeNull(); // the old agreement's hash cannot vouch for a different one
  });

  test('JSON-LD currency derives deterministically when the model cannot see the script (Codex PR r15 P1)', () => {
    const { verifyPriceEvidence } = _internals;
    const text = `Directory listing page with membership details. Join for $95 / year. ${'Copy. '.repeat(10)}`;
    const html = `<html><script type="application/ld+json">{"@type":"Offer","price":"95","priceCurrency":"USD"}</script><body>${text}</body></html>`;
    const page = { url: 'https://example.com/join', excerpt: text, text, html };
    // the model reports NO currency evidence — it never saw the JSON-LD
    const v = verifyPriceEvidence([page], modelPath({ price_text: '$95 / year', renewal_price_text: null, renewal_price_page_url: null, currency_evidence: null }));
    expect(v.currency_evidence).toEqual({ marker: 'USD', kind: 'jsonld_price_currency', page_url: 'https://example.com/join', derived: true });
    expect(v.verification.currency_evidence).toBe('derived_from_structured_offer');
    // …but an offer with a DIFFERENT amount derives nothing
    const html2 = html.replace('"price":"95"', '"price":"500"');
    const v2 = verifyPriceEvidence([{ ...page, html: html2 }], modelPath({ price_text: '$95 / year', renewal_price_text: null, renewal_price_page_url: null, currency_evidence: null }));
    expect(v2.currency_evidence).toBeNull();
  });

  test('a failed acquisition attempt makes its path due before the 90-day expiry (Codex PR r15 P2)', async () => {
    const d = domainRow({ agent_state: 'qualified' });
    const path = {
      id: uid(), domain_id: d.id, acquisition_type: 'paid_listing', submission_url: 'https://example.com/join',
      path_key: 'paid_listing:https://example.com/join', superseded_by: null, baseline: false, confidence: 0.7,
      last_investigated_at: new Date('2026-08-20'), investigation: JSON.stringify({}),
      revision: 1, revision_payment: 1, revision_communication: 1, revision_execution: 1,
    };
    const attempt = { id: uid(), path_id: path.id, prospect_id: null, provider: 'deterministic_runner', action: 'submit', outcome: 'failed', created_at: new Date('2026-08-30') };
    const db = makeDb({ seo_link_domains: [d], seo_link_acquisition_paths: [path], seo_link_attempts: [attempt] });
    const r = await investigatePaths(db, runOpts(db));
    expect(r.selected).toBe(1); // the failure re-selects the domain now, not in 90 days
    // re-investigation stamped the path — the same failure never triggers twice
    const again = await investigatePaths(db, runOpts(db));
    expect(again.selected).toBe(0);
  });

  test('a working fallback origin carries the probes too (Codex PR r15 P2)', async () => {
    const d = domainRow();
    const db = makeDb({ seo_link_domains: [d] });
    const fetched = [];
    const fetcher = async (url) => {
      fetched.push(url);
      if (url.startsWith('https://www.example.com')) return okFetch(url);
      return { status: null, finalUrl: null, html: null, blocked: false, error: 'tls_error' }; // apex dead
    };
    await investigatePaths(db, runOpts(db, { fetchPage: fetcher }));
    expect(fetched.some((u) => u.startsWith('https://www.example.com/'))).toBe(true); // probes re-based onto the live origin
  });

  test('path refresh on an acquired domain stamps last_investigated_at but NEVER the aggregate state', async () => {
    const d = domainRow({ agent_state: 'acquired' });
    const baseline = {
      id: uid(), domain_id: d.id, acquisition_type: 'unknown', submission_url: null, baseline: true,
      path_key: 'unknown:-', superseded_by: null, last_investigated_at: null,
      revision: 1, revision_payment: 1, revision_communication: 1, revision_execution: 1,
    };
    const db = makeDb({ seo_link_domains: [d], seo_link_acquisition_paths: [baseline] });
    const r = await investigatePaths(db, runOpts(db));
    expect(r).toMatchObject({ investigated: 1, pathRefreshes: 1, qualified: 0 });
    expect(db._tables.seo_link_domains[0].agent_state).toBe('acquired');
    expect(db._tables.seo_link_acquisition_paths.find((p) => p.id === baseline.id).last_investigated_at).toEqual(NOW);
    // the real path was written beside it and became the best path
    const real = db._tables.seo_link_acquisition_paths.find((p) => p.id !== baseline.id);
    expect(db._tables.seo_link_domains[0].best_path_id).toBe(real.id);
  });

  // ---- Codex PR round 16 -------------------------------------------------

  test('a LEASED placement is never repointed mid-submission; it follows once the lease settles (Codex PR r16 P1)', async () => {
    const d = domainRow();
    const oldPath = {
      id: uid(), domain_id: d.id, acquisition_type: 'paid_listing', submission_url: 'https://example.com/old-join',
      path_key: 'paid_listing:https://example.com/old-join', superseded_by: null, last_investigated_at: null,
      revision: 1, revision_payment: 1, revision_communication: 1, revision_execution: 1,
    };
    // the signup runner holds this one's lease (claim → browser action → report)
    const leased = { id: uid(), domain_id: d.id, path_id: oldPath.id, status: 'prospect', claimed_at: new Date('2026-08-31T11:55:00Z') };
    const idle = { id: uid(), domain_id: d.id, path_id: oldPath.id, status: 'prospect', claimed_at: null };
    const db = makeDb({ seo_link_domains: [d], seo_link_acquisition_paths: [oldPath], seo_link_prospects: [leased, idle] });
    const goneFetch = async (url) => (url.includes('/old-join') ? { status: 404, finalUrl: url, html: null, blocked: false } : okFetch(url));
    const r = await investigatePaths(db, runOpts(db, { fetchPage: goneFetch, llmDispatch: async () => ({ ok: true, json: verdictOf([modelPath({ replaces_path_id: oldPath.id })]) }) }));
    expect(r.superseded).toBe(1);
    const fresh = db._tables.seo_link_acquisition_paths.find((p) => p.id !== oldPath.id);
    const row = (id) => db._tables.seo_link_prospects.find((p) => p.id === id);
    expect(row(idle.id).path_id).toBe(fresh.id); // idle placement follows the successor
    expect(row(leased.id).path_id).toBe(oldPath.id); // the in-flight one stays on the path it is submitting through
    // the lease settles (report/release cleared claimed_at); the next upsert
    // of the successor — a plain re-investigation echoing it — repoints it
    row(leased.id).claimed_at = null;
    await investigatePaths(db, { ...runOpts(db, { fetchPage: goneFetch }), domainIds: [d.id] });
    expect(row(leased.id).path_id).toBe(fresh.id);
  });

  test('a no-progress probe pass retries on the ESCALATING failure backoff, not a flat six hours (Codex PR r16 P1)', async () => {
    const { failureBackoffMs } = _internals;
    const d = domainRow();
    const db = makeDb({ seo_link_domains: [d] });
    const fetcher = async (url) => (url === 'https://example.com/submit'
      ? { status: null, finalUrl: null, html: null, blocked: false, error: 'timeout' } // a multi-day route outage
      : okFetch(url));
    const llm = async () => ({ ok: true, json: verdictOf([], 'not_reproducible') });
    const dom = () => db._tables.seo_link_domains[0];
    const pairs = []; // [failure count, recheck horizon] for every stalled pass
    let t = NOW;
    for (let i = 0; i < 10; i++) {
      await investigatePaths(db, { ...runOpts(db, { fetchPage: fetcher, llmDispatch: llm }), now: t, domainIds: [d.id] });
      const f = Number(dom().investigate_failures) || 0;
      if (f > 0) pairs.push([f, dom().watch_recheck_at.getTime() - t.getTime()]);
      if (/parked for review/.test(String(dom().score_reasons))) break;
      t = dom().watch_recheck_at;
    }
    const H = 60 * 60 * 1000;
    expect(pairs.slice(0, 4)).toEqual([[1, 6 * H], [2, 12 * H], [3, 24 * H], [4, 48 * H]]);
    expect(pairs.map(([f]) => f)).toEqual(pairs.map(([, ms]) => ms).map((ms, i) => (ms === failureBackoffMs(i + 1) ? i + 1 : -1)));
    expect(dom().agent_state).toBe('watching'); // still parked for review at the ceiling — never a close
  });

  test('minimum-price syntax never verifies a truncated quote nor derives an exact cost (Codex PR r16 P1)', () => {
    const { verifyPriceEvidence, centsFor } = _internals;
    const claim = (price_text) => modelPath({ price_text, renewal_price_text: null, renewal_price_page_url: null, quotes: [price_text] });
    const pageOf = (text) => ({ url: 'https://example.com/join', excerpt: text, text, html: '' });
    const plus = pageOf('Directory listing page with membership details. Sponsor packages: USD 95+ per year. Contact us to reserve.');
    expect(verifyPriceEvidence([plus], claim('USD 95')).price_text).toBeNull(); // "USD 95+" is a floor, not "USD 95"
    expect(verifyPriceEvidence([plus], claim('USD 95+')).price_text).toBe('USD 95+'); // the verbatim floor verifies…
    expect(centsFor('USD', 'USD 95+')).toBeNull(); // …but never becomes an exact cost
    for (const text of ['USD 95 and up', 'USD 95 or more', 'minimum USD 95', 'at least USD 95', 'USD 95 min.']) expect(centsFor('USD', text)).toBeNull();
    expect(centsFor('USD', 'USD 95 / year')).toBe(9500); // an exact quote still derives
    const andUp = pageOf('Directory listing page with membership details. Sponsor packages: USD 95 and up per year. Contact us to reserve.');
    expect(verifyPriceEvidence([andUp], claim('USD 95')).price_text).toBeNull();
    const minimum = pageOf('Directory listing page with membership details. Sponsor packages: minimum USD 95 per year. Contact us to reserve.');
    expect(verifyPriceEvidence([minimum], claim('USD 95')).price_text).toBeNull();
  });

  test('a retained terms hash keeps its URL identity — an omitting pass cannot set up the next pass to clear it (Codex PR r16 P1)', async () => {
    const d = domainRow();
    const priorHash = 'e'.repeat(64);
    const existing = {
      id: uid(), domain_id: d.id, acquisition_type: 'paid_listing', submission_url: 'https://example.com/join',
      path_key: 'paid_listing:https://example.com/join', superseded_by: null, baseline: false, confidence: 0.7,
      legal_attestation: true, legal_terms_hash: priorHash,
      last_investigated_at: new Date('2026-08-01'), investigation: JSON.stringify({ legal_terms_url: 'https://example.com/terms' }),
      revision: 1, revision_payment: 1, revision_communication: 1, revision_execution: 1,
    };
    const db = makeDb({ seo_link_domains: [d], seo_link_acquisition_paths: [existing] });
    const kept = () => db._tables.seo_link_acquisition_paths.find((p2) => p2.id === existing.id);
    // pass 1: the model OMITS the terms URL — hash retained, and so is its identity
    await investigatePaths(db, runOpts(db, { llmDispatch: async () => ({ ok: true, json: verdictOf([modelPath({ legal_attestation: true, legal_terms_url: null })]) }) }));
    expect(kept().legal_terms_hash).toBe(priorHash);
    expect(JSON.parse(kept().investigation)).toMatchObject({ legal_terms_url: 'https://example.com/terms', legal_terms_url_retained: true });
    // pass 2: the model names the ORIGINAL URL again and its fetch is transiently inconclusive — same identity, hash stands
    const fetcher = async (url) => (url.includes('/terms') ? { status: 503, finalUrl: url, html: null, blocked: false, error: 'http_503' } : okFetch(url));
    await investigatePaths(db, { ...runOpts(db, { fetchPage: fetcher, llmDispatch: async () => ({ ok: true, json: verdictOf([modelPath({ legal_attestation: true, legal_terms_url: 'https://example.com/terms' })]) }) }), domainIds: [d.id] });
    expect(kept().legal_terms_hash).toBe(priorHash);
  });

  test('a negative refresh keeps the baseline best path until a replacement exists or its URL is gone (Codex PR r16 P2)', async () => {
    const d = domainRow({ agent_state: 'acquired' });
    const baseline = {
      id: uid(), domain_id: d.id, acquisition_type: 'editorial_outreach', submission_url: 'https://example.com/resources', baseline: true,
      path_key: 'editorial_outreach:https://example.com/resources', superseded_by: null, last_investigated_at: null, confidence: 0.1,
      investigation: JSON.stringify({ baseline: true }), revision: 1, revision_payment: 1, revision_communication: 1, revision_execution: 1,
    };
    d.best_path_id = baseline.id; // the importer's deliberate pointer at the live placement
    const db = makeDb({ seo_link_domains: [d], seo_link_acquisition_paths: [baseline] });
    const negative = async () => ({ ok: true, json: verdictOf([], 'not_reproducible') });
    await investigatePaths(db, { ...runOpts(db, { llmDispatch: negative }), domainIds: [d.id] });
    expect(db._tables.seo_link_domains[0].best_path_id).toBe(baseline.id); // no reproducible route ≠ no link
    expect(db._tables.seo_link_domains[0].agent_state).toBe('acquired');
    // a real path outranks it
    await investigatePaths(db, { ...runOpts(db), domainIds: [d.id] });
    const real = db._tables.seo_link_acquisition_paths.find((p) => !p.baseline);
    expect(db._tables.seo_link_domains[0].best_path_id).toBe(real.id);
    // …and once the baseline's own URL is GONE, a negative refresh clears the pointer
    const db2 = makeDb({ seo_link_domains: [domainRow({ agent_state: 'acquired', best_path_id: baseline.id })], seo_link_acquisition_paths: [{ ...baseline, domain_id: undefined }] });
    db2._tables.seo_link_acquisition_paths[0].domain_id = db2._tables.seo_link_domains[0].id;
    const gone = async (url) => (url.includes('/resources') ? { status: 404, finalUrl: url, html: null, blocked: false } : okFetch(url));
    await investigatePaths(db2, { ...runOpts(db2, { fetchPage: gone, llmDispatch: negative }), domainIds: [db2._tables.seo_link_domains[0].id] });
    expect(db2._tables.seo_link_domains[0].best_path_id).toBeNull();
  });

  test('a working fallback origin carries KNOWN paths too, crediting the apex identity (Codex PR r16 P2)', async () => {
    const d = domainRow();
    const custom = {
      id: uid(), domain_id: d.id, acquisition_type: 'paid_listing', submission_url: 'https://example.com/get-listed',
      path_key: 'paid_listing:https://example.com/get-listed', superseded_by: null, baseline: false, confidence: 0.7,
      last_investigated_at: null, investigation: JSON.stringify({}),
      revision: 1, revision_payment: 1, revision_communication: 1, revision_execution: 1,
    };
    const db = makeDb({ seo_link_domains: [d], seo_link_acquisition_paths: [custom] });
    const fetched = [];
    const fetcher = async (url) => {
      fetched.push(url);
      if (url.startsWith('https://www.example.com')) return okFetch(url);
      return { status: null, finalUrl: null, html: null, blocked: false, error: 'tls_error' }; // apex dead
    };
    const echoed = modelPath({ submission_url: 'https://www.example.com/get-listed', price_page_url: 'https://www.example.com/get-listed', renewal_price_page_url: 'https://www.example.com/get-listed' });
    const r = await investigatePaths(db, runOpts(db, { fetchPage: fetcher, llmDispatch: async () => ({ ok: true, json: verdictOf([echoed]) }) }));
    expect(fetched).toContain('https://www.example.com/get-listed'); // the known custom route re-based onto the live origin
    expect(fetched.filter((u) => u.startsWith('https://example.com/'))).toHaveLength(0); // nothing else wasted on the dead apex
    expect(r.investigated).toBe(1);
    const path = db._tables.seo_link_acquisition_paths.find((p) => p.id === custom.id);
    expect(path.last_investigated_at).toEqual(NOW); // covered under its apex identity — no longer due forever
    expect(db._tables.seo_link_acquisition_paths).toHaveLength(1); // the www echo IS the same path (identity strips www)
  });

  test('an owner Watch → Reopen during the model call is a NEW generation — the old run aborts stale (Codex PR r16 P1)', async () => {
    const d = domainRow();
    const db = makeDb({ seo_link_domains: [d] });
    const reopen = (row) => Object.assign(row, { agent_state: 'investigating', investigate_claim_token: null, probe_coverage_mask: 0, investigate_failures: 0, investigate_after: null });
    const llm = jest.fn(async () => {
      const row = db._tables.seo_link_domains[0];
      expect(typeof row.investigate_claim_token).toBe('string'); // the claim minted a token
      row.agent_state = 'watching'; // owner: Watch
      reopen(row); // owner: Reopen — same state, fresh mandate
      return { ok: true, json: verdictOf([modelPath()]) };
    });
    const r = await investigatePaths(db, runOpts(db, { llmDispatch: llm }));
    expect(r.staleClaims).toBe(1);
    expect(r.pathsWritten).toBe(0);
    expect(db._tables.seo_link_acquisition_paths).toHaveLength(0);
    expect(db._tables.seo_link_domains[0]).toMatchObject({ agent_state: 'investigating', investigate_claim_token: null, probe_coverage_mask: 0 }); // the reopened mandate stands untouched
    // …and the failure defer is bound the same way: a reopened counter is never re-deferred by the stale run
    const db2 = makeDb({ seo_link_domains: [domainRow({ investigate_failures: 2 })] });
    const llm2 = async () => { reopen(db2._tables.seo_link_domains[0]); return { ok: false, reason: 'provider_down' }; };
    await investigatePaths(db2, runOpts(db2, { llmDispatch: llm2 }));
    expect(db2._tables.seo_link_domains[0]).toMatchObject({ investigate_failures: 0, investigate_after: null, agent_state: 'investigating' });
  });

  test('failed-attempt selection is bounded by the batch limit in SQL, newest failure first (Codex PR r16 P2)', async () => {
    const mkPath = (d) => ({
      id: uid(), domain_id: d.id, acquisition_type: 'paid_listing', submission_url: `https://${d.domain}/join`,
      path_key: `paid_listing:https://${d.domain}/join`, superseded_by: null, baseline: false, confidence: 0.7,
      last_investigated_at: new Date('2026-08-20'), investigation: JSON.stringify({}),
      revision: 1, revision_payment: 1, revision_communication: 1, revision_execution: 1,
    });
    const older = domainRow({ agent_state: 'qualified', domain: 'older.com' });
    const newer = domainRow({ agent_state: 'qualified', domain: 'newer.com' });
    const stamped = domainRow({ agent_state: 'qualified', domain: 'stamped.com' }); // its failure PREDATES the stamp — not due
    const [po, pn, ps] = [mkPath(older), mkPath(newer), mkPath(stamped)];
    const retired = { ...mkPath(older), superseded_by: po.id }; // a failure on a RETIRED path never re-selects
    const attempt = (path, created_at, outcome = 'failed') => ({ id: uid(), path_id: path.id, prospect_id: null, provider: 'deterministic_runner', action: 'submit', outcome, created_at });
    const db = makeDb({
      seo_link_domains: [older, newer, stamped],
      seo_link_acquisition_paths: [po, pn, ps, retired],
      seo_link_attempts: [attempt(po, new Date('2026-08-25')), attempt(pn, new Date('2026-08-30')), attempt(ps, new Date('2026-08-10')), attempt(retired, new Date('2026-08-31')), attempt(ps, new Date('2026-08-30'), 'placed')],
    });
    const one = await investigatePaths(db, { ...runOpts(db), limit: 1, dryRun: true });
    expect(one.selected).toBe(1); // the limit bounds the failure bucket itself
    const { selectTargets } = _internals;
    const picked = await selectTargets(db, { limit: 1, now: NOW });
    expect(picked.map((t) => t.domain.domain)).toEqual(['newer.com']); // newest qualifying failure first
    const all = await selectTargets(db, { limit: 10, now: NOW });
    expect(all.map((t) => t.domain.domain).sort()).toEqual(['newer.com', 'older.com']); // stamped.com's failure predates its stamp
  });
});
