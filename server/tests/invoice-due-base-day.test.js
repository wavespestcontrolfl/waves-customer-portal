/**
 * Audit fix 7 (owner 2026-11-01, "fix all"): a Net-term proposal bill is dated from the visit day, never before today, on
 * BOTH mints. The single-visit completion always did that (invoiceDueBaseDay); the combined-visit packet mint passed the raw
 * visit date, so a combined visit closed 40 days late on Net 30 was born 10 days overdue. Both now import the one function.
 * The packet's database proof is in visit-completion-packets-postgres.test.js.
 */
const fs = require('fs');
const path = require('path');
const { invoiceDueBaseDay, serviceDateOnly } = require('../utils/invoice-due-base-day');
const { proposalTermsDueDate } = require('../services/proposal-win');

describe('invoiceDueBaseDay', () => {
  test('a past visit day counts from today; today and a future day are unchanged', () => {
    expect(invoiceDueBaseDay('2026-09-20', '2026-11-01')).toBe('2026-11-01');
    expect(invoiceDueBaseDay('2026-11-01', '2026-11-01')).toBe('2026-11-01');
    expect(invoiceDueBaseDay('2026-11-09', '2026-11-01')).toBe('2026-11-09');
  });

  test('a Date and a timestamp string read as their calendar day; no value reads as today', () => {
    expect(serviceDateOnly(new Date('2026-10-04T00:00:00Z'))).toBe('2026-10-04');
    expect(serviceDateOnly('2026-10-04T13:00:00.000Z')).toBe('2026-10-04');
    expect(invoiceDueBaseDay(null, '2026-11-01')).toBe('2026-11-01');
  });
});

describe('the Net term counts from that base on the packet mint', () => {
  const estimate = {
    status: 'accepted', bill_by_invoice: true,
    estimate_data: { proposal: {
      enabled: true, taxRate: 0, buildings: [{ name: 'Main', lineItems: [{ description: 'Quarterly pest', quantity: 1, unitPrice: 300, frequency: 'quarterly', amount: 300 }] }],
      commercialTerms: { paymentTerms: 'net30' },
    } },
  };
  const conn = () => () => ({ where: () => ({ first: async () => estimate }) });

  test('a visit closed 40 days late is due 30 days from today; a future visit keeps its own day', async () => {
    expect(await proposalTermsDueDate(conn(), 'est-1', invoiceDueBaseDay('2026-09-22', '2026-11-01'))).toBe('2026-12-01');
    expect(await proposalTermsDueDate(conn(), 'est-1', invoiceDueBaseDay('2026-11-05', '2026-11-01'))).toBe('2026-12-05');
  });

  test('both mints import the one function; the packet passes its visit day through it (source pin)', () => {
    const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
    const packet = read('../services/visit-completion-invoice.js');
    const single = read('../services/complete-scheduled-service.js');
    expect(packet).toContain("const { invoiceDueBaseDay } = require('../utils/invoice-due-base-day');");
    expect(packet).toContain('proposalTermsDueDate(trx, sourceEstimateId, invoiceDueBaseDay(visit.scheduled_date))');
    expect(single).toContain("const { serviceDateOnly, invoiceDueBaseDay } = require('../utils/invoice-due-base-day');");
    expect(single).not.toMatch(/^function invoiceDueBaseDay/m);
  });
});
