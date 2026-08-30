/**
 * Step 2 intake: durable intake items (§3.4d) + resolver sweep + CSV.
 * Knex double: every chain is recorded; terminal results come from `answers`.
 */
const path = require('path');

jest.mock('../services/seo/link-registry', () => {
  const actual = jest.requireActual('../services/seo/link-registry');
  return { ...actual, ensureDomain: jest.fn() };
});
const registry = require('../services/seo/link-registry');
const intakeSvc = require('../services/seo/link-registry-intake');
const { parseOpportunities, parseCsvOpportunities, intake, resolveIntakeItems, _internals } = intakeSvc;

// ---- knex double ---------------------------------------------------------
function makeDb(answers = {}) {
  const calls = [];
  function builder(table) {
    const chain = { table, ops: [] };
    const proxy = new Proxy({}, {
      get(_, prop) {
        if (prop === 'then') return undefined;
        if (prop === 'toString') return () => `[${table}]`;
        return (...args) => {
          chain.ops.push([prop, args]);
          calls.push({ table, op: prop, args });
          const key = `${table}.${prop}`;
          if (answers[key] !== undefined) {
            const a = answers[key];
            const v = typeof a === 'function' ? a(chain, args) : a;
            return Promise.resolve(v);
          }
          // terminal ops default
          if (['returning', 'first', 'update', 'select', 'skipLocked'].includes(prop)) return Promise.resolve(prop === 'first' ? undefined : []);
          return proxy;
        };
      },
    });
    return proxy;
  }
  const db = (table) => builder(table);
  db.fn = { now: () => 'NOW()' };
  db.raw = (sql, bind) => ({ __raw: [sql, bind] });
  db.transaction = async (fn) => { const trx = (t) => builder(t); trx.fn = db.fn; trx.raw = db.raw; return fn(trx); };
  db.calls = calls;
  return db;
}

beforeEach(() => {
  registry.ensureDomain.mockReset();
  registry.ensureDomain.mockImplementation(async (_q, { domain }) => ({ id: `id-${domain}`, domain, created: true, touched: true, touchId: `touch-${domain}` }));
});

describe('parseOpportunities (step 2 shape)', () => {
  test('keeps every raw token per domain and classifies references vs drops', () => {
    const r = parseOpportunities('academia.edu https://academia.edu/about bit.ly/abc123 https://x.com/waves/status/123 google.com wavespestcontrol.com/blog');
    expect(r.candidates).toEqual([expect.objectContaining({ domain: 'academia.edu', url: 'https://academia.edu/about', raws: ['academia.edu', 'https://academia.edu/about'] })]);
    expect(r.unresolved).toEqual(['bit.ly/abc123', 'https://x.com/waves/status/123']);
    expect(r.dropped).toEqual(expect.arrayContaining([
      expect.objectContaining({ token: 'google.com', dropReason: 'never_a_target' }),
      expect.objectContaining({ token: 'wavespestcontrol.com/blog', dropReason: 'own_domain' }),
    ]));
  });

  test('a bare shortener host with no path is a drop, not a reference', () => {
    const r = parseOpportunities('bit.ly');
    expect(r.unresolved).toEqual([]);
    expect(r.dropped[0]).toEqual(expect.objectContaining({ dropReason: 'never_a_target' }));
  });

  test('CSV with a Website column: one candidate per row, other columns become the note', () => {
    const csv = 'Website,Primary Action\nacademia.edu,Add website to profile\nproducthunt.com,"Add URL to profile/product"\n';
    expect(parseCsvOpportunities(csv)).toEqual({ rows: [
      { raw: 'academia.edu', note: 'Add website to profile' },
      { raw: 'producthunt.com', note: 'Add URL to profile/product' },
    ] });
    const r = parseOpportunities(csv);
    expect(r.candidates.map((c) => [c.domain, c.note])).toEqual([
      ['academia.edu', 'Add website to profile'], ['producthunt.com', 'Add URL to profile/product'],
    ]);
  });

  test('CSV grammar: quoted commas, escaped quotes and quoted newlines never shift the Website cell', () => {
    const csv = 'Name,Website,Action\n"Acme, Inc.",example.com,Claim\n"Say ""hi""","https://sample.example/a,b","multi\nline"\n';
    expect(parseCsvOpportunities(csv)).toEqual({ rows: [
      { raw: 'example.com', note: 'Acme, Inc. | Claim' },
      { raw: 'https://sample.example/a,b', note: 'Say "hi" | multi\nline' },
    ] });
  });

  test('a recognized CSV cell is ONE reference kept whole: commas / parentheses inside a quoted Website cell reach the durable item and the submission hint intact', () => {
    const csv = 'Name,Website,Action\n"Acme, Inc.","https://sample.example/a,b(c)",Claim\nnot a url at all,Skip me\n';
    const r = parseOpportunities(csv);
    expect(r.candidates).toEqual([expect.objectContaining({ domain: 'sample.example', url: 'https://sample.example/a,b(c)', raws: ['https://sample.example/a,b(c)'], note: 'Acme, Inc. | Claim' })]);
    expect(r.dropped).toEqual([]); // a cell that does not start like a host yields nothing (free-text tokenizer finds no host in it either)
    // free text still tokenizes on the same characters
    expect(parseOpportunities('see sample.example/a,b and more').candidates[0]).toEqual(expect.objectContaining({ domain: 'sample.example', url: 'https://sample.example/a' }));
  });

  test('plain text without a header is not treated as CSV', () => {
    expect(parseCsvOpportunities('foo.com, bar.com\nbaz.com')).toBeNull();
    expect(parseOpportunities('foo.com, bar.com\nbaz.com').candidates.map((c) => c.domain)).toEqual(['foo.com', 'bar.com', 'baz.com']);
  });
});

