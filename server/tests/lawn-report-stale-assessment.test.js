const { loadLinkedLawnAssessment } = require('../services/service-report/report-data');

// Fake knex that records each .where() criteria and resolves .first() based on
// which linkage the query targets, so we can assert exactly which queries run.
function fakeKnex({ recordRow = null, serviceRow = null, customerWideRow = null }) {
  const calls = [];
  const knex = () => {
    let criteria = null;
    const builder = {
      where(c) { criteria = c; calls.push(c); return builder; },
      orderBy() { return builder; },
      first() {
        let row = null;
        if (criteria && 'service_record_id' in criteria) row = recordRow;
        else if (criteria && 'service_id' in criteria) row = serviceRow;
        else row = customerWideRow; // would only fire if a customer-wide query ran
        return Promise.resolve(row);
      },
      catch() { return builder.first(); },
    };
    return builder;
  };
  knex._calls = calls;
  return knex;
}

describe('loadLinkedLawnAssessment — show-nothing for visits without their own assessment', () => {
  const service = { customer_id: 'cust-1', id: 'rec-1', scheduled_service_id: 'sched-1' };

  test('returns the assessment linked to THIS service record', async () => {
    const knex = fakeKnex({ recordRow: { id: 'a-record' } });
    expect(await loadLinkedLawnAssessment(service, knex)).toEqual({ id: 'a-record' });
  });

  test('falls back to the assessment linked to THIS scheduled service', async () => {
    const knex = fakeKnex({ recordRow: null, serviceRow: { id: 'a-service' } });
    expect(await loadLinkedLawnAssessment(service, knex)).toEqual({ id: 'a-service' });
  });

  test('returns null (shows nothing) when no assessment is linked to this visit — even if the customer has a recent one', async () => {
    const knex = fakeKnex({ recordRow: null, serviceRow: null, customerWideRow: { id: 'stale-other-visit' } });
    expect(await loadLinkedLawnAssessment(service, knex)).toBeNull();
    // The customer-wide fallback must never be queried: every query is scoped
    // to this visit (carries service_record_id or service_id).
    const customerWideQueried = knex._calls.some(
      (c) => !('service_record_id' in c) && !('service_id' in c)
    );
    expect(customerWideQueried).toBe(false);
  });

  test('returns null with no customer_id', async () => {
    const knex = fakeKnex({ recordRow: { id: 'x' } });
    expect(await loadLinkedLawnAssessment({}, knex)).toBeNull();
  });
});
