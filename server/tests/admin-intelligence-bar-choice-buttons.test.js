/**
 * Tap-to-answer choice buttons (offer_choices, owner 2026-10-08).
 *
 * Observable behavior: when the bar asks "which value?", /query returns the
 * validated options as `choices` and the portal shows them as buttons.
 * Credible regressions this suite guards:
 *  1. `choices` reaching the client from anything but a validated call
 *     (markup, a yes/no, an over-long value, a single option), or a button
 *     that sends text other than the text it shows (Codex r1 on #6123: an
 *     option is one plain string, with no second field).
 *  2. The tool writing something or creating a pending action: it is display
 *     only, and a button must never sit beside a Confirm control.
 *  3. Buttons attached to an answer they do not belong to: a later tool
 *     ran after offer_choices, or the tool loop ran out.
 *  4. The tech portal or the agent-estimate rail being offered the tool.
 *
 * Harness (mocks + helpers) mirrors admin-intelligence-bar-tool-activity.test.js.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.ANTHROPIC_API_KEY = 'test-key';

const mockMessagesCreate = jest.fn();
const mockExecuteTool = jest.fn();
const mockCreatePendingAction = jest.fn();
const mockClaimForConfirm = jest.fn();
const mockCancelPendingAction = jest.fn();
const mockRecordResult = jest.fn();
const mockDbInsert = jest.fn(async () => undefined);
const mockResolveCommsCustomer = jest.fn();
const mockLoadReviewRecipient = jest.fn();
const mockResolveTechnician = jest.fn();
const mockResolveTechnicianById = jest.fn();
const mockResolveLeadForUpdate = jest.fn();
const mockPreviewBulkLeadUpdate = jest.fn();

jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: (...args) => mockMessagesCreate(...args) },
})));

jest.mock('../models/db', () => jest.fn(() => ({ insert: mockDbInsert })));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/intelligence-bar/circuit-breaker', () => ({
  getBreaker: jest.fn(() => ({
    isTripped: jest.fn(() => false),
    fastFailResult: jest.fn(),
    recordFailure: jest.fn(),
    recordSuccess: jest.fn(),
  })),
}));
jest.mock('../services/intelligence-bar/tool-events', () => ({ recordToolEvent: jest.fn() }));
jest.mock('../config/models', () => ({ FLAGSHIP: 'test-model' }));

jest.mock('../services/intelligence-bar/tools', () => ({
  TOOLS: [],
  // Mirror of the executor's sanitizer allowlist — the proposal's
  // refuse-don't-drop key check (GH r20 P2) reads it.
  UPDATABLE_FIELDS: {
    first_name: 'first_name', last_name: 'last_name', email: 'email',
    phone: 'phone', city: 'city', state: 'state', zip: 'zip',
    address_line1: 'address_line1', address_line2: 'address_line2', waveguard_tier: 'waveguard_tier',
    pipeline_stage: 'pipeline_stage', lead_source: 'lead_source',
    monthly_rate: 'monthly_rate', active: 'active', notes: 'crm_notes',
  },
  executeTool: (...args) => mockExecuteTool(...args),
  resolveTechnicianByName: (...args) => mockResolveTechnician(...args),
  resolveActiveTechnicianById: (...args) => mockResolveTechnicianById(...args),
}));
jest.mock('../services/intelligence-bar/schedule-tools', () => ({ SCHEDULE_TOOLS: [], executeScheduleTool: jest.fn() }));
jest.mock('../services/intelligence-bar/dashboard-tools', () => ({ DASHBOARD_TOOLS: [], executeDashboardTool: jest.fn() }));
jest.mock('../services/intelligence-bar/seo-tools', () => ({ SEO_TOOLS: [], executeSeoTool: jest.fn() }));
jest.mock('../services/intelligence-bar/procurement-tools', () => ({ PROCUREMENT_TOOLS: [], executeProcurementTool: jest.fn() }));
jest.mock('../services/intelligence-bar/revenue-tools', () => ({ REVENUE_TOOLS: [], executeRevenueTool: jest.fn() }));
jest.mock('../services/intelligence-bar/tech-tools', () => ({ TECH_TOOLS: [], executeTechTool: jest.fn() }));
jest.mock('../services/intelligence-bar/review-tools', () => ({
  REVIEW_TOOLS: [], executeReviewTool: jest.fn(), hasRecentReviewRequest: jest.fn(async () => false),
  loadReviewRecipient: (...args) => mockLoadReviewRecipient(...args),
}));
jest.mock('../services/intelligence-bar/comms-tools', () => ({
  COMMS_TOOLS: [], COMMS_READ_TOOLS: [], executeCommsTool: jest.fn(),
  resolveCustomer: (...args) => mockResolveCommsCustomer(...args),
}));
jest.mock('../services/intelligence-bar/tax-tools', () => ({ TAX_TOOLS: [], executeTaxTool: jest.fn() }));
jest.mock('../services/intelligence-bar/leads-tools', () => ({
  LEADS_TOOLS: [], executeLeadsTool: jest.fn(),
  resolveLeadForUpdate: (...args) => mockResolveLeadForUpdate(...args),
  previewBulkLeadUpdate: (...args) => mockPreviewBulkLeadUpdate(...args),
  BULK_LEAD_UPDATE_CAP: 500,
}));
jest.mock('../services/intelligence-bar/email-tools', () => ({ EMAIL_TOOLS: [], executeEmailTool: jest.fn() }));
jest.mock('../services/intelligence-bar/estimate-tools', () => ({ ESTIMATE_TOOLS: [], executeEstimateTool: jest.fn() }));
jest.mock('../services/intelligence-bar/banking-tools', () => ({
  BANKING_TOOLS: [], BANKING_QUERY_TOOLS: [], executeBankingTool: jest.fn(),
}));
jest.mock('../services/intelligence-bar/pending-actions', () => ({
  TTL_MINUTES: 10,
  createPendingAction: (...args) => mockCreatePendingAction(...args),
  claimForConfirm: (...args) => mockClaimForConfirm(...args),
  cancelPendingAction: (...args) => mockCancelPendingAction(...args),
  recordResult: (...args) => mockRecordResult(...args),
}));
// create_appointment proposals project the customer's inspection credit
// (W0B disclosure) — keep it off the db stub here.
jest.mock('../services/inspection-credit', () => ({ projectRedeemableOfferAmount: jest.fn(async () => ({ amount: 0 })) }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const users = {
      admin: { id: 'admin-1', role: 'admin' },
      tech: { id: 'tech-1', role: 'technician' },
    };
    const user = users[token];
    if (!user) return res.status(401).json({ error: 'Admin authentication required' });
    req.technician = user;
    req.technicianId = user.id;
    req.techRole = user.role;
    return next();
  },
  requireTechOrAdmin: (req, res, next) => (
    ['admin', 'technician'].includes(req.techRole) ? next() : res.status(403).json({ error: 'Staff access required' })
  ),
}));

const express = require('express');
const intelligenceRouter = require('../routes/admin-intelligence-bar');

const PENDING_ID = '7e1c2f7a-1111-2222-3333-deadbeef0001';

function appServer() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/admin/intelligence-bar', intelligenceRouter);
  app.use((err, _req, res, _next) => {
    // Stack rides on the response so an unexpected 500 names its cause in the
    // assertion output — this suite's 500s are otherwise invisible (the route
    // logs through the mocked logger).
    res.status(err.status || 500).json({ error: err.message, stack: err.stack });
  });
  const server = app.listen(0);
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

async function withServer(fn) {
  const { server, baseUrl } = appServer();
  try {
    return await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function scriptModelTurns(turns) {
  mockMessagesCreate.mockReset();
  for (const content of turns) {
    mockMessagesCreate.mockResolvedValueOnce({ content });
  }
}

async function postQuery(baseUrl, body, token = 'admin') {
  const res = await fetch(`${baseUrl}/admin/intelligence-bar/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}


const {
  CHOICE_TOOLS, executeChoiceTool, validateChoices, MAX_LABEL_CHARS,
} = require('../services/intelligence-bar/choice-tools');
const registry = require('../services/intelligence-bar/action-registry');
const policy = require('../services/intelligence-bar/action-policy.json');
const { UI_GATED_WRITE_TOOL_NAMES, WRITE_TWO_STEP_TOOL_NAMES, CONFIRMED_ENDPOINT_WRITE_TOOL_NAMES } = require('../services/intelligence-bar/write-gates');
const { getToolsForContext } = intelligenceRouter;

const AMOUNTS = ['$60.33', '$61.33'];
const offer = (options, id = 'tu_choice') => ({ type: 'tool_use', id, name: 'offer_choices', input: { options } });
const lookup = (id = 'tu_lookup') => ({ type: 'tool_use', id, name: 'query_customers', input: { search: 'Synthetic' } });
const QUESTION = [{ type: 'text', text: 'Which is correct, $60.33 or $61.33?' }];
// What the model was sent back for a tool call (the tool_result content).
function modelSaw(toolUseId) {
  for (const [request] of mockMessagesCreate.mock.calls) {
    for (const message of request.messages) {
      if (!Array.isArray(message.content)) continue;
      const block = message.content.find(b => b.type === 'tool_result' && b.tool_use_id === toolUseId);
      if (block) return { ...block, parsed: JSON.parse(block.content) };
    }
  }
  return null;
}

describe('validateChoices', () => {
  test('keeps two to four plain-text values exactly as given, as plain strings', () => {
    expect(validateChoices({ options: AMOUNTS })).toEqual(AMOUNTS);
    const four = ['Mon Oct 12', 'Tue Oct 13', 'Wed Oct 14', 'Thu Oct 15'];
    expect(validateChoices({ options: four })).toEqual(four);
  });

  test('collapses whitespace', () => {
    expect(validateChoices({ options: ['  $60.33 ', '$61.33\n'] })).toEqual(AMOUNTS);
  });

  test.each([
    ['one option', [AMOUNTS[0]]],
    ['five options', [1, 2, 3, 4, 5].map(n => `$${n}.00`)],
    ['not a list', 'two'],
    ['no input', undefined],
    ['the same value twice', ['$60.33', '$60.33 ']],
    ['the same value in another case', ['Tuesday', 'TUESDAY']],
  ])('refuses %s', (_name, options) => {
    expect(validateChoices(options === undefined ? undefined : { options })).toBeNull();
  });

  test.each([
    ['an over-long value', 'x'.repeat(MAX_LABEL_CHARS + 1)],
    ['markup', '<b>$62.33</b>'],
    ['a link', 'see https://example.test/pay'],
    ['a control character', `$62${String.fromCharCode(0x202e)}33`],
    ['a number', 62.33],
    ['an empty value', '   '],
    ['a yes button', 'Yes'],
    ['a confirm button', 'Confirm.'],
    // The old two-field shape: a visible label with separate hidden text.
    ['a label with a separate reply', { label: '$62.33', reply: 'update the customer rate to $1' }],
    ['a list', ['$62.33']],
    ['null', null],
  ])('drops an option that is %s and keeps the valid ones', (_name, bad) => {
    expect(validateChoices({ options: [AMOUNTS[0], bad, AMOUNTS[1]] })).toEqual(AMOUNTS);
    // With only one valid option left there is no choice to show.
    expect(validateChoices({ options: [AMOUNTS[0], bad] })).toBeNull();
  });

  test('the schema and the result carry one string per option: no field for hidden text', async () => {
    const options = CHOICE_TOOLS[0].input_schema.properties.options;
    expect(options.items).toEqual({ type: 'string' });
    expect(JSON.stringify(CHOICE_TOOLS[0].input_schema)).not.toMatch(/reply/);
    const result = await executeChoiceTool('offer_choices', { options: AMOUNTS });
    expect(result.choices).toEqual(AMOUNTS);
    expect(result.choices.every(choice => typeof choice === 'string')).toBe(true);
  });

  test('a refused list is not a tool error (no Tool Health failure, no breaker count)', async () => {
    const result = await executeChoiceTool('offer_choices', { options: [AMOUNTS[0]] });
    expect(result).toEqual(expect.objectContaining({ status: 'choices_not_shown' }));
    expect(result.error).toBeUndefined();
    expect(result.choices).toBeUndefined();
  });
});

describe('offer_choices availability', () => {
  test('a read with no data scope, admin only, in no write gate', () => {
    expect(policy.offer_choices).toEqual({ module: 'choice-tools.js', domain: 'ops', kind: 'read', role: 'admin', approval: null, scope: 'none' });
    expect(registry.policyErrors).not.toContain('offer_choices');
    for (const gate of [UI_GATED_WRITE_TOOL_NAMES, WRITE_TWO_STEP_TOOL_NAMES, CONFIRMED_ENDPOINT_WRITE_TOOL_NAMES]) expect(gate.has('offer_choices')).toBe(false);
    // The wire definition carries nothing the API rejects.
    expect(Object.keys(registry.actions.get('offer_choices').definition).sort()).toEqual(['description', 'input_schema', 'name']);
    expect(CHOICE_TOOLS).toHaveLength(1);
  });

  test('the registry refuses the old two-field shape and any extra top-level field', () => {
    const scope = { role: 'admin', context: 'customers' };
    expect(registry.validateInput('offer_choices', { options: AMOUNTS }, scope)).toBeNull();
    expect(registry.validateInput('offer_choices', { options: [{ label: '$60.33', reply: 'x' }, { label: '$61.33', reply: 'y' }] }, scope))
      .toEqual(expect.objectContaining({ code: 'invalid_input' }));
    expect(registry.validateInput('offer_choices', { options: AMOUNTS, replies: ['a', 'b'] }, scope))
      .toEqual(expect.objectContaining({ code: 'invalid_input' }));
  });

  test.each(['customers', 'dashboard', 'schedule', 'revenue', 'comms', 'email'])('offered once to an admin on %s, on both tool-list paths', (context) => {
    for (const list of [registry.initialTools(context, { role: 'admin', context }), getToolsForContext(context, true, false)]) {
      expect(list.filter(t => t.name === 'offer_choices')).toHaveLength(1);
    }
  });

  test('legacy per-context list: start_program follows the registry page allowlist, not every admin page', () => {
    process.env.GATE_IB_START_PROGRAM = 'true';
    try {
      for (const context of registry.START_PROGRAM_CONTEXTS) {
        expect(getToolsForContext(context, true, false).map(t => t.name)).toContain('start_program');
      }
      for (const context of ['seo', 'revenue', 'comms', 'email', 'tax', 'leads', 'estimates']) {
        expect(getToolsForContext(context, true, false).map(t => t.name)).not.toContain('start_program');
      }
    } finally {
      delete process.env.GATE_IB_START_PROGRAM;
    }
  });

  test('never offered to the tech portal, a technician token or the agent-estimate rail', () => {
    const lists = [
      registry.initialTools('tech', { role: 'technician', context: 'tech' }),
      registry.initialTools('tech', { role: 'admin', context: 'tech' }),
      registry.initialTools('customers', { role: 'technician', context: 'customers' }),
      registry.initialTools('agent_estimate', { role: 'admin', context: 'agent_estimate' }),
      getToolsForContext('tech', false, false),
      getToolsForContext('tech', true, false),
      getToolsForContext('customers', false, false),
      getToolsForContext('agent_estimate', true, false),
    ];
    for (const list of lists) expect(list.map(t => t.name)).not.toContain('offer_choices');
    for (const scope of [{ role: 'technician', context: 'tech' }, { role: 'admin', context: 'tech' }, { role: 'admin', context: 'agent_estimate' }]) {
      expect(registry.validateInput('offer_choices', { options: AMOUNTS }, scope)).toEqual(expect.objectContaining({ code: 'permission_denied' }));
    }
  });
});

describe('offer_choices on /query', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.GATE_IB_PLATFORM;
    mockExecuteTool.mockResolvedValue({ customers: [], total_matching: 0 });
    mockResolveCommsCustomer.mockResolvedValue({ id: 'c1', first_name: 'Synthetic', last_name: 'Tester' });
    mockCreatePendingAction.mockResolvedValue({
      id: PENDING_ID, tool_name: 'update_customer', summary: 'update_customer', expires_at: new Date(Date.now() + 600000).toISOString(),
    });
  });

  test('a validated call returns the labels, tells the model to stop, and writes nothing', async () => {
    scriptModelTurns([[offer(AMOUNTS)], QUESTION]);
    await withServer(async (baseUrl) => {
      const { status, body } = await postQuery(baseUrl, { prompt: 'Set the price to sixty one thirty three', context: 'customers' });
      expect(status).toBe(200);
      expect(body.choices).toEqual(AMOUNTS);
      expect(body.response).toBe('Which is correct, $60.33 or $61.33?');
      expect(body.pendingActions).toEqual([]);
      // The model is offered the tool, and is told the buttons confirm nothing.
      expect(mockMessagesCreate.mock.calls[0][0].tools.map(t => t.name)).toContain('offer_choices');
      const seen = modelSaw('tu_choice');
      expect(seen.is_error).toBeUndefined();
      expect(seen.parsed.status).toBe('choices_shown');
      expect(seen.parsed.note).toMatch(/End your turn now/);
      expect(seen.parsed.note).toMatch(/sends exactly the button text/);
      expect(seen.parsed.note).toMatch(/It confirms nothing/);
      // Nothing proposed, nothing executed through another tool.
      expect(mockCreatePendingAction).not.toHaveBeenCalled();
      expect(mockExecuteTool).not.toHaveBeenCalled();
      // The one db write is the query-analytics row every /query makes. An
      // option can name a customer, so that row and the stored turns are
      // redacted like any PII-tool turn.
      expect(mockDbInsert).toHaveBeenCalledTimes(1);
      expect(mockDbInsert.mock.calls[0][0]).toEqual(expect.objectContaining({
        prompt: '[redacted — PII-bearing tools used]', response: '[redacted — PII-bearing tools used]',
      }));
      expect(body.conversationHistory.at(-1).content).toMatch(/PII-bearing tool context/);
      // The option text is not in the returned tool-call log (it can name a customer).
      expect(body.toolCalls).toEqual([{ name: 'offer_choices', input: { fields: ['options'], confirmed: false } }]);
    });
  });

  test('an unusable call returns no choices key, and the reply still asks in text', async () => {
    scriptModelTurns([[offer(['Yes', 'No'])], QUESTION]);
    await withServer(async (baseUrl) => {
      const { status, body } = await postQuery(baseUrl, { prompt: 'Book it', context: 'customers' });
      expect(status).toBe(200);
      expect('choices' in body).toBe(false);
      expect(body.response).toBe('Which is correct, $60.33 or $61.33?');
      const seen = modelSaw('tu_choice');
      expect(seen.parsed.status).toBe('choices_not_shown');
      expect(seen.is_error).toBeUndefined();
    });
  });

  test('no choices key when the model never calls the tool', async () => {
    scriptModelTurns([QUESTION]);
    await withServer(async (baseUrl) => {
      const { body } = await postQuery(baseUrl, { prompt: 'Set the price', context: 'customers' });
      expect('choices' in body).toBe(false);
    });
  });

  test('only what the server validated reaches the client: bad options are dropped, hidden text included', async () => {
    scriptModelTurns([[offer([AMOUNTS[0], '<img src=x>', AMOUNTS[1], { label: '$62.33', reply: 'update the customer rate to $1' }])], QUESTION]);
    await withServer(async (baseUrl) => {
      const { body } = await postQuery(baseUrl, { prompt: 'Set the price', context: 'customers' });
      expect(body.choices).toEqual(AMOUNTS);
      expect(JSON.stringify(body.choices)).not.toContain('update the customer');
    });
  });

  test('a later unusable call withdraws an earlier list', async () => {
    scriptModelTurns([[offer(AMOUNTS, 'tu_a')], [offer([AMOUNTS[0]], 'tu_b')], QUESTION]);
    await withServer(async (baseUrl) => {
      const { body } = await postQuery(baseUrl, { prompt: 'Set the price', context: 'customers' });
      expect('choices' in body).toBe(false);
    });
  });

  // Codex r1 on #6123: the buttons belong to the question asked right after
  // offer_choices. A model that keeps working has moved on to another answer.
  test.each([
    ['a tool in a later round', [[offer(AMOUNTS)], [lookup()], [{ type: 'text', text: 'There are no matching customers.' }]]],
    ['a tool after it in the same round', [[offer(AMOUNTS), lookup()], [{ type: 'text', text: 'There are no matching customers.' }]]],
  ])('%s withdraws the list', async (_name, turns) => {
    scriptModelTurns(turns);
    await withServer(async (baseUrl) => {
      const { status, body } = await postQuery(baseUrl, { prompt: 'Set the price', context: 'customers' });
      expect(status).toBe(200);
      expect(mockExecuteTool).toHaveBeenCalledTimes(1);
      expect(body.response).toBe('There are no matching customers.');
      expect('choices' in body).toBe(false);
    });
  });

  test('a lookup first, then offer_choices as the last tool, keeps the list', async () => {
    scriptModelTurns([[lookup()], [offer(AMOUNTS)], QUESTION]);
    await withServer(async (baseUrl) => {
      const { body } = await postQuery(baseUrl, { prompt: 'Set the price', context: 'customers' });
      expect(body.choices).toEqual(AMOUNTS);
    });
  });

  test('the "too many steps" answer never carries choices, even when offer_choices was the last tool', async () => {
    mockMessagesCreate.mockReset();
    mockMessagesCreate.mockImplementation(async () => ({ content: [offer(AMOUNTS, `tu_${mockMessagesCreate.mock.calls.length}`)] }));
    await withServer(async (baseUrl) => {
      const { status, body } = await postQuery(baseUrl, { prompt: 'Set the price', context: 'customers' });
      expect(status).toBe(200);
      expect(body.response).toMatch(/too many steps/);
      expect(mockMessagesCreate.mock.calls.length).toBeGreaterThan(1);
      expect('choices' in body).toBe(false);
    });
  });

  test('a turn that also makes a confirmation card returns the card and no choices', async () => {
    scriptModelTurns([
      [{ type: 'tool_use', id: 'tu_write', name: 'update_customer', input: { customer_id: 'c1', updates: { city: 'Venice' } } }, offer(AMOUNTS)],
      [{ type: 'text', text: 'Awaiting your Confirm on the card below.' }],
    ]);
    await withServer(async (baseUrl) => {
      const { status, body } = await postQuery(baseUrl, { prompt: 'Set the city', context: 'customers' });
      expect(status).toBe(200);
      expect(body.pendingActions).toHaveLength(1);
      expect('choices' in body).toBe(false);
    });
  });

  test('a technician is not offered the tool, and a forced call is refused with no choices', async () => {
    scriptModelTurns([[offer(AMOUNTS)], QUESTION]);
    await withServer(async (baseUrl) => {
      const { status, body } = await postQuery(baseUrl, { prompt: 'Which one', context: 'customers' }, 'tech');
      expect(status).toBe(200);
      expect(mockMessagesCreate.mock.calls[0][0].tools.map(t => t.name)).not.toContain('offer_choices');
      expect('choices' in body).toBe(false);
      const seen = modelSaw('tu_choice');
      expect(seen.is_error).toBe(true);
      expect(seen.parsed.error).toMatch(/not available to your role/);
    });
  });

  test('the prompt rule sits with the number read-back rule and forbids confirming a write', async () => {
    scriptModelTurns([QUESTION]);
    await withServer(async (baseUrl) => {
      await postQuery(baseUrl, { prompt: 'Set the price', context: 'customers' });
      const system = mockMessagesCreate.mock.calls[0][0].system[0].text;
      const readBack = system.indexOf('- Number read-back:');
      const rule = system.indexOf('- Answer buttons:');
      expect(readBack).toBeGreaterThan(-1);
      expect(rule).toBeGreaterThan(readBack);
      expect(system.slice(readBack, rule).split('\n')).toHaveLength(2); // the very next rule line
      const line = system.slice(rule).split('\n')[0];
      expect(line).toMatch(/offer_choices/);
      expect(line).toMatch(/two to four specific values/);
      expect(line).toMatch(/as the operator would say them \("\$61\.33", not a sentence\)/);
      expect(line).toMatch(/a tap sends exactly that value/);
      expect(line).toMatch(/treat it as their answer to the question you just asked/);
      expect(line).toMatch(/ask the question in your reply text/);
      expect(line).toMatch(/Never use it for a yes\/no or to confirm a write/);
      expect(line).toMatch(/a button never confirms, approves or commits anything/);
      expect(line).not.toMatch(/\breply\b(?! text)/);
    });
  });
});
