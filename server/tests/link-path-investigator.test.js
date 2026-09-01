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
const { investigatePaths, MAX_FETCHES_PER_DOMAIN, _internals } = investigator;

// ---------------------------------------------------------------------------
// In-memory knex-shaped store
// ---------------------------------------------------------------------------
let idSeq = 0;
const uid = () => `00000000-0000-4000-8000-${String(++idSeq).padStart(12, '0')}`;

function makeDb(seed = {}) {
  const tables = {
    seo_link_domains: [], seo_link_acquisition_paths: [], seo_link_domain_sources: [],
    seo_competitor_backlinks: [], seo_link_prospects: [],
    ...seed,
  };
  const stripAlias = (expr) => {
    const m = String(expr).match(/^(\S+)\s+as\s+(\S+)$/i);
    return m ? { table: m[1], alias: m[2] } : { table: expr, alias: null };
  };

  function builder(tableExpr) {
    const { table, alias } = stripAlias(tableExpr);
    const state = { table, alias, preds: [], join: null, select: null, order: [], limit: null, dedupe: false };
    const colVal = (row, col) => {
      const c = String(col);
      if (state.join && c.includes('.')) {
        const [pfx, name] = c.split('.');
        return pfx === state.alias ? row.d[name] : row.p[name];
      }
      const name = c.includes('.') ? c.split('.')[1] : c;
      return state.join ? row.d[name] : row[name];
    };
    const matches = (row) => state.preds.every((p) => p(row, colVal));
    const baseRows = () => {
      if (!state.join) return tables[table].filter(matches);
      const { table: jt } = stripAlias(state.join.tableExpr);
      const [lc] = state.join.on1.split('.').slice(1);
      const joined = tables[table].flatMap((d) => tables[jt]
        .filter((p) => p[lc] === d.id)
        .map((p) => ({ d, p })));
      return joined.filter(matches);
    };
    const resolve = () => {
      let rows = baseRows();
      if (state.join) {
        const seen = new Set();
        rows = rows.map((r) => r.d).filter((d) => (seen.has(d.id) ? false : (seen.add(d.id), true)));
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
            orWhere(col, op, val) {
              preds.push(val === undefined
                ? (row, get) => get(row, col) === op
                : (row, get) => (op === '<=' ? get(row, col) <= val : op === '<' ? get(row, col) < val : get(row, col) === val));
              return sub;
            },
          };
          a(sub);
          state.preds.push((row, get) => preds.some((p) => p(row, get)));
          return q;
        }
        if (typeof a === 'object') state.preds.push((row, get) => Object.entries(a).every(([k, v]) => get(row, k) === v));
        else if (c !== undefined) state.preds.push((row, get) => (b === '<=' ? get(row, a) <= c : b === '<' ? get(row, a) < c : get(row, a) === c));
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
  db.transaction = async (cb) => {
    const trx = (t) => builder(t);
    trx.raw = db.raw;
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

const okFetch = async (url) => ({ status: 200, finalUrl: url, html: `<html><body>Join for USD 95 / year — ${url}</body></html>`, blocked: false, truncated: false });
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
    expect(r).toMatchObject({ dryRun: true, selected: 1, wouldFetch: MAX_FETCHES_PER_DOMAIN, wouldCall: 1, investigated: 0 });
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
    expect(targets.map((t) => [t.domain.domain, t.claimState])).toEqual([
      ['seed.com', true], ['older.com', true], ['due.com', true], ['acquired.com', false],
    ]);
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
    expect(db2._tables.seo_link_domains[0].agent_state).toBe('watching'); // qualified with no executable path downgrades
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
    const d = domainRow();
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
    const fetch120 = async (url) => ({ status: 200, finalUrl: url, html: `<html><body>Join for USD 120 / year — ${url}</body></html>`, blocked: false, truncated: false });
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
    const r = await investigatePaths(db, runOpts(db, { llmDispatch: async () => ({ ok: true, json: verdictOf([replacing]) }) }));
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
    const fetcher = jest.fn(okFetch);
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
    const p = db._tables.seo_link_acquisition_paths[0];
    expect(p.submission_url).toBeNull();
    expect(p.path_key).toBe('paid_listing:-');
    expect(p.legal_terms_hash).toBeNull();
    const evidence = JSON.parse(p.investigation);
    expect(evidence.offhost_urls).toEqual({ submission_url: 'https://evil.example.net/join', legal_terms_url: 'https://evil.example.net/terms' });
    expect(r.pathsWritten).toBe(1);
    // a stripped submission URL is a rejected claim — never model-confidence
    // riding the null-URL exemption into best_path_id (Codex r10 P1)
    expect(p.confidence).toBe(0);
    expect(evidence.submission_verification).toBe('offhost_submission_url');
    expect(db._tables.seo_link_domains[0].best_path_id).toBeNull();
    expect(db._tables.seo_link_domains[0].agent_state).toBe('watching'); // qualified downgrades with no executable path
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
    const d = domainRow({ agent_state: 'investigating', best_path_id: null });
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
    const jsonldFetch = async (url) => ({ status: 200, finalUrl: url, html: `<html><script type="application/ld+json">{"@type":"Offer","priceCurrency":"USD"}</script><body>Join for $95 / year — ${url}</body></html>`, blocked: false, truncated: false });
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
    const r = await investigatePaths(db, runOpts(db, { llmDispatch: async () => ({ ok: true, json: verdictOf([replacing]) }) }));
    expect(r.superseded).toBe(1);
    const old = db._tables.seo_link_acquisition_paths.find((p) => p.id === oldPath.id);
    expect(old.superseded_by).toBe(existingReplacement.id);
    expect(db._tables.seo_link_prospects[0].path_id).toBe(existingReplacement.id);
    expect(db._tables.seo_link_acquisition_paths).toHaveLength(2); // no third row
  });

  test('a redirect that leaves the domain is rejected as model input and evidence (Codex r3 P1)', async () => {
    const d = domainRow();
    const db = makeDb({ seo_link_domains: [d] });
    // every fetch redirects off-domain
    const redirecting = async (url) => ({ status: 200, finalUrl: 'https://evil.example.net/landing', html: '<html>Join for USD 95 / year</html>', blocked: false, truncated: false });
    const legal = modelPath({ legal_attestation: true, legal_terms_url: 'https://example.com/terms' });
    const llm = jest.fn(async (route, payload) => {
      expect(payload.text).not.toContain('evil.example.net'); // off-site page never reaches the prompt
      return { ok: true, json: verdictOf([legal]) };
    });
    await investigatePaths(db, runOpts(db, { fetchPage: redirecting, llmDispatch: llm }));
    const p = db._tables.seo_link_acquisition_paths[0];
    expect(p.legal_terms_hash).toBeNull(); // the terms redirect is not this domain's agreement
    expect(p.currency).toBe('unknown'); // the quote had no on-domain page to verify against
    expect(p.estimated_cost_cents).toBeNull();
    const evidence = JSON.parse(p.investigation);
    expect(evidence.fetch_errors.every((f) => f.reason === 'offsite_redirect')).toBe(true);
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
});
