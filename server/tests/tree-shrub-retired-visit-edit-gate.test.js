// Codex r17 on #4786: the visit-edit retired-for-sale gate must see every
// line the save ADDS — catalog ids, a changed primary label, and the name of
// an ID-less add-on line (normalizeUpdateDetailsAddons keeps an unresolved
// serviceName and persists it by name alone) — and nothing the visit already
// carries, so a grandfathered visit is never re-checked.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return { ...actual, adminAuthenticate: (_req, _res, next) => next() };
});
jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.transaction = jest.fn();
  return fn;
});
jest.mock('../sockets', () => ({ getIo: jest.fn(() => ({ to: jest.fn(() => ({ emit: jest.fn() })) })) }));

const { retiredGateInputsForVisitEdit } = require('../routes/admin-schedule')._test;

const RETIRED_ID = '11111111-2222-4333-8444-555555555555';
const LIVE_ID = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const current = { customer_id: 'cust-1', service_id: LIVE_ID, service_type: 'Quarterly Pest Control' };

describe('retiredGateInputsForVisitEdit', () => {
  test('an ID-less add-on name new to the visit goes through the gate by name', () => {
    expect(retiredGateInputsForVisitEdit({
      current, currentAddons: [], postedCatalogIds: [LIVE_ID],
      postedAddonNames: ['Quarterly Tree & Shrub'], serviceType: 'Quarterly Pest Control',
    })).toEqual({ serviceIds: [], serviceTypes: ['Quarterly Tree & Shrub'] });
  });

  test('a grandfathered visit that keeps its own lines is never re-checked', () => {
    expect(retiredGateInputsForVisitEdit({
      current,
      currentAddons: [{ service_id: null, service_name: 'Quarterly Tree & Shrub' }, { service_id: RETIRED_ID, service_name: 'Quarterly T&S' }],
      postedCatalogIds: [LIVE_ID, RETIRED_ID],
      postedAddonNames: ['quarterly tree & shrub '],
      serviceType: ' quarterly pest control',
    })).toEqual({ serviceIds: [], serviceTypes: [] });
  });

  test('added catalog ids and a changed primary label are gated too', () => {
    expect(retiredGateInputsForVisitEdit({
      current, currentAddons: [], postedCatalogIds: [RETIRED_ID], postedAddonNames: [], serviceType: 'Quarterly Tree & Shrub Care',
    })).toEqual({ serviceIds: [RETIRED_ID], serviceTypes: ['Quarterly Tree & Shrub Care'] });
  });

  test('the route hands ID-less add-on names and the visit\'s current add-on names to the helper', () => {
    const source = require('fs').readFileSync(require.resolve('../routes/admin-schedule'), 'utf8');
    expect(source).toMatch(/\.filter\(\(l\) => l && !l\.serviceId && typeof l\.serviceName === 'string' && l\.serviceName\.trim\(\)\)/);
    expect(source).toMatch(/where\(\{ scheduled_service_id: req\.params\.id \}\)\.select\('service_id', 'service_name'\)/);
    expect(source).toMatch(/retiredGateInputsForVisitEdit\(\{ current, currentAddons, postedCatalogIds, postedAddonNames, serviceType \}\)/);
  });
});
