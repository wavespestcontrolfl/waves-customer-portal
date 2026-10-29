const { NON_PERFORMED_VISIT_OUTCOMES, visitWasPerformed, closeoutPerformedForCharge } = require('../services/visit-outcomes');

describe('closeoutPerformedForCharge (the predicate behind chargeInvoiceWithSavedCard requirePerformedVisit)', () => {
  const record = (notes, status = 'completed') => ({ status, structured_notes: notes });
  const marker = (invoiceId) => ({ visitOutcome: 'completed', backfill: true, invoiceAlreadySent: true, issuedInvoiceCloseout: { invoiceId, trigger: 'sent', completedAt: '2026-10-29T14:00:00.000Z' } });

  test.each([
    ['a completed record with the completed outcome', record({ visitOutcome: 'completed' }), true],
    ['a completed record with no outcome stored', record({}), true],
    ['structured_notes stored as a JSON string', record(JSON.stringify({ visitOutcome: 'completed' })), true],
    ['inspection_only', record({ visitOutcome: 'inspection_only' }), false],
    ['customer_declined', record({ visitOutcome: 'customer_declined' }), false],
    ['incomplete', record({ visitOutcome: 'incomplete' }), false],
    ['a record that is not completed', record({ visitOutcome: 'completed' }, 'in_progress'), false],
    ['no record', null, false],
    ['unparseable notes on a completed record', record('{not json'), true],
    ['a backfill closeout', record({ visitOutcome: 'completed', backfill: true }), false],
    ['a backfill closeout stored as the string true', record({ visitOutcome: 'completed', backfill: 'true' }), false],
    ['an issued-invoice closeout (no option)', record(marker('inv-1')), false],
  ])('%s -> %s without the option', (_label, row, expected) => {
    expect(closeoutPerformedForCharge(row)).toBe(expected);
  });

  test.each([
    ['the marker names this invoice', record(marker('inv-1')), 'inv-1', true],
    ['the marker names this invoice (JSON string notes)', record(JSON.stringify(marker('inv-1'))), 'inv-1', true],
    ['a numeric id compares as text', record(marker(41)), 41, true],
    ['the marker names another invoice', record(marker('inv-2')), 'inv-1', false],
    ['a manual backfill without the marker', record({ visitOutcome: 'completed', backfill: true }), 'inv-1', false],
    ['the marker without an outcome of completed', record({ ...marker('inv-1'), visitOutcome: 'inspection_only' }), 'inv-1', false],
    ['the marker on a record that is not completed', record(marker('inv-1'), 'in_progress'), 'inv-1', false],
    ['a marker with no invoice id', record({ visitOutcome: 'completed', backfill: true, issuedInvoiceCloseout: {} }), 'inv-1', false],
    ['an ordinary performed record', record({ visitOutcome: 'completed' }), 'inv-1', true],
    ['a null option never opens a backfill', record(marker('inv-1')), null, false],
  ])('with issuedCloseoutInvoiceId: %s', (_label, row, invoiceId, expected) => {
    expect(closeoutPerformedForCharge(row, { issuedCloseoutInvoiceId: invoiceId })).toBe(expected);
  });

  test('the existing exports are unchanged', () => {
    expect(NON_PERFORMED_VISIT_OUTCOMES).toEqual(['inspection_only', 'customer_declined']);
    expect(visitWasPerformed('inspection_only')).toBe(false);
    expect(visitWasPerformed('completed')).toBe(true);
  });
});
