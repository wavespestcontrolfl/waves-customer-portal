/**
 * The Intelligence Bar's admin edit catalog (owner ruling 2026-10-12: a general
 * EDIT tool for a reviewed allow-list of small internal edits only). The
 * catalog is generated from the reviewed rows and the handler-chain scan: these
 * tests keep it from drifting silently, keep a changed handler out of it, and
 * check the deny rules against a messaging route, a money route and a DELETE.
 */
const fs = require('fs');
const {
  buildCatalog, serialize, loadReviewed, validateReviewedRow, judgeEdit, keyOf, writtenTables, OUT_FILE, REVIEWED_FILE,
} = require('../../scripts/build-ib-admin-write-catalog');
const read = require('../../scripts/build-ib-admin-read-catalog');
const readRules = require('../utils/admin-read-rules');
const writeRules = require('../utils/admin-write-rules');

jest.setTimeout(60000);

const committed = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
const census = JSON.parse(fs.readFileSync(read.CENSUS_FILE, 'utf8'));
const reviewedFile = JSON.parse(fs.readFileSync(REVIEWED_FILE, 'utf8'));

// The label an excluded endpoint carries: the census spelling, :param for every parameter.
const censusLabel = entry => `${entry.method} ${normalize(entry.endpoint)}`;
const normalize = endpoint => `/${readRules.splitPath(endpoint).map(seg => (readRules.isParam(seg) ? ':param' : seg)).join('/')}`;

function driftMessage(excluded) {
  const stale = excluded.review.filter(item => /^review is stale|^writes is stale/.test(item.reason));
  if (!stale.length) return 'The Intelligence Bar edit list (server/services/intelligence-bar/admin-write-catalog.json) is out of date. Run `npm run ib:write-catalog` and commit the result (server/services/intelligence-bar/README.md).';
  return `A reviewed Intelligence Bar edit went stale because its code changed: ${stale.map(item => `${item.endpoint} (${item.reason})`).join('; ')}. `
    + 'Run `npm run ib:write-catalog` and commit the result: CI then passes, and the edit leaves the bar\'s edit list until someone re-reviews it (server/services/intelligence-bar/README.md).';
}

test('regenerating the catalog gives the committed file byte for byte', () => {
  const { output, excluded } = buildCatalog();
  if (serialize(output) !== fs.readFileSync(OUT_FILE, 'utf8')) throw new Error(driftMessage(excluded));
});

test('every reviewed row is admitted: a stale row is a build failure here, not a silent drop', () => {
  const { excluded } = buildCatalog();
  const wanted = new Set(reviewedFile.reviewed.map(row => keyOf(row.method, row.endpoint)));
  const left = excluded.review.filter(item => wanted.has(keyOf(item.endpoint.split(' ')[0], item.endpoint.split(' ')[1])) && item.reason !== 'not reviewed');
  expect(left).toEqual([]);
});

test('every entry is a PUT or PATCH endpoint the census resolved, with named parameters', () => {
  const censusEdits = new Set(census.actions
    .filter(a => ['PUT', 'PATCH'].includes(a.operation.method) && a.operation.resolution === 'literal_or_template')
    .map(a => keyOf(a.operation.method, a.operation.endpoint)));
  expect(committed.entries.length).toBeGreaterThan(0);
  for (const entry of committed.entries) {
    expect({ entry: `${entry.method} ${entry.endpoint}`, inCensus: censusEdits.has(keyOf(entry.method, entry.endpoint)) }).toEqual({ entry: `${entry.method} ${entry.endpoint}`, inCensus: true });
    expect(['PUT', 'PATCH']).toContain(entry.method);
    expect(entry.params).toEqual(readRules.patternParams(entry.endpoint));
    expect(Object.keys(entry.paramKinds).sort()).toEqual([...entry.params].sort());
    expect(entry.screens.length).toBeGreaterThan(0);
    expect(entry.digest).toMatch(/^[0-9a-f]{32}$/);
    expect(entry.chain).toMatch(/^[0-9a-f]{32}$/);
  }
  expect(new Set(committed.entries.map(e => `${e.method} ${e.endpoint}`)).size).toBe(committed.entries.length);
});

