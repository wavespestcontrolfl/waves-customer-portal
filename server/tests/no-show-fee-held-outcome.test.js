// B10 (Codex #5394 P2): a no-show fee refused by a collections DISPUTE hold
// never reached Stripe. It is the definite no-charge 'held' outcome, not
// 'review' (Stripe may have accepted it). The customer gets the ordinary
// no-show notice with no fee/receipt wording; the office gets an
// informational note, not a decline/parked alert.

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
const mockNotifyAdmin = jest.fn().mockResolvedValue({});
jest.mock('../services/notification-service', () => ({ notifyAdmin: (...a) => mockNotifyAdmin(...a) }));
const mockHoldFee = jest.fn();
jest.mock('../services/estimate-card-holds', () => ({ chargeNoShowFee: (...a) => mockHoldFee(...a) }));
const mockApptFee = jest.fn();
jest.mock('../services/appointment-card-request', () => ({ chargeAppointmentNoShowFee: (...a) => mockApptFee(...a) }));
jest.mock('../services/email-template-library', () => ({
  sendTemplate: jest.fn(async () => ({ sent: true, message: { provider_message_id: 'sg-1', sent_at: '2026-06-16T00:00:00.000Z' } })),
}));

const db = require('../models/db');
const EmailTemplates = require('../services/email-template-library');
const AppointmentEmail = require('../services/appointment-email');
const { runNoShowFeeStep } = require('../services/no-show-fee-step');

const svc = { id: 'svc-1', customer_id: 'cust-1' };

beforeEach(() => jest.clearAllMocks());

describe('runNoShowFeeStep', () => {
  test('hold-rail collection_hold is held: informational note, no decline alert, appointment rail untouched', async () => {
    mockHoldFee.mockResolvedValue({ charged: false, reason: 'collection_hold' });
    await expect(runNoShowFeeStep({ svc })).resolves.toBe('held');
    expect(mockApptFee).not.toHaveBeenCalled();
    expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
    const [category, title, body, opts] = mockNotifyAdmin.mock.calls[0];
    expect(category).toBe('billing');
    expect(title).toBe('Billing — decide on a no-show fee held by a dispute');
    expect(body).toMatch(/No-show fee not charged yet — customer has a collections dispute hold; decide after the dispute is resolved/);
    expect(`${title} ${body}`).not.toMatch(/declin|parked|needs review|failed/i);
    expect(opts.link).toBe('/admin/customers?customerId=cust-1');
    // Raised through raiseAdminAlert (docs/admin-notifications.md): structured fields present.
    expect(opts.metadata).toEqual({
      scheduledServiceId: 'svc-1',
      reason: 'fee_held_collections_dispute',
      area: 'Billing',
      severity: 'needs-you',
      subject: { type: 'visit', id: 'svc-1' },
      doneWhen: 'no_show_fee_decided',
      who: 'person',
    });
  });

  test('appointment-rail collection_hold (hold rail saw no hold) is held too', async () => {
    mockHoldFee.mockResolvedValue({ charged: false, reason: 'no_hold' });
    mockApptFee.mockResolvedValue({ charged: false, reason: 'collection_hold' });
    await expect(runNoShowFeeStep({ svc })).resolves.toBe('held');
    expect(mockNotifyAdmin.mock.calls[0][1]).toMatch(/held by a dispute/);
    expect(mockNotifyAdmin.mock.calls[0][3].metadata.reason).toBe('fee_held_collections_dispute');
  });

  test.each([['charge_review'], ['charge_failed']])('%s stays review with the decline/parked alert', async (reason) => {
    mockHoldFee.mockResolvedValue({ charged: false, reason });
    await expect(runNoShowFeeStep({ svc })).resolves.toBe('review');
    expect(mockNotifyAdmin.mock.calls[0][1]).toBe('Billing — review a no-show fee that did not settle');
    expect(mockNotifyAdmin.mock.calls[0][3].metadata.reason).toBe('fee_unsettled');
  });

  test('appointment-rail charge_review stays review', async () => {
    mockHoldFee.mockResolvedValue({ charged: false, reason: 'feature_disabled' });
    mockApptFee.mockResolvedValue({ charged: false, reason: 'charge_review' });
    await expect(runNoShowFeeStep({ svc })).resolves.toBe('review');
  });

  test('charged and none send no alert', async () => {
    mockHoldFee.mockResolvedValueOnce({ charged: true });
    await expect(runNoShowFeeStep({ svc })).resolves.toBe('charged');
    mockHoldFee.mockResolvedValueOnce({ charged: false, reason: 'no_hold' });
    mockApptFee.mockResolvedValueOnce({ charged: false, reason: 'no_request' });
    await expect(runNoShowFeeStep({ svc })).resolves.toBe('none');
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });

  test('a thrown fee step is review with the step-error alert', async () => {
    mockHoldFee.mockRejectedValue(new Error('boom'));
    await expect(runNoShowFeeStep({ svc })).resolves.toBe('review');
    expect(mockNotifyAdmin.mock.calls[0][1]).toBe('Billing — review a no-show fee step that errored');
    expect(mockNotifyAdmin.mock.calls[0][3].metadata.reason).toBe('fee_step_error');
  });

  test('a failing office bell never throws into the status flip', async () => {
    mockHoldFee.mockResolvedValue({ charged: false, reason: 'collection_hold' });
    mockNotifyAdmin.mockRejectedValueOnce(new Error('bell down'));
    await expect(runNoShowFeeStep({ svc })).resolves.toBe('held');
  });
});

test('the dispatch no_show branch hands the fee step to runNoShowFeeStep and passes its outcome on', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../routes/admin-dispatch.js'), 'utf8');
  expect(src).toContain("require('../services/no-show-fee-step').runNoShowFeeStep({ svc })");
  expect(src).toContain('feeOutcome: noShowFeeOutcome');
  expect(src).not.toMatch(/collection_hold'\]\.includes/);
});

describe('no-show email charge line for a held fee', () => {
  function mockDb() {
    db.mockImplementation((table) => {
      if (table === 'customers') {
        return { where: () => ({ select: () => ({ first: async () => ({ id: 'c1', first_name: 'Pat', email: 'pat@example.com', phone: '+19415551234' }) }) }) };
      }
      if (table === 'notification_prefs') return { where: () => ({ first: async () => null }) };
      if (table === 'customer_interactions') return { insert: async () => [1] };
      throw new Error(`unexpected db table ${table}`);
    });
  }
  const line = async (feeOutcome) => {
    mockDb();
    EmailTemplates.sendTemplate.mockClear();
    await AppointmentEmail.sendAppointmentNoShowEmail({ customerId: 'c1', scheduledServiceId: 'ss1', serviceLabel: 'Pest Control', missedWhen: 'today', feeOutcome });
    return EmailTemplates.sendTemplate.mock.calls[0][0].payload.charge_line;
  };

  test('held omits the charge line: no claim about a charge either way, no fee or receipt wording', async () => {
    const held = await line('held');
    expect(held).toBe('');
    expect(held).not.toMatch(/no charge|receipt|fee|charged/i);
    expect(held).not.toBe(await line('none'));
  });

  test('none still says there is no charge', async () => {
    expect(await line('none')).toMatch(/no charge/);
  });

  test('review keeps the cautious receipt copy', async () => {
    expect(await line('review')).toMatch(/emailed receipt/);
  });
});
