jest.mock('../models/db', () => {
  const dbMock = jest.fn();
  dbMock.raw = jest.fn((sql) => ({ __raw: sql }));
  return dbMock;
});
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
const mockReconcile = jest.fn(async () => undefined);
jest.mock('../services/setup-fee-alert-reconcile', () => ({
  reconcileSetupFeeAlertForInvoice: (...args) => mockReconcile(...args),
}));
const mockRetrievePI = jest.fn();
jest.mock('../services/stripe', () => ({
  retrievePaymentIntent: (...args) => mockRetrievePI(...args),
}));
jest.mock('../services/annual-prepay-renewals', () => ({
  ANNUAL_PREPAY_PREPAID_METHOD: 'annual_prepay',
  syncTermForInvoicePayment: jest.fn(async () => undefined),
}));
jest.mock('../services/invoice-followups', () => ({
  resumeSequence: jest.fn(async () => undefined),
  scheduleForInvoice: jest.fn(async () => undefined),
  stopSequence: jest.fn(async () => undefined),
}));

const db = require('../models/db');
const InvoiceService = require('../services/invoice');

function chain({ first, returning } = {}) {
  const q = {};
  q.where = jest.fn(() => q);
  q.whereIn = jest.fn(() => q);
  q.whereRaw = jest.fn(() => q);
  q.whereNull = jest.fn(() => q);
  q.forUpdate = jest.fn(() => q);
  q.update = jest.fn(() => q);
  q.first = jest.fn(async () => first);
  q.returning = jest.fn(async () => returning || []);
  return q;
}

const noRow = () => chain({ first: undefined });

function voidInvoice(overrides = {}) {
  return {
    id: 'inv-1',
    status: 'void',
    invoice_number: 'WPC-2026-1042',
    ...overrides,
  };
}

// Happy-path db() slot order inside unvoidInvoice:
//   load → annual_prepay_terms canonical-link pre-guard → (trx) conditional
//   restore → annual_prepay_terms TOCTOU re-check → payments money guard →
//   active-sequence stop repair → sms_log deferred-send cancel → sms_log
//   in-flight 'sending' fence.
// (No sequence re-arm here: that lives in scheduleForInvoice at resend.)
function mockHappyPath({ restored } = {}) {
  const updateChain = chain({ returning: [restored] });
  const seqStopChain = chain();
  const smsChain = chain();
  const sendingChain = noRow();
  db
    .mockReturnValueOnce(chain({ first: voidInvoice() }))
    .mockReturnValueOnce(noRow()) // pre-guard: no owning annual_prepay_terms row
    .mockReturnValueOnce(updateChain)
    .mockReturnValueOnce(noRow()) // TOCTOU: still no owning term
    .mockReturnValueOnce(noRow()) // fresh-row money guard
    .mockReturnValueOnce(seqStopChain)
    .mockReturnValueOnce(smsChain)
    .mockReturnValueOnce(sendingChain);
  return { updateChain, seqStopChain, smsChain, sendingChain };
}

