/**
 * The seo_link_prospects board has ONE per-domain advisory lock shared by every
 * writer. Lost-link recovery enforces its domain-wide in-flight invariant with a
 * re-check under that lock — which only excludes writers that take the SAME
 * lock. These tests pin the key and that each writer takes it inside the
 * transaction that does its check + insert.
 */
const fs = require('fs');
const path = require('path');

const { lockProspectDomain, claimProspectDomain, findPlacementRow, canonicalProspectDomain, targetPageVariants, LOCK_PREFIX, ACTIVE_OUTREACH_STATUSES, IN_FLIGHT_STATUSES, TARGET_DOMAIN_CANONICAL_SQL } = require('../services/seo/prospect-domain-lock');

describe('prospect-domain-lock helper', () => {
  test('key = lost_recovery:<canonical host> — scheme, www/mail, path, port, case all collapse to one key', async () => {
    const calls = [];
    const trx = { raw: jest.fn(async (sql, bind) => { calls.push([sql, bind]); }) };
    for (const spelling of ['Blog.Example', 'https://www.blog.example/path?x=1', 'http://mail.blog.example:8080', ' blog.example/ ']) {
      await expect(lockProspectDomain(trx, spelling)).resolves.toBe('blog.example');
    }
    expect(new Set(calls.map(([, b]) => b[0]))).toEqual(new Set([`${LOCK_PREFIX}blog.example`]));
    expect(calls.every(([sql]) => sql === 'SELECT pg_advisory_xact_lock(hashtext(?))')).toBe(true);
    expect(LOCK_PREFIX).toBe('lost_recovery:');
  });

  test('empty domain takes no lock', async () => {
    const trx = { raw: jest.fn() };
    await expect(lockProspectDomain(trx, '')).resolves.toBeNull();
    expect(trx.raw).not.toHaveBeenCalled();
  });

  test('claimProspectDomain: lock FIRST, then the domain-wide probe (canonical host SQL, status set, outreach lanes only by default) — in-flight row returned, else null', async () => {
    const order = []; let raws = []; let ins = null;
    const q = { whereRaw: jest.fn((sql, bind) => { raws.push([sql, bind]); order.push('probe'); return q; }), whereIn: jest.fn((col, vals) => { ins = [col, vals]; return q; }), first: jest.fn(async () => ({ id: 'p1', status: 'contacted', target_page: '/x' })) };
    const trx = Object.assign(jest.fn(() => q), { raw: jest.fn(async () => { order.push('lock'); }) });
    const r = await claimProspectDomain(trx, 'https://WWW.Blog.Example/');
    expect(order[0]).toBe('lock');
    expect(r).toEqual({ domain: 'blog.example', inFlight: { id: 'p1', status: 'contacted', target_page: '/x' } });
    expect(raws[0]).toEqual([`${TARGET_DOMAIN_CANONICAL_SQL} = ?`, ['blog.example']]);
    expect(ins).toEqual(['status', [...ACTIVE_OUTREACH_STATUSES]]);
    // signup-lane rows (directory/citation/social — claimed by the signup runner, per-location) are not an outreach conversation
    expect(raws[1]).toEqual(["COALESCE(link_type, '') NOT IN (?, ?, ?)", ['directory', 'citation', 'social']]);
    // lanes: 'all' (recovery) sees every row
    raws = [];
    await claimProspectDomain(trx, 'blog.example', { lanes: 'all' });
    expect(raws.map(x => x[0]).join(' ')).not.toMatch(/link_type/);
    // the SQL twin compiles with exactly one binding (no bare '?' eaten by knex.raw)
    const knex = require('knex')({ client: 'pg' });
    const c = knex('seo_link_prospects').whereRaw(`${TARGET_DOMAIN_CANONICAL_SQL} = ?`, ['blog.example']).toSQL().toNative();
    expect(c.bindings).toEqual(['blog.example']);

    // a row outside the requested set does not count (recovery widens the set to IN_FLIGHT)
    q.first.mockResolvedValueOnce({ id: 'p2', status: 'live', target_page: '/y' });
    await expect(claimProspectDomain(trx, 'blog.example')).resolves.toEqual({ domain: 'blog.example', inFlight: null });
    q.first.mockResolvedValueOnce({ id: 'p2', status: 'live', target_page: '/y' });
    await expect(claimProspectDomain(trx, 'blog.example', { statuses: IN_FLIGHT_STATUSES })).resolves.toEqual(expect.objectContaining({ inFlight: expect.objectContaining({ id: 'p2' }) }));
    // v2 (plan §3.3): awaiting_owner = still the domain's one conversation (ACTIVE); watching = recovery-lane visible only
    expect(ACTIVE_OUTREACH_STATUSES).toEqual(['prospect', 'contacted', 'negotiating', 'awaiting_owner']);
    expect(IN_FLIGHT_STATUSES).toEqual(['prospect', 'contacted', 'negotiating', 'awaiting_owner', 'placed', 'live', 'indexed', 'watching']);
  });

  test('findPlacementRow: canonical host + every page spelling (www/non-www, http/https, ±slash), optional self-exclusion', async () => {
    let captured = null;
    const q = { whereRaw: jest.fn((sql, bind) => { captured = { sql, bind }; return q; }), whereIn: jest.fn((col, vals) => { captured.pages = [col, vals]; return q; }), where: jest.fn((col, val) => { captured.loc = [col, val]; return q; }), whereNot: jest.fn((col, val) => { captured.not = [col, val]; return q; }), first: jest.fn(async () => ({ id: 'p1', status: 'lost', target_page: 'https://wavespestcontrol.com/x' })) };
    const trx = jest.fn(() => q);
    const r = await findPlacementRow(trx, 'WWW.Blog.Example', 'http://www.wavespestcontrol.com/x/?utm=1', { excludeId: 'me' });
    expect(r).toEqual({ id: 'p1', status: 'lost', target_page: 'https://wavespestcontrol.com/x' });
    expect(captured.loc).toBeUndefined(); // default '-' = location-AGNOSTIC (the legacy 2-col unique is live through the expand phase)
    expect(captured.sql).toBe(`${TARGET_DOMAIN_CANONICAL_SQL} = ?`);
    expect(captured.bind).toEqual(['blog.example']);
    expect(captured.pages[0]).toBe('target_page');
    expect(new Set(captured.pages[1])).toEqual(new Set(targetPageVariants('https://wavespestcontrol.com/x/')));
    expect(captured.pages[1]).toEqual(expect.arrayContaining(['https://wavespestcontrol.com/x/', 'https://www.wavespestcontrol.com/x', 'http://wavespestcontrol.com/x/']));
    expect(captured.not).toEqual(['id', 'me']);
    q.first.mockResolvedValueOnce(undefined);
    await expect(findPlacementRow(trx, 'blog.example', 'https://wavespestcontrol.com/')).resolves.toBeNull();
    await expect(findPlacementRow(trx, '', 'https://wavespestcontrol.com/')).resolves.toBeNull();
    // an explicit location narrows (trim/lower); 'default' means unscoped → no filter
    await findPlacementRow(trx, 'blog.example', 'https://wavespestcontrol.com/', { location: ' Sarasota ' });
    expect(captured.loc).toEqual(['location_key', 'sarasota']);
    await findPlacementRow(trx, 'blog.example', 'https://wavespestcontrol.com/', { location: 'default' });
    expect(captured.loc).toBeUndefined();
  });

  test('canonical form matches the recovery lane normalizeDomain (one identity everywhere)', () => {
    const { _test } = require('../services/seo/lost-link-recovery');
    for (const s of ['WWW.Blog.Example/', 'https://blog.example:443/x', 'mail.blog.example']) {
      expect(_test.normalizeDomain(s)).toBe(canonicalProspectDomain(s));
    }
  });
});

