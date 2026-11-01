// GATE_PORTAL_CHAT_OPEN: the opened-up portal assistant (owner 2026-11-01).
// Gate off, the prompt, the tools and the keyword pre-check are the ones the
// chat had before (fixtures taken from the live lane). Gate on, the chat has
// the wider prompt, request_quote and request_move, only the legal words
// still hand off before the model, and a chat keeps ONE hand-off item.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.ANTHROPIC_API_KEY = 'test-key';

const fs = require('fs');
const path = require('path');

// Real Knex SQL compilation with an in-memory transport (same pattern as
// portal-chat-email-change.test.js).
jest.mock('../models/db', () => {
  const db = require('knex')({ client: 'pg' });
  db.__rows = () => [];
  db.__queries = [];
  // On the dialect's prototype, so a transaction's client records too.
  const Dialect = Object.getPrototypeOf(db.client);
  Dialect.acquireConnection = async () => ({});
  Dialect.releaseConnection = async () => {};
  Dialect._query = async (_, query) => {
    db.__queries.push({ sql: query.sql, bindings: query.bindings });
    query.response = { command: 'SELECT', rows: db.__rows(query) };
    return query;
  };
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn() }));
jest.mock('../services/notification-triggers', () => ({ triggerNotification: jest.fn(async () => ({ bellWritten: true })) }));
jest.mock('../services/agent-gap-reports', () => ({ recordGap: jest.fn(async () => {}) }));
const mockCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: mockCreate } })));

const db = require('../models/db');
const NotificationService = require('../services/notification-service');
const { triggerNotification } = require('../services/notification-triggers');
const assistant = require('../services/ai-assistant/assistant');
const { portalToolsFor, executeToolCall } = require('../services/ai-assistant/tools');
const portalOpen = require('../services/ai-assistant/portal-open');
const gates = require('../config/feature-gates');
const { CTA_REQUEST_SOURCES } = require('../services/cta-service-request');

const FIXTURES = path.join(__dirname, 'fixtures', 'portal-chat-open');
const read = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');
const OTHER_GATES = [
  'GATE_PORTAL_CHAT_FACTS', 'GATE_PORTAL_CHAT_VISIT_FACTS', 'GATE_PORTAL_CHAT_RESERVICE', 'GATE_PORTAL_CHAT_RESERVICE_LAWN',
  'GATE_PORTAL_CHAT_EMAIL_CHANGE', 'GATE_RESERVICE_SELF_SERVE', 'GATE_RESERVICE_STREAMLINE', 'GATE_RESERVICE_PHOTOS',
  'GATE_RESERVICE_DETAILS_REQUIRED', 'GATE_AI_CONTENT_REPORT', 'GATE_CANCEL_FLOW_V2',
];
const OPEN = 'GATE_PORTAL_CHAT_OPEN';
const conversation = {
  id: 'conv-1', channel: 'portal_chat', channel_identifier: 'sess-1', customer_id: 'cust-1',
  status: 'active', message_count: 0, context_snapshot: { version: 2, firstName: 'Pat' },
};
const customer = { id: 'cust-1', first_name: 'Pat', last_name: 'Sample', email: 'pat@example.com' };
let standing; // the chat's pending ai_escalations row, when a test sets one
let openRequest; // an open service_requests row, when a test sets one
let chat;

const writes = (pattern) => db.__queries.filter((q) => pattern.test(q.sql));

beforeEach(() => {
  jest.clearAllMocks();
  mockCreate.mockReset();
  for (const gate of OTHER_GATES) process.env[gate] = 'true';
  process.env[OPEN] = 'true';
  standing = null;
  openRequest = null;
  chat = [];
  db.__queries.length = 0;
  db.__rows = (q) => {
    if (q.sql.includes('from "agent_sessions"')) return [conversation];
    if (q.sql.includes('from "agent_messages"')) return [...chat];
    if (q.sql.includes('from "customers"')) return [customer];
    if (q.sql.includes('from "ai_escalations"')) {
      // The standing-row lookup carries the email-row exclusion; honor it like the database would.
      const isEmailRow = /Email on file:|asked to change their email/.test(standing?.summary || '');
      return standing && !(q.sql.includes('NOT LIKE') && isEmailRow) ? [standing] : [];
    }
    if (q.sql.includes('insert into "ai_escalations"')) return [{ id: 'esc-1', ...rowFromInsert(q) }];
    if (q.sql.includes('from "service_requests"')) {
      // Open rows; a lookup by requested_service sees only the rows of that service.
      return [].concat(openRequest || []).filter((r) => !q.sql.includes('"requested_service"') || q.bindings.includes(r.requested_service));
    }
    if (q.sql.includes('insert into "service_requests"')) return [{ id: 'req-1' }];
    return [];
  };
  NotificationService.notifyAdmin.mockResolvedValue({ id: 'n-1', deduped: false });
});
afterAll(() => {
  delete process.env[OPEN];
  for (const gate of OTHER_GATES) delete process.env[gate];
});

