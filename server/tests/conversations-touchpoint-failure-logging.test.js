// The unified-messages dual write (conversations.recordTouchpoint) swallows its own failure: it must log the driver code only.
// Its insert binds the message body and the phone, and a knex message and its stack carry both.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const db = require('../models/db');
const logger = require('../services/logger');
const conversations = require('../services/conversations');

test('a failed touchpoint write logs a code, never the body, the short link or the phone', async () => {
  const body = 'Pat is on the way. Track live: https://portal.wavespestcontrol.com/l/abcdefghjk';
  const boom = Object.assign(new Error(`insert into "messages" ("body", "contact_phone") values ('${body}', '+19415550123') - connection terminated`), { code: '57P01' });
  db.mockImplementation(() => { throw boom; });
  db.transaction = jest.fn(async () => { throw boom; });
  const result = await conversations.recordTouchpoint({
    customerId: 'cust-1', channel: 'sms', ourEndpointId: '+19413180000', contactPhone: '+19415550123',
    direction: 'outbound', body, authorType: 'system', twilioSid: 'SM1', messageType: 'tech_en_route', deliveryStatus: 'sent',
  });
  expect(result).toBeNull();
  const logged = JSON.stringify([logger.error.mock.calls, logger.warn.mock.calls]);
  expect(logged).toContain('recordTouchpoint failed');
  expect(logged).toContain('code=57P01');
  expect(logged).not.toContain('abcdefghjk');
  expect(logged).not.toContain('9415550123');
  expect(logged).not.toContain('Pat is on the way');
});
