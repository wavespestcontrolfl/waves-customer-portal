/**
 * A customer created from a call on a last name alone (GATE_CALL_FIRST_NAME_ADVISORY)
 * has first_name ''. Every SMS template that opens "Hello {first_name}!" must read
 * "Hello there!" — never "Hello !" and never "Hello null!". Synthetic data only.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => {
  const row = { template_key: 'appointment_confirmation_v2', body: 'Hello {first_name}! Your {service_type} is booked.', is_active: true };
  const db = jest.fn(() => ({ where: () => ({ first: async () => row }) }));
  db.schema = { hasTable: async () => true };
  return db;
});
jest.mock('../services/sms-template-variants', () => ({ selectVariant: async () => null }), { virtual: false });

const router = require('../routes/admin-sms-templates');

describe('getTemplate first_name fallback', () => {
  test.each([['', 'empty string'], [null, 'null'], [undefined, 'undefined'], ['  ', 'blank']])(
    'a %p first_name (%s) renders "there"',
    async (first_name) => {
      const body = await router.getTemplate('appointment_confirmation_v2', { first_name, service_type: 'Pest Control' });
      expect(body).toBe('Hello there! Your Pest Control is booked.');
    },
  );

  test('a real first name is untouched', async () => {
    expect(await router.getTemplate('appointment_confirmation_v2', { first_name: 'Sam', service_type: 'Pest Control' }))
      .toBe('Hello Sam! Your Pest Control is booked.');
  });
});
