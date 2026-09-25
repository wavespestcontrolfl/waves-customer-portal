/**
 * enrollNewLeadAutomation (routes/lead-webhook.js) — the new_lead
 * automation enroll call, extracted so it can be unit-tested directly (the
 * surrounding POST handler is not). Runs AFTER leadRecord is resolved (see
 * the call site's comment) and must pass `context: { leadId }` so the
 * consultation-booking email block (dark behind GATE_LEAD_INSPECTION_LINK)
 * has a lead id to stamp onto automation_enrollments.metadata.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/automation-runner', () => ({ enrollCustomer: jest.fn() }));

const { _test } = require('../routes/lead-webhook');
const { enrollNewLeadAutomation } = _test;
const AutomationRunner = require('../services/automation-runner');

describe('enrollNewLeadAutomation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    AutomationRunner.enrollCustomer.mockResolvedValue({ enrolled: true, enrollmentId: 'enr-1' });
  });

  test('enrolls with context.leadId set to the resolved lead record id', async () => {
    await enrollNewLeadAutomation({
      email: 'sam@example.com',
      firstName: 'Sam',
      lastName: 'Lead',
      customerId: 'cust-1',
      leadId: 'lead-123',
    });

    expect(AutomationRunner.enrollCustomer).toHaveBeenCalledWith({
      templateKey: 'new_lead',
      customer: { email: 'sam@example.com', first_name: 'Sam', last_name: 'Lead', id: 'cust-1' },
      context: { leadId: 'lead-123' },
    });
  });

  test('passes context.leadId: null when leadRecord creation failed (never omits the key)', async () => {
    await enrollNewLeadAutomation({ email: 'sam@example.com', firstName: 'Sam', lastName: 'Lead', customerId: 'cust-1', leadId: undefined });

    expect(AutomationRunner.enrollCustomer).toHaveBeenCalledWith(expect.objectContaining({
      context: { leadId: null },
    }));
  });

  test('no email → no-op, never calls enrollCustomer', async () => {
    const result = await enrollNewLeadAutomation({ email: null, firstName: 'Sam', lastName: 'Lead', customerId: 'cust-1', leadId: 'lead-123' });
    expect(result).toBeNull();
    expect(AutomationRunner.enrollCustomer).not.toHaveBeenCalled();
  });

  test('an unlinked customer (no customerId) still enrolls, with id:null', async () => {
    await enrollNewLeadAutomation({ email: 'sam@example.com', firstName: 'Sam', lastName: 'Lead', customerId: null, leadId: 'lead-123' });
    expect(AutomationRunner.enrollCustomer).toHaveBeenCalledWith(expect.objectContaining({
      customer: expect.objectContaining({ id: null }),
      context: { leadId: 'lead-123' },
    }));
  });

  test('returns whatever AutomationRunner.enrollCustomer returns', async () => {
    AutomationRunner.enrollCustomer.mockResolvedValue({ enrolled: false, reason: 'already enrolled' });
    const result = await enrollNewLeadAutomation({ email: 'sam@example.com', firstName: 'Sam', lastName: 'Lead', customerId: 'cust-1', leadId: 'lead-123' });
    expect(result).toEqual({ enrolled: false, reason: 'already enrolled' });
  });
});
