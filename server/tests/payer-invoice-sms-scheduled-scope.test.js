// A held payer text (GATE_PAYER_INVOICE_SMS) previews the payer's and customer's names and the service street. The
// scheduled-queue reader (GET /api/admin/communications/scheduled) admits technicians with no customer scope, so it shows
// these rows to the office only, the same rule as queued recruiting texts.
const fs = require('fs');
const path = require('path');

jest.mock('../models/db', () => jest.fn());

const knex = require('knex')({ client: 'pg' });
const { hidePayerHoldsFromNonAdmin } = require('../services/payer-invoice-sms');

const scheduledQuery = (req) => hidePayerHoldsFromNonAdmin(
  knex('sms_log').where({ status: 'scheduled' }), req, 'sms_log.message_type',
).toSQL().toNative();

describe('held payer texts in the scheduled queue', () => {
  test('the office sees every scheduled row', () => {
    const q = scheduledQuery({ techRole: 'admin' });
    expect(q.sql).not.toMatch(/message_type/);
    expect(q.bindings).toEqual(['scheduled']);
  });

  test('a technician never sees a held payer text; rows with no message type stay visible', () => {
    const q = scheduledQuery({ techRole: 'technician', technicianId: 'tech-A' });
    expect(q.sql).toMatch(/\("sms_log"\."message_type" is null or "sms_log"\."message_type" <> \$2\)/);
    expect(q.bindings).toEqual(['scheduled', 'payer_invoice']);
  });

  test('a reader with no staff request is treated as not the office', () => {
    expect(scheduledQuery(null).bindings).toEqual(['scheduled', 'payer_invoice']);
  });

  test('GET /scheduled applies the payer filter next to the recruiting one', () => {
    const src = fs.readFileSync(path.join(__dirname, '../routes/admin-communications.js'), 'utf8');
    const start = src.indexOf("router.get('/scheduled'");
    const handler = src.slice(start, src.indexOf('router.', start + 10));
    expect(handler).toMatch(/hideRecruitingThreadsFromNonAdmin\(q, req, 'sms_log\.message_type'\)/);
    expect(handler).toMatch(/hidePayerHoldsFromNonAdmin\(q, req, 'sms_log\.message_type'\)/);
  });
});