// The columns an insert carried, by position in its SQL.
function rowFromInsert(q) {
  const columns = (q.sql.match(/\(([^)]*)\) values/)?.[1] || '').split(',').map((c) => c.replace(/"/g, '').trim());
  return Object.fromEntries(columns.map((c, i) => [c, q.bindings[i]]));
}
const say = (message) => assistant.processMessage({ message, channel: 'portal_chat', channelIdentifier: 'sess-1', customerId: 'cust-1' });
const tool = (name, input, id = 't1') => ({ type: 'tool_use', id, name, input });
const calls = (...uses) => ({ content: uses });
const text = (words) => ({ content: [{ type: 'text', text: words }] });
// The tool result the model was handed in its second call.
const resultsOfSecondCall = () => mockCreate.mock.calls[1][0].messages.at(-1).content.map((r) => JSON.parse(r.content));
// The prompt and tools of the first model call.
async function firstCall(message = 'Hi') {
  mockCreate.mockResolvedValueOnce(text('Hi.'));
  await say(message);
  return mockCreate.mock.calls[0][0];
}

describe('gate off: today\'s chat, byte for byte', () => {
  beforeEach(() => { delete process.env[OPEN]; });

  test('the prompt and the tool list are the live lane\'s', async () => {
    const call = await firstCall();
    expect(call.system[0].text).toBe(read('live-prompt.txt'));
    expect(JSON.stringify(call.tools)).toBe(JSON.stringify(JSON.parse(read('live-tools.json'))));
    expect(call.tools.map((t) => t.name)).not.toEqual(expect.arrayContaining(['request_quote', 'request_move']));
    expect(call.tools.find((t) => t.name === 'escalate').input_schema.properties).not.toHaveProperty('say');
  });

  test('every old keyword still hands off before the model, except the reschedule ones', async () => {
    for (const word of ['cancel', 'adam', 'owner', 'manager', 'refund', 'lawsuit', 'bbb', 'complaint', 'dispute', 'not happy']) {
      expect(assistant.matchedEscalationTrigger(`please ${word} thanks`, 'portal_chat')).toBe(word);
    }
    expect(assistant.matchedEscalationTrigger('can you reschedule me', 'portal_chat')).toBe(null);
    expect(assistant.matchedEscalationTrigger('an attorney or a lawyer', 'portal_chat')).toBe(null);
  });

  test('the new tools do not run, and a hand-off still ends the chat', async () => {
    expect(await executeToolCall('request_quote', { service: 'mosquito', note: 'x' }, 'cust-1', [], null, {})).toEqual({ error: 'Unknown tool: request_quote' });
    expect(await executeToolCall('request_move', {}, 'cust-1', [], null, {})).toEqual({ error: 'Unknown tool: request_move' });
    mockCreate.mockResolvedValueOnce(calls(tool('escalate', { reason: 'complaint', topic: 'complaint', say: 'The team will call you.' })));

    const result = await say('The tech was rude');

    expect(result.reply).toBe("Thanks Pat. I've sent this to our team, and they'll reply by text or email, usually within one business hour between 8 AM and 8 PM. Is there anything else you'd like me to pass along?");
    expect(NotificationService.notifyAdmin.mock.calls[0][1]).toBe('Comms — Reply to a portal chat request');
    expect(writes(/update "agent_sessions"/).some((q) => q.bindings.includes('escalated'))).toBe(true);
  });
});

describe('gate on: the prompt and the tools', () => {
  test('with every other gate live the prompt is the replayed target prompt', async () => {
    const call = await firstCall();
    expect(call.system[0].text).toBe(read('opened-v4-prompt.txt'));
  });

  test('the new sections and facts are in the prompt', () => {
    const prompt = portalOpen.withOpen(read('live-prompt.txt'));
    for (const heading of ['CANCEL OR PAUSE:', 'ADDING A SERVICE:', 'MOVING:']) expect(prompt).toContain(heading);
    expect(prompt).toContain('request_quote');
    expect(prompt).toContain('request_move');
    expect(prompt).toContain('Bronze 1, Silver 2, Gold 3, Platinum 4 or more');
    expect(prompt).toContain('Never promise a soil test on request');
    expect(prompt).toContain('topic account_change and say the team will turn them back on');
    expect(prompt).toContain('Only on a residential general pest plan that includes inside service');
    expect(prompt).toContain('State every fact with its condition');
    expect(prompt).toContain('shown the re-service button twice');
    expect(prompt).toContain('with topic billing');
    expect(prompt).not.toContain('Any request to cancel, pause, or downgrade service');
  });

  test('without GATE_CANCEL_FLOW_V2 the prompt promises no one-service cancel, Away Mode or hold, and hands off a pause', async () => {
    const live = read('live-prompt.txt');
    const off = portalOpen.withOpen(live, { cancelFlow: false });
    expect(off).not.toMatch(/Away Mode|one service, when they have more|hold of up to six months/);
    expect(off).toContain('call escalate: the My Plan page cannot do that');
    expect(off).toContain('Account Options on the My Plan page lets them cancel the whole plan');
    expect(off).toContain('Never offer a discount, a pause, a hold or any option the page does not show.');
    expect(off.replace(/If the customer wants to cancel or pause[^\n]*\n/, '')).toBe(
      portalOpen.withOpen(live).replace(/If the customer wants to cancel or pause[^\n]*\n/, ''),
    );
    // The live lane follows the gate, with its own prompt-cache key.
    delete process.env.GATE_CANCEL_FLOW_V2;
    const lane = await firstCall();
    expect(lane.system[0].text).toBe(off);
    process.env.GATE_CANCEL_FLOW_V2 = 'true';
    mockCreate.mockClear();
    expect((await firstCall()).system[0].text).toBe(read('opened-v4-prompt.txt'));
  });

  test('with no other gate live the same sections and facts are still there', () => {
    const base = 'WHAT YOU CAN DO:\n- Hand the conversation to the Waves team (escalate)\n\nWHAT YOU MUST ESCALATE (use the escalate tool):\n- Anything you are uncertain about\n\nRULES:\n- x';
    const out = portalOpen.withOpen(base);
    expect(out).toContain('- Ask the team for a written quote for a service (request_quote)');
    expect(out).toContain('ADDING A SERVICE:');
    expect(out).toContain('COMPANY FACTS (owner-approved; state these plainly):\n- WaveGuard levels');
    expect(out).toContain('- A legal threat');
    expect(out).toMatch(/- Anything you still cannot answer after using your tools\n\nRULES:/);
  });

  test('the tool list adds request_quote and request_move before escalate, and escalate gains say', () => {
    const names = (flags) => portalToolsFor(flags).map((t) => t.name);
    expect(names({ open: true }).slice(-3)).toEqual(['request_quote', 'request_move', 'escalate']);
    expect(names({})).toEqual(['get_upcoming_services', 'get_pest_advice', 'offer_reschedule_link', 'open_portal_section', 'escalate']);
    const escalate = portalToolsFor({ open: true }).at(-1);
    expect(escalate.input_schema.properties.say.type).toBe('string');
    expect(escalate.input_schema.required).toEqual(['reason', 'topic']);
    const quote = portalToolsFor({ open: true }).find((t) => t.name === 'request_quote');
    expect(quote.input_schema.properties.service.enum).toEqual(['pest_control', 'lawn_care', 'tree_shrub', 'mosquito', 'termite', 'other', 'not_stated']);
    expect(portalToolsFor({ open: true }).find((t) => t.name === 'request_move').input_schema.required).toEqual([]);
  });

  test('the reader is its own export and reads at call time', () => {
    delete process.env[OPEN];
    expect(gates.portalChatOpenLive()).toBe(false);
    process.env[OPEN] = 'yes';
    expect(gates.portalChatOpenLive()).toBe(false);
    process.env[OPEN] = 'true';
    expect(gates.portalChatOpenLive()).toBe(true);
  });
});

describe('gate on: only the legal words hand off before the model', () => {
  test('owner, adam, cancel, refund and the rest reach the model', async () => {
    for (const word of ['cancel', 'adam', 'owner', 'manager', 'refund', 'complaint', 'dispute', 'not happy', 'supervisor']) {
      expect(assistant.matchedEscalationTrigger(`please ${word} thanks`, 'portal_chat')).toBe(null);
    }
    mockCreate.mockResolvedValueOnce(text('Sure, I can help.'));

    const result = await say('Can Adam call me about cancelling?');

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(result.escalated).toBe(false);
  });

  test.each(['lawsuit', 'attorney', 'lawyer', 'bbb'])('%s hands off before the model, without the model', async (word) => {
    chat = [{ role: 'user', content: `my ${word} will call` }];

    const result = await say(`my ${word} will call`);

    expect(mockCreate).not.toHaveBeenCalled();
    expect(result.escalated).toBe(true);
    expect(writes(/insert into "ai_escalations"/)).toHaveLength(1);
  });

  test('a legal word inside an email address is not a request', () => {
    expect(assistant.matchedEscalationTrigger('send it to lawyer@example.com', 'portal_chat')).toBe(null);
  });
});

describe('request_quote', () => {
  const quote = (service, note = 'I want it') => calls(tool('request_quote', { service, note }));

  test('writes one request (source portal_chat) and rings one bell', async () => {
    mockCreate.mockResolvedValueOnce(quote('mosquito', 'How much for mosquito?')).mockResolvedValueOnce(text('Done.'));

    await say('Can I add mosquito?');

    const inserts = writes(/insert into "service_requests"/);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].bindings).toEqual(expect.arrayContaining(['cust-1', 'mosquito', 'portal_chat', 'add_service', 'Quote requested in portal chat: Mosquito']));
    expect(inserts[0].bindings.join(' ')).toContain('How much for mosquito?');
    expect(triggerNotification).toHaveBeenCalledTimes(1);
    const [key, payload] = triggerNotification.mock.calls[0];
    expect(key).toBe('bundle_quote_requested');
    expect(payload).toEqual(expect.objectContaining({
      bundled: false, customerId: 'cust-1', customerName: 'Pat Sample', relationship: 'add', requestId: 'req-1', refreshed: false,
      suggestedService: 'Mosquito (quote requested in portal chat)',
    }));
    const [result] = resultsOfSecondCall();
    expect(result.instruction).toContain('A quote request is now with the team.');
    expect(result.instruction).toContain('nothing is booked or charged until they accept it');
    expect(result.instruction).toContain('Do not state a price.');
    // The one-hour promise covers the reply; the written estimate has no time on it.
    expect(result.instruction).toContain('usually within one business hour between 8 AM and 8 PM, and will send a written estimate;');
    expect(result.instruction).not.toContain('with a written estimate');
    expect(result.instruction).not.toContain('Ask which service');
  });

  test('the rule that the bell is a customer contact holds: the trigger declares it', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'services', 'notification-triggers.js'), 'utf8');
    const block = source.slice(source.indexOf('bundle_quote_requested: {'));
    expect(block.slice(0, block.indexOf('build:'))).toMatch(/contact: true/);
  });

  test('portal_chat shares the open-request slot with the other add-service sources', () => {
    expect(CTA_REQUEST_SOURCES).toEqual(['service_report', 'portal_home', 'portal_chat']);
  });

  test('a second ask for the same service while one is open writes nothing and rings nothing', async () => {
    openRequest = {
      id: 'req-0', customer_id: 'cust-1', requested_service: 'mosquito', source: 'portal_chat', status: 'new',
      subject: 'Quote requested in portal chat: Mosquito', pricing_revision: { source: 'portal_chat', service: 'mosquito', note: 'I want it' },
    };
    mockCreate.mockResolvedValueOnce(quote('mosquito')).mockResolvedValueOnce(text('Done.'));

    await say('Add mosquito please');

    expect(writes(/insert into "service_requests"/)).toHaveLength(0);
    expect(writes(/update "service_requests"/)).toHaveLength(0);
    expect(triggerNotification).not.toHaveBeenCalled();
    expect(resultsOfSecondCall()[0].instruction).toContain('A quote request is now with the team.');
  });

  const openMosquito = (note) => ({
    id: 'req-0', customer_id: 'cust-1', requested_service: 'mosquito', source: 'portal_chat', status: 'new',
    subject: 'Quote requested in portal chat: Mosquito', pricing_revision: { source: 'portal_chat', service: 'mosquito', note },
  });

  test('a repeat ask with a changed note refreshes the open row and rings the bell as updated', async () => {
    openRequest = openMosquito('I want it');
    mockCreate.mockResolvedValueOnce(quote('mosquito', 'Only the back yard, please')).mockResolvedValueOnce(text('Done.'));

    await say('Only the back yard');

    expect(writes(/insert into "service_requests"/)).toHaveLength(0);
    const [update] = writes(/update "service_requests"/);
    expect(update.bindings.join('|')).toContain('Only the back yard, please');
    expect(update.bindings.join('|')).toContain('"note":"Only the back yard, please"');
    expect(triggerNotification).toHaveBeenCalledTimes(1);
    expect(triggerNotification.mock.calls[0][1]).toEqual(expect.objectContaining({ refreshed: true, requestId: 'req-0' }));
  });

  test('a repeat ask with no note of its own keeps the saved note and writes nothing', async () => {
    openRequest = openMosquito('Only the back yard, please');
    mockCreate.mockResolvedValueOnce(quote('mosquito', '')).mockResolvedValueOnce(text('Done.'));

    await say('Yes please add it');

    expect(writes(/update "service_requests"/)).toHaveLength(0);
    expect(writes(/insert into "service_requests"/)).toHaveLength(0);
    expect(triggerNotification).not.toHaveBeenCalled();
  });

  test('every add-service source resolves with the estimate: the cleanup reads the shared source list', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'estimate-public.js'), 'utf8');
    expect(source).not.toContain("['service_report', 'portal_home']");
    expect(source.match(/whereIn\('source', require\('..\/services\/cta-service-request'\)\.CTA_REQUEST_SOURCES\)/g)).toHaveLength(2);
  });

  test('a saved note is read from the chat snapshot even on a row another surface created', async () => {
    openRequest = { ...openMosquito('Back yard only'), source: 'portal_home' };
    mockCreate.mockResolvedValueOnce(quote('mosquito', '')).mockResolvedValueOnce(text('Done.'));

    await say('Yes please');

    expect(writes(/update "service_requests"/)).toHaveLength(0);
    expect(triggerNotification).not.toHaveBeenCalled();
  });

  test('naming the service after a "not stated" request promotes that row: one inquiry, the saved words kept', async () => {
    openRequest = {
      id: 'req-0', customer_id: 'cust-1', requested_service: 'not_stated', source: 'portal_chat', status: 'new',
      subject: 'Quote requested in portal chat: Service not stated', description: 'x',
      pricing_revision: { source: 'portal_chat', service: 'not_stated', note: 'I want another service' },
    };
    const rows = db.__rows;
    db.__rows = (q) => {
      // The promotion renames the row; later reads see it.
      if (/^update "service_requests" set "requested_service"/.test(q.sql)) openRequest.requested_service = q.bindings[0];
      return rows(q);
    };
    mockCreate.mockResolvedValueOnce(quote('lawn_care', '')).mockResolvedValueOnce(text('Done.'));

    await say('Lawn care');

    expect(writes(/update "service_requests" set "requested_service"/)[0].bindings[0]).toBe('lawn_care');
    expect(writes(/insert into "service_requests"/)).toHaveLength(0);
    const refresh = writes(/update "service_requests" set "subject"/)[0];
    expect(refresh.bindings.join('|')).toContain('Quote requested in portal chat: Lawn Care');
    expect(refresh.bindings.join('|')).toContain('I want another service');
    expect(triggerNotification).toHaveBeenCalledTimes(1);
  });

  test('naming the service when that service is already open resolves the unnamed row with a pointer', async () => {
    openRequest = [
      {
        id: 'req-0', customer_id: 'cust-1', requested_service: 'not_stated', source: 'portal_chat', status: 'new',
        description: 'Customer asked.', pricing_revision: { source: 'portal_chat', service: 'not_stated', note: '' },
      },
      openMosquito('Back yard only'),
    ];
    mockCreate.mockResolvedValueOnce(quote('mosquito', 'Back yard only')).mockResolvedValueOnce(text('Done.'));

    await say('Mosquito');

    const resolved = writes(/update "service_requests" set "status"/)[0];
    expect(resolved.bindings).toEqual(expect.arrayContaining(['resolved', 'Customer asked. Resolved: the customer named the service; see request req-0.'.replace('req-0.', 'req-0.')]));
    expect(writes(/insert into "service_requests"/)).toHaveLength(0);
  });

  test('a named request with no unnamed one open does no settling write', async () => {
    mockCreate.mockResolvedValueOnce(quote('mosquito')).mockResolvedValueOnce(text('Done.'));

    await say('Mosquito');

    expect(writes(/update "service_requests"/)).toHaveLength(0);
    expect(writes(/insert into "service_requests"/)).toHaveLength(1);
  });

  test('a service not named is saved as such, and the model is told to ask which', async () => {
    mockCreate.mockResolvedValueOnce(quote('not_stated', 'I want another service')).mockResolvedValueOnce(text('Which one?'));

    await say('I want another service');

    expect(writes(/insert into "service_requests"/)[0].bindings).toEqual(expect.arrayContaining(['not_stated', 'Quote requested in portal chat: Service not stated']));
    expect(resultsOfSecondCall()[0].instruction).toContain('Ask which service they want; when they say, call request_quote again with it.');
  });

  test('termite is saved under the bait-station key the estimate flows use', async () => {
    mockCreate.mockResolvedValueOnce(quote('termite')).mockResolvedValueOnce(text('Done.'));

    await say('Termite bait please');

    expect(writes(/insert into "service_requests"/)[0].bindings).toContain('termite_bait');
  });

  test('it is a customer-scoped tool and only runs under the gate', async () => {
    expect(await executeToolCall('request_quote', { service: 'lawn_care', note: '' }, null, [], null, { open: true })).toEqual({ error: 'Authenticated customer context required' });
    expect(await executeToolCall('request_quote', { service: 'lawn_care', note: '' }, 'cust-1', [], null, {})).toEqual({ error: 'Unknown tool: request_quote' });
  });
});

