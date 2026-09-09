jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/job-status', () => ({ transitionJobStatus: jest.fn() }));
jest.mock('../services/track-transitions', () => ({ markComplete: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/completion-recap', () => ({ generateRecap: jest.fn(), smsRecap: jest.fn() }));
jest.mock('../services/service-completion-profiles', () => ({
  resolveCompletionProfileForScheduledService: jest.fn().mockResolvedValue({ category: 'pest_control' }),
}));

const { buildRecapContext } = require('../services/pest-recap');

function contextDb(visit) {
  return jest.fn((table) => {
    if (!['scheduled_services', 'job_status_history', 'products_catalog', 'service_records'].includes(table)) {
      throw new Error(`Unexpected recap context table: ${table}`);
    }
    const q = {
      where: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue(table === 'scheduled_services' ? visit : null),
      select: jest.fn(() => (table === 'scheduled_services' ? q : Promise.resolve([]))),
    };
    return q;
  });
}

const visit = {
  id: 'visit-example', customer_id: 'customer-example', property_id: 'property-a',
  service_type: 'Quarterly Pest Control', service_id: 'cat-1', scheduled_date: '2026-09-09', status: 'confirmed',
  cust_address_line1: '100 Example Court', cust_address_line2: 'Unit 3',
  cust_city: 'Example City', cust_state: 'FL', cust_zip: '34201',
};

test('recap context exposes the live property and resolved legacy primary address', async () => {
  const result = await buildRecapContext(visit.id, contextDb(visit));
  expect(result.service).toMatchObject({
    propertyId: 'property-a',
    catalogServiceId: 'cat-1',
    address: { line1: '100 Example Court', line2: 'Unit 3', city: 'Example City', state: 'FL', zip: '34201' },
  });
});

test('a same-customer property reassignment returns the new stamped visit address', async () => {
  const changedVisit = {
    ...visit, property_id: 'property-b', service_address_line1: '200 Example Court',
    service_address_city: 'Example City', service_address_state: 'FL', service_address_zip: '34201',
  };
  const before = await buildRecapContext(visit.id, contextDb(visit));
  const after = await buildRecapContext(visit.id, contextDb(changedVisit));
  expect(after.service).toMatchObject({
    propertyId: 'property-b',
    address: { line1: '200 Example Court', line2: null, city: 'Example City', state: 'FL', zip: '34201' },
  });
  expect(after.service.customerId).toBe(before.service.customerId);
  expect(after.service.scheduledDate).toBe(before.service.scheduledDate);
  expect(after.service.serviceType).toBe(before.service.serviceType);
  expect(after.service.address).not.toEqual(before.service.address);
});

test('legacy primary address edits change recap identity without a property id', async () => {
  const before = await buildRecapContext(visit.id, contextDb({ ...visit, property_id: null }));
  const after = await buildRecapContext(visit.id, contextDb({
    ...visit, property_id: null, cust_address_line1: '300 Example Court',
  }));
  expect(before.service.propertyId).toBeNull();
  expect(after.service.propertyId).toBeNull();
  expect(after.service.address.line1).toBe('300 Example Court');
  expect(after.service.address).not.toEqual(before.service.address);
});

test('a visit stamp with an inline unit does not inherit the primary unit', async () => {
  const result = await buildRecapContext(visit.id, contextDb({
    ...visit, service_address_line1: '100 Example Court Unit 5',
  }));
  expect(result.service.address.line1).toBe('100 Example Court Unit 5');
  expect(result.service.address.line2).toBeNull();
});