test('no entry matches a deny rule, writes a money, message or queue table, or lists an address field', () => {
  for (const entry of committed.entries) {
    expect({ entry: entry.endpoint, deny: writeRules.editDenyReason(entry.method, entry.endpoint) }).toEqual({ entry: entry.endpoint, deny: null });
    expect({ entry: entry.endpoint, deny: readRules.denyReason(entry.endpoint) }).toEqual({ entry: entry.endpoint, deny: null });
    expect(writeRules.bodySpecProblem(entry)).toBeNull();
    expect(entry.writes.filter(table => writeRules.DENIED_TABLE_RE.test(table))).toEqual([]);
    expect(Object.keys(entry.body).filter(writeRules.bodyKeyLooksLikeAddress)).toEqual([]);
    expect(entry.noSend.length).toBeGreaterThan(20);
    // A customer or visit scoped edit names the parameter that carries the id, and it is a uuid.
    if (entry.scope !== 'broad') expect(entry.paramKinds[entry.scopeParam]).toBe('uuid');
  }
});

test('the committed catalog holds no counts, and each reviewed row carries a reason and a fingerprint', () => {
  expect(Object.keys(committed).sort()).toEqual(['blockedRoutes', 'entries', 'source', 'version']);
  for (const row of reviewedFile.reviewed) {
    expect(row.reason.length).toBeGreaterThanOrEqual(40);
    expect(row.hash).toMatch(/^[0-9a-f]{32}$/);
    expect(Array.isArray(row.signals)).toBe(true);
    expect(Array.isArray(row.unresolved)).toBe(true);
  }
  expect(reviewedFile.rejected.length).toBeGreaterThan(0);
  // A candidate a person read and kept out is not also in the catalog.
  const admitted = new Set(committed.entries.map(e => `${e.method} ${e.endpoint}`));
  for (const item of reviewedFile.rejected) expect(admitted.has(`${item.method} ${item.endpoint}`)).toBe(false);
});

test('every entry has a record snapshot (label, current values, version), and the email version row requires a draft', () => {
  const Snapshots = require('../services/intelligence-bar/admin-write-snapshots');
  for (const entry of committed.entries) {
    expect({ entry: `${entry.method} ${entry.endpoint}`, snapshot: Snapshots.hasSnapshot(`${entry.method} ${entry.endpoint}`) }).toEqual({ entry: `${entry.method} ${entry.endpoint}`, snapshot: true });
  }
  expect(committed.entries.find(entry => entry.endpoint === '/admin/email-templates/versions/:id').requireState).toEqual({ status: 'draft' });
});

test('the runtime reads the committed catalog only: a stale row cannot throw there', () => {
  const code = fs.readFileSync(require.resolve('../services/intelligence-bar/admin-write-tools.js'), 'utf8')
    .split('\n').filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
  expect(code).not.toMatch(/admin-write-reviewed|build-ib-admin/);
  expect(code).toContain("require('./admin-write-catalog.json')");
});

describe('a changed handler drops the row', () => {
  test.each([
    ['the chain hash', { hash: '0'.repeat(32) }, 'the handler chain changed'],
    ['the scan signals', { signals: ['write:update', 'write:insert'] }, 'scan signals changed'],
    ['the unresolved callees', { unresolved: ['routes/x.js#db.update'] }, 'unresolved callees changed'],
  ])('a stale %s leaves the endpoint out of the regenerated catalog', (_label, change, reason) => {
    const full = loadReviewed();
    const victim = committed.entries[0];
    const key = keyOf(victim.method, victim.endpoint);
    const stale = new Map(full.reviewed).set(key, { ...full.reviewed.get(key), ...change });
    const { output, excluded } = buildCatalog({ reviewed: { reviewed: stale, rejected: [] } });
    expect(output.entries.some(e => e.endpoint === victim.endpoint && e.method === victim.method)).toBe(false);
    expect(serialize(output)).not.toBe(fs.readFileSync(OUT_FILE, 'utf8'));
    const left = excluded.review.find(item => item.endpoint === censusLabel(victim));
    expect(left.reason).toContain(reason);
    expect(driftMessage(excluded)).toContain(censusLabel(victim));
  });

  test('a changed written-table list or a changed body list changes the entry', () => {
    const full = loadReviewed();
    const victim = committed.entries[0];
    const key = keyOf(victim.method, victim.endpoint);
    const row = full.reviewed.get(key);
    const wrongTables = new Map(full.reviewed).set(key, { ...row, writes: [...row.writes, 'other_table'] });
    expect(buildCatalog({ reviewed: { reviewed: wrongTables, rejected: [] } }).excluded.review.find(item => item.endpoint === censusLabel(victim)).reason).toMatch(/^writes is stale/);
    const widerBody = new Map(full.reviewed).set(key, { ...row, body: { ...row.body, extra_field: { type: 'string', maxLength: 10 } } });
    const entry = buildCatalog({ reviewed: { reviewed: widerBody, rejected: [] } }).output.entries.find(e => e.endpoint === victim.endpoint);
    expect(entry.digest).not.toBe(victim.digest);
  });
});

