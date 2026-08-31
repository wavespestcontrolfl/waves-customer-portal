/**
 * IB `cancel_plan` (cancel-flow C3) — the admin Cancel plan service behind
 * the #1568 trust boundary:
 *   - unconfirmed → the server preview, zero commits (the write-gate
 *     contract proves zero DB mutations; this pins the service contract)
 *   - confirmed (attached only by /confirm-action) → commitCancelPlan with
 *     the OPERATOR as the actor (route-derived technicianId, never model
 *     input) and the same option mapping the Customer 360 dialog sends
 *   - service errors (gate off, scope, nothing to cancel) come back as tool
 *     errors with their code, never thrown into the model loop
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockPreview = jest.fn();
const mockCommit = jest.fn();
jest.mock('../services/admin-cancellation', () => ({
  previewCancelPlan: (...args) => mockPreview(...args),
  commitCancelPlan: (...args) => mockCommit(...args),
}));

const { TOOLS, executeTool } = require('../services/intelligence-bar/tools');

const CUSTOMER = '00000000-0000-0000-0000-00000000c001';
const PREVIEW = {
  customer: { id: CUSTOMER, name: 'Pat Tester' },
  eligible: true, wholeAccount: true, scope: [], scopeLabels: [], scopedSupported: null, scopeError: null,
  impact: {
    families: [{ key: 'pest_control', label: 'Pest Control', upcomingVisits: 2, nextVisitDate: '2099-01-05' }],
    visitsCancelled: 2, nextVisitCancelled: '2099-01-05', tierBefore: 'Silver', tierAfter: null,
    accountMonthlyBefore: 89, accountMonthlyAfter: 0, openBalance: 0, termiteRental: false,
  },
  effectiveDate: 'now', effectiveOn: '2026-08-31', prepay: null, waiveLateFee: false, sendConfirmation: true,
  confirmationChannels: { sms: true, email: true }, reasonCode: 'price', note: 'too expensive',
};

beforeEach(() => {
  mockPreview.mockReset().mockResolvedValue(PREVIEW);
  mockCommit.mockReset();
});

describe('cancel_plan tool schema', () => {
  test('is registered with a uuid customer_id, no confirmed property, and the option enums', () => {
    const tool = TOOLS.find((t) => t.name === 'cancel_plan');
    expect(tool).toBeDefined();
    expect(tool.input_schema.properties.customer_id).toEqual(expect.objectContaining({ type: 'string', format: 'uuid' }));
    expect(tool.input_schema.required).toEqual(['customer_id']);
    expect(Object.keys(tool.input_schema.properties)).not.toContain('confirmed');
    expect(tool.input_schema.properties.effective_date.enum).toEqual(['now', 'end_of_coverage']);
    expect(tool.input_schema.properties.prepay_disposition.enum).toEqual(['end_at_term', 'end_now_refund']);
  });
});

describe('cancel_plan unconfirmed', () => {
  test('returns the server preview and never commits', async () => {
    const result = await executeTool('cancel_plan', {
      customer_id: CUSTOMER, families: ['pest_control'], effective_date: 'now', waive_late_fee: true,
      send_confirmation: false, reason_code: 'price', note: 'too expensive',
    }, { technicianId: 'admin-1', isAdmin: true });
    expect(mockCommit).not.toHaveBeenCalled();
    expect(mockPreview).toHaveBeenCalledWith({
      customerId: CUSTOMER, families: ['pest_control'], effectiveDate: 'now', prepayDisposition: null,
      waiveLateFee: true, sendConfirmation: false, reasonCode: 'price', note: 'too expensive',
    });
    expect(result).toEqual(expect.objectContaining({
      preview: true, customer_id: CUSTOMER, customer_name: 'Pat Tester', eligible: true, whole_account: true,
      visits_to_pull: 2, tier_before: 'Silver', tier_after: null, monthly_before: 89, monthly_after: 0,
      effective_date: 'now', effective_on: '2026-08-31', send_confirmation: true, reason_code: 'price',
    }));
    expect(result.owned_families).toEqual([{ key: 'pest_control', label: 'Pest Control', upcoming_visits: 2, next_visit: '2099-01-05' }]);
    expect(result.success).toBeUndefined();
    expect(result.note_to_operator).toMatch(/PREVIEW ONLY/);
  });

  test('a model-supplied confirmed:true is ignored by the route; the executor only honours the flag /confirm-action attaches — and defaults apply', async () => {
    await executeTool('cancel_plan', { customer_id: CUSTOMER });
    expect(mockPreview).toHaveBeenCalledWith(expect.objectContaining({ families: [], effectiveDate: 'now', waiveLateFee: false, sendConfirmation: true, reasonCode: null, note: '' }));
  });

  test('service refusals surface as tool errors with their code', async () => {
    const err = Object.assign(new Error('Cancel flow V2 is not enabled'), { status: 404, code: 'cancel_flow_v2_off' });
    mockPreview.mockRejectedValueOnce(err);
    expect(await executeTool('cancel_plan', { customer_id: CUSTOMER })).toEqual({ error: 'Cancel flow V2 is not enabled', code: 'cancel_flow_v2_off' });
    expect(await executeTool('cancel_plan', {})).toEqual({ error: 'customer_id is required' });
  });
});

describe('cancel_plan confirmed (server-derived)', () => {
  test('commits with the operator as the ib actor and reports the truthful outcome', async () => {
    mockCommit.mockResolvedValueOnce({
      requestId: 'req-1', caseId: 'case-1', processed: true, visitsPulled: 2, scope: [], remaining: [], tierBefore: 'Silver', tierAfter: null,
      effectiveDate: '2026-08-31', keptThrough: null, lateFeeWaived: false, prepayDisposition: null,
      confirmation: 'sms', confirmationChannels: ['sms', 'email'], confirmationRequested: true, errors: [],
    });
    const result = await executeTool('cancel_plan', { customer_id: CUSTOMER, reason_code: 'price', confirmed: true }, { technicianId: 'admin-1', isAdmin: true, confirmed: true });
    expect(mockCommit).toHaveBeenCalledWith(expect.objectContaining({
      customerId: CUSTOMER, families: [], effectiveDate: 'now', reasonCode: 'price', sendConfirmation: true,
      actor: { type: 'ib', userId: 'admin-1' },
    }));
    expect(result).toEqual(expect.objectContaining({
      success: true, request_id: 'req-1', processed: true, visits_pulled: 2, effective_date: '2026-08-31', confirmation_channels: ['sms', 'email'],
    }));
    expect(result.warning).toBeUndefined();
  });

  test('a partial run carries a warning; a refund outcome is echoed (recorded, never issued here)', async () => {
    mockCommit.mockResolvedValueOnce({
      requestId: 'req-2', processed: false, visitsPulled: 0, scope: [], remaining: [], tierBefore: 'Silver', tierAfter: null,
      effectiveDate: '2026-08-31', lateFeeWaived: false, prepayDisposition: 'end_now_refund',
      refund: { amount: 360, needsManualCalc: false }, confirmationChannels: [], confirmationRequested: false, errors: ['in_progress_visit:s9'],
    });
    const result = await executeTool('cancel_plan', { customer_id: CUSTOMER, effective_date: 'now', prepay_disposition: 'end_now_refund', send_confirmation: false, confirmed: true }, { technicianId: 'admin-1' });
    expect(mockCommit).toHaveBeenCalledWith(expect.objectContaining({ prepayDisposition: 'end_now_refund', sendConfirmation: false }));
    expect(result.processed).toBe(false);
    expect(result.warning).toMatch(/in_progress_visit:s9/);
    expect(result.refund).toEqual({ amount: 360, needsManualCalc: false });
  });

  test('a commit refusal (scope changed under the card) is a tool error with its code', async () => {
    mockCommit.mockRejectedValueOnce(Object.assign(new Error('not attributable'), { status: 409, code: 'scoped_cancellation_unattributed' }));
    const result = await executeTool('cancel_plan', { customer_id: CUSTOMER, families: ['lawn_care'], confirmed: true }, { technicianId: 'admin-1' });
    expect(result).toEqual({ error: 'not attributable', code: 'scoped_cancellation_unattributed' });
  });
});
