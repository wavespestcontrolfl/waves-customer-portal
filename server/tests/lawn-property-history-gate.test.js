jest.mock('../services/lawn-assessment-history', () => ({ installedForVisit: jest.fn() }));
const history = require('../services/lawn-assessment-history');
const { loadLinkedLawnAssessment } = require('../services/service-report/report-data');
const gates = require('../config/feature-gates');

test('a runtime gate change switches the reader without changing the registered boolean', async () => {
  const original = process.env.GATE_LAWN_PROPERTY_HISTORY;
  const registered = gates.isEnabled('lawnPropertyHistory');
  const row = { id: 'legacy-assessment' };
  const chain = { where: jest.fn(), orderBy: jest.fn(), first: jest.fn().mockResolvedValue(row) };
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  const knex = jest.fn(() => chain);
  const service = { id: 'record-a', customer_id: 'customer-a', scheduled_service_id: 'visit-a' };
  try {
    delete process.env.GATE_LAWN_PROPERTY_HISTORY;
    expect(await loadLinkedLawnAssessment(service, knex)).toEqual(row);
    expect(chain.where).toHaveBeenCalledWith({ customer_id: 'customer-a', confirmed_by_tech: true, service_record_id: 'record-a' });
    expect(chain.orderBy.mock.calls).toEqual([['confirmed_at', 'desc'], ['created_at', 'desc']]);
    history.installedForVisit.mockResolvedValue({ id: 'scoped-assessment' });
    process.env.GATE_LAWN_PROPERTY_HISTORY = 'true';
    expect(await loadLinkedLawnAssessment(service, knex)).toEqual({ id: 'scoped-assessment' });
    expect(history.installedForVisit).toHaveBeenCalledWith({ customerId: 'customer-a', serviceRecordId: 'record-a', serviceId: 'visit-a' }, knex);
    expect(gates.isEnabled('lawnPropertyHistory')).toBe(registered);
    process.env.GATE_LAWN_PROPERTY_HISTORY = 'false';
    expect(await loadLinkedLawnAssessment(service, knex)).toEqual(row);
  } finally {
    if (original === undefined) delete process.env.GATE_LAWN_PROPERTY_HISTORY;
    else process.env.GATE_LAWN_PROPERTY_HISTORY = original;
  }
});

test('delivery lookup errors propagate while a rendering caller may degrade', async () => {
  history.installedForVisit.mockRejectedValue(new Error('fixture unavailable'));
  const service = { id: 'record-a', customer_id: 'customer-a' };
  await expect(loadLinkedLawnAssessment(service, jest.fn(), { propertyHistoryEnabled: true, failClosed: true })).rejects.toThrow('fixture unavailable');
  await expect(loadLinkedLawnAssessment(service, jest.fn(), { propertyHistoryEnabled: true })).resolves.toBeNull();
});
