/**
 * Completion invoice suppressors must ignore REFUNDED / CANCELED invoices.
 *
 * The completion route reuses an invoice already attached to the visit
 * (existingCompletionInvoice / preMintedInvoice) instead of minting a new
 * one. Those lookups filtered only `whereNot('status', 'void')`, but the
 * Stripe webhook writes 'refunded' on a full refund and 'canceled' on a
 * PaymentIntent cancel (admins cancel by hand too). A one-time job that was
 * pre-minted/prepaid and then fully refunded (dispute, rain-out then rebook,
 * goodwill) still ran → no fresh invoice, invoiceCreated=true, the completion
 * SMS carried a pay link to the REFUNDED invoice, and
 * shouldAutoInvoiceCompletion saw "invoice exists" so the bill-manually alert
 * never fired — the visit completed unbilled.
 */
const fs = require('fs');
const path = require('path');
const { completionSuppressorInvoiceLookup, completionSupersededTerminalInvoiceLookup, COMPLETION_SUPERSEDABLE_TERMINAL_STATUSES } = require('../routes/admin-dispatch')._test;
const InvoiceService = require('../services/invoice');

function makeKnex(rows) {
  const calls = [];
  let excluded = [];
  let included = null;
  const chain = {
    where: jest.fn((...args) => { calls.push(['where', ...args]); return chain; }),
    whereNot: jest.fn((...args) => { calls.push(['whereNot', ...args]); return chain; }),
    whereNotIn: jest.fn((col, list) => { calls.push(['whereNotIn', col, list]); excluded = list; return chain; }),
    whereIn: jest.fn((col, list) => { calls.push(['whereIn', col, list]); included = list; return chain; }),
    orderBy: jest.fn((...args) => { calls.push(['orderBy', ...args]); return chain; }),
    first: jest.fn(async () => rows.find((r) => !excluded.includes(r.status) && (!included || included.includes(r.status))) || null),
  };
  const knex = jest.fn((table) => { calls.push(['table', table]); return chain; });
  knex.calls = calls;
  return knex;
}

describe('completionSuppressorInvoiceLookup', () => {
  test('a fully refunded pre-minted invoice no longer suppresses the mint (null → shouldAutoInvoiceCompletion decides live)', async () => {
    const knex = makeKnex([{ id: 'inv-refunded', status: 'refunded', token: 'tok-refunded' }]);
    const found = await completionSuppressorInvoiceLookup(knex, { scheduled_service_id: 'svc-1' });
    expect(found).toBeNull();
    expect(knex.calls).toContainEqual(['table', 'invoices']);
    expect(knex.calls).toContainEqual(['where', { scheduled_service_id: 'svc-1' }]);
    expect(knex.calls).toContainEqual(['whereNotIn', 'status', InvoiceService.CANCELLED_SERVICE_RESOLVED_STATUSES]);
    expect(chainCalled(knex, 'whereNot')).toBe(false);
  });

  test.each(['canceled', 'cancelled', 'void'])('%s invoice is skipped too', async (status) => {
    const knex = makeKnex([{ id: `inv-${status}`, status, token: 't' }]);
    await expect(completionSuppressorInvoiceLookup(knex, { service_record_id: 'rec-1' })).resolves.toBeNull();
  });

  test.each(['paid', 'prepaid', 'sent', 'draft', 'processing'])('%s invoice is still reused (alreadyPaid / pay-link paths unchanged)', async (status) => {
    const row = { id: `inv-${status}`, status, token: 't' };
    const knex = makeKnex([row]);
    await expect(completionSuppressorInvoiceLookup(knex, { scheduled_service_id: 'svc-1' })).resolves.toBe(row);
  });

  test('the shared vocabulary covers every webhook/admin terminal status', () => {
    expect(InvoiceService.CANCELLED_SERVICE_RESOLVED_STATUSES).toEqual(
      expect.arrayContaining(['void', 'refunded', 'canceled', 'cancelled'])
    );
  });
});