describe('the deny rules keep a messaging route, a money route and a DELETE out', () => {
  // A row a reviewer could write for a route the deny rules must still refuse: the fingerprint is copied from the scan, so
  // only the rules (not a stale hash) can keep it out. The body and reason are well formed.
  function fabricatedRow(method, endpoint, extra = {}) {
    const { table, opaqueMounts } = read.routeTable(['put', 'patch', 'all']);
    const segments = readRules.splitPath(normalize(endpoint));
    const matches = read.matchRoutes(segments, table.filter(entry => entry.route.method === method.toLowerCase() || entry.route.all));
    const verdicts = matches.map(match => judgeEdit(match, opaqueMounts));
    const fingerprint = read.endpointFingerprint(verdicts);
    const params = Object.fromEntries(readRules.patternParams(endpoint).map(name => [name, 'uuid']));
    return {
      method, endpoint, params, scope: 'broad', body: { notes: { type: 'string', maxLength: 100 } }, required: [],
      reviewed: 'Fabricated for a test: the fingerprint is copied from the scan so only the rules can keep this row out.',
      reason: 'Fabricated for a test: the fingerprint is copied from the scan so only the rules can keep this row out.',
      noSend: 'Fabricated for a test, sends nothing.', writes: [...new Set(verdicts.flatMap(v => v.writes || []))].sort(),
      signals: fingerprint.signals, unresolved: fingerprint.unresolved, hash: fingerprint.hash, ...extra,
    };
  }

  function admitted(row) {
    const full = loadReviewed();
    const reviewed = new Map(full.reviewed).set(keyOf(row.method, row.endpoint), row);
    const { output, excluded } = buildCatalog({ reviewed: { reviewed, rejected: [] } });
    return { entry: output.entries.find(e => e.method === row.method && e.endpoint === row.endpoint), excluded };
  }

  const censusHas = (method, endpoint) => census.actions.some(a => a.operation.method === method && a.operation.endpoint === normalize(endpoint));

  test('a route that reaches the customer message senders is out, however the row reads', () => {
    // PUT /admin/requests/:id dispatches customer SMS and email in its chain.
    expect(censusHas('PATCH', '/admin/requests/:id')).toBe(true);
    const row = fabricatedRow('PATCH', '/admin/requests/:id');
    expect(row.signals).toEqual(expect.arrayContaining(['outside:twilio', 'outside:sendgrid', 'effect_call:sendSMS']));
    const { entry, excluded } = admitted(row);
    expect(entry).toBeUndefined();
    expect(excluded.review.find(item => item.endpoint === 'PATCH /admin/requests/:param').reason).toMatch(/^hard signal (outside|outside_service:|credential_link:)/);
  });

  test('a waiver cannot clear a hard signal', () => {
    const row = fabricatedRow('PATCH', '/admin/requests/:id');
    const hard = row.signals.filter(signal => writeRules.HARD_WRITE_SIGNAL_RE.test(signal));
    expect(hard.length).toBeGreaterThan(0);
    const waive = Object.fromEntries(row.signals.map(signal => [signal, 'A reason that is long enough to look like a review.']));
    expect(admitted({ ...row, waive }).entry).toBeUndefined();
  });

  test('a money route is out: product price fields reach the pricing cache and the alert module', () => {
    expect(censusHas('PUT', '/admin/inventory/:id')).toBe(true);
    const row = fabricatedRow('PUT', '/admin/inventory/:id');
    expect(row.signals.some(signal => writeRules.HARD_WRITE_SIGNAL_RE.test(signal))).toBe(true);
    expect(admitted(row).entry).toBeUndefined();
  });

  test('a money path is out by its name, before any scan: price, invoice, payment, refund, credit, discount', () => {
    for (const path of ['/admin/inventory/:id/pricing', '/admin/invoices/:id', '/admin/discounts/:id', '/admin/customers/:id/credits', '/admin/payments/:id', '/admin/refunds/:id', '/admin/pricing-config/:key']) {
      expect({ path, reason: writeRules.editDenyReason('PUT', path) }).toEqual({ path, reason: expect.any(String) });
    }
  });

  test('a settings, user, credential, send, delete or bulk path is out by its name', () => {
    for (const path of ['/admin/settings/call-routing', '/admin/users/:id', '/admin/technicians/:id', '/admin/credentials/:id', '/admin/customers/:id/send-reminder',
      '/admin/customers/bulk', '/admin/schedule/:id/cancel', '/admin/customers/:id/delete', '/admin/leads/batch', '/admin/estimates/:id', '/admin/auth/password']) {
      expect({ path, denied: Boolean(writeRules.editDenyReason('PATCH', path)) }).toEqual({ path, denied: true });
    }
  });

  test('a DELETE is not an edit: the rules, the row validator and the catalog refuse it', () => {
    expect(writeRules.editDenyReason('DELETE', '/admin/sms-templates/:id')).toBe('method_not_edit');
    expect(writeRules.editDenyReason('POST', '/admin/sms-templates/:id')).toBe('method_not_edit');
    expect(() => validateReviewedRow({ ...reviewedFile.reviewed[0], method: 'DELETE' })).toThrow(/method must be PUT or PATCH/);
    expect(committed.entries.some(entry => entry.method === 'DELETE')).toBe(false);
    // The route table is built for PUT and PATCH only: a DELETE route never reaches the scan.
    const { table } = read.routeTable(['put', 'patch', 'all']);
    expect(table.every(entry => ['put', 'patch', 'all'].includes(entry.route.method))).toBe(true);
  });

  test('a chain that deletes, runs DDL or a raw SQL write has a write kind the rules refuse', () => {
    for (const signal of ['write:del', 'write:delete', 'write:destroy', 'write:truncate', 'write:alterTable', 'write:raw_sql', 'write:sql_text', 'write:upsert', 'write:batchInsert']) {
      expect({ signal, problem: writeRules.signalProblem(signal, { [signal]: 'A reason that is long enough to look like a review.' }) }).toEqual({ signal, problem: expect.stringContaining('write kind') });
    }
    expect(writeRules.signalProblem('write:update')).toBeNull();
  });
});

