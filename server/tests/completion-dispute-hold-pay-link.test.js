/**
 * B10 follow-up (owner ruling 2026-09-30): while a customer has an ACTIVE
 * collections DISPUTE hold, completion-time customer messages leave the pay
 * link out. The customer was told on the collections call that all billing
 * follow-up is on hold. The report link and the rest of the message still send.
 *
 * Covered: the fail-closed reader (shouldWithholdPayLink), the completion route
 * wiring (pinned by source, like collection-hold-charge-stop.test.js — the
 * handler is too large to drive in a unit test), and that a frozen deferred
 * body loses ONLY its pay-link line (report link kept).
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const fs = require('fs');
const path = require('path');

// Tiny knex stand-in: whereRaw understands the one predicate the hold lookup
// uses (reason ILIKE ?, prefix match, case-insensitive).
function makeFakeDb(tables, { failTable = null } = {}) {
  const build = (name) => {
    const filters = [];
    const q = {};
    const rows = () => (tables[name] || []).filter((r) => filters.every((f) => f(r)));
    q.where = (a, b) => {
      if (a && typeof a === 'object') Object.entries(a).forEach(([k, v]) => filters.push((r) => String(r[k]) === String(v)));
      else filters.push((r) => String(r[a]) === String(b));
      return q;
    };
    q.whereNull = (col) => { filters.push((r) => r[col] == null); return q; };
    q.whereRaw = (sql, bindings = []) => {
      if (/reason ILIKE \?/i.test(sql)) {
        const prefix = String(bindings[0]).replace(/%$/, '').toLowerCase();
        filters.push((r) => String(r.reason || '').toLowerCase().startsWith(prefix));
      }
      return q;
    };
    q.first = async () => { if (failTable === name) throw new Error('db down'); return rows()[0]; };
    return q;
  };
  return jest.fn((name) => build(name));
}

const DISPUTE = { id: 'f1', customer_id: 'cust-1', flag: 'collection_hold', reason: 'dispute on call: says the July bill is wrong', released_at: null };
const RELEASED = { ...DISPUTE, id: 'f2', released_at: '2026-09-29T12:00:00Z' };
const WRONG_NUMBER = { id: 'f3', customer_id: 'cust-1', flag: 'collection_hold', reason: 'wrong-number report on billing follow-up call; wrong_number flag write failed', released_at: null };

describe('shouldWithholdPayLink', () => {
  const { shouldWithholdPayLink } = require('../services/collections/collection-hold');

  test('an active dispute hold withholds the pay link', async () => {
    const database = makeFakeDb({ collections_flags: [DISPUTE] });
    expect(await shouldWithholdPayLink('cust-1', database)).toBe(true);
  });

  test('another customer\'s hold does not', async () => {
    const database = makeFakeDb({ collections_flags: [{ ...DISPUTE, customer_id: 'cust-2' }] });
    expect(await shouldWithholdPayLink('cust-1', database)).toBe(false);
  });

  test('a released hold keeps the pay link', async () => {
    const database = makeFakeDb({ collections_flags: [RELEASED] });
    expect(await shouldWithholdPayLink('cust-1', database)).toBe(false);
  });

  test('a non-dispute (wrong-number fallback) hold keeps the pay link', async () => {
    const database = makeFakeDb({ collections_flags: [WRONG_NUMBER] });
    expect(await shouldWithholdPayLink('cust-1', database)).toBe(false);
  });

  test('no hold row keeps the pay link; no customer id is not a hold', async () => {
    expect(await shouldWithholdPayLink('cust-1', makeFakeDb({ collections_flags: [] }))).toBe(false);
    expect(await shouldWithholdPayLink(null, makeFakeDb({ collections_flags: [DISPUTE] }))).toBe(false);
  });

  test('a lookup failure fails CLOSED (omit the pay link) instead of throwing', async () => {
    const database = makeFakeDb({ collections_flags: [DISPUTE] }, { failTable: 'collections_flags' });
    await expect(shouldWithholdPayLink('cust-1', database)).resolves.toBe(true);
  });
});

describe('completion route wiring (complete-scheduled-service.js)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../services/complete-scheduled-service.js'), 'utf8');

  test('the hold is read once, only when the text could carry a pay link, via the fail-closed reader', () => {
    expect(src).toMatch(/const payLinkHeldByDisputeHold = \(invoiceCreated && payUrl && svc\.customer_id\)\s*\?\s*await require\('\.\.\/services\/collections\/collection-hold'\)\.shouldWithholdPayLink\(svc\.customer_id\)\s*:\s*false;/);
    expect(src.match(/const payLinkHeldByDisputeHold =/g)).toHaveLength(1);
  });

  test('the lookup runs before the decline notice, which comes before the completion SMS composition', () => {
    const lookup = src.indexOf('const payLinkHeldByDisputeHold =');
    const notice = src.indexOf('let paymentFailedNoticeSent = false;');
    const sms = src.indexOf('const allowCompletionInvoiceLinkBase =');
    expect(lookup).toBeGreaterThan(0);
    expect(lookup).toBeLessThan(notice);
    expect(notice).toBeLessThan(sms);
  });

  test('the completion/report SMS drops the pay link (and so the past-due line, the with-invoice lane and the invoice-delivery mark)', () => {
    const i = src.indexOf('const allowCompletionInvoiceLinkBase =');
    const end = src.indexOf('const allowCompletionInvoiceLink = ', i);
    const base = src.slice(i, end);
    expect(base).toMatch(/&& !payLinkHeldByDisputeHold;/);
    // Every pay-link decision downstream keys off allowCompletionInvoiceLink.
    const after = src.slice(end);
    expect(after).toMatch(/completionPastDueLine = \(invoiceCreated && payUrl && allowCompletionInvoiceLink/);
    expect(after).toMatch(/payUrl: invoiceCreated && payUrl && allowCompletionInvoiceLink \? payUrl : null/);
    expect(after).toMatch(/\} else if \(invoiceCreated && payUrl && allowCompletionInvoiceLink\) \{/);
  });

  test('the decline notice (which carries the pay link as its own text) is not armed under a dispute hold', () => {
    const i = src.indexOf('} else if (paymentFailedSmsContext && !');
    expect(i).toBeGreaterThan(0);
    const cond = src.slice(i, src.indexOf(') {', i));
    expect(cond).toMatch(/&& !payLinkHeldByDisputeHold/);
  });
});

describe('deferred completion replay: a held body loses only the pay-link line', () => {
  const { stripPayLinkLineFromBody } = require('../services/dispatch-completion-deferred');

  test('report link and greeting stay; pay link and its label go', () => {
    const body = [
      'Hi Sam, your Waves Pest Control service is complete.',
      'Report: portal.example.test/r/abc123',
      'Invoice: pay.example.test/i/xyz789',
    ].join('\n');
    const stripped = stripPayLinkLineFromBody(body, 'https://pay.example.test/i/xyz789');
    expect(stripped).toContain('portal.example.test/r/abc123');
    expect(stripped).toContain('Hi Sam');
    expect(stripped).not.toContain('pay.example.test');
    expect(stripped).not.toMatch(/Invoice:/);
  });
});

describe('deferred replay registry wiring', () => {
  const src = fs.readFileSync(path.join(__dirname, '../services/messaging/deferred-replay-registry.js'), 'utf8');

  test('the completion recheck strips the pay link under a dispute hold before reading the invoice', () => {
    const start = src.indexOf('dispatch_completion_deferred: {');
    const holdAt = src.indexOf("customerHasActiveCollectionHoldChecked(meta.customer_id)", start);
    const invoiceAt = src.indexOf('await invoiceStillCollectible(meta)', start);
    expect(holdAt).toBeGreaterThan(start);
    expect(holdAt).toBeLessThan(invoiceAt);
    expect(src.slice(holdAt, invoiceAt)).toMatch(/stripPayLink: true, reason: 'collections-dispute-hold'/);
  });
});
