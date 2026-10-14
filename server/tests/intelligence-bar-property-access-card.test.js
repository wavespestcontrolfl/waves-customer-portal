// The update_property_access card shows the plan, not the raw request: a
// property code that is the community code is not listed as an effect.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { confirmationDisplayParams } = require('../routes/admin-intelligence-bar');

describe('update_property_access confirmation card', () => {
  test('lists the planned updates and what is not saved, never the dropped field', () => {
    const params = { customer_id: 'c1', property_gate_code: '5550', access_notes: 'Ring twice' };
    const preview = {
      preview: true,
      customer_name: 'Avery Fixture',
      would_update: { access_notes: '(new first line) Ring twice' },
      kept: ['property_gate_code: not saved; that is the community gate code, which the stop card already shows'],
    };
    const shown = confirmationDisplayParams('update_property_access', params, preview);
    expect(shown).toEqual({
      customer: 'Avery Fixture',
      access_notes: '(new first line) Ring twice',
      not_saved_or_changed: preview.kept[0],
    });
    expect(shown).not.toHaveProperty('property_gate_code');
  });
});