describe('request_move and one hand-off item per chat', () => {
  const move = (input, id) => tool('request_move', input, id);

  test('the first call makes one item (row + bell) and the turn goes on', async () => {
    mockCreate
      .mockResolvedValueOnce(calls(move({ new_address: '12 Palm Way, Sarasota', move_date: 'Nov 20' })))
      .mockResolvedValueOnce(text('Thanks, the team has it.'));

    const result = await say("I'm moving to 12 Palm Way, Sarasota on Nov 20");

    expect(result.escalated).toBe(false);
    const inserts = writes(/insert into "ai_escalations"/);
    expect(inserts).toHaveLength(1);
    const row = rowFromInsert(inserts[0]);
    expect(row.reason).toBe('account_change');
    expect(row.summary).toBe('Customer is moving and asked the portal assistant to transfer service\nNew address: 12 Palm Way, Sarasota\nMove date: Nov 20');
    expect(row.status).toBe('pending');
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    const [category, headline, why, opts] = NotificationService.notifyAdmin.mock.calls[0];
    expect(category).toBe('alert');
    expect(headline).toBe("Comms — Reply to Pat Sample's portal chat");
    expect(why).toBe('Pat Sample is moving and asked the portal assistant to transfer service');
    expect(opts.detail).toContain('New address: 12 Palm Way, Sarasota');
    expect(opts.dedupeKey).toBe('portal-chat-escalation:esc-1');
    expect(opts.metadata.topic).toBe('account_change');
    const [toolResult] = resultsOfSecondCall();
    expect(toolResult).toEqual(expect.objectContaining({ sent: true, missing: [] }));
    expect(toolResult.instruction).toContain('Do not promise a price, a date, or that the new address is served.');
    // The chat stays open: it is not marked as a closed, escalated session.
    expect(writes(/update "agent_sessions" set "escalated"/)).toHaveLength(0);
  });

  test('a call with nothing yet still makes the item, and says what is missing', async () => {
    mockCreate.mockResolvedValueOnce(calls(move({}))).mockResolvedValueOnce(text('Where to?'));

    await say("We're moving");

    expect(rowFromInsert(writes(/insert into "ai_escalations"/)[0]).summary).toMatch(/New address: not given yet\nMove date: not given yet$/);
    expect(resultsOfSecondCall()[0].missing).toEqual(['new_address', 'move_date']);
  });

  test('a second call in the same chat updates that item and refreshes its bell', async () => {
    standing = {
      id: 'esc-1', conversation_id: 'conv-1', status: 'pending', priority: 'normal', reason: 'account_change',
      summary: 'Customer is moving and asked the portal assistant to transfer service\nNew address: not given yet\nMove date: not given yet',
      customer_message: "We're moving",
    };
    mockCreate.mockResolvedValueOnce(calls(move({ new_address: '12 Palm Way, Sarasota', move_date: 'Nov 20' }))).mockResolvedValueOnce(text('Thanks.'));

    await say('12 Palm Way, Sarasota, on Nov 20');

    expect(writes(/insert into "ai_escalations"/)).toHaveLength(0);
    const updates = writes(/update "ai_escalations"/);
    expect(updates).toHaveLength(1);
    expect(updates[0].bindings).toEqual(expect.arrayContaining([
      'Customer is moving and asked the portal assistant to transfer service\nNew address: 12 Palm Way, Sarasota\nMove date: Nov 20',
      "We're moving\n\n12 Palm Way, Sarasota, on Nov 20",
    ]));
    const [, , , opts] = NotificationService.notifyAdmin.mock.calls[0];
    expect(opts.dedupeKey).toBe('portal-chat-escalation:esc-1');
    expect(opts.refreshOnDedupe).toBe(true);
    expect(opts.detail).toContain('New address: 12 Palm Way, Sarasota');
    expect(opts.detail).not.toContain('not given yet');
  });

  test('a hand-off after the move updates the same row and carries both needs', async () => {
    standing = {
      id: 'esc-1', conversation_id: 'conv-1', status: 'pending', priority: 'normal', reason: 'account_change',
      summary: 'Customer is moving and asked the portal assistant to transfer service\nNew address: 12 Palm Way\nMove date: not given yet',
      customer_message: "We're moving to 12 Palm Way",
    };
    mockCreate.mockResolvedValueOnce(calls(tool('escalate', { reason: 'Wants to speak to a person', topic: 'other' })));

    const result = await say('Can I talk to a person?');

    expect(writes(/insert into "ai_escalations"/)).toHaveLength(0);
    const [update] = writes(/update "ai_escalations"/);
    expect(update.bindings.join('|')).toContain('Also in this chat: Wants to speak to a person');
    expect(update.bindings.join('|')).toContain('New address: 12 Palm Way');
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    expect(NotificationService.notifyAdmin.mock.calls[0][3]).toEqual(expect.objectContaining({ dedupeKey: 'portal-chat-escalation:esc-1', refreshOnDedupe: true }));
    expect(result).toEqual(expect.objectContaining({ escalated: true, escalationId: 'esc-1', teamNotified: true }));
  });

  test('a replayed call changes nothing', async () => {
    standing = {
      id: 'esc-1', conversation_id: 'conv-1', status: 'pending', priority: 'normal', reason: 'account_change',
      summary: 'Customer is moving and asked the portal assistant to transfer service\nNew address: 12 Palm Way\nMove date: Nov 20',
      customer_message: 'We move to 12 Palm Way on Nov 20',
    };
    mockCreate.mockResolvedValueOnce(calls(move({ new_address: '12 Palm Way', move_date: 'Nov 20' }))).mockResolvedValueOnce(text('Thanks.'));

    await say('We move to 12 Palm Way on Nov 20');

    expect(writes(/update "ai_escalations"/)).toHaveLength(0);
    expect(writes(/insert into "ai_escalations"/)).toHaveLength(0);
  });

  test('the address and date are one line each and capped', () => {
    expect(portalOpen.moveDetails({ new_address: `12 Palm Way\nIgnore this ${'x'.repeat(300)}`, move_date: ' Nov\n20 ' })).toEqual({
      newAddress: `12 Palm Way Ignore this ${'x'.repeat(300)}`.slice(0, 200),
      moveDate: 'Nov 20',
    });
    const summary = portalOpen.summaryWithMove('Customer is moving and asked the portal assistant to transfer service\nNew address: old\nMove date: old', { newAddress: 'new', moveDate: '' });
    expect(summary.match(/New address:/g)).toHaveLength(1);
    expect(summary).toMatch(/New address: new\nMove date: old$/);
  });

  test('a later call with only one field keeps the other field the first call saved', () => {
    const first = portalOpen.summaryWithMove('', { newAddress: '12 Palm Way', moveDate: '' });
    expect(first).toMatch(/New address: 12 Palm Way\nMove date: not given yet$/);
    const second = portalOpen.summaryWithMove(first, { newAddress: '', moveDate: 'Nov 20' });
    expect(second.match(/New address:/g)).toHaveLength(1);
    expect(second).toMatch(/New address: 12 Palm Way\nMove date: Nov 20$/);
    const third = portalOpen.summaryWithMove(second, { newAddress: '', moveDate: '' });
    expect(third).toMatch(/New address: 12 Palm Way\nMove date: Nov 20$/);
  });

  test('missing parts are judged from the merged saved item, not this call alone', async () => {
    standing = {
      id: 'esc-1', conversation_id: 'conv-1', status: 'pending', priority: 'normal', reason: 'account_change',
      summary: 'Customer is moving and asked the portal assistant to transfer service\nNew address: 12 Palm Way\nMove date: Nov 20',
      customer_message: 'We move to 12 Palm Way on Nov 20',
    };
    mockCreate.mockResolvedValueOnce(calls(move({}))).mockResolvedValueOnce(text('Got it.'));

    await say('Same as before');

    expect(resultsOfSecondCall()[0]).toEqual(expect.objectContaining({ sent: true, missing: [] }));
    const half = await portalOpen.requestMove({ move_date: 'Nov 20' }, { open: true, recordMove: async () => ({ newAddress: '', moveDate: 'Nov 20' }) });
    expect(half.missing).toEqual(['new_address']);
    const unchanged = await portalOpen.requestMove({}, { open: true, recordMove: async () => undefined });
    expect(unchanged.missing).toEqual(['new_address', 'move_date']);
  });

  test('a confirmed email-change row is never merged into: a move makes its own item and bell', async () => {
    standing = {
      id: 'esc-email', conversation_id: 'conv-1', status: 'pending', priority: 'normal', reason: 'account_change',
      summary: 'Customer confirmed a new email address in portal chat. Email on file: pat@example.com. New email, confirmed by the customer in portal chat: new@example.com',
      customer_message: 'Yes',
    };
    mockCreate.mockResolvedValueOnce(calls(move({ new_address: '12 Palm Way' }))).mockResolvedValueOnce(text('Thanks.'));

    await say('We are moving to 12 Palm Way');

    expect(writes(/update "ai_escalations"/)).toHaveLength(0);
    expect(writes(/insert into "ai_escalations"/)).toHaveLength(1);
    expect(writes(/from "ai_escalations"/)[0].sql).toMatch(/NOT LIKE/);
    expect(NotificationService.notifyAdmin.mock.calls[0][3].dedupeKey).toBe('portal-chat-escalation:esc-1');
  });

  test('a failed save tells the model to hand off with escalate instead', async () => {
    const failing = await portalOpen.requestMove({ new_address: 'x' }, { open: true, recordMove: async () => { throw new Error('db down'); } });
    expect(failing.sent).toBe(false);
    expect(failing.instruction).toContain('Call escalate with topic account_change');
  });
});