describe('InvoiceService.unvoidInvoice', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.transaction = jest.fn(async (fn) => fn(db));
  });

  test('restores a voided invoice to draft and clears the archive/session/schedule stamps', async () => {
    const restored = voidInvoice({ status: 'draft' });
    const { updateChain } = mockHappyPath({ restored });

    const result = await InvoiceService.unvoidInvoice('inv-1');

    expect(result).toBe(restored);
    expect(updateChain.where).toHaveBeenCalledWith({ id: 'inv-1', status: 'void' });
    expect(updateChain.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'draft',
        archived_at: null,
        stripe_payment_intent_id: null,
        scheduled_send_at: null,
        scheduled_send_attempts: 0,
        scheduled_send_error: null,
        scheduled_request_review: false,
        scheduled_review_delay_minutes: null,
      }),
    );
    expect(mockReconcile).toHaveBeenCalledWith(restored);
  });

  test('cancels queued deferred pay-link/dunning sms_log rows atomically with the restore (Codex #3493)', async () => {
    const restored = voidInvoice({ status: 'draft' });
    const { smsChain } = mockHappyPath({ restored });

    await InvoiceService.unvoidInvoice('inv-1');

    expect(smsChain.where).toHaveBeenCalledWith({ status: 'scheduled' });
    expect(smsChain.whereRaw).toHaveBeenCalledWith(
      "metadata->>'entry_point' IN ('invoice_send_deferred', 'invoice_followup_deferred')",
    );
    expect(smsChain.whereRaw).toHaveBeenCalledWith("metadata->>'invoice_id' = ?", ['inv-1']);
    expect(smsChain.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'cancelled' }),
    );
  });

  test('applies the missed void-time lifecycle stop to a still-ACTIVE sequence atomically with the restore (Codex #3493 r4)', async () => {
    const restored = voidInvoice({ status: 'draft' });
    const { seqStopChain } = mockHappyPath({ restored });

    await InvoiceService.unvoidInvoice('inv-1');

    expect(seqStopChain.where).toHaveBeenCalledWith({ invoice_id: 'inv-1', status: 'active' });
    expect(seqStopChain.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'stopped',
        stopped_reason: 'invoice_voided',
        stopped_by_admin_id: null,
        next_touch_at: null,
      }),
    );
  });

  test('refuses a conversion-minted annual prepay charge by title — a failed term creation leaves no term row to detect (Codex #3493 r4)', async () => {
    db.mockReturnValueOnce(
      chain({ first: voidInvoice({ title: 'WaveGuard Silver — Annual Prepay (12 months)' }) }),
    ).mockReturnValueOnce(noRow());
    await expect(InvoiceService.unvoidInvoice('inv-1')).rejects.toThrow(
      /this is an annual prepay charge/,
    );
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('refuses while a claimed deferred send is mid-dispatch — the cancel cannot reach a claimed row (Codex #3493 r2)', async () => {
    db
      .mockReturnValueOnce(chain({ first: voidInvoice() }))
      .mockReturnValueOnce(noRow())
      .mockReturnValueOnce(chain({ returning: [voidInvoice({ status: 'draft' })] }))
      .mockReturnValueOnce(noRow())
      .mockReturnValueOnce(noRow())
      .mockReturnValueOnce(chain()) // active-sequence stop repair
      .mockReturnValueOnce(chain())
      .mockReturnValueOnce(chain({ first: { id: 'sms-9' } })); // 'sending' claim present → rollback
    await expect(InvoiceService.unvoidInvoice('inv-1')).rejects.toThrow(
      'Cannot unvoid — a deferred message for this invoice is dispatching right now; retry in a minute',
    );
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  test('refuses an invoice that is not void', async () => {
    db.mockReturnValueOnce(chain({ first: voidInvoice({ status: 'sent' }) }));
    await expect(InvoiceService.unvoidInvoice('inv-1')).rejects.toThrow(
      'Only a voided invoice can be unvoided (current status: sent)',
    );
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test("refuses a term's own prepay invoice via the CANONICAL prepay_invoice_id link, even with a null denormalized stamp (Codex #3493)", async () => {
    db
      .mockReturnValueOnce(chain({ first: voidInvoice({ annual_prepay_term_id: null }) }))
      .mockReturnValueOnce(chain({ first: { id: 'term-1' } }));
    await expect(InvoiceService.unvoidInvoice('inv-1')).rejects.toThrow(/annual prepay term/);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('fails CLOSED when the term link cannot be read (Codex #3493)', async () => {
    const termChain = chain();
    termChain.first = jest.fn(async () => { throw new Error('boom'); });
    db
      .mockReturnValueOnce(chain({ first: voidInvoice() }))
      .mockReturnValueOnce(termChain);
    await expect(InvoiceService.unvoidInvoice('inv-1')).rejects.toThrow(
      'Could not verify the annual prepay term link — refusing to unvoid (boom)',
    );
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('re-checks the term link on the FRESH locked row — a concurrent /annual-prepay stamp rolls the restore back (Codex #3493 r2)', async () => {
    // Stamp landed on the row between the pre-guards and the conditional update.
    db
      .mockReturnValueOnce(chain({ first: voidInvoice() }))
      .mockReturnValueOnce(noRow())
      .mockReturnValueOnce(chain({ returning: [voidInvoice({ status: 'draft', annual_prepay_term_id: 'term-9' })] }));
    await expect(InvoiceService.unvoidInvoice('inv-1')).rejects.toThrow(/annual prepay term/);
    expect(mockReconcile).not.toHaveBeenCalled();

    // Term created concurrently without the denormalized stamp.
    jest.clearAllMocks();
    db.transaction = jest.fn(async (fn) => fn(db));
    db
      .mockReturnValueOnce(chain({ first: voidInvoice() }))
      .mockReturnValueOnce(noRow())
      .mockReturnValueOnce(chain({ returning: [voidInvoice({ status: 'draft' })] }))
      .mockReturnValueOnce(chain({ first: { id: 'term-9' } }));
    await expect(InvoiceService.unvoidInvoice('inv-1')).rejects.toThrow(/annual prepay term/);
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  test('refuses a prepay-switch-superseded invoice — its guarded restore path owns it (Codex #3493)', async () => {
    db
      .mockReturnValueOnce(chain({
        first: voidInvoice({ notes: 'Original invoice\n[prepay-switch-superseded-by:inv-9]' }),
      }))
      .mockReturnValueOnce(noRow());
    await expect(InvoiceService.unvoidInvoice('inv-1')).rejects.toThrow(
      /superseded by an annual prepay switch/,
    );
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('refuses an annual-prepay-term invoice (denormalized stamp)', async () => {
    db.mockReturnValueOnce(chain({ first: voidInvoice({ annual_prepay_term_id: 'term-1' }) }));
    await expect(InvoiceService.unvoidInvoice('inv-1')).rejects.toThrow(/annual prepay term/);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('refuses when the linked service visit is cancelled/rescheduled — its invoices were voided on purpose (Codex #3493 r2)', async () => {
    db
      .mockReturnValueOnce(chain({ first: voidInvoice({ scheduled_service_id: 'svc-1' }) }))
      .mockReturnValueOnce(noRow())
      .mockReturnValueOnce(chain({ first: { id: 'svc-1', status: 'cancelled' } }));
    await expect(InvoiceService.unvoidInvoice('inv-1')).rejects.toThrow(
      'Cannot unvoid — the linked service visit is cancelled; restore or re-book the visit before restoring its invoice',
    );
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('refuses a visit stamped prepaid by an annual term — deterministic stamp check, never the fail-open coverage helper (Codex #3493 r3)', async () => {
    const svc = {
      id: 'svc-1',
      status: 'completed',
      prepaid_method: 'annual_prepay',
      prepaid_amount: 120,
      annual_prepay_term_id: 'term-1',
    };
    db
      .mockReturnValueOnce(chain({ first: voidInvoice({ scheduled_service_id: 'svc-1' }) }))
      .mockReturnValueOnce(noRow())
      .mockReturnValueOnce(chain({ first: svc }));
    await expect(InvoiceService.unvoidInvoice('inv-1')).rejects.toThrow(
      /stamped prepaid by an annual prepay term/,
    );
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('refuses a visit converted to a free re-service — its invoice was retired with the conversion (Codex #3493 r3)', async () => {
    const svc = { id: 'svc-1', status: 'pending', is_callback: true, estimated_price: 0 };
    db
      .mockReturnValueOnce(chain({ first: voidInvoice({ scheduled_service_id: 'svc-1' }) }))
      .mockReturnValueOnce(noRow())
      .mockReturnValueOnce(chain({ first: svc }));
    await expect(InvoiceService.unvoidInvoice('inv-1')).rejects.toThrow(
      /converted to a free re-service/,
    );
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('re-checks the linked visit on the locked row — a cancellation landing mid-restore rolls it back (Codex #3493 r3)', async () => {
    db
      .mockReturnValueOnce(chain({ first: voidInvoice({ scheduled_service_id: 'svc-1' }) }))
      .mockReturnValueOnce(noRow()) // term pre-guard
      .mockReturnValueOnce(chain({ first: { id: 'svc-1', status: 'confirmed' } })) // fast-fail pass: visit live
      .mockReturnValueOnce(chain({ returning: [voidInvoice({ status: 'draft', scheduled_service_id: 'svc-1' })] }))
      .mockReturnValueOnce(noRow()) // TOCTOU term re-check
      .mockReturnValueOnce(noRow()) // money guard
      .mockReturnValueOnce(chain({ first: { id: 'svc-1', status: 'cancelled' } })); // in-trx visit re-check
    await expect(InvoiceService.unvoidInvoice('inv-1')).rejects.toThrow(
      'Cannot unvoid — the linked service visit is cancelled; restore or re-book the visit before restoring its invoice',
    );
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  test('fails CLOSED when the linked service cannot be read (Codex #3493 r2)', async () => {
    const svcChain = chain();
    svcChain.first = jest.fn(async () => { throw new Error('boom'); });
    db
      .mockReturnValueOnce(chain({ first: voidInvoice({ scheduled_service_id: 'svc-1' }) }))
      .mockReturnValueOnce(noRow())
      .mockReturnValueOnce(svcChain);
    await expect(InvoiceService.unvoidInvoice('inv-1')).rejects.toThrow(
      'Could not verify the linked service visit — refusing to unvoid (boom)',
    );
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('refuses when the void returned a deposit credit — the line stays on the invoice but the ledger rows reopened', async () => {
    db
      .mockReturnValueOnce(
        chain({
          first: voidInvoice({
            line_items: JSON.stringify([
              { description: 'Service', quantity: 1, unit_price: 100, amount: 100 },
              { description: 'Deposit credit', quantity: 1, unit_price: -49, amount: -49, category: 'deposit_credit', estimate_id: 'est-1' },
            ]),
          }),
        }),
      )
      .mockReturnValueOnce(noRow());
    await expect(InvoiceService.unvoidInvoice('inv-1')).rejects.toThrow(/Cannot unvoid — the deposit credit/);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('refuses when a payment landed on the voided row (late webhook) — restoring beside collected money double-collects', async () => {
    db
      .mockReturnValueOnce(chain({ first: voidInvoice() }))
      .mockReturnValueOnce(noRow())
      .mockReturnValueOnce(chain({ returning: [voidInvoice({ status: 'draft' })] }))
      .mockReturnValueOnce(noRow())
      .mockReturnValueOnce(chain({ first: { id: 'pay-9' } })); // fresh-row money guard hit → rollback
    await expect(InvoiceService.unvoidInvoice('inv-1')).rejects.toThrow(
      'Cannot unvoid an invoice with payment already applied (payment pay-9)',
    );
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  test('a lost conditional restore (status changed mid-flight) throws instead of committing side effects', async () => {
    db
      .mockReturnValueOnce(chain({ first: voidInvoice() }))
      .mockReturnValueOnce(noRow())
      .mockReturnValueOnce(chain({ returning: [] }));
    await expect(InvoiceService.unvoidInvoice('inv-1')).rejects.toThrow(
      'Invoice status changed while unvoiding — re-check and retry',
    );
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  test('a kept PaymentIntent stamp must verify as canceled before it is cleared; anything live refuses', async () => {
    db
      .mockReturnValueOnce(chain({ first: voidInvoice({ stripe_payment_intent_id: 'pi_1' }) }))
      .mockReturnValueOnce(noRow());
    mockRetrievePI.mockResolvedValueOnce({ status: 'requires_payment_method' });
    await expect(InvoiceService.unvoidInvoice('inv-1')).rejects.toThrow(
      'This invoice still has a live payment session (requires_payment_method); resolve it before unvoiding',
    );

    db
      .mockReturnValueOnce(chain({ first: voidInvoice({ stripe_payment_intent_id: 'pi_1' }) }))
      .mockReturnValueOnce(noRow());
    mockRetrievePI.mockRejectedValueOnce(new Error('boom'));
    await expect(InvoiceService.unvoidInvoice('inv-1')).rejects.toThrow(
      'Open payment session pi_1 could not be verified (boom); resolve it before unvoiding',
    );

    // Verified-canceled proceeds and clears the stamp.
    const restored = voidInvoice({ status: 'draft' });
    db
      .mockReturnValueOnce(chain({ first: voidInvoice({ stripe_payment_intent_id: 'pi_1' }) }))
      .mockReturnValueOnce(noRow())
      .mockReturnValueOnce(chain({ returning: [restored] }))
      .mockReturnValueOnce(noRow())
      .mockReturnValueOnce(noRow())
      .mockReturnValueOnce(chain()) // active-sequence stop repair
      .mockReturnValueOnce(chain())
      .mockReturnValueOnce(noRow());
    mockRetrievePI.mockResolvedValueOnce({ status: 'canceled' });
    await expect(InvoiceService.unvoidInvoice('inv-1')).resolves.toBe(restored);
  });

  test('refuses a voided line on a finalized payer statement (frozen total)', async () => {
    db
      .mockReturnValueOnce(chain({ first: voidInvoice({ payer_statement_id: 'stmt-1' }) }))
      .mockReturnValueOnce(noRow())
      .mockReturnValueOnce(chain({ first: { status: 'finalized' } }));
    await expect(InvoiceService.unvoidInvoice('inv-1')).rejects.toThrow(/finalized payer statement/);
    expect(db.transaction).not.toHaveBeenCalled();
  });
});