describe('every board writer takes the shared lock inside its check+insert transaction', () => {
  const src = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

  test('admin manual add: lock → exists check → insert, all on the trx', () => {
    const s = src('routes/admin-backlink-agent-v2.js');
    const block = s.slice(s.indexOf("router.post('/prospects'"), s.indexOf("router.patch('/prospects/:id'"));
    const iTrx = block.indexOf('db.transaction(async (trx)');
    const iLock = block.indexOf('claimProspectDomain(trx, domain)');
    const iRefuse = block.indexOf('if (inFlight) return { inFlight };');
    const iExists = block.indexOf('findPlacementRow(trx, domain, target_page)');
    const iInsert = block.indexOf("trx('seo_link_prospects').insert(");
    expect(iTrx).toBeGreaterThan(-1);
    expect(iLock).toBeGreaterThan(iTrx);
    expect(iRefuse).toBeGreaterThan(iLock);
    expect(iExists).toBeGreaterThan(iRefuse);
    expect(iInsert).toBeGreaterThan(iExists);
    expect(block).toMatch(/result\.inFlight\) return res\.status\(409\)/);
    expect(block).not.toMatch(/\bdb\('seo_link_prospects'\)/); // nothing on the board outside the trx
  });

  test('admin PATCH: a status edit entering active outreach goes through the guard inside the trx, before the update; sibling in flight → 409', () => {
    const s = src('routes/admin-backlink-agent-v2.js');
    const block = s.slice(s.indexOf("router.patch('/prospects/:id'"), s.indexOf("router.post('/prospects/:id/recheck'"));
    const iTrx = block.indexOf('db.transaction(async (trx)');
    const iRead = block.indexOf("trx('seo_link_prospects').where({ id: req.params.id }).first('id', 'status', 'target_domain', 'target_page', 'link_type', 'location_key')");
    const iGate = block.indexOf("&& !inOutreach(current.status, current.link_type)");
    // a link_type change out of the signup lane (directory/citation/social → outreach type) is an admission too
    expect(block).toMatch(/const inOutreach = \(status, type\) => ACTIVE_OUTREACH_STATUSES\.includes\(status\) && !SIGNUP_TYPES\.includes\(type \|\| ''\);/);
    expect(block).toMatch(/inOutreach\('status' in patch \? patch\.status : current\.status, 'link_type' in patch \? patch\.link_type : current\.link_type\)/);
    const iLock = block.indexOf('claimProspectDomain(trx, current.target_domain)');
    const iUpdate = block.indexOf("trx('seo_link_prospects').where({ id: req.params.id }).update(patch)");
    expect(iTrx).toBeGreaterThan(-1);
    expect(iRead).toBeGreaterThan(iTrx);
    expect(iGate).toBeGreaterThan(iRead);
    expect(iLock).toBeGreaterThan(iGate);
    expect(iUpdate).toBeGreaterThan(iLock);
    expect(block).toMatch(/inFlight\.id !== current\.id/); // the row itself never blocks its own edit
    expect(block).toMatch(/result\.inFlight\) return res\.status\(409\)/);
    expect(block).not.toMatch(/\bdb\('seo_link_prospects'\)/);
    // a target_page edit is a placement move: domain lock + canonical placement probe (self excluded) → 409, before the update
    const iMove = block.indexOf("'target_page' in patch && patch.target_page !== current.target_page");
    const iMoveLock = block.indexOf('lockProspectDomain(trx, current.target_domain)');
    const iMoveProbe = block.indexOf('findPlacementRow(trx, current.target_domain, patch.target_page, { excludeId: current.id, location: current.location_key })');
    expect(iMove).toBeGreaterThan(iRead);
    expect(iMoveLock).toBeGreaterThan(iMove);
    expect(iMoveProbe).toBeGreaterThan(iMoveLock);
    expect(iUpdate).toBeGreaterThan(iMoveProbe);
    expect(block).toMatch(/result\.taken\) return res\.status\(409\)/);
  });

  test('strategy agent create_link_prospects: lock → pair re-check → insert on the trx; a raced pair is a duplicate, not a throw', () => {
    const s = src('services/seo/backlink-strategy-tools.js');
    const block = s.slice(s.indexOf("case 'create_link_prospects'"), s.indexOf("case 'list_prospects'"));
    const iTrx = block.indexOf('db.transaction(async (trx)');
    const iLock = block.indexOf('claimProspectDomain(trx, domain)');
    const iRefuse = block.indexOf('if (inFlight) return false;');
    const iRecheck = block.indexOf('findPlacementRow(trx, domain, p.target_page)');
    const iInsert = block.indexOf("trx('seo_link_prospects').insert(");
    expect(iLock).toBeGreaterThan(iTrx);
    expect(iRefuse).toBeGreaterThan(iLock);
    expect(iRecheck).toBeGreaterThan(iRefuse);
    expect(iInsert).toBeGreaterThan(iRecheck);
    expect(block).toMatch(/if \(!landed\) \{ duplicates\.push\(domain\); skipped\+\+; continue; \}/);
    expect(block).not.toMatch(/\bdb\('seo_link_prospects'\)\.insert/);
  });

  test('local-opportunity promoter: lock precedes the ON CONFLICT insert on the trx', () => {
    const s = src('services/seo/local-opportunity-promoter.js');
    const iTrx = s.indexOf('db.transaction(async (trx)');
    const iLock = s.indexOf('claimProspectDomain(trx, cand.domain)');
    const iRefuse = s.indexOf('if (inFlight) return [];');
    const iPair = s.indexOf('findPlacementRow(trx, cand.domain, HOME)');
    const iInsert = s.indexOf("trx('seo_link_prospects').insert(");
    expect(iLock).toBeGreaterThan(iTrx);
    expect(iRefuse).toBeGreaterThan(iLock);
    expect(iPair).toBeGreaterThan(iRefuse);
    expect(iInsert).toBeGreaterThan(iPair);
    expect(s).not.toMatch(/\bdb\('seo_link_prospects'\)\.insert/);
  });

  test('deep-harvest script: guard → pair re-check → insert on the trx', () => {
    const s = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'backlink-deep-harvest.js'), 'utf8');
    const iTrx = s.indexOf('db.transaction(async (trx)');
    const iLock = s.indexOf('claimProspectDomain(trx, s.candidate.domain)');
    const iDup = s.indexOf('findPlacementRow(trx, s.candidate.domain, targetPage)');
    const iInsert = s.indexOf("trx('seo_link_prospects').insert(");
    expect(iLock).toBeGreaterThan(iTrx);
    expect(iDup).toBeGreaterThan(iLock);
    expect(iInsert).toBeGreaterThan(iDup);
    expect(s).not.toMatch(/\bdb\('seo_link_prospects'\)\.insert/);
  });

  test('no seo_link_prospects writer anywhere bypasses the guard', () => {
    const { execSync } = require('child_process');
    const root = path.join(__dirname, '..', '..');
    const hits = execSync(`grep -rln "seo_link_prospects').insert" server scripts --include='*.js' | grep -v /tests/`, { cwd: root }).toString().trim().split('\n');
    for (const f of hits) {
      const src = fs.readFileSync(path.join(root, f), 'utf8');
      expect({ file: f, guarded: /claimProspectDomain\(trx, /.test(src) }).toEqual({ file: f, guarded: true });
      // and no writer checks the pair by raw spelling any more
      expect({ file: f, rawPair: /where\(\{ target_domain: [^}]*target_page/.test(src) }).toEqual({ file: f, rawPair: false });
    }
    expect(hits.length).toBeGreaterThanOrEqual(5);
  });

  test('lost-link recovery uses the shared guard with the wider IN_FLIGHT set for insert AND reopen (no private lock string / SQL twin); resolveRecoveredLink locks the domain in a transaction before its placement move', () => {
    const s = src('services/seo/lost-link-recovery.js');
    const rb = s.slice(s.indexOf('async function resolveRecoveredLink'));
    const iTrx = rb.indexOf('if (!trx) return db.transaction((t) => resolveRecoveredLink(backlink, now, { trx: t }));');
    const iLock = rb.indexOf('await lockProspectDomain(q, domain);');
    const iProbe = rb.indexOf('findPlacementRow') >= 0 ? rb.indexOf('findPlacementRow') : rb.indexOf("whereIn('target_page', [...variants]).whereNot('id', row.id)");
    expect(iTrx).toBeGreaterThan(-1);
    expect(iLock).toBeGreaterThan(iTrx);
    expect(iProbe).toBeGreaterThan(iLock);
    expect(s.match(/claimProspectDomain\(trx, domain, \{ statuses: IN_FLIGHT_STATUSES, lanes: 'all' \}\)/g)).toHaveLength(2);
    expect(s).not.toMatch(/pg_advisory_xact_lock/);
    expect(s).not.toMatch(/split_part\(split_part/);
  });
});