describe('the row validator', () => {
  const base = reviewedFile.reviewed.find(row => row.scope === 'broad');
  test.each([
    ['an address field in the body', { body: { ...base.body, address_line1: { type: 'string', maxLength: 50 } } }, /looks like address text/],
    ['a money table in writes', { writes: ['invoices'] }, /money, message or queue table/],
    ['a message table in writes', { writes: ['sms_outbox'] }, /money, message or queue table/],
    ['no reason', { reason: 'short' }, /reason must explain/],
    ['no noSend line', { noSend: '' }, /noSend must say/],
    ['an unknown scope', { scope: 'everything' }, /scope must be one of/],
    ['a body field with no size', { body: { notes: { type: 'string' } } }, /maxLength must be set/],
    ['a required field that is not allowed', { required: ['nope'] }, /required must name allowed body fields/],
    ['an undeclared path parameter', { params: {} }, /is missing: declare every path parameter/],
    ['a waiver without a reason', { waive: { 'effect_call:x': 'no' } }, /waive maps a signal to a reason/],
    ['a denied path', { endpoint: '/admin/invoices/:id' }, /not editable from the bar/],
    ['a state requirement that is not a value', { requireState: { status: 5 } }, /requireState maps a record state field/],
    ['an empty state requirement', { requireState: {} }, /requireState maps a record state field/],
  ])('refuses %s', (_label, change, message) => {
    expect(() => validateReviewedRow({ ...base, ...change })).toThrow(message);
  });
  test('the committed rows all pass', () => {
    for (const row of reviewedFile.reviewed) expect(() => validateReviewedRow(row)).not.toThrow();
  });
});

describe('the written-table scan', () => {
  test('finds the table a chain updates or inserts, through a transaction or a (h || db) handle', () => {
    const sources = [
      "server/routes/x.js\nasync function f(trx) { await trx('time_entries').where({ id }).update({ a: 1 }); await (h || db)('recipient_optin').where({ c }).update({ d: 2 }); await db('read_only').where({ id }).first(); await db('log_rows').insert({ a: 1 }); }",
    ];
    expect(writtenTables(sources)).toEqual(['log_rows', 'recipient_optin', 'time_entries']);
  });
});
