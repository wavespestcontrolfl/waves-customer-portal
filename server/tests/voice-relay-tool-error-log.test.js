/**
 * A database failure on the relay tool path must not put its bound values (a
 * caller's name, street or phone number, which knex echoes in err.message) in a
 * log line: only a bounded code is logged. Covers the shared executeTool catch
 * through the real lookup_customer handler.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const SECRET_QUERY = 'select "id" from "customers" where "first_name" ilike \'%Pat%\' and "address_line1" ilike \'%12 Palm Ave%\' and RIGHT(phone, 10) = \'9415550123\'';
jest.mock('../models/db', () => jest.fn(() => {
  throw Object.assign(new Error(SECRET_QUERY), { code: '57014' });
}));

const logger = require('../services/logger');
const { executeTool } = require('../services/voice-agent/relay-tools');

const OLD = process.env.VOICE_RELAY_CONTEXT_ENABLED;
beforeEach(() => { jest.clearAllMocks(); process.env.VOICE_RELAY_CONTEXT_ENABLED = 'true'; });
afterAll(() => {
  if (OLD === undefined) delete process.env.VOICE_RELAY_CONTEXT_ENABLED;
  else process.env.VOICE_RELAY_CONTEXT_ENABLED = OLD;
});

const everyLogLine = () => JSON.stringify(['info', 'warn', 'error'].map((level) => logger[level].mock.calls));

test('a failing lookup_customer query logs a bounded code and none of the caller\'s words or numbers', async () => {
  const ctx = {
    callSid: 'CA-err-1', from: '+19415550100', callerVerified: true, sandbox: true, practiceLine: true,
    rememberLookup: jest.fn(), consumeLookup: jest.fn(() => true),
  };
  const out = await executeTool('lookup_customer', { name: 'Pat Smith', street: '12 Palm Ave', phone: '941-555-0123' }, ctx);
  expect(out).toMatch(/Could not look that up right now/); // the failure is still answered, and flagged
  expect(ctx.toolFailed).toBe(true);
  expect(logger.error).toHaveBeenCalledWith('[voice-relay] tool "lookup_customer" failed code=57014');
  const logged = everyLogLine();
  expect(logged).not.toMatch(/Palm Ave|9415550123|ilike|first_name|Pat Smith/);
});

test('a tool name the model made up is bounded in the log line too', async () => {
  const { executeTool: run } = require('../services/voice-agent/relay-tools');
  const ctx = { callSid: 'CA-err-2' };
  const out = await run('not_a_tool', {}, ctx);
  expect(out).toMatch(/Unknown tool/);
});
