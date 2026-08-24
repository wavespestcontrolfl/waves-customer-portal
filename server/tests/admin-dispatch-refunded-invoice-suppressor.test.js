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
const {
  completionSuppressorInvoiceLookup,
  completionTerminalInvoiceLookup,
  completionNewestLiveInvoiceLookup,
  splitTerminalCompletionInvoice,
  reconcileLiveVsRefunded,
  COMPLETION_TERMINAL_INVOICE_STATUSES,
  shouldAutoInvoiceCompletion,
} = require('../routes/admin-dispatch')._test;
const InvoiceService = require('../services/invoice');

function makeKnex(rows) {
  const calls = [];
  let excluded = [];
  const chain = {
    where: jest.fn((...args) => { calls.push(['where', ...args]); return chain; }),
    whereNot: jest.fn((...args) => { calls.push(['whereNot', ...args]); return chain; }),
    whereNotIn: jest.fn((col, list) => { calls.push(['whereNotIn', col, list]); excluded = list; return chain; }),
    orderBy: jest.fn((...args) => { calls.push(['orderBy', ...args]); return chain; }),
    first: jest.fn(async () => rows.find((r) => !excluded.includes(r.status)) || null),
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

describe('completionTerminalInvoiceLookup (refunded/canceled invoice on THIS visit blocks the mint)', () => {
  function makeOrderedKnex(rows) {
    let scopes = [];
    let included = null;
    const orders = [];
    const chain = {
      where: jest.fn((arg) => {
        if (typeof arg === 'function') {
          const qb = { orWhere: jest.fn((cond) => { scopes.push(cond); return qb; }) };
          arg(qb);
        }
        return chain;
      }),
      whereIn: jest.fn((col, list) => { included = list; return chain; }),
      orderBy: jest.fn((col, dir) => { orders.push([col, dir]); return chain; }),
      first: jest.fn(async () => {
        const matches = rows.filter((r) => included.includes(r.status)
          && scopes.some((sc) => Object.entries(sc).every(([k, v]) => r[k] === v)));
        matches.sort((a, b) => (b.created_at.localeCompare(a.created_at)) || String(b.id).localeCompare(String(a.id)));
        return matches[0] ? { id: matches[0].id, invoice_number: matches[0].invoice_number, status: matches[0].status, created_at: matches[0].created_at } : undefined;
      }),
    };
    const knex = jest.fn(() => chain);
    knex.scopes = () => scopes; knex.orders = orders;
    return knex;
  }

  test('finds the REFUNDED invoice on the visit (only a refund can bounce)', async () => {
    const knex = makeOrderedKnex([{ id: 'inv-refunded', invoice_number: 'WPC-1', status: 'refunded', scheduled_service_id: 'svc-1', created_at: '2026-08-20' }]);
    await expect(completionTerminalInvoiceLookup(knex, { scheduledServiceId: 'svc-1' })).resolves.toEqual({ id: 'inv-refunded', invoice_number: 'WPC-1', status: 'refunded', created_at: '2026-08-20' });
    expect(knex.scopes()).toEqual([{ scheduled_service_id: 'svc-1' }]);
    expect(COMPLETION_TERMINAL_INVOICE_STATUSES).toEqual(['refunded']);
  });

  test.each(['canceled', 'cancelled'])('a %s invoice on the visit does NOT block — excluded from reuse, the completion mints its replacement', async (status) => {
    const knex = makeOrderedKnex([{ id: `inv-${status}`, status, scheduled_service_id: 'svc-1', created_at: '2026-08-20' }]);
    await expect(completionTerminalInvoiceLookup(knex, { scheduledServiceId: 'svc-1' })).resolves.toBeNull();
    // Still never reused as the completion invoice.
    expect(InvoiceService.CANCELLED_SERVICE_RESOLVED_STATUSES).toContain(status);
    // And the decision mints (no terminal → no suppression, no alert).
    expect(shouldAutoInvoiceCompletion({
      recapReviewOnly: false, alreadyPaid: false, prepaidCovered: false, autopayCoversVisit: false,
      preMintedInvoice: null, existingCompletionInvoice: null, terminalInvoiceOnVisit: false,
      createInvoiceOnComplete: true, hasVisitPrice: true, invoiceAmount: 120, serviceType: 'Pest Control', isCallback: false,
    })).toBe(true);
  });

  test('one ordered query across both identifiers — newest refunded wins', async () => {
    const knex = makeOrderedKnex([
      { id: 'inv-old', status: 'refunded', service_record_id: 'rec-1', created_at: '2026-08-01' },
      { id: 'inv-new', status: 'refunded', scheduled_service_id: 'svc-1', created_at: '2026-08-20' },
    ]);
    const found = await completionTerminalInvoiceLookup(knex, { serviceRecordId: 'rec-1', scheduledServiceId: 'svc-1' });
    expect(found.id).toBe('inv-new');
    expect(knex.scopes()).toEqual([{ service_record_id: 'rec-1' }, { scheduled_service_id: 'svc-1' }]);
    expect(knex.orders).toEqual([['created_at', 'desc'], ['id', 'desc']]);
    expect(knex).toHaveBeenCalledTimes(1);
  });

  test('a VOID invoice does not block (nothing restores a void); a live one is not terminal', async () => {
    expect(COMPLETION_TERMINAL_INVOICE_STATUSES).not.toContain('void');
    const voidKnex = makeOrderedKnex([{ id: 'inv-void', status: 'void', service_record_id: 'rec-1', created_at: '2026-08-20' }]);
    await expect(completionTerminalInvoiceLookup(voidKnex, { serviceRecordId: 'rec-1' })).resolves.toBeNull();
    const liveKnex = makeOrderedKnex([{ id: 'inv-sent', status: 'sent', service_record_id: 'rec-1', created_at: '2026-08-20' }]);
    await expect(completionTerminalInvoiceLookup(liveKnex, { serviceRecordId: 'rec-1' })).resolves.toBeNull();
    const none = makeOrderedKnex([]);
    await expect(completionTerminalInvoiceLookup(none, {})).resolves.toBeNull();
    expect(none).not.toHaveBeenCalled();
  });
});

describe('completionNewestLiveInvoiceLookup (comparison row for the refunded reconciliation)', () => {
  test('one ordered query across both identifiers, live statuses only, newest wins', async () => {
    const scopes = [];
    const orders = [];
    let excluded = [];
    const rows = [
      { id: 'inv-rec-old', status: 'sent', service_record_id: 'rec-1', created_at: '2026-08-01' },
      { id: 'inv-ss-new', status: 'draft', scheduled_service_id: 'svc-1', created_at: '2026-08-25' },
      { id: 'inv-refunded', status: 'refunded', scheduled_service_id: 'svc-1', created_at: '2026-08-30' },
    ];
    const chain = {
      where: jest.fn((arg) => { if (typeof arg === 'function') arg({ orWhere: (c) => { scopes.push(c); return { orWhere: (c2) => { scopes.push(c2); } }; } }); return chain; }),
      whereNotIn: jest.fn((col, list) => { excluded = list; return chain; }),
      orderBy: jest.fn((col, dir) => { orders.push([col, dir]); return chain; }),
      first: jest.fn(async () => {
        const m = rows.filter((r) => !excluded.includes(r.status) && scopes.some((sc) => Object.entries(sc).every(([k, v]) => r[k] === v)));
        m.sort((a, b) => b.created_at.localeCompare(a.created_at) || String(b.id).localeCompare(String(a.id)));
        return m[0] ? { id: m[0].id, status: m[0].status, created_at: m[0].created_at } : undefined;
      }),
    };
    const knex = jest.fn(() => chain);
    const found = await completionNewestLiveInvoiceLookup(knex, { serviceRecordId: 'rec-1', scheduledServiceId: 'svc-1' });
    expect(found).toEqual({ id: 'inv-ss-new', status: 'draft', created_at: '2026-08-25' });
    expect(excluded).toEqual(InvoiceService.CANCELLED_SERVICE_RESOLVED_STATUSES);
    expect(orders).toEqual([['created_at', 'desc'], ['id', 'desc']]);
    expect(knex).toHaveBeenCalledTimes(1);
    await expect(completionNewestLiveInvoiceLookup(knex, {})).resolves.toBeNull();
  });
});

describe('shouldAutoInvoiceCompletion: a terminal invoice on the visit suppresses the mint', () => {
  const billable = {
    recapReviewOnly: false, alreadyPaid: false, prepaidCovered: false, autopayCoversVisit: false,
    preMintedInvoice: null, existingCompletionInvoice: null,
    createInvoiceOnComplete: true, waveguardTier: null, perApplicationBilling: false, annualPrepayBilling: false,
    hasVisitPrice: true, invoiceAmount: 120, autoInvoicePricedVisits: false, serviceType: 'Pest Control', isCallback: false,
  };
  test('baseline: the same visit without a terminal invoice mints', () => {
    expect(shouldAutoInvoiceCompletion({ ...billable })).toBe(true);
  });
  test('terminalInvoiceOnVisit → false (no replacement is ever minted)', () => {
    expect(shouldAutoInvoiceCompletion({ ...billable, terminalInvoiceOnVisit: true })).toBe(false);
  });
});

describe('completion route: terminal invoice → no mint, no pay link, manual-billing alert, report-only SMS (source contract)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-dispatch.js'), 'utf8');

  test('the own-visit terminal lookup runs after the direct suppressors and BEFORE the sibling first-application fallback, which is skipped when a terminal invoice exists', () => {
    const idx = src.indexOf('refundedOnVisit = await completionTerminalInvoiceLookup(db, {');
    expect(idx).toBeGreaterThan(-1);
    const chainStart = src.indexOf('let existingCompletionInvoice = null;');
    const siblingAt = src.indexOf('existingCompletionInvoice = await findFirstApplicationInvoiceForEstimateService(svc, db);', chainStart);
    expect(chainStart).toBeLessThan(idx);
    expect(idx).toBeLessThan(siblingAt);
    // Unconditional (not gated on the suppressors finding nothing) — an
    // older live row must not mask a newer refunded one.
    expect(src.slice(idx - 160, idx)).toMatch(/if \(!recapReviewOnly\) \{\s*let refundedOnVisit = null;\s*let newestLiveOnVisit = null;\s*try \{\s*$/);
    expect(src.slice(idx, idx + 2000)).toContain('reconcileLiveVsRefunded(existingCompletionInvoice, refundedOnVisit, newestLiveOnVisit)');
    expect(src.slice(idx, idx + 600)).toContain('newestLiveOnVisit = await completionNewestLiveInvoiceLookup(db, {');
    // Fail CLOSED: outside the non-blocking suppressor try (that catch sits
    // BEFORE this lookup), and its own failure releases the attempt + 503.
    const directCatch = src.indexOf('} catch (e) { invoiceLookupFailed = true; /* non-blocking */ }', chainStart);
    expect(directCatch).toBeLessThan(idx);
    expect(src.slice(idx, idx + 2000)).toContain('await CompletionAttempts.releaseCompletionAttemptForResume(completionAttempt, lookupErr);');
    expect(src.slice(idx, idx + 2000)).toContain("code: 'terminal_invoice_lookup_failed',");
    expect(src.slice(idx, idx + 2000)).not.toContain('invoiceLookupFailed = true');
    expect(src.slice(siblingAt - 100, siblingAt)).toMatch(/if \(!existingCompletionInvoice && !terminalCompletionInvoice\) \{\s*$/);
    expect(src.slice(idx, idx + 160)).toMatch(/serviceRecordId: record\.id,\s*scheduledServiceId: svc\.id,/);
    const fn = src.slice(src.indexOf('async function completionTerminalInvoiceLookup'), src.indexOf('router.post', src.indexOf('async function completionTerminalInvoiceLookup')));
    expect(fn).not.toMatch(/source_estimate_id|first_visit|findFirstApplicationInvoiceForEstimateService/);
  });

  test('own-visit REFUNDED first-application invoice: the sibling fallback cannot resurrect it — no payUrl, alert path instead (chain simulation)', async () => {
    // Simulate the route's chain with the same helpers and the same order
    // the source contract pins: direct suppressors → own-visit terminal →
    // sibling fallback only if no terminal.
    const { findFirstApplicationInvoiceForEstimateService } = require('../services/estimate-first-application-invoice');
    const refundedOwn = {
      id: 'inv-own', status: 'refunded', scheduled_service_id: 'svc-1', token: 'dead-token', created_at: '2026-08-20',
      title: 'WaveGuard Membership Setup + First Application',
      notes: 'Auto-generated from accepted estimate #est-1. Customer selected pay per application - $99 setup fee plus first application.',
    };
    const rows = [refundedOwn];
    const chain = {
      where: jest.fn((arg) => { if (typeof arg === 'function') arg({ orWhere: () => ({ orWhere: () => {} }) }); return chain; }),
      whereIn: jest.fn(() => chain),
      whereNot: jest.fn(() => chain),
      whereNotIn: jest.fn(() => chain),
      join: jest.fn(() => chain),
      orderBy: jest.fn(() => chain),
      first: jest.fn(async () => undefined),
      select: jest.fn(async () => rows),
    };
    // Suppressor: refunded row excluded → null. Terminal: found.
    chain.first
      .mockResolvedValueOnce(undefined) // suppressor by service_record_id
      .mockResolvedValueOnce(undefined) // suppressor by scheduled_service_id
      .mockResolvedValueOnce({ id: 'inv-own', invoice_number: 'WPC-9', status: 'refunded', created_at: '2026-08-20' }); // terminal lookup
    const knex = jest.fn(() => chain);
    const svc = { id: 'svc-1', customer_id: 'customer-1', source_estimate_id: 'est-1', scheduled_date: '2026-06-08' };

    let existing = await completionSuppressorInvoiceLookup(knex, { service_record_id: 'rec-1' });
    if (!existing) existing = await completionSuppressorInvoiceLookup(knex, { scheduled_service_id: svc.id });
    const refundedOnVisit = await completionTerminalInvoiceLookup(knex, { serviceRecordId: 'rec-1', scheduledServiceId: svc.id });
    let terminal;
    ({ existing, terminal } = reconcileLiveVsRefunded(existing, refundedOnVisit));
    if (!existing && !terminal) existing = await findFirstApplicationInvoiceForEstimateService(svc, knex);

    expect(existing).toBeFalsy();
    expect(terminal).toEqual({ id: 'inv-own', invoice_number: 'WPC-9', status: 'refunded', created_at: '2026-08-20' });
    // The sibling fallback never ran, so its dead token can't become a pay link.
    expect(chain.join).not.toHaveBeenCalled();
    expect(chain.select).not.toHaveBeenCalled();
    // And with a terminal invoice the decision suppresses (alert path).
    expect(shouldAutoInvoiceCompletion({
      recapReviewOnly: false, alreadyPaid: false, prepaidCovered: false, autopayCoversVisit: false,
      preMintedInvoice: null, existingCompletionInvoice: existing, terminalInvoiceOnVisit: !!terminal,
      createInvoiceOnComplete: true, hasVisitPrice: true, invoiceAmount: 120, serviceType: 'Pest Control', isCallback: false,
    })).toBe(false);
    // Sanity: WITHOUT the reorder the sibling fallback WOULD return the refunded own row.
    await expect(findFirstApplicationInvoiceForEstimateService(svc, knex)).resolves.toBe(refundedOwn);
  });

  test('a REFUNDED sibling first-application row is routed to the manual path; a canceled sibling is dropped from reuse and the mint proceeds (splitTerminalCompletionInvoice)', () => {
    const refundedSibling = { id: 'inv-sib', invoice_number: 'WPC-7', status: 'refunded', token: 'dead', scheduled_service_id: 'sibling-visit' };
    expect(splitTerminalCompletionInvoice(refundedSibling)).toEqual({ existing: null, terminal: { id: 'inv-sib', invoice_number: 'WPC-7', status: 'refunded' } });
    for (const status of ['canceled', 'cancelled', 'void']) {
      expect(splitTerminalCompletionInvoice({ ...refundedSibling, status })).toEqual({ existing: null, terminal: null });
    }
    const live = { id: 'inv-live', status: 'sent', token: 't' };
    expect(splitTerminalCompletionInvoice(live)).toEqual({ existing: live, terminal: null });
    expect(splitTerminalCompletionInvoice(null)).toEqual({ existing: null, terminal: null });
    // Wired right after the sibling lookup, before anything reads the row.
    const at = src.indexOf('existingCompletionInvoice = await findFirstApplicationInvoiceForEstimateService(svc, db);');
    expect(src.slice(at, at + 400)).toContain('const split = splitTerminalCompletionInvoice(existingCompletionInvoice);');
    expect(src.slice(at, at + 400)).toContain('existingCompletionInvoice = split.existing;');
    expect(src.slice(at, at + 400)).toContain('if (split.terminal) terminalCompletionInvoice = split.terminal;');
  });

  test('alert failure fails CLOSED: attempt released for resume + 503, after the record commit and before the attempt is marked succeeded', () => {
    const at = src.indexOf("const dedupeKey = `terminal_invoice_manual_billing:${svc.id}`;");
    const block = src.slice(at, at + 3200);
    expect(block).toContain("if (!created) throw new Error('manual-billing notification insert failed');");
    expect(block).toContain('if (!manualBillingAlerted) {');
    expect(block).toContain('await CompletionAttempts.releaseCompletionAttemptForResume(completionAttempt, alertErr);');
    expect(block).toContain("code: 'terminal_invoice_manual_billing_alert_failed',");
    expect(block).toMatch(/return res\.status\(503\)\.json\(\{/);
    // No swallow: the only catch feeds the fail-closed branch.
    expect(block).not.toMatch(/catch \(e\) \{ logger\.warn\(`\[dispatch\] terminal-invoice/);
    // Position: the service_record is already durable, the attempt not yet finalized.
    const committedAt = src.lastIndexOf('durableCompletionCommitted = true;', at);
    const succeededAt = src.indexOf('markedSucceeded = true;', at);
    expect(committedAt).toBeGreaterThan(-1);
    expect(succeededAt).toBeGreaterThan(at);
    // Same release + 503 shape as the typed-required mint failure.
    expect(src).toContain("code: 'backfill_invoice_mint_failed',");
  });

  test('reconcileLiveVsRefunded: a NEWER refunded invoice beats an older live row (no dead-or-stale pay link); an older refunded one is history', () => {
    const live = { id: 'inv-live', status: 'sent', token: 't', created_at: '2026-08-01T00:00:00Z' };
    const refundedNewer = { id: 'inv-ref', status: 'refunded', created_at: '2026-08-20T00:00:00Z' };
    const refundedOlder = { id: 'inv-ref-old', status: 'refunded', created_at: '2026-07-01T00:00:00Z' };
    expect(reconcileLiveVsRefunded(live, refundedNewer)).toEqual({ existing: null, terminal: refundedNewer });
    expect(reconcileLiveVsRefunded(live, refundedOlder)).toEqual({ existing: live, terminal: null });
    // Ties (same created_at — e.g. minted in one transaction) go to the refunded row.
    const refundedTie = { id: 'inv-ref-tie', status: 'refunded', created_at: '2026-08-01T00:00:00Z' };
    expect(reconcileLiveVsRefunded(live, refundedTie)).toEqual({ existing: null, terminal: refundedTie });
    expect(reconcileLiveVsRefunded(null, refundedNewer)).toEqual({ existing: null, terminal: refundedNewer });
    // The chain may hand back an OLDER live row (service_record_id first)
    // while a NEWER live row hangs off scheduled_service_id — compare the
    // refund against the NEWEST live row, not the chain's row.
    const newestLive = { id: 'inv-live-2', status: 'sent', created_at: '2026-08-25T00:00:00Z' };
    expect(reconcileLiveVsRefunded(live, refundedNewer, newestLive)).toEqual({ existing: live, terminal: null });
    const newestLiveOlderThanRefund = { id: 'inv-live-2', status: 'sent', created_at: '2026-08-10T00:00:00Z' };
    expect(reconcileLiveVsRefunded(live, refundedNewer, newestLiveOlderThanRefund)).toEqual({ existing: null, terminal: refundedNewer });
    expect(reconcileLiveVsRefunded(live, null)).toEqual({ existing: live, terminal: null });
    expect(reconcileLiveVsRefunded(null, null)).toEqual({ existing: null, terminal: null });
  });

  test('the pre-minted lookup cannot resurrect the older live row once the refunded invoice won', () => {
    const at = src.indexOf("preMintedInvoice = await completionSuppressorInvoiceLookup(db, { scheduled_service_id: svc.id });");
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, at + 600)).toContain('if (terminalCompletionInvoice) preMintedInvoice = null;');
  });

  test('the terminal invoice is NEVER reused as the completion invoice / pay link', () => {
    expect(src).not.toMatch(/invoice = terminalCompletionInvoice/);
    expect(src).not.toMatch(/terminalCompletionInvoice\.token/);
    expect(src).not.toMatch(/payUrl = [^;]*terminalCompletionInvoice/);
    expect(src).not.toMatch(/invoiceCreated = true;[^\n]*terminal/);
  });

  test('it feeds shouldAutoInvoiceCompletion as terminalInvoiceOnVisit and the helper treats it as a suppressor', () => {
    expect(src).toContain('terminalInvoiceOnVisit: !!terminalCompletionInvoice,');
    const gateAt = src.indexOf('|| preMintedInvoice || existingCompletionInvoice) {');
    const terminalAt = src.indexOf('if (terminalInvoiceOnVisit) return false;');
    const governAt = src.indexOf('if (backfillMintRequired === true) return true;');
    expect(gateAt).toBeGreaterThan(-1);
    expect(terminalAt).toBeGreaterThan(gateAt);
    // Above the governed REQUIRED posture: a frozen required mint must not
    // cut a replacement beside a refundable invoice either.
    expect(governAt).toBeGreaterThan(terminalAt);
  });

  test('the manual-billing alert rides the existing admin notification mechanism (notifyAdmin, billing, bell, deduped per visit)', () => {
    const at = src.indexOf("const dedupeKey = `terminal_invoice_manual_billing:${svc.id}`;");
    expect(at).toBeGreaterThan(-1);
    const block = src.slice(at - 1600, at + 1800);
    expect(block).toContain('if (terminalCompletionInvoice && !shouldInvoice && !recapReviewOnly');
    expect(block).toContain('&& !alreadyPaid && !prepaidCovered && !autopayCoversVisit && !preMintedInvoice && !existingCompletionInvoice');
    expect(block).toContain("require('../services/notification-service').notifyAdmin(");
    expect(block).toContain("'billing',");
    expect(block).toContain('Completed visit needs manual billing — prior invoice was refunded');
    expect(block).toContain('bell: true');
    expect(block).toMatch(/whereRaw\("metadata->>'dedupeKey' = \?", \[dedupeKey\]\)/);
    // Same mechanism as the dues-covered alert (not a parallel one).
    expect(src).toContain("const dedupeKey = `dues_covered_priced_series:${svc.recurring_parent_id || svc.id}`;");
  });

  test('the alert fires only when the refunded invoice is the DECIDING suppressor — the guard re-asks the same gate with the terminal flag cleared', () => {
    const at = src.indexOf('if (terminalCompletionInvoice && !shouldInvoice && !recapReviewOnly');
    expect(at).toBeGreaterThan(-1);
    const guard = src.slice(at, at + 500);
    expect(guard).toContain('&& shouldAutoInvoiceCompletion({ ...completionInvoiceGateInput, terminalInvoiceOnVisit: false })) {');
    // The re-ask reads the SAME hoisted input the route's decision read —
    // not a second hand-built derivation that could drift.
    expect(src).toContain('const shouldInvoice = shouldAutoInvoiceCompletion(completionInvoiceGateInput);');
    // Semantics: a visit that would not invoice even WITHOUT the refunded
    // row (no scheduler flag, no tier/lane, gate off — nothing triggers
    // billing) owes nothing — no bell, no exposure to the alert-failure 503.
    const owesNothing = {
      recapReviewOnly: false, alreadyPaid: false, prepaidCovered: false, autopayCoversVisit: false,
      preMintedInvoice: null, existingCompletionInvoice: null, terminalInvoiceOnVisit: false,
      createInvoiceOnComplete: false, waveguardTier: null, autoInvoicePricedVisits: false,
      hasVisitPrice: true, invoiceAmount: 120, serviceType: 'Pest Control', isCallback: false,
    };
    expect(shouldAutoInvoiceCompletion(owesNothing)).toBe(false); // deciding reason ≠ refund → guard skips the alert
    expect(shouldAutoInvoiceCompletion({ ...owesNothing, createInvoiceOnComplete: true })).toBe(true); // refund IS deciding → alert parks
  });

  test('the manual-billing flag flips only from the transaction\'s RESOLVED value — a failed COMMIT cannot leave it true', () => {
    const at = src.indexOf("const dedupeKey = `terminal_invoice_manual_billing:${svc.id}`;");
    const block = src.slice(at, at + 3600);
    expect(block).toContain('manualBillingAlerted = true === await db.transaction(async (trx) => {');
    // No assignment inside the callback: success is signalled by returning
    // true, which only reaches the flag after the commit resolves.
    const cb = block.slice(block.indexOf('db.transaction'), block.indexOf('} catch (e) {'));
    expect(cb).not.toContain('manualBillingAlerted = true;');
    expect(cb).toContain('if (already) return true;');
    expect(cb.trimEnd().endsWith('return true;\n        });')).toBe(true);
  });

  test('the completion SMS pay-link branch requires an invoice the completion created — with none, the report-only template is used', () => {
    expect(src).toContain('} else if (invoiceCreated && payUrl && allowCompletionInvoiceLink) {');
    expect(src).toContain("let body = await renderTemplate('service_complete', {");
  });

  test('the sibling first-application lookup keeps its pre-PR void-only filter (a refunded sibling still suppresses)', () => {
    const sibling = fs.readFileSync(path.join(__dirname, '..', 'services', 'estimate-first-application-invoice.js'), 'utf8');
    expect(sibling).toContain(".whereNot('i.status', 'void')");
    expect(sibling).not.toContain('CANCELLED_SERVICE_RESOLVED_STATUSES');
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
