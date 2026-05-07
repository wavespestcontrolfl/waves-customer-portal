const table = {
  template_key: 'sample_template',
  body: 'Hello {first_name}! Track: {track_url}',
  is_active: true,
};

jest.mock('../models/db', () => {
  const db = jest.fn(() => ({
    where: jest.fn(() => ({
      first: jest.fn(async () => table),
    })),
  }));
  db.schema = { hasTable: jest.fn(async () => true) };
  return db;
});

const smsTemplates = require('../routes/admin-sms-templates');

describe('admin SMS template renderer', () => {
  test('renders supplied variables', async () => {
    const body = await smsTemplates.getTemplate('sample_template', {
      first_name: 'Sam',
      track_url: 'https://portal.wavespestcontrol.com/l/abc23',
    });

    expect(body).toBe('Hello Sam! Track: https://portal.wavespestcontrol.com/l/abc23');
  });

  test('returns null instead of leaking unresolved placeholders', async () => {
    const body = await smsTemplates.getTemplate('sample_template', {
      first_name: 'Sam',
    });

    expect(body).toBeNull();
  });
});
