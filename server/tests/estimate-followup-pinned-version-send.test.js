// What sendTemplate does with a pinned versionId that is no longer the active
// version (an admin published a newer one after the follow-up checked it): the
// pinned version is the one sent. Nothing is lost and the average copy always
// goes out with the template version whose tokens were checked.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const { resolveTemplateForSend } = require('../services/email-template-library');

const builder = (row) => {
  const b = {};
  for (const m of ['join', 'where', 'select']) b[m] = jest.fn(() => b);
  b.first = jest.fn(async () => row);
  return b;
};

describe('sendTemplate resolution with a pinned versionId', () => {
  const template = { id: 't1', template_key: 'estimate.unviewed_followup', status: 'active', active_version_id: 'ver-2' };

  test('an archived (superseded) pinned version is still the one sent', async () => {
    db.raw = jest.fn();
    db.mockImplementation(() => builder({ id: 'ver-1', status: 'archived', template, blocks: [] }));
    const out = await resolveTemplateForSend({ templateKey: 'estimate.unviewed_followup', versionId: 'ver-1' });
    expect(out.version.id).toBe('ver-1');
    expect(out.template.template_key).toBe('estimate.unviewed_followup');
  });

  test('a disabled template still refuses, as for an unpinned send', async () => {
    db.raw = jest.fn();
    db.mockImplementation(() => builder({ id: 'ver-1', status: 'archived', template: { ...template, status: 'archived' }, blocks: [] }));
    await expect(resolveTemplateForSend({ templateKey: 'estimate.unviewed_followup', versionId: 'ver-1' }))
      .rejects.toMatchObject({ code: 'EMAIL_TEMPLATE_DISABLED' });
  });
});
