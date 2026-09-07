const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { etDateString } = require('../utils/datetime-et');

// Exercise the private reader without booting the converter's external services.
const source = fs.readFileSync(path.join(__dirname, '../services/estimate-converter.js'), 'utf8');
const start = source.indexOf('async function verifyAcceptedRecurringSchedule(');
const end = source.indexOf('// The pattern seedRecurringFollowUpsForParent', start);

test('retained coverage excludes prior-term visits using the selected Eastern acceptance day', async () => {
  const estimate = { id: 'estimate-new', customer_id: 'customer-1', accepted_at: new Date('2026-07-02T02:00:00Z') };
  const visits = [
    { id: 'old', recurring_parent_id: 'root', source_estimate_id: 'estimate-old', scheduled_date: '2026-06-30', status: 'completed' },
    { id: 'current', recurring_parent_id: 'root', source_estimate_id: 'estimate-old', scheduled_date: '2026-07-01', status: 'completed' },
    { id: 'future', recurring_parent_id: 'root', source_estimate_id: 'estimate-old', scheduled_date: '2026-08-01', status: 'pending' },
  ];
  const classify = jest.fn(() => [{ serviceFamily: 'pest', recordedVisits: 2, expectedVisits: 12 }]);
  const insert = jest.fn(async () => []);
  const database = (table) => {
    let columns;
    const query = {
      where: () => query,
      leftJoin: () => query,
      select: (...selected) => { columns = selected; return query; },
      first: async () => Object.fromEntries(columns.map((column) => [column, estimate[column]])),
      insert,
      then: (resolve, reject) => Promise.resolve(table === 'activity_log'
        ? [{ metadata: { estimateId: estimate.id, existingParentId: 'root' } }]
        : visits).then(resolve, reject),
    };
    return query;
  };
  const verify = vm.runInNewContext(`${source.slice(start, end)}; verifyAcceptedRecurringSchedule`, {
    etDateString,
    require: () => ({ acceptedScheduleFindings: classify, formatDateOnly: (value) => value || null }),
    logger: { warn: jest.fn(), error: jest.fn() },
  });
  const result = await verify(database, { estimateId: estimate.id, customerId: estimate.customer_id });
  expect(classify.mock.calls[0][1].map((visit) => visit.id)).toEqual(['current', 'future']);
  expect(result.ok).toBe(false);
  expect(insert).toHaveBeenCalledWith(expect.objectContaining({ action: 'recurring_schedule_missing_followups' }));
});
