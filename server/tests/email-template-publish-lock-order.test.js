/**
 * publishVersion takes the email_templates row lock before touching any
 * email_template_versions row. The copy-audit migrations (20260926120100,
 * 20260926120300 and their down paths) CAS the template row first and then
 * archive a version. An admin publish that locked versions first could
 * deadlock against a deploy's migration on the same template (pre-push
 * audit P1, #4874).
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/sendgrid-mail', () => ({ newsletterGroupId: jest.fn(), serviceGroupId: jest.fn(), sendOne: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({})) }));

const db = require('../models/db');
const EmailTemplates = require('../services/email-template-library');

test('publishVersion locks the template row, then archives/activates versions, then repoints the template', async () => {
  const version = {
    id: 'v2', template_id: 't1', subject: 'Your visit', preview_text: '', text_body: '', blocks: [],
    template: { id: 't1', allowed_variables: [], required_variables: [] },
  };
  const load = {};
  ['join', 'where', 'select'].forEach((m) => { load[m] = jest.fn(() => load); });
  load.first = jest.fn(async () => version);
  db.mockImplementation(() => load);
  db.raw = jest.fn(() => 'raw');

  const ops = [];
  const trx = jest.fn((table) => {
    const q = {};
    q.where = jest.fn(() => q);
    q.forUpdate = jest.fn(() => { ops.push([table, 'lock']); return q; });
    q.first = jest.fn(async () => ({ id: 't1' }));
    q.update = jest.fn(async () => { ops.push([table, 'update']); return 1; });
    return q;
  });
  db.transaction = jest.fn(async (fn) => fn(trx));

  await expect(EmailTemplates.publishVersion('v2', 'tech-1')).resolves.toMatchObject({ published: true });
  expect(ops).toEqual([
    ['email_templates', 'lock'],
    ['email_template_versions', 'update'],
    ['email_template_versions', 'update'],
    ['email_templates', 'update'],
  ]);
});

// createDraftVersion takes the same template row lock before it reads
// max(version_number) and inserts max + 1 (Codex #4918 r7): unlocked, a
// draft racing a publisher could take the same number, and one side fails
// the (template_id, version_number) unique constraint.
test('createDraftVersion locks the template row, then reads the latest version, then inserts — all in one transaction', async () => {
  const ops = [];
  const trx = jest.fn((table) => {
    const q = {};
    q.where = jest.fn(() => q);
    q.orderBy = jest.fn(() => q);
    q.forUpdate = jest.fn(() => { ops.push([table, 'lock']); return q; });
    q.first = jest.fn(async () => {
      if (table === 'email_templates') return { id: 't1', name: 'Your visit', active_version_id: null };
      ops.push([table, 'read-latest']);
      return { version_number: 3, subject: 'Your visit', blocks: [] };
    });
    q.insert = jest.fn(() => { ops.push([table, 'insert']); return q; });
    q.returning = jest.fn(async () => [{ id: 'v4', version_number: 4 }]);
    return q;
  });
  db.mockImplementation(() => { throw new Error('createDraftVersion must not query outside its transaction'); });
  db.transaction = jest.fn(async (fn) => fn(trx));

  await expect(EmailTemplates.createDraftVersion('estimate.engage_gone_quiet', 'tech-1')).resolves.toMatchObject({ version_number: 4 });
  expect(db.transaction).toHaveBeenCalledTimes(1);
  expect(ops).toEqual([
    ['email_templates', 'lock'],
    ['email_template_versions', 'read-latest'],
    ['email_template_versions', 'insert'],
  ]);
});