describe('escalate under the gate', () => {
  const handOff = (input) => calls(tool('escalate', { reason: 'Customer is unhappy with a visit', topic: 'complaint', ...input }));

  test('the say sentence joins the fixed reply, sanitized', async () => {
    mockCreate.mockResolvedValueOnce(handOff({ topic: 'account_change', say: 'The team will turn our emails back on for you.' }));

    const result = await say('Please turn my emails back on');

    expect(result.reply).toBe("Thanks Pat. I've sent this to our team, and they'll reply by text or email, usually within one business hour between 8 AM and 8 PM. The team will turn our emails back on for you. Is there anything else you'd like me to pass along?");
  });

  test.each([
    ['plain', 'The team will check on it.', 'The team will check on it.'],
    ['no period', 'The team will check on it', 'The team will check on it.'],
    ['two sentences', 'The team will check. Then they will call you', 'The team will check.'],
    ['a link', 'Visit https://example.com for it.', ''],
    ['a bare domain', 'See wavespestcontrol.com/pay for it.', ''],
    ['an address', 'Email me@example.com for it.', ''],
    ['a price', 'The team will refund $50.', ''],
    ['a time', 'The team will call by 5 pm.', ''],
    ['too long', `The team will ${'work '.repeat(40)}on it.`, ''],
    ['blank', '   ', ''],
    ['not text', 12, ''],
    ['a newline', 'The team will\ncheck on it.', 'The team will check on it.'],
  ])('say: %s', (_name, input, expected) => {
    expect(portalOpen.sanitizeSay(input)).toBe(expected);
  });

  test('a say with a digit is left out of the reply', async () => {
    mockCreate.mockResolvedValueOnce(handOff({ say: 'The team will call you by 5.' }));

    const result = await say('The tech was rude');

    expect(result.reply).toBe("Thanks Pat. I've sent this to our team, and they'll reply by text or email, usually within one business hour between 8 AM and 8 PM. Is there anything else you'd like me to pass along?");
  });

  test('the bell names the customer and the first hand-off makes one row and one bell', async () => {
    mockCreate.mockResolvedValueOnce(handOff({}));

    await say('The tech was rude');

    expect(writes(/insert into "ai_escalations"/)).toHaveLength(1);
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    const [, headline, why, opts] = NotificationService.notifyAdmin.mock.calls[0];
    expect(headline).toBe("Comms — Reply to Pat Sample's portal chat");
    expect(why).toBe('Pat Sample asked the portal assistant about a complaint');
    expect(opts.detail).toBe("Customer is unhappy with a visit\n\nCustomer's message: The tech was rude");
    expect(opts).toEqual(expect.objectContaining({ bell: true, dedupeKey: 'portal-chat-escalation:esc-1', link: '/admin/customers?customerId=cust-1' }));
    // The chat is flagged escalated but stays active.
    const [session] = writes(/update "agent_sessions" set "escalated"/);
    expect(session.sql).not.toMatch(/"status"/);
    expect(session.bindings).toContain(true);
  });

  test('a second hand-off in the chat updates the pending row and refreshes the one bell', async () => {
    standing = {
      id: 'esc-1', conversation_id: 'conv-1', status: 'pending', priority: 'normal', reason: 'complaint',
      summary: 'Customer is unhappy with a visit', customer_message: 'The tech was rude',
    };
    mockCreate.mockResolvedValueOnce(handOff({ reason: 'Also wants a call back', topic: 'other' }));

    const result = await say('Also please call me back');

    expect(writes(/insert into "ai_escalations"/)).toHaveLength(0);
    const [update] = writes(/update "ai_escalations"/);
    expect(update.bindings).toEqual(expect.arrayContaining([
      'Customer is unhappy with a visit\nAlso in this chat: Also wants a call back',
      'The tech was rude\n\nAlso please call me back',
    ]));
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    const [, , , opts] = NotificationService.notifyAdmin.mock.calls[0];
    expect(opts.dedupeKey).toBe('portal-chat-escalation:esc-1');
    expect(opts.refreshOnDedupe).toBe(true);
    expect(opts.detail).toContain('Also in this chat: Also wants a call back');
    expect(opts.detail).toContain("Customer's message: The tech was rude\n\nAlso please call me back");
    expect(result.escalationId).toBe('esc-1');
  });

  test('a later urgent message makes the pending item urgent', async () => {
    standing = { id: 'esc-1', conversation_id: 'conv-1', status: 'pending', priority: 'normal', summary: 'x', customer_message: 'hello' };
    mockCreate.mockResolvedValueOnce(handOff({ reason: 'Wants a refund' }));

    await say('I want a refund now');

    expect(writes(/update "ai_escalations"/)[0].bindings).toContain('urgent');
  });

  test('a later hand-off does not merge into a confirmed email-change row either', async () => {
    standing = {
      id: 'esc-email', conversation_id: 'conv-1', status: 'pending', priority: 'normal', reason: 'account_change',
      summary: 'Customer confirmed a new email address in portal chat. The customer also asked to change their email, and the chat could not take the new address: it is in the message below',
      customer_message: 'change my email',
    };
    mockCreate.mockResolvedValueOnce(handOff({ reason: 'Wants a call', topic: 'other' }));

    const result = await say('Please call me');

    expect(writes(/update "ai_escalations"/)).toHaveLength(0);
    expect(writes(/insert into "ai_escalations"/)).toHaveLength(1);
    expect(result.escalationId).toBe('esc-1');
  });

  test('a keyword hand-off joins the chat\'s pending item too', async () => {
    standing = { id: 'esc-1', conversation_id: 'conv-1', status: 'pending', priority: 'normal', summary: 'Customer is unhappy', customer_message: 'rude tech' };

    await say('My lawyer will call you');

    expect(mockCreate).not.toHaveBeenCalled();
    expect(writes(/insert into "ai_escalations"/)).toHaveLength(0);
    expect(writes(/update "ai_escalations"/)).toHaveLength(1);
  });

  test('a confirmed email change keeps its own bell and row', async () => {
    process.env.GATE_PORTAL_CHAT_EMAIL_CHANGE = 'true';
    const result = await assistant.escalate(conversation, 'yes', 'Customer confirmed a new email address in portal chat', {
      topic: 'account_change', newEmail: 'new@example.com', open: true,
    });

    expect(result.reply).toContain('new@example.com');
    expect(NotificationService.notifyAdmin.mock.calls[0][3].dedupeKey).toBe('portal-chat-email-change:conv-1:new@example.com');
  });
});

