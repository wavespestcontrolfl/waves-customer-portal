/**
 * AUDIT REPRO r1-projects-docs-4 — send-with-invoice dry_run (non-WDO) mints a
 * real draft, and a never-sent draft satisfies the project Close billing guard.
 *
 * Both tests assert the EXPECTED behaviour, so on current code they FAIL when the
 * bug is real:
 *  1. resolveProjectCompletionBilling must NOT report `resolved: true` for a
 *     lone `draft` invoice (nothing in the close path sends or charges it).
 *  2. The non-WDO branch of resolveOrCreateProjectInvoice must consult `dryRun`
 *     before InvoiceService.create (the WDO branch does; the non-WDO one never
 *     reads the flag — source-contract check, mirrors admin-projects-guards.test.js).
 */
jest.mock('../services/annual-prepay-renewals', () => ({ annualPrepayCoversVisit: jest.fn(async () => false) }));
jest.mock('../services/payer', () => ({ resolveForInvoice: jest.fn(async () => null) }));

const fs = require('fs');
const path = require('path');

function knexWithInvoice(invoiceRow) {
  const chain = {
    whereNot: jest.fn(() => chain),
    where: jest.fn(() => chain),
    orderBy: jest.fn(() => chain),
    first: jest.fn(async () => invoiceRow),
  };
  return jest.fn(() => chain);
}

function knexWithDraftInvoice() {
  return knexWithInvoice({ id: 'inv-draft-1', status: 'draft', invoice_number: 'WPC-2026-9999', total: '175.00' });
}

describe('r1-projects-docs-4: Close billing guard vs an unsent draft', () => {
  test('a lone draft invoice (never sent) must not count as billing resolved', async () => {
    const { resolveProjectCompletionBilling } = require('../services/project-completion');
    const result = await resolveProjectCompletionBilling({
      scheduledService: { id: 'ss-1', customer_id: 'cust-1', estimated_price: '175.00' },
      customer: {},
      project: { id: 'proj-1', project_type: 'termite_treatment' },
      knex: knexWithDraftInvoice(),
    });
    // Bug: current code returns { required: true, resolved: true, reason: 'invoice_exists', invoice: {status:'draft'} }
    expect(result.required).toBe(true);
    expect(result.resolved).toBe(false);
  });

  // Codex round-1 P1 on the fix: a NET-terms payer invoice accrued to a
  // monthly statement stays 'draft' BY DESIGN (admin-projects.js
  // deliberately suppresses its individual delivery) — that must still
  // count as billing resolved, not get caught by the new unsent-draft guard.
  test('a draft invoice accrued to a payer statement (payer_statement_id set) still counts as resolved', async () => {
    const { resolveProjectCompletionBilling } = require('../services/project-completion');
    const result = await resolveProjectCompletionBilling({
      scheduledService: { id: 'ss-1', customer_id: 'cust-1', estimated_price: '175.00' },
      customer: {},
      project: { id: 'proj-1', project_type: 'termite_treatment' },
      knex: knexWithInvoice({
        id: 'inv-accrued-1', status: 'draft', invoice_number: 'WPC-2026-9998', total: '175.00',
        payer_statement_id: 'stmt-1',
      }),
    });
    expect(result.required).toBe(true);
    expect(result.resolved).toBe(true);
    expect(result.reason).toBe('invoice_exists');
  });

  // Codex round-1 P1: the delivered/settled allowlist must reuse
  // closeout-status.js's canonical INVOICE_DELIVERED_STATUSES vocabulary,
  // which includes 'partially_paid' — a customer who received AND paid
  // part of the invoice was clearly shown it and must not be refused a
  // project closeout.
  test('a partially_paid invoice counts as billing resolved', async () => {
    const { resolveProjectCompletionBilling } = require('../services/project-completion');
    const result = await resolveProjectCompletionBilling({
      scheduledService: { id: 'ss-1', customer_id: 'cust-1', estimated_price: '175.00' },
      customer: {},
      project: { id: 'proj-1', project_type: 'termite_treatment' },
      knex: knexWithInvoice({
        id: 'inv-partial-1', status: 'partially_paid', invoice_number: 'WPC-2026-9997', total: '175.00',
      }),
    });
    expect(result.required).toBe(true);
    expect(result.resolved).toBe(true);
    expect(result.reason).toBe('invoice_exists');
  });
});

describe('r1-projects-docs-4: non-WDO dry_run must not mint a real invoice', () => {
  test('non-WDO branch of resolveOrCreateProjectInvoice consults dryRun before InvoiceService.create', () => {
    const src = fs.readFileSync(path.join(__dirname, '../routes/admin-projects.js'), 'utf8');
    const fnStart = src.indexOf('async function resolveOrCreateProjectInvoice(');
    expect(fnStart).toBeGreaterThan(-1);
    const nonWdoStart = src.indexOf('// Non-WDO service reports bill what the visit actually was', fnStart);
    expect(nonWdoStart).toBeGreaterThan(fnStart);
    const createIdx = src.indexOf('const createdNonWdo = await InvoiceService.create(', nonWdoStart);
    expect(createIdx).toBeGreaterThan(nonWdoStart);
    const nonWdoRegion = src.slice(nonWdoStart, createIdx);
    // Strip comments so the "mint the real draft on BOTH the dry-run" prose does not count.
    const code = nonWdoRegion.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).toMatch(/\bdryRun\b/);
  });
});
