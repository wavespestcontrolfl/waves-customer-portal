/**
 * The seo_link_prospects board has ONE per-domain advisory lock shared by every
 * writer. Lost-link recovery enforces its domain-wide in-flight invariant with a
 * re-check under that lock — which only excludes writers that take the SAME
 * lock. These tests pin the key and that each writer takes it inside the
 * transaction that does its check + insert.
 */
const fs = require('fs');
const path = require('path');

const { lockProspectDomain, canonicalProspectDomain, LOCK_PREFIX } = require('../services/seo/prospect-domain-lock');

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
    const iLock = block.indexOf('lockProspectDomain(trx, domain)');
    const iExists = block.indexOf("trx('seo_link_prospects').where({ target_domain: domain, target_page }).first()");
    const iInsert = block.indexOf("trx('seo_link_prospects').insert(");
    expect(iTrx).toBeGreaterThan(-1);
    expect(iLock).toBeGreaterThan(iTrx);
    expect(iExists).toBeGreaterThan(iLock);
    expect(iInsert).toBeGreaterThan(iExists);
    expect(block).not.toMatch(/\bdb\('seo_link_prospects'\)/); // nothing on the board outside the trx
  });

  test('strategy agent create_link_prospects: lock → pair re-check → insert on the trx; a raced pair is a duplicate, not a throw', () => {
    const s = src('services/seo/backlink-strategy-tools.js');
    const block = s.slice(s.indexOf("case 'create_link_prospects'"), s.indexOf("case 'list_prospects'"));
    const iTrx = block.indexOf('db.transaction(async (trx)');
    const iLock = block.indexOf('lockProspectDomain(trx, domain)');
    const iRecheck = block.indexOf("trx('seo_link_prospects').where({ target_domain: domain, target_page: p.target_page }).first('id')");
    const iInsert = block.indexOf("trx('seo_link_prospects').insert(");
    expect(iLock).toBeGreaterThan(iTrx);
    expect(iRecheck).toBeGreaterThan(iLock);
    expect(iInsert).toBeGreaterThan(iRecheck);
    expect(block).toMatch(/if \(!landed\) \{ duplicates\.push\(domain\); skipped\+\+; continue; \}/);
    expect(block).not.toMatch(/\bdb\('seo_link_prospects'\)\.insert/);
  });

  test('local-opportunity promoter: lock precedes the ON CONFLICT insert on the trx', () => {
    const s = src('services/seo/local-opportunity-promoter.js');
    const iTrx = s.indexOf('db.transaction(async (trx)');
    const iLock = s.indexOf('lockProspectDomain(trx, cand.domain)');
    const iInsert = s.indexOf("trx('seo_link_prospects').insert(");
    expect(iLock).toBeGreaterThan(iTrx);
    expect(iInsert).toBeGreaterThan(iLock);
    expect(s).not.toMatch(/\bdb\('seo_link_prospects'\)\.insert/);
  });

  test('lost-link recovery uses the shared helper (no private lock string)', () => {
    const s = src('services/seo/lost-link-recovery.js');
    expect(s).toMatch(/lockProspectDomain\(trx, domain\)/);
    expect(s).not.toMatch(/pg_advisory_xact_lock/);
  });
});