describe('a turn that ends without a model reply', () => {
  const FALLBACK = "I'm having trouble right now. Please try calling us at (941) 318-7612.";
  const HAND_OFF = "Thanks Pat. I've sent this to our team, and they'll reply by text or email, usually within one business hour between 8 AM and 8 PM. Is there anything else you'd like me to pass along?";
  const MESSAGE = "I was supposed to have a lawn service on Thursday but I don't think a tech came.";

  test('a model error files one item (topic other, "chat turn failed") and answers with the hand-off text', async () => {
    mockCreate.mockRejectedValueOnce(new Error('provider down'));

    const result = await say(MESSAGE);

    expect(result).toEqual(expect.objectContaining({ escalated: true, escalationId: 'esc-1', teamNotified: true, reply: HAND_OFF }));
    const inserts = writes(/insert into "ai_escalations"/);
    expect(inserts).toHaveLength(1);
    expect(rowFromInsert(inserts[0])).toEqual(expect.objectContaining({ summary: 'chat turn failed', customer_message: MESSAGE, status: 'pending' }));
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    const [, headline, why, opts] = NotificationService.notifyAdmin.mock.calls[0];
    expect(headline).toBe("Comms — Reply to Pat Sample's portal chat");
    expect(why).toBe('Pat Sample asked the portal assistant about a request it could not handle');
    expect(opts.detail).toBe(`chat turn failed\n\nCustomer's message: ${MESSAGE}`);
  });

  test('it joins the chat\'s pending item rather than adding a second', async () => {
    standing = { id: 'esc-1', conversation_id: 'conv-1', status: 'pending', priority: 'normal', summary: 'Customer is unhappy', customer_message: 'rude tech' };
    mockCreate.mockRejectedValueOnce(new Error('provider down'));

    const result = await say(MESSAGE);

    expect(result.escalated).toBe(true);
    expect(writes(/insert into "ai_escalations"/)).toHaveLength(0);
    expect(writes(/update "ai_escalations"/)[0].bindings).toEqual(expect.arrayContaining([`Customer is unhappy\nAlso in this chat: chat turn failed`, `rude tech\n\n${MESSAGE}`]));
  });

  test('a tool loop that never answers files the item too', async () => {
    mockCreate.mockResolvedValue(calls(tool('get_pest_advice', { topic: 'ants' })));

    const result = await say(MESSAGE);

    expect(result).toEqual(expect.objectContaining({ escalated: true, reply: HAND_OFF }));
    expect(writes(/insert into "ai_escalations"/)).toHaveLength(1);
  });

  test('a failed conversation read files the item when it can', async () => {
    let reads = 0;
    const rows = db.__rows;
    db.__rows = (q) => {
      if (q.sql.includes('from "agent_sessions"') && /order by|limit/.test(q.sql) && reads++ === 0) throw new Error('db blip');
      return rows(q);
    };

    const result = await say(MESSAGE);

    expect(result.reply).toBe(HAND_OFF);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('if filing fails too, today\'s fallback reply stays and nothing throws', async () => {
    mockCreate.mockRejectedValueOnce(new Error('provider down'));
    const rows = db.__rows;
    db.__rows = (q) => {
      if (q.sql.includes('insert into "ai_escalations"')) throw new Error('db down');
      return rows(q);
    };

    const result = await say(MESSAGE);

    expect(result).toEqual({ reply: FALLBACK, escalated: false });
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('a cancelled turn (deadline) is left to the coordinator and files nothing here', async () => {
    const turn = { requestRowId: 'req-row-1', assertActive: jest.fn(), registerFallbackExtras: jest.fn(), providerOptions: jest.fn() };
    turn.transaction = jest.fn((_stage, work) => db.transaction(work));
    turn.query = jest.fn((query) => query);
    mockCreate.mockRejectedValueOnce(Object.assign(new Error('deadline'), { code: 'PORTAL_CHAT_DEADLINE' }));

    const result = await assistant.processMessage({ message: MESSAGE, channel: 'portal_chat', channelIdentifier: 'sess-1', customerId: 'cust-1', turn });

    expect(result.reply).toBe(FALLBACK);
    expect(writes(/insert into "ai_escalations"/)).toHaveLength(0);
  });

  test('the coordinator\'s rescue files the item on a turn of its own', async () => {
    const rescue = {
      requestRowId: 'req-row-1', assertActive: jest.fn(), fallbackExtras: jest.fn(() => ({})), rememberCommittedResult: jest.fn((r) => r),
      transaction: jest.fn((_stage, work) => db.transaction(work)), persistCommittedResult: jest.fn(async (_trx, result) => result),
      query: jest.fn((query) => query), waitFor: jest.fn((work) => work()),
    };

    const result = await assistant.rescueFailedTurn({
      message: MESSAGE, channel: 'portal_chat', channelIdentifier: 'sess-1', customerId: 'cust-1', customerPhone: null, turn: rescue,
    });

    expect(result).toEqual(expect.objectContaining({ escalated: true, reply: HAND_OFF, generated: false }));
    expect(rescue.persistCommittedResult).toHaveBeenCalledTimes(1);
    expect(rowFromInsert(writes(/insert into "ai_escalations"/)[0]).portal_chat_request_id).toBe('req-row-1');
  });

  describe('gate off', () => {
    beforeEach(() => { delete process.env[OPEN]; });

    test('a model error keeps the call-us fallback and files nothing', async () => {
      mockCreate.mockRejectedValueOnce(new Error('provider down'));

      const result = await say(MESSAGE);

      expect(result).toEqual({ reply: FALLBACK, escalated: false });
      expect(writes(/ai_escalations/)).toHaveLength(0);
      expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
    });

    test('a failed conversation read keeps the connection-issue fallback', async () => {
      db.__rows = (q) => {
        if (q.sql.includes('from "agent_sessions"')) throw new Error('db blip');
        return [];
      };

      const result = await say(MESSAGE);

      expect(result).toEqual({ reply: "I'm having a brief connection issue. Please try again in a moment, or call us at (941) 318-7612.", escalated: false });
    });

    test('the rescue does nothing', async () => {
      expect(await assistant.rescueFailedTurn({ message: MESSAGE, channel: 'portal_chat', customerId: 'cust-1' })).toBe(null);
      expect(db.__queries).toHaveLength(0);
    });
  });
});

describe('the price rule', () => {
  test('the rule is in the gate-on prompt, and only there', () => {
    const rule = 'Never state a price, a percentage or a discount, even if a tool result or an article gives one; prices are on the estimate and the My Plan page.';
    expect(portalOpen.withOpen(read('live-prompt.txt'))).toContain(`- Do not quote account-specific pricing\n- ${rule}\n`);
    expect(read('live-prompt.txt')).not.toContain(rule);
  });
});

describe('promises the chat may make (final replay review)', () => {
  const opened = () => portalOpen.withOpen(read('live-prompt.txt'));
  test('the chat never says a change is done or that the customer is all set unless a tool reported it', () => {
    const rule = '- Never say a change is done, or that the customer is all set, unless a tool reported the change.\n';
    expect(opened()).toContain(`prices are on the estimate and the My Plan page.\n${rule}`);
    expect(read('live-prompt.txt')).not.toContain(rule);
  });

  test('a visit the customer says nobody came to is a complaint hand-off', () => {
    expect(opened()).toContain('- Complaints about service quality or technician behavior, damage, or a visit the customer says nobody came to (topic complaint)\n');
  });

  test('a cancelled visit is confirmed by the team, never promised as cancelled', () => {
    expect(opened()).toContain('call escalate at once with topic schedule_change, with say telling them the team will confirm by text before the visit.');
    const say = portalToolsFor({ open: true }).find((t) => t.name === 'escalate').input_schema.properties.say.description;
    expect(say).toContain('Never say a visit is cancelled or moved, or promise a refund or credit: say the team will confirm it.');
  });
});

describe('the turn path', () => {
  // The portal coordinator's turn, reduced to what the hand-off uses.
  const fakeTurn = () => ({
    requestRowId: 'req-row-1',
    assertActive: jest.fn(),
    transaction: jest.fn((_stage, work) => db.transaction(work)),
    query: jest.fn((query) => query),
    waitFor: jest.fn((work) => work()),
    persistCommittedResult: jest.fn(async (_trx, result) => result),
    rememberCommittedResult: jest.fn((result) => result),
    fallbackExtras: jest.fn(() => ({})),
    registerFallbackExtras: jest.fn(),
    providerOptions: jest.fn(() => undefined),
  });

  test('an escalate is one transaction with the row, the bell, the reply and the committed result', async () => {
    const turn = fakeTurn();
    mockCreate.mockResolvedValueOnce(calls(tool('escalate', { reason: 'Customer is unhappy', topic: 'complaint', say: 'The team will look into the visit.' })));

    const result = await assistant.processMessage({ message: 'The tech was rude', channel: 'portal_chat', channelIdentifier: 'sess-1', customerId: 'cust-1', turn });

    expect(result).toEqual(expect.objectContaining({ escalated: true, escalationId: 'esc-1', teamNotified: true, generated: false }));
    expect(result.reply).toContain('The team will look into the visit.');
    expect(rowFromInsert(writes(/insert into "ai_escalations"/)[0]).portal_chat_request_id).toBe('req-row-1');
    expect(turn.persistCommittedResult).toHaveBeenCalledTimes(1);
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
  });

  test('a move item in a turn is written inside the turn\'s transaction and does not end it', async () => {
    const turn = fakeTurn();
    mockCreate
      .mockResolvedValueOnce(calls(tool('request_move', { new_address: '12 Palm Way', move_date: '' })))
      .mockResolvedValueOnce(text('Which day?'));

    const result = await assistant.processMessage({ message: 'Moving to 12 Palm Way', channel: 'portal_chat', channelIdentifier: 'sess-1', customerId: 'cust-1', turn });

    expect(result.escalated).toBe(false);
    expect(turn.transaction).toHaveBeenCalledWith('move hand-off', expect.any(Function));
    expect(turn.persistCommittedResult).toHaveBeenCalledTimes(1);
    // A move item leaves the turn's row key free for a hand-off later in the turn.
    expect(rowFromInsert(writes(/insert into "ai_escalations"/)[0]).portal_chat_request_id).toBeUndefined();
  });

  test('a quote request in a turn is written through the turn\'s transaction', async () => {
    const turn = fakeTurn();
    mockCreate.mockResolvedValueOnce(calls(tool('request_quote', { service: 'lawn_care', note: 'lawn' }))).mockResolvedValueOnce(text('Done.'));

    await assistant.processMessage({ message: 'Add lawn care', channel: 'portal_chat', channelIdentifier: 'sess-1', customerId: 'cust-1', turn });

    expect(turn.transaction).toHaveBeenCalledWith('quote request', expect.any(Function));
    expect(writes(/insert into "service_requests"/)).toHaveLength(1);
  });
});

describe('one item holds a bounded amount of text', () => {
  test('many long messages keep only the newest text, marked as cut', () => {
    let standing = { summary: 'first reason', customer_message: '', priority: 'normal' };
    for (let i = 0; i < 40; i += 1) {
      const change = portalOpen.mergedItem(standing, { customerMessage: `message ${i} ${'x'.repeat(3900)}`, reason: `reason ${i} ${'y'.repeat(500)}` });
      standing = { ...standing, ...change };
    }
    expect(standing.customer_message.length).toBeLessThanOrEqual(portalOpen.MAX_ITEM_MESSAGE_CHARS);
    expect(standing.customer_message.startsWith('[earlier messages cut')).toBe(true);
    expect(standing.customer_message).toContain('message 39 ');
    expect(standing.customer_message).not.toContain('message 0 ');
    expect(standing.summary.length).toBeLessThanOrEqual(portalOpen.MAX_ITEM_SUMMARY_CHARS);
    expect(standing.summary).toContain('reason 39 ');
  });

  test('a short chat is stored in full, unchanged', () => {
    const change = portalOpen.mergedItem({ summary: 'a', customer_message: 'hello', priority: 'normal' }, { customerMessage: 'second', reason: 'b' });
    expect(change.customer_message).toBe('hello\n\nsecond');
    expect(portalOpen.keepNewest('short', 100)).toBe('short');
  });
});
