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
  test('the sibling lookup skips prepay-linked, prepaid-stamped and callback visits', async () => {
    const calls = [];
    const conn = () => {
      const b = {};
      for (const m of ['where', 'whereNotIn', 'whereNotNull', 'whereNull', 'orderBy']) {
        b[m] = (...args) => {
          if (typeof args[0] === 'function') {
            const inner = { whereNull: (c) => { calls.push(['inner.whereNull', c]); return inner; }, orWhere: (c, v) => { calls.push(['inner.orWhere', c, v]); return inner; } };
            args[0].call(inner);
          } else calls.push([m, ...args]);
          return b;
        };
      }
      b.first = () => Promise.resolve({ create_invoice_on_complete: true });
      return b;
    };
    await expect(resolveSeriesCreateInvoiceOnComplete(conn, 10, { create_invoice_on_complete: false })).resolves.toBe(true);
    expect(calls).toEqual(expect.arrayContaining([
      ['whereNull', 'annual_prepay_term_id'],
      ['whereNull', 'prepaid_at'],
      ['inner.whereNull', 'is_callback'],
      ['inner.orWhere', 'is_callback', false],
    ]));
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
