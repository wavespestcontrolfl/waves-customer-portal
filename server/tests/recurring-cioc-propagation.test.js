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
    for (const m of ['where', 'whereNotIn', 'whereNotNull', 'orderBy']) {
      b[m] = () => b;
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

describe('extension call sites apply the resolved flag (source guards)', () => {
  test('auto-extend (runRecurringSeriesMaintenance) resolves + stamps', () => {
    const fnStart = src.indexOf('async function runRecurringSeriesMaintenance');
    const fnBlock = src.slice(fnStart, src.indexOf('router.put(\'/:id/status\'', fnStart));
    expect(fnBlock).toContain('resolveSeriesCreateInvoiceOnComplete(conn, parentId, parent)');
    expect(fnBlock).toContain('nextData.create_invoice_on_complete = seriesCioc;');
  });

  test('recurring-alert extend AND convert_ongoing both stamp the resolved flag', () => {
    // Resolved once in the action route, applied in both insert loops.
    expect(src).toContain('await resolveSeriesCreateInvoiceOnComplete(db, parentId, parent)');
    const stamps = src.match(/if \(cols\.create_invoice_on_complete && seriesCioc !== undefined\) data\.create_invoice_on_complete = seriesCioc;/g) || [];
    expect(stamps.length).toBe(2);
  });
});