describe('intake — persists every reference as an intake item', () => {
  test('candidates → resolved items bound to the domain; references → pending; drops → dropped with reason', async () => {
    const inserted = [];
    const db = makeDb({
      'seo_link_intake_items.returning': (chain) => { inserted.push(chain.ops.find((o) => o[0] === 'insert')[1][0]); return [{ id: `item-${inserted.length}` }]; },
    });
    const r = await intake(db, { text: 'academia.edu bit.ly/abc google.com', source: 'list_import', sourceDetail: 'paste:2026-08-30' });
    expect(registry.ensureDomain).toHaveBeenCalledTimes(1);
    expect(registry.ensureDomain).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ domain: 'academia.edu', source: 'list_import', sourceDetail: 'paste:2026-08-30' }));
    expect(inserted).toEqual([
      expect.objectContaining({ raw_url: 'academia.edu', state: 'resolved', resolved_host: 'academia.edu', domain_id: 'id-academia.edu', source_row_id: 'touch-academia.edu', item_key: 'list_import:https://academia.edu' }),
      expect.objectContaining({ raw_url: 'bit.ly/abc', state: 'pending', domain_id: null }),
      expect.objectContaining({ raw_url: 'google.com', state: 'dropped', drop_reason: 'never_a_target' }),
    ]);
    expect(r.items).toEqual({ created: 3, seen: 0, pending: 1 });
    expect(r.inserted).toBe(1);
  });

  test('re-feeding the same list only bumps last_seen_at on the item (state untouched) but still records the touch', async () => {
    registry.ensureDomain.mockResolvedValue({ id: 'id-academia.edu', created: false, touched: true });
    const updates = [];
    const db = makeDb({
      'seo_link_intake_items.returning': [],
      'seo_link_intake_items.first': { id: 'item-old' },
      'seo_link_intake_items.update': (chain, args) => { updates.push(args[0]); return 1; },
    });
    const r = await intake(db, { text: 'academia.edu', sourceDetail: 'paste:again' });
    expect(registry.ensureDomain).toHaveBeenCalledTimes(1);
    expect(updates).toEqual([{ last_seen_at: 'NOW()' }]);
    expect(r.items).toEqual({ created: 0, seen: 1, pending: 0 });
    expect(r.existing).toBe(1);
    expect(r.touched).toBe(1);
  });

  test('re-feeding a reference that an earlier feed already resolved records THIS feed\'s provenance on the domain', async () => {
    registry.ensureDomain.mockResolvedValue({ id: 'id-dir.example', created: false, touched: true });
    const db = makeDb({
      'seo_link_intake_items.returning': [],
      'seo_link_intake_items.first': { id: 'item-old', state: 'resolved', resolved_host: 'dir.example', domain_id: 'id-dir.example' },
      'seo_link_intake_items.update': () => 1,
    });
    const r = await intake(db, { text: 'Website,Action\nbit.ly/abc,Claim it', source: 'owner_seed', sourceDetail: 'sheet:aug' });
    expect(registry.ensureDomain).toHaveBeenCalledWith(expect.anything(), { domain: 'dir.example', source: 'owner_seed', sourceDetail: 'sheet:aug note:Claim it', sourceRef: null });
    expect(r.items).toEqual({ created: 0, seen: 1, pending: 0, retouched: 1 }); // already resolved: nothing waits for the sweep
  });

  test('a later feed of a STILL-pending reference keeps its own provenance on the row (pending_touches) and the resolver applies every one as a touch', async () => {
    const updates = [];
    const db = makeDb({
      'seo_link_intake_items.returning': [],
      'seo_link_intake_items.first': { id: 'item-p', state: 'pending', source_detail: 'paste:first', source_ref: null, pending_touches: [] },
      'seo_link_intake_items.update': (chain, args) => { updates.push(args[0]); return 1; },
    });
    const r = await intake(db, { text: 'Website,Action\nbit.ly/abc,Claim it', source: 'list_import', sourceDetail: 'sheet:aug' });
    expect(r.items).toEqual({ created: 0, seen: 1, pending: 1 });
    expect(updates).toHaveLength(1);
    // ATOMIC: a jsonb || concat (never a serialized read-modify-write array), deduped by a NOT-contains predicate
    expect(updates[0].pending_touches.__raw).toEqual(['pending_touches || ?::jsonb', [JSON.stringify([{ source_detail: 'sheet:aug note:Claim it', source_ref: null }])]]);
    const appendWheres = db.calls.filter((c) => c.op === 'whereRaw').map((c) => c.args[0]);
    expect(appendWheres).toContain('NOT pending_touches @> ?::jsonb');
    // the row's own provenance is never appended
    updates.length = 0;
    const db2 = makeDb({ 'seo_link_intake_items.returning': [], 'seo_link_intake_items.first': { id: 'item-p', state: 'pending', source_detail: 'paste:first', source_ref: null, pending_touches: [] }, 'seo_link_intake_items.update': (chain, args) => { updates.push(args[0]); return 1; } });
    await intake(db2, { text: 'bit.ly/abc', source: 'list_import', sourceDetail: 'paste:first' });
    expect(updates).toEqual([{ last_seen_at: 'NOW()' }]);
    // resolver: primary touch + one touch per pending feed — read FRESH under the row lock inside
    // the resolve trx (a feed appended after the claim snapshot is applied too, never stranded),
    // and cleared atomically with the resolution
    const dbr = makeDb({
      'seo_link_intake_items.skipLocked': [{ id: 'i1', raw_url: 'bit.ly/abc', source: 'list_import', source_detail: 'paste:first', source_ref: null, attempts: 0, pending_touches: [] }], // snapshot at claim: EMPTY
      'seo_link_intake_items.first': { pending_touches: [{ source_detail: 'sheet:aug note:Claim it', source_ref: 'ref-2' }] }, // appended while resolving; seen by the in-trx re-read
      'seo_link_intake_items.update': () => 1,
    });
    await resolveIntakeItems(dbr, { now: new Date('2026-08-30T01:00:00Z'), fetchPage: async () => ({ status: 200, finalUrl: 'https://listing.example/c', blocked: false, error: null }) });
    expect(registry.ensureDomain.mock.calls.map((c) => c[1])).toEqual([
      expect.objectContaining({ domain: 'listing.example', source: 'list_import', sourceDetail: 'paste:first https://listing.example/c', sourceRef: null }),
      expect.objectContaining({ domain: 'listing.example', source: 'list_import', sourceDetail: 'sheet:aug note:Claim it https://listing.example/c', sourceRef: 'ref-2' }),
    ]);
    expect(dbr.calls.some((c) => c.table === 'seo_link_intake_items' && c.op === 'forUpdate')).toBe(true); // the re-read locks the row
    const final = dbr.calls.filter((c) => c.table === 'seo_link_intake_items' && c.op === 'update').map((c) => c.args[0]).find((u) => u.state === 'resolved');
    expect(final.pending_touches).toBe('[]'); // applied touches cleared atomically with the resolution
  });

  test('appending a pending touch is conditional on the row STILL waiting: a row resolved mid-flight is re-read so the caller retouches directly', async () => {
    let reads = 0;
    const db = makeDb({
      'seo_link_intake_items.returning': [],
      'seo_link_intake_items.first': () => (reads += 1) === 1
        ? { id: 'item-p', state: 'pending', source_detail: 'paste:first', source_ref: null, pending_touches: [] }
        : { state: 'resolved', resolved_host: 'listing.example', domain_id: 'id-listing.example' },
      'seo_link_intake_items.update': (chain, args) => (args[0].pending_touches ? 0 : 1), // the conditional append misses — resolver got there first
    });
    registry.ensureDomain.mockResolvedValue({ id: 'id-listing.example', created: false, touched: true, touchId: 't9' });
    const r = await intake(db, { text: 'Website,Action\nbit.ly/abc,Claim it', source: 'list_import', sourceDetail: 'sheet:aug' });
    expect(registry.ensureDomain).toHaveBeenCalledWith(expect.anything(), { domain: 'listing.example', source: 'list_import', sourceDetail: 'sheet:aug note:Claim it', sourceRef: null });
    expect(r.items).toEqual({ created: 0, seen: 1, pending: 0, retouched: 1 });
  });

  test('a whole CSV cell that is a root URL with a query names the HOST, never `host?query`', () => {
    const r = parseOpportunities('Website,Action\nhttps://example.com?utm=x,Claim\n');
    expect(r.candidates).toEqual([expect.objectContaining({ domain: 'example.com', url: null, raws: ['https://example.com?utm=x'] })]); // a bare query on the root is no submission hint; the raw reference is kept
  });

  test('CSV note lands on the touch source_detail', async () => {
    const db = makeDb({ 'seo_link_intake_items.returning': [{ id: 'i' }] });
    await intake(db, { text: 'Website,Primary Action\nacademia.edu,Add website to profile', sourceDetail: 'backlinks_csv_2026_08' });
    expect(registry.ensureDomain).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ sourceDetail: 'backlinks_csv_2026_08 note:Add website to profile' }));
  });

  test('dryRun writes nothing', async () => {
    const db = makeDb({ 'seo_link_domains.select': [{ domain: 'academia.edu' }] });
    const r = await intake(db, { text: 'academia.edu producthunt.com bit.ly/x', dryRun: true });
    expect(registry.ensureDomain).not.toHaveBeenCalled();
    expect(db.calls.filter((c) => c.table === 'seo_link_intake_items')).toEqual([]);
    expect(r).toEqual(expect.objectContaining({ dryRun: true, existing: 1, inserted: 1, items: { created: 0, seen: 0, pending: 1 } }));
  });

  test('rejects an unknown source', async () => {
    await expect(intake(makeDb(), { text: 'a.com', source: 'nope' })).rejects.toMatchObject({ code: 'invalid_source' });
  });
});

