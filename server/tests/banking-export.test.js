const BankingExport = require('../services/banking-export');

describe('banking export', () => {
  test('CSV treats payout amount as the net bank deposit', () => {
    const csv = BankingExport.generateCSV([
      {
        id: 'local-payout-1',
        stripe_payout_id: 'po_123',
        amount: '100.00',
        fee_total: '3.25',
        status: 'paid',
        arrival_date: '2026-05-10T14:00:00.000Z',
        method: 'standard',
        transaction_count: 2,
        bank_name: 'Capital One',
        reconciled: true,
      },
    ], []);

    expect(csv.content).toContain('po_123,100.00,3.25,100.00,paid,2026-05-10');
    expect(csv.content).toContain('TOTAL,100.00,3.25,100.00');
  });
});