describe('completionSupersededTerminalInvoiceLookup (replacement provenance, codex #3456)', () => {
  // Knex-shaped mock: where(fn) collects orWhere scopes, whereIn pins the
  // vocabulary, orderBy(created_at desc, id desc) is applied to the rows so
  // the newest terminal row wins regardless of which identifier matched.
  function makeOrderedKnex(rows) {
    const calls = [];
    let scopes = [];
    let included = null;
    const orders = [];
    const chain = {
      where: jest.fn((arg) => {
        if (typeof arg === 'function') {
          const qb = { orWhere: jest.fn((cond) => { scopes.push(cond); return qb; }) };
          arg(qb);
        }
        calls.push(['where', typeof arg === 'function' ? 'fn' : arg]);
        return chain;
      }),
      whereIn: jest.fn((col, list) => { calls.push(['whereIn', col, list]); included = list; return chain; }),
      orderBy: jest.fn((col, dir) => { orders.push([col, dir]); return chain; }),
      first: jest.fn(async () => {
        const matches = rows.filter((r) => included.includes(r.status)
          && scopes.some((sc) => Object.entries(sc).every(([k, v]) => r[k] === v)));
        matches.sort((a, b) => (b.created_at.localeCompare(a.created_at)) || String(b.id).localeCompare(String(a.id)));
        return matches[0] ? { id: matches[0].id } : undefined;
      }),
    };
    const knex = jest.fn(() => chain);
    knex.calls = calls; knex.scopes = () => scopes; knex.orders = orders;
    return knex;
  }

  test.each(['refunded', 'canceled', 'cancelled'])('returns the skipped %s invoice id so the mint can stamp replaces_invoice_id', async (status) => {
    const knex = makeOrderedKnex([{ id: `inv-${status}`, status, scheduled_service_id: 'svc-1', created_at: '2026-08-20' }]);
    await expect(completionSupersededTerminalInvoiceLookup(knex, { scheduledServiceId: 'svc-1' })).resolves.toBe(`inv-${status}`);
    expect(knex.calls).toContainEqual(['whereIn', 'status', COMPLETION_SUPERSEDABLE_TERMINAL_STATUSES]);
    expect(knex.scopes()).toEqual([{ scheduled_service_id: 'svc-1' }]);
  });

  test('ONE globally ordered query across both identifiers — a newer scheduled_service_id row beats an older service_record_id row', async () => {
    const knex = makeOrderedKnex([
      { id: 'inv-old', status: 'refunded', service_record_id: 'rec-1', created_at: '2026-08-01' },
      { id: 'inv-new', status: 'canceled', scheduled_service_id: 'svc-1', created_at: '2026-08-20' },
    ]);
    await expect(completionSupersededTerminalInvoiceLookup(knex, { serviceRecordId: 'rec-1', scheduledServiceId: 'svc-1' })).resolves.toBe('inv-new');
    expect(knex.scopes()).toEqual([{ service_record_id: 'rec-1' }, { scheduled_service_id: 'svc-1' }]);
    expect(knex.orders).toEqual([['created_at', 'desc'], ['id', 'desc']]);
    expect(knex).toHaveBeenCalledTimes(1);
  });

  test('a VOID invoice is never a superseded terminal (nothing restores a void — the mint is a plain new invoice)', async () => {
    const knex = makeOrderedKnex([{ id: 'inv-void', status: 'void', service_record_id: 'rec-1', created_at: '2026-08-20' }]);
    await expect(completionSupersededTerminalInvoiceLookup(knex, { serviceRecordId: 'rec-1' })).resolves.toBeNull();
    expect(COMPLETION_SUPERSEDABLE_TERMINAL_STATUSES).not.toContain('void');
  });

  test('a live invoice is not a terminal either (the suppressor would have reused it)', async () => {
    const knex = makeOrderedKnex([{ id: 'inv-sent', status: 'sent', service_record_id: 'rec-1', created_at: '2026-08-20' }]);
    await expect(completionSupersededTerminalInvoiceLookup(knex, { serviceRecordId: 'rec-1' })).resolves.toBeNull();
  });

  test('no identifiers → null without querying', async () => {
    const knex = makeOrderedKnex([]);
    await expect(completionSupersededTerminalInvoiceLookup(knex, {})).resolves.toBeNull();
    expect(knex).not.toHaveBeenCalled();
  });
});

describe('sibling first-application invoices are OUT of the replacement mechanism (status quo)', () => {
  const dispatchSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-dispatch.js'), 'utf8');
  const siblingSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'estimate-first-application-invoice.js'), 'utf8');

  test('the sibling lookup keeps its pre-PR void-only filter (a refunded sibling still suppresses, never remints)', () => {
    expect(siblingSrc).toContain(".whereNot('i.status', 'void')");
    expect(siblingSrc).not.toContain('CANCELLED_SERVICE_RESOLVED_STATUSES');
    expect(siblingSrc).toMatch(/INTENTIONALLY retains refunded\/cancelled rows/);
  });

  test('the marker lookup only ever scopes to the CURRENT visit (service_record_id / scheduled_service_id), never the sibling lookup', () => {
    const fn = dispatchSrc.slice(dispatchSrc.indexOf('async function completionSupersededTerminalInvoiceLookup'), dispatchSrc.indexOf('router.post', dispatchSrc.indexOf('async function completionSupersededTerminalInvoiceLookup')));
    expect(fn).not.toMatch(/source_estimate_id|first_visit|findFirstApplicationInvoiceForEstimateService/);
    const calls = dispatchSrc.match(/completionSupersededTerminalInvoiceLookup\(db, \{[\s\S]{0,120}?\}\)/g);
    expect(calls).toHaveLength(1);
    expect(calls[0].replace(/\s+/g, ' ')).toBe('completionSupersededTerminalInvoiceLookup(db, { serviceRecordId: record.id, scheduledServiceId: svc.id, })');
  });
});