describe('resolveIntakeItems — sweep', () => {
  const now = new Date('2026-08-30T01:00:00Z');
  function dbWith(items, extra = {}) {
    const updates = [];
    const db = makeDb({
      'seo_link_intake_items.first': { pending_touches: [] }, // the resolve trx's locked re-read; override to simulate a mid-flight append
      'seo_link_intake_items.skipLocked': items,
      'seo_link_intake_items.update': (chain, args) => { updates.push({ where: chain.ops.find((o) => o[0] === 'where' || o[0] === 'whereIn'), set: args[0] }); return 1; },
      ...extra,
    });
    db.updates = updates;
    return db;
  }

  test('claims due rows FOR UPDATE SKIP LOCKED and holds them; resolves through ensureDomain with the item provenance', async () => {
    const db = dbWith([{ id: 'i1', raw_url: 'bit.ly/abc', source: 'list_import', source_detail: 'paste:x', source_ref: null, attempts: 0 }]);
    const fetchPage = jest.fn(async () => ({ status: 200, finalUrl: 'https://Example.org/page?a=1', blocked: false, error: null }));
    const r = await resolveIntakeItems(db, { now, fetchPage });
    expect(db.calls.some((c) => c.table === 'seo_link_intake_items' && c.op === 'forUpdate')).toBe(true);
    expect(db.calls.some((c) => c.table === 'seo_link_intake_items' && c.op === 'skipLocked')).toBe(true);
    expect(fetchPage).toHaveBeenCalledWith('https://bit.ly/abc', { resolveOnly: true });
    // userinfo in a redirect target never pollutes the identity
    const dbu = dbWith([{ id: 'u1', raw_url: 'bit.ly/u', source: 'list_import', attempts: 0 }]);
    await resolveIntakeItems(dbu, { now, fetchPage: async () => ({ status: 200, finalUrl: 'https://user@evil-looking.example/p', blocked: false, error: null }) });
    expect(registry.ensureDomain).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ domain: 'evil-looking.example' }));
    expect(registry.ensureDomain).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ domain: 'example.org', source: 'list_import', sourceDetail: 'paste:x https://Example.org/page?a=1' }));
    // hold, then final resolved write
    expect(db.updates[0].set).toEqual({ next_retry_at: new Date(now.getTime() + _internals.CLAIM_HOLD_MS) });
    expect(db.updates[1].set).toEqual(expect.objectContaining({ state: 'resolved', resolved_host: 'example.org', domain_id: 'id-example.org', source_row_id: 'touch-example.org', attempts: 1, next_retry_at: null }));
    expect(r).toEqual(expect.objectContaining({ claimed: 1, resolved: 1 }));
  });

  test('every final write is conditional on OUR claim stamp: a row reclaimed by a later run (0 rows updated) is counted lost, its newer result untouched, the domain upsert rolled back', async () => {
    const db = dbWith([{ id: 'i1', raw_url: 'bit.ly/abc', source: 'list_import', attempts: 0 }], {
      'seo_link_intake_items.update': (chain, args) => (args[0].next_retry_at instanceof Date && args[0].state === undefined ? 1 : 0), // the hold write succeeds; every finalize finds another run's stamp
    });
    const fetchPage = jest.fn(async () => ({ status: 200, finalUrl: 'https://example.org/p', blocked: false, error: null }));
    const r = await resolveIntakeItems(db, { now, fetchPage });
    expect(r).toEqual(expect.objectContaining({ claimed: 1, resolved: 0, lost: 1, errors: [] }));
    // the finalize predicate carries the claim stamp
    const finalWhere = db.calls.filter((c) => c.table === 'seo_link_intake_items' && c.op === 'where' && c.args[0] === 'next_retry_at');
    const stamp = new Date(now.getTime() + _internals.CLAIM_HOLD_MS);
    expect(finalWhere.map((c) => c.args[1])).toEqual([stamp, stamp]); // the locked re-read AND the final write both carry the claim stamp
  });

  test('claims come in lease-sized batches: the lease covers one batch\'s worst case (3 hops × 8 s + 10 s X lookup per item); a large limit runs several batches, each stamped from its own claim time; a short batch ends the run', async () => {
    expect(_internals.CLAIM_HOLD_MS).toBeGreaterThanOrEqual(_internals.CLAIM_BATCH_MAX * (3 * 8000 + 10000));
    let claims = 0;
    const batch = (n, prefix) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, raw_url: `bit.ly/${prefix}${i}`, source: 'list_import', attempts: 0 }));
    const db = dbWith(null, { 'seo_link_intake_items.skipLocked': () => { claims += 1; return claims === 1 ? batch(50, 'a') : claims === 2 ? batch(50, 'b') : batch(7, 'c'); } });
    const fetchPage = jest.fn(async (url) => ({ status: 200, finalUrl: url.replace('bit.ly/', 'https://h-') + '.example/', blocked: false, error: null }));
    const r = await resolveIntakeItems(db, { now, fetchPage, limit: 500 });
    expect(claims).toBe(3); // 50 + 50 + 7 (< 50 ⇒ stop), never one 500-row claim
    expect(db.calls.filter((c) => c.table === 'seo_link_intake_items' && c.op === 'limit').map((c) => c.args[0])).toEqual([50, 50, 50]);
    expect(r).toEqual(expect.objectContaining({ claimed: 107, resolved: 107, lost: 0 }));
    // a later batch anchors its back-off (and lease) to ITS claim time, not the run start
    claims = 0;
    const realNow = Date.now; let tick = 0;
    Date.now = () => realNow() + tick;
    try {
      const db3 = dbWith(null, { 'seo_link_intake_items.skipLocked': () => { claims += 1; tick = 25 * 60e3 * claims; /* the clock moves on after each claim */ return claims === 1 ? batch(50, 'a') : claims === 2 ? batch(1, 'b') : []; } });
      await resolveIntakeItems(db3, { now, fetchPage: async () => ({ status: 0, finalUrl: null, blocked: false, error: 'fetch_failed' }), limit: 500 });
      const backoffs = db3.updates.filter((u) => u.set.state === 'unresolved').map((u) => u.set.next_retry_at.getTime() - now.getTime() - _internals.BACKOFF_MS[0]);
      expect(backoffs.slice(0, 50).every((d) => d === 0)).toBe(true);           // batch 1: anchored at `now`
      expect(backoffs[50]).toBeGreaterThanOrEqual(25 * 60e3);                    // batch 2: anchored ≥ 25 min later
    } finally { Date.now = realNow; }
    // limit caps the run too: 60 ⇒ 50 then 10
    claims = 0;
    const db2 = dbWith(null, { 'seo_link_intake_items.skipLocked': () => { claims += 1; return claims === 1 ? batch(50, 'a') : batch(10, 'b'); } });
    await resolveIntakeItems(db2, { now, fetchPage, limit: 60 });
    expect(db2.calls.filter((c) => c.table === 'seo_link_intake_items' && c.op === 'limit').map((c) => c.args[0])).toEqual([50, 10]);
  });

  test('CSV rows for the same domain keep every distinct note (nothing silently discarded by the dedupe)', () => {
    const csv = 'Website,Primary Action\nacademia.edu,Add website to profile\nhttps://academia.edu/upload,Upload a paper\nacademia.edu,Add website to profile\n';
    const r = parseOpportunities(csv);
    expect(r.candidates).toEqual([expect.objectContaining({ domain: 'academia.edu', url: 'https://academia.edu/upload', note: 'Add website to profile | Upload a paper' })]);
  });

  test('a CSV row whose reference is a shortener / X post keeps its note: parsed, persisted on the pending item, carried onto the resolved touch', async () => {
    const csv = 'Website,Primary Action\nhttps://x.com/waves/status/1,Reply with our link\nbit.ly/abc,Claim the listing\nbit.ly/abc,Add address\n';
    const parsed = parseOpportunities(csv);
    expect(parsed.unresolved).toEqual(['https://x.com/waves/status/1', 'bit.ly/abc']);
    expect(parsed.unresolvedNotes).toEqual({ 'https://x.com/waves/status/1': 'Reply with our link', 'bit.ly/abc': 'Claim the listing | Add address' });
    const db = makeDb({ 'seo_link_intake_items.returning': [{ id: 'i' }] });
    await intake(db, { text: csv, sourceDetail: 'backlinks_csv' });
    const inserts = db.calls.filter((c) => c.table === 'seo_link_intake_items' && c.op === 'insert').map((c) => c.args[0]);
    expect(inserts.map((r) => [r.raw_url, r.source_detail])).toEqual([
      ['https://x.com/waves/status/1', 'backlinks_csv note:Reply with our link'],
      ['bit.ly/abc', 'backlinks_csv note:Claim the listing | Add address'],
    ]);
    // resolver: the item's source_detail (with the note) + final URL become the domain touch
    const dbr = dbWith([{ id: 'i1', raw_url: 'bit.ly/abc', source: 'list_import', source_detail: 'backlinks_csv note:Claim the listing | Add address', source_ref: null, attempts: 0 }]);
    await resolveIntakeItems(dbr, { now, fetchPage: async () => ({ status: 200, finalUrl: 'https://listing.example/claim', blocked: false, error: null }) });
    expect(registry.ensureDomain).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ domain: 'listing.example', sourceDetail: 'backlinks_csv note:Claim the listing | Add address https://listing.example/claim' }));
  });

  test('dryRun reports what the sweep WOULD claim: no hold, no fetch, no writes', async () => {
    const db = makeDb({ 'seo_link_intake_items.limit': [
      { id: 'i1', raw_url: 'bit.ly/abc' }, { id: 'i2', raw_url: 'https://x.com/waves/status/123' },
    ] });
    const fetchPage = jest.fn();
    const r = await resolveIntakeItems(db, { now, fetchPage, dryRun: true });
    expect(r).toEqual(expect.objectContaining({ dryRun: true, due: 2, wouldFetch: 1, wouldPark: 1, claimed: 0, resolved: 0 }));
    expect(fetchPage).not.toHaveBeenCalled();
    expect(db.calls.some((c) => ['update', 'forUpdate', 'skipLocked', 'insert'].includes(c.op))).toBe(false);
    expect(registry.ensureDomain).not.toHaveBeenCalled();
  });

  test('a chain ending on our own host is dropped own_domain', async () => {
    const db = dbWith([{ id: 'i1', raw_url: 't.co/zzz', source: 'x', attempts: 0 }]);
    const fetchPage = jest.fn(async () => ({ status: 200, finalUrl: 'https://www.wavespestcontrol.com/blog/x', blocked: false, error: null }));
    const r = await resolveIntakeItems(db, { now, fetchPage });
    expect(db.updates[1].set).toEqual(expect.objectContaining({ state: 'dropped', drop_reason: 'own_domain' }));
    expect(registry.ensureDomain).not.toHaveBeenCalled();
    expect(r.dropped).toBe(1);
  });

  test('blocked / invalid hops drop invalid_url', async () => {
    const db = dbWith([{ id: 'i1', raw_url: 'bit.ly/priv', source: 'list_import', attempts: 0 }]);
    const fetchPage = jest.fn(async () => ({ status: 0, finalUrl: null, blocked: true, error: 'blocked_host' }));
    await resolveIntakeItems(db, { now, fetchPage });
    expect(db.updates[1].set).toEqual(expect.objectContaining({ state: 'dropped', drop_reason: 'invalid_url', last_error: 'blocked_host' }));
  });

  test('network failure backs off on the schedule and exhausts to dropped after the last step', async () => {
    const fetchPage = jest.fn(async () => ({ status: 0, finalUrl: null, blocked: false, error: 'fetch_failed' }));
    let db = dbWith([{ id: 'i1', raw_url: 'bit.ly/a', source: 'list_import', attempts: 0 }]);
    await resolveIntakeItems(db, { now, fetchPage });
    expect(db.updates[1].set).toEqual(expect.objectContaining({ state: 'unresolved', attempts: 1, next_retry_at: new Date(now.getTime() + _internals.BACKOFF_MS[0]) }));

    // every BACKOFF_MS entry is scheduled — the final 7-day wait included — and the drop comes on the failure after it
    expect(_internals.MAX_ATTEMPTS).toBe(_internals.BACKOFF_MS.length + 1);
    db = dbWith([{ id: 'i1', raw_url: 'bit.ly/a', source: 'list_import', attempts: _internals.BACKOFF_MS.length - 1 }]);
    await resolveIntakeItems(db, { now, fetchPage });
    expect(db.updates[1].set).toEqual(expect.objectContaining({ state: 'unresolved', attempts: _internals.BACKOFF_MS.length, next_retry_at: new Date(now.getTime() + _internals.BACKOFF_MS[_internals.BACKOFF_MS.length - 1]) }));
    db = dbWith([{ id: 'i1', raw_url: 'bit.ly/a', source: 'list_import', attempts: _internals.MAX_ATTEMPTS - 1 }]);
    const r = await resolveIntakeItems(db, { now, fetchPage });
    expect(db.updates[1].set).toEqual(expect.objectContaining({ state: 'dropped', drop_reason: 'retry_exhausted', attempts: _internals.MAX_ATTEMPTS }));
    expect(r.dropped).toBe(1);
    // a DNS lookup failure is transient: it takes the schedule, never the invalid_url drop
    db = dbWith([{ id: 'i1', raw_url: 'bit.ly/dns', source: 'list_import', attempts: 0 }]);
    await resolveIntakeItems(db, { now, fetchPage: async () => ({ status: 0, finalUrl: null, blocked: false, error: 'dns_error' }) });
    expect(db.updates[1].set).toEqual(expect.objectContaining({ state: 'unresolved', attempts: 1, last_error: 'dns_error' }));
  });

  test('a chain that ends on a never-target host is NOT turned into that domain — it stays unresolved', async () => {
    const db = dbWith([{ id: 'i1', raw_url: 'bit.ly/a', source: 'list_import', attempts: 0 }]);
    const fetchPage = jest.fn(async () => ({ status: 200, finalUrl: 'https://twitter.com/home', blocked: false, error: null }));
    await resolveIntakeItems(db, { now, fetchPage });
    expect(registry.ensureDomain).not.toHaveBeenCalled();
    expect(db.updates[1].set).toEqual(expect.objectContaining({ state: 'unresolved', last_error: 'resolved_to_never_target:twitter.com' }));
  });

  test('X posts are parked for the X feeder without spending an attempt', async () => {
    const db = dbWith([{ id: 'i1', raw_url: 'https://x.com/waves/status/123', source: 'x', attempts: 0 }]);
    const fetchTweetUrls = jest.fn(async () => null); // API unavailable
    const fetchPage = jest.fn();
    const r = await resolveIntakeItems(db, { now, fetchPage, fetchTweetUrls });
    expect(fetchPage).not.toHaveBeenCalled();
    expect(db.updates[1].set).toEqual(expect.objectContaining({ state: 'unresolved', attempts: 1, last_error: 'x_api_unavailable', next_retry_at: new Date(now.getTime() + _internals.BACKOFF_MS[0]) }));
    expect(fetchPage).not.toHaveBeenCalled();
    expect(r.unresolved).toBe(1);
  });

  test('an X post resolves through the X API: first non-X link → the host; further links become their own pending items; a link-less post is dropped', async () => {
    const db = dbWith([{ id: 'i1', raw_url: 'https://x.com/waves/status/123', source: 'x', source_detail: 'paste:x', attempts: 0 }], { 'seo_link_intake_items.returning': [{ id: 'new' }] });
    const fetchTweetUrls = jest.fn(async () => ['https://x.com/other/status/9', 'https://Dir.example/listing', 'https://second.example/p']);
    const fetchPage = jest.fn(async (url) => ({ status: 200, finalUrl: url, blocked: false, error: null }));
    const r = await resolveIntakeItems(db, { now, fetchPage, fetchTweetUrls });
    expect(fetchTweetUrls).toHaveBeenCalledWith('https://x.com/waves/status/123');
    expect(fetchPage).toHaveBeenCalledWith('https://Dir.example/listing', { resolveOnly: true });
    expect(registry.ensureDomain).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ domain: 'dir.example', source: 'x', sourceDetail: 'paste:x https://Dir.example/listing' }));
    const inserts = db.calls.filter((c) => c.table === 'seo_link_intake_items' && c.op === 'insert').map((c) => c.args[0]);
    expect(inserts).toEqual([expect.objectContaining({ raw_url: 'https://second.example/p', state: 'pending', source: 'x', source_detail: 'paste:x https://x.com/waves/status/123' })]);
    expect(r).toEqual(expect.objectContaining({ resolved: 1, spawned: 1, parked: 0 }));
    // an extra link whose item already resolved under this source still gets the post's provenance touch
    registry.ensureDomain.mockClear();
    const db3 = dbWith([{ id: 'i1', raw_url: 'https://x.com/waves/status/125', source: 'x', source_detail: 'paste:x', attempts: 0 }], { 'seo_link_intake_items.returning': [], 'seo_link_intake_items.first': { id: 'old', state: 'resolved', resolved_host: 'second.example', domain_id: 'id-second.example' } });
    await resolveIntakeItems(db3, { now, fetchPage, fetchTweetUrls: async () => ['https://dir.example/listing', 'https://second.example/p'] });
    expect(registry.ensureDomain).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ domain: 'second.example', source: 'x', sourceDetail: 'paste:x https://x.com/waves/status/125' }));
    // a post with no outbound links can never name a host: dropped invalid_url
    const db2 = dbWith([{ id: 'i1', raw_url: 'https://x.com/waves/status/124', source: 'x', attempts: 0 }]);
    await resolveIntakeItems(db2, { now, fetchPage, fetchTweetUrls: async () => ['https://x.com/waves/status/1'] });
    expect(db2.updates[1].set).toEqual(expect.objectContaining({ state: 'dropped', drop_reason: 'invalid_url', last_error: 'x_post_no_links' }));
  });

  test('defaultFetchTweetUrls: null without a bearer token (never throws, never fetches)', async () => {
    const saved = process.env.TWITTER_BEARER_TOKEN; delete process.env.TWITTER_BEARER_TOKEN;
    try { expect(await _internals.defaultFetchTweetUrls('https://x.com/a/status/1')).toBeNull(); } finally { if (saved !== undefined) process.env.TWITTER_BEARER_TOKEN = saved; }
    expect(_internals.isXHost('https://twitter.com/x/status/1')).toBe(true);
    expect(_internals.isXHost('https://dir.example/a')).toBe(false);
  });

  test('a throwing item is reported and does not stop the sweep', async () => {
    const db = dbWith([
      { id: 'i1', raw_url: 'bit.ly/a', source: 'list_import', attempts: 0 },
      { id: 'i2', raw_url: 'bit.ly/b', source: 'list_import', attempts: 0 },
    ]);
    const fetchPage = jest.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ status: 200, finalUrl: 'https://ok.example/', blocked: false, error: null });
    const r = await resolveIntakeItems(db, { now, fetchPage });
    expect(r.errors).toEqual([{ id: 'i1', error: 'boom' }]);
    expect(r.resolved).toBe(1);
  });

  test('nothing due → no fetches', async () => {
    const db = dbWith([]);
    const fetchPage = jest.fn();
    const r = await resolveIntakeItems(db, { now, fetchPage });
    expect(fetchPage).not.toHaveBeenCalled();
    expect(r.claimed).toBe(0);
  });
});

test('module path sanity', () => {
  expect(require.resolve(path.join(__dirname, '..', 'services/seo/link-registry-intake.js'))).toBeTruthy();
});
