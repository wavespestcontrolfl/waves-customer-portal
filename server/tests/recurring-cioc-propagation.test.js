/**
 * create_invoice_on_complete propagation on series extension rows (fix:
 * cioc dropped on extension rows).
 *
 * Completion auto-invoicing gates off the ROW's create_invoice_on_complete
 * (admin-dispatch shouldAutoInvoiceCompletion), and the extend paths built
 * the next visit without it — a pay-per-visit customer's year-2 extension
 * visit completed UNINVOICED. resolveSeriesCreateInvoiceOnComplete resolves
 * the freshest billing intent: latest non-cancelled sibling first, parent
 * template as fallback, undefined when nothing carries a value.
 */
const fs = require('fs');
const path = require('path');

const adminScheduleRouter = require('../routes/admin-schedule');
const { resolveSeriesCreateInvoiceOnComplete } = adminScheduleRouter._test;

const src = fs.readFileSync(path.join(__dirname, '../routes/admin-schedule.js'), 'utf8');

function connWithSibling(siblingResult) {
  return () => {
    const b = {};
    for (const m of ['where', 'whereNotIn', 'whereNotNull', 'whereNull', 'orWhere', 'orderBy']) {
      b[m] = (arg) => { if (typeof arg === 'function') arg.call(b); return b; };
    }
    b.first = () => (siblingResult instanceof Error
      ? Promise.reject(siblingResult)
      : Promise.resolve(siblingResult));
    return b;
  };
}

describe('resolveSeriesCreateInvoiceOnComplete', () => {
  test('latest non-cancelled sibling wins (true)', async () => {
    await expect(resolveSeriesCreateInvoiceOnComplete(
      connWithSibling({ create_invoice_on_complete: true }), 10, { create_invoice_on_complete: false },
    )).resolves.toBe(true);
  });

  test('latest sibling wins even when FALSE (freshest office intent beats a stale parent)', async () => {
    await expect(resolveSeriesCreateInvoiceOnComplete(
      connWithSibling({ create_invoice_on_complete: false }), 10, { create_invoice_on_complete: true },
    )).resolves.toBe(false);
  });

  test('falls back to the parent template when no sibling carries a value', async () => {
    await expect(resolveSeriesCreateInvoiceOnComplete(
      connWithSibling(undefined), 10, { create_invoice_on_complete: true },
    )).resolves.toBe(true);
  });

  test('query failure (pre-migration column) falls back to the parent, never throws', async () => {
    await expect(resolveSeriesCreateInvoiceOnComplete(
      connWithSibling(new Error('column does not exist')), 10, { create_invoice_on_complete: true },
    )).resolves.toBe(true);
  });

  test('undefined when nothing carries a value — the insert keeps the column default', async () => {
    await expect(resolveSeriesCreateInvoiceOnComplete(
      connWithSibling(undefined), 10, { create_invoice_on_complete: null },
    )).resolves.toBeUndefined();
    await expect(resolveSeriesCreateInvoiceOnComplete(
      connWithSibling(undefined), 10, null,
    )).resolves.toBeUndefined();
  });
});

describe('a visit off for its own reason does not set the series flag', () => {
  // A tiny row-filtering fake: the builder records the WHERE tree and evaluates it over rows, so the test checks
  // which sibling the real query shape picks, not just which calls it makes.
  function rowConn(rows) {
    return () => {
      const make = (preds) => {
        const b = {};
        const nested = (fn) => { const inner = make([]); fn.call(inner); return inner._preds; };
        b._preds = preds;
        b.where = (a, v) => {
          if (typeof a === 'function') { const sub = nested(a); preds.push((r) => sub.every((p) => p(r))); }
          else if (typeof a === 'object') preds.push((r) => Object.entries(a).every(([k, val]) => r[k] === val));
          else preds.push((r) => r[a] === v);
          return b;
        };
        b.orWhere = (a, v) => {
          const left = preds.splice(0, preds.length);
          const right = typeof a === 'function' ? nested(a) : [(r) => r[a] === v];
          preds.push((r) => left.every((p) => p(r)) || right.every((p) => p(r)));
          return b;
        };
        b.whereNull = (c) => { preds.push((r) => r[c] == null); return b; };
        b.whereNotNull = (c) => { preds.push((r) => r[c] != null); return b; };
        b.whereNotIn = (c, vals) => { preds.push((r) => !vals.includes(r[c])); return b; };
        b.orderBy = () => b;
        b.first = async () => rows.filter((r) => preds.every((p) => p(r)))
          .sort((x, y) => (x.scheduled_date < y.scheduled_date ? 1 : -1))[0];
        return b;
      };
      return make([]);
    };
  }
  const visit = (date, flag, extra = {}) => ({
    recurring_parent_id: 10, status: 'pending', scheduled_date: date, create_invoice_on_complete: flag,
    annual_prepay_term_id: null, prepaid_at: null, is_callback: false, ...extra,
  });

  test.each([
    ['a prepay-linked visit', { annual_prepay_term_id: 'term-1' }],
    ['a prepaid-stamped visit', { prepaid_at: '2026-06-01' }],
    ['a free callback', { is_callback: true }],
  ])('%s that is off does not set the flag; the newest regular visit does', async (_label, extra) => {
    const conn = rowConn([visit('2026-09-01', true), visit('2026-12-01', false, extra)]);
    await expect(resolveSeriesCreateInvoiceOnComplete(conn, 10, { create_invoice_on_complete: false })).resolves.toBe(true);
  });

  test('a prepaid visit that is ON still states the series intent over an older parent', async () => {
    const conn = rowConn([visit('2026-12-01', true, { annual_prepay_term_id: 'term-1' })]);
    await expect(resolveSeriesCreateInvoiceOnComplete(conn, 10, { create_invoice_on_complete: false })).resolves.toBe(true);
  });

  test('an office "don\'t charge" on a regular visit still carries over', async () => {
    const conn = rowConn([visit('2026-09-01', true), visit('2026-12-01', false)]);
    await expect(resolveSeriesCreateInvoiceOnComplete(conn, 10, { create_invoice_on_complete: true })).resolves.toBe(false);
  });
});

describe('extension call sites apply the resolved flag (source guards)', () => {
  test('auto-extend (runRecurringSeriesMaintenance) resolves + stamps', () => {
    const fnStart = src.indexOf('async function runRecurringSeriesMaintenance');
    const fnBlock = src.slice(fnStart, src.indexOf('router.put(\'/:id/status\'', fnStart));
    expect(fnBlock).toContain('resolveSeriesCreateInvoiceOnComplete(conn, parentId, parent)');
    expect(fnBlock).toContain('nextData.create_invoice_on_complete = seriesCioc;');
  });

  test('every trx-scoped extension loop stamps the resolved flag', () => {
    // Resolved once inside the locked transaction, applied in each insert
    // loop. (Was `db` before the actions joined the maintenance lock's
    // transaction.) Three loops today: the alert route's extend and
    // convert_ongoing, plus the Edit-appointment visit-count top-up — a plan
    // topped up to a new count must bill on completion like every other visit
    // in the series.
    expect(src).toContain('await resolveSeriesCreateInvoiceOnComplete(trx, parentId, parent)');
    const stamps = src.match(/if \(cols\.create_invoice_on_complete && seriesCioc !== undefined\) data\.create_invoice_on_complete = seriesCioc;/g) || [];
    expect(stamps.length).toBe(3);
  });
});