describe('completion mint stamps replaces_invoice_id (source contract)', () => {
  const dispatchSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-dispatch.js'), 'utf8');
  const invoiceSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'invoice.js'), 'utf8');

  test('the superseded-terminal lookup runs only after the whole suppressor chain resolved null', () => {
    const idx = dispatchSrc.indexOf('supersededTerminalInvoiceId = await completionSupersededTerminalInvoiceLookup(db, {');
    expect(idx).toBeGreaterThan(-1);
    const chainStart = dispatchSrc.indexOf('let existingCompletionInvoice = null;');
    const chainEnd = dispatchSrc.indexOf('} catch (e) { invoiceLookupFailed = true; /* non-blocking */ }', chainStart);
    // The whole suppressor chain (incl. the sibling lookup) runs and is
    // swallowed non-blocking BEFORE the provenance lookup ...
    expect(dispatchSrc.slice(chainStart, chainEnd)).toContain('findFirstApplicationInvoiceForEstimateService(svc, db);');
    expect(chainEnd).toBeLessThan(idx);
    // ... which sits OUTSIDE that try/catch (fail closed: a provenance
    // failure propagates instead of minting an unmarked replacement) and
    // is gated on the chain having succeeded with nothing reusable.
    expect(dispatchSrc.slice(chainEnd, idx)).not.toMatch(/try \{/);
    expect(dispatchSrc.slice(idx - 120, idx)).toContain('if (!existingCompletionInvoice && !invoiceLookupFailed && !recapReviewOnly) {');
  });

  test('BOTH completion mint lanes carry the marker through the create options (no post-insert UPDATE)', () => {
    const stamp = "...(supersededTerminalInvoiceId ? { replacesInvoiceId: supersededTerminalInvoiceId } : {}),";
    expect(dispatchSrc.split(stamp).length - 1).toBe(2);
    // typed-live serialized helper lane
    const helperIdx = dispatchSrc.indexOf('buildCreateParams: () => ({');
    expect(dispatchSrc.slice(helperIdx, helperIdx + 900)).toContain(stamp);
    // createFromService lane
    const optsIdx = dispatchSrc.indexOf('const mintOptions = {');
    const optsEnd = dispatchSrc.indexOf('skipAccrual: isBackfillCompletion,', optsIdx);
    expect(dispatchSrc.slice(optsIdx, optsEnd)).toContain(stamp);
    expect(dispatchSrc).not.toMatch(/update\(\{\s*replaces_invoice_id/);
  });

  test('a marked replacement mint serializes on the shared mint lock even on the explicit-amount (backfill) path', () => {
    expect(invoiceSrc).toContain('const serializedReplacementMint =\n      !replayFromScheduled && !!replacesInvoiceId && !!sr.scheduled_service_id;');
    expect(invoiceSrc).toContain('if (!replayFromScheduled && !serializedReplacementMint) return null;');
    expect(invoiceSrc).toContain('if (replayFromScheduled || serializedReplacementMint) {\n      return runMintTransaction(async (trx) => {\n        const adopted = await adoptUnderMintLock(trx);');
  });

  test('InvoiceService.create writes the column and createFromService threads the option', () => {
    expect(invoiceSrc).toContain('replacesInvoiceId = null,');
    expect(invoiceSrc).toContain('...(replacesInvoiceId ? { replaces_invoice_id: replacesInvoiceId } : {}),');
    expect(invoiceSrc).toContain('...(replacesInvoiceId ? { replacesInvoiceId } : {}),');
  });
});

describe('completion route wiring (source contract)', () => {
  const source = fs.readFileSync(path.join(__dirname, '../routes/admin-dispatch.js'), 'utf8');
  const completeRoute = source.slice(source.indexOf("router.post('/:serviceId/complete'"));

  test('both suppressor lookups route through the helper — no bare whereNot(void) invoice filter in the completion route', () => {
    expect(completeRoute).toMatch(/existingCompletionInvoice = await completionSuppressorInvoiceLookup\(db, \{ service_record_id: record\.id \}\)/);
    expect(completeRoute).toMatch(/existingCompletionInvoice = await completionSuppressorInvoiceLookup\(db, \{ scheduled_service_id: svc\.id \}\)/);
    expect(completeRoute).toMatch(/preMintedInvoice = await completionSuppressorInvoiceLookup\(db, \{ scheduled_service_id: svc\.id \}\)/);
    expect(completeRoute).not.toMatch(/db\('invoices'\)[\s\S]{0,200}\.whereNot\('status', 'void'\)/);
  });

  test('helper excludes the full resolved vocabulary, not just void', () => {
    expect(source).toMatch(/function completionSuppressorInvoiceLookup\(conn, where\) \{[\s\S]{0,300}\.whereNotIn\('status', InvoiceService\.CANCELLED_SERVICE_RESOLVED_STATUSES\)/);
  });
});

function chainCalled(knex, method) {
  return knex.calls.some((c) => c[0] === method);
}
