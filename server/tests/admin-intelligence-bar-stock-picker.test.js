/**
 * Product picker + Show again through the route (owner 2026-10-07).
 *
 * Picker: when adjust_stock cannot pin the operator's words to one product,
 * the bar shows a "choose the product" card instead of refusing. Its
 * shortlist is pinned server-side; /choose-product accepts only a listed id,
 * writes nothing, and proposes a normal card with the exact before -> after.
 * Show again: an expired, undecided card is proposed again through the full
 * proposal path; it never commits.
 *
 * Harness mirrors admin-intelligence-bar-stock-write-target.test.js.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.ANTHROPIC_API_KEY = 'test-key';

const mockMessagesCreate = jest.fn();
const mockExecuteTool = jest.fn();
const mockCreatePendingAction = jest.fn();
const mockDbInsert = jest.fn(async () => undefined);
const mockResolveCommsCustomer = jest.fn();
const mockClaimForConfirm = jest.fn();
const mockRecordResult = jest.fn(async () => true);
const mockGetPendingRow = jest.fn();
const mockRetireExpiredAction = jest.fn();
const mockAttachThread = jest.fn(async () => 1);
const mockFindDerivedCard = jest.fn(async () => null);

jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: (...args) => mockMessagesCreate(...args) },
})));

// db.transaction runs its callback with a stand-in trx; the pending-action
// store is mocked, so the trx is only threaded through.
jest.mock('../models/db', () => Object.assign(jest.fn(() => ({ insert: mockDbInsert })), {
  transaction: async (fn) => fn({ isTrx: true }),
}));
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
  UPDATABLE_FIELDS: { city: 'city' },
  executeTool: (...args) => mockExecuteTool(...args),
  resolveTechnicianByName: jest.fn(),
  resolveActiveTechnicianById: jest.fn(),
}));
jest.mock('../services/intelligence-bar/schedule-tools', () => ({ SCHEDULE_TOOLS: [], executeScheduleTool: jest.fn() }));
jest.mock('../services/intelligence-bar/dashboard-tools', () => ({ DASHBOARD_TOOLS: [], executeDashboardTool: jest.fn() }));
jest.mock('../services/intelligence-bar/seo-tools', () => ({ SEO_TOOLS: [], executeSeoTool: jest.fn() }));
// Real tool definitions; the preview and the target rule are scripted so the
// test watches only what the route does with their answers.
const mockExecuteProcurementTool = jest.fn();
const mockStockTarget = jest.fn();
const mockChoiceCard = jest.fn();
jest.mock('../services/intelligence-bar/procurement-tools', () => {
  const actual = jest.requireActual('../services/intelligence-bar/procurement-tools');
  return {
    PROCUREMENT_TOOLS: actual.PROCUREMENT_TOOLS,
    executeProcurementTool: (...args) => mockExecuteProcurementTool(...args),
    stockProposalTarget: (...args) => mockStockTarget(...args),
    productChoiceCard: (...args) => mockChoiceCard(...args),
  };
});
jest.mock('../services/intelligence-bar/revenue-tools', () => ({ REVENUE_TOOLS: [], executeRevenueTool: jest.fn() }));
jest.mock('../services/intelligence-bar/tech-tools', () => ({ TECH_TOOLS: [], executeTechTool: jest.fn() }));
jest.mock('../services/intelligence-bar/review-tools', () => ({ REVIEW_TOOLS: [], executeReviewTool: jest.fn(), hasRecentReviewRequest: jest.fn(async () => false), loadReviewRecipient: jest.fn() }));
jest.mock('../services/intelligence-bar/comms-tools', () => ({
  COMMS_TOOLS: [], COMMS_READ_TOOLS: [], executeCommsTool: jest.fn(),
  resolveCustomer: (...args) => mockResolveCommsCustomer(...args),
}));
jest.mock('../services/intelligence-bar/tax-tools', () => ({ TAX_TOOLS: [], executeTaxTool: jest.fn() }));
jest.mock('../services/intelligence-bar/leads-tools', () => ({ LEADS_TOOLS: [], executeLeadsTool: jest.fn(), resolveLeadForUpdate: jest.fn(), previewBulkLeadUpdate: jest.fn(), BULK_LEAD_UPDATE_CAP: 500 }));
jest.mock('../services/intelligence-bar/email-tools', () => ({ EMAIL_TOOLS: [], executeEmailTool: jest.fn() }));
jest.mock('../services/intelligence-bar/estimate-tools', () => ({ ESTIMATE_TOOLS: [], executeEstimateTool: jest.fn() }));
jest.mock('../services/intelligence-bar/banking-tools', () => ({ BANKING_TOOLS: [], BANKING_QUERY_TOOLS: [], executeBankingTool: jest.fn() }));
jest.mock('../services/intelligence-bar/pending-actions', () => ({
  TTL_MINUTES: 10,
  createPendingAction: (...args) => mockCreatePendingAction(...args),
  claimForConfirm: (...args) => mockClaimForConfirm(...args),
  cancelPendingAction: jest.fn(),
  recordResult: (...args) => mockRecordResult(...args),
  getPendingRow: (...args) => mockGetPendingRow(...args),
  retireExpiredAction: (...args) => mockRetireExpiredAction(...args),
  attachThread: (...args) => mockAttachThread(...args),
  findDerivedCard: (...args) => mockFindDerivedCard(...args),
  stepKey: jest.fn(() => 'step-key'),
  getActionReceipt: jest.fn(async () => null),
}));
jest.mock('../services/inspection-credit', () => ({ projectRedeemableOfferAmount: jest.fn(async () => ({ amount: 0 })) }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (token !== 'admin') return res.status(401).json({ error: 'Admin authentication required' });
    req.technician = { id: 'admin-1', role: 'admin' };
    req.technicianId = 'admin-1';
    req.techRole = 'admin';
    return next();
  },
  requireTechOrAdmin: (req, res, next) => (req.techRole === 'admin' ? next() : res.status(403).json({ error: 'Staff access required' })),
}));

const express = require('express');
const intelligenceRouter = require('../routes/admin-intelligence-bar');

const CHOICE_ID = '7e1c2f7a-1111-2222-3333-deadbeef0010';
const NEW_ID = '7e1c2f7a-1111-2222-3333-deadbeef0011';
const PRODUCT_A = '5b0c8f1e-0000-4000-8000-00000000000a';
const PRODUCT_B = '5b0c8f1e-0000-4000-8000-00000000000b';
const FORGED = '5b0c8f1e-0000-4000-8000-00000000000f';

function appServer() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/admin/intelligence-bar', intelligenceRouter);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message, stack: err.stack }));
  const server = app.listen(0);
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

async function withServer(fn) {
  const { server, baseUrl } = appServer();
  try { return await fn(baseUrl); } finally { await new Promise((resolve) => server.close(resolve)); }
}

function scriptModelTurns(turns) {
  mockMessagesCreate.mockReset();
  for (const content of turns) mockMessagesCreate.mockResolvedValueOnce({ content });
}

const modelSaw = () => mockMessagesCreate.mock.calls.map(([request]) => JSON.stringify(request.messages)).join('\n');

async function post(baseUrl, path, body) {
  const res = await fetch(`${baseUrl}/admin/intelligence-bar/${path}`, {
    method: 'POST', headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const previewFor = (id, name, before, after) => ({
  preview: true, tool: 'adjust_stock', product: { id, name }, movement_type: 'restock',
  stock_before: before, change: after - before, stock_after: after, unit: 'fl_oz', entered_quantity: 78, entered_unit: 'fl_oz', _version: `v-${id}`,
});
const MOVEMENT = { movement_type: 'restock', quantity: 78, unit: 'fl_oz' };
// The stock layer's picker card (procurement-tools productChoiceCard shape;
// its own decisions are covered in intelligence-bar-stock-product-choices).
const PICKER_CARD = {
  params: { product_name: 'Zentrovex', ...MOVEMENT, _ib_product_choices: [PRODUCT_A, PRODUCT_B] },
  preview: { preview: true, choose_product: true, tool: 'adjust_stock', movement_type: 'restock', entered_quantity: 78, entered_unit: 'fl_oz',
    product_choices: [
      { product_id: PRODUCT_A, name: 'Zentrovex 10% SC', container_size: '78 fl oz', unit: 'fl_oz', on_hand: 20, stock_after: 98, selectable: true },
      { product_id: PRODUCT_B, name: 'Zentrovex 20% SC', container_size: '1 gal', unit: 'fl_oz', on_hand: 0, stock_after: 78, selectable: true },
    ] },
  displayParams: { product_words: 'Zentrovex' },
  note: 'Nothing was written. Pick the product on the card.',
};
const adjustByName = { type: 'tool_use', id: 'tu_adjust', name: 'adjust_stock', input: { product_name: 'Zentrovex', ...MOVEMENT } };
const pickerRow = (overrides = {}) => ({
  id: CHOICE_ID, tool_name: 'adjust_stock', status: 'pending', context: 'procurement', contract_hash: 'hash-choice',
  params: { product_name: 'Zentrovex', ...MOVEMENT, _ib_product_choices: [PRODUCT_A, PRODUCT_B] }, ...overrides,
});
const confirmedCalls = () => mockExecuteProcurementTool.mock.calls.filter(([, , ctx]) => ctx && ctx.confirmed === true);

beforeEach(() => {
  jest.clearAllMocks();
  mockCreatePendingAction.mockImplementation(async ({ toolName, summary }) => ({
    id: NEW_ID, tool_name: toolName, summary, status: 'pending', expires_at: new Date(Date.now() + 600000).toISOString(),
  }));
  mockChoiceCard.mockResolvedValue(PICKER_CARD);
  // A re-proposal is grounded on the stored product; /query cards get a picker.
  mockStockTarget.mockImplementation(async ({ grounded, preview }) => {
    if (!grounded) return { productChoice: PICKER_CARD };
    return preview.error ? { failed: true, modelResult: preview } : { productId: grounded.productId };
  });
  mockFindDerivedCard.mockResolvedValue(null);
  mockExecuteProcurementTool.mockImplementation(async (name, input) => {
    if (input.product_id === PRODUCT_B) return previewFor(PRODUCT_B, 'Zentrovex 20% SC', 0, 78);
    if (input.product_id === PRODUCT_A) return previewFor(PRODUCT_A, 'Zentrovex 10% SC', 20, 98);
    return { error: 'Multiple products match "Zentrovex" — retry with product_id', code: 'product_ambiguous', candidates: [] };
  });
});

describe('the picker card', () => {
  test('a picker from the stock layer becomes a choose-the-product card with the shortlist pinned server-side', async () => {
    scriptModelTurns([[adjustByName], [{ type: 'text', text: 'Pick the product on the card.' }]]);
    await withServer(async (baseUrl) => {
      const { status, body } = await post(baseUrl, 'query', { prompt: 'We got 78 oz of Zentrovex', context: 'procurement', pageData: { route: '/admin/inventory' } });
      expect(status).toBe(200);
      expect(body.pendingActions).toHaveLength(1);
      const card = body.pendingActions[0];
      expect(card.contract.action_label).toBe('Choose the product');
      expect(card.contract.product_choices.map((c) => c.product_id)).toEqual([PRODUCT_A, PRODUCT_B]);
      expect(card.contract.effects.map((e) => e.label)).toContain('Pick the product for this stock change (restock 78 fl_oz). Nothing changes until you pick a product and confirm the next card.');
      const stored = mockCreatePendingAction.mock.calls[0][0];
      expect(stored.params._ib_product_choices).toEqual([PRODUCT_A, PRODUCT_B]);
      expect(stored.params.product_id).toBeUndefined();
      // The contract the card echoes covers the whole list.
      expect(stored.contract.product_choices).toHaveLength(2);
      expect(card.params._ib_product_choices).toBeUndefined();
    });
    // The failed preview went to the stock layer with the operator's own words.
    expect(mockStockTarget).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'We got 78 oz of Zentrovex',
      preview: expect.objectContaining({ code: 'product_ambiguous' }) }));
    expect(modelSaw()).toContain('Pick the product on the card.');
    expect(confirmedCalls()).toHaveLength(0);
  });

  test('a stock-layer refusal leaves no card', async () => {
    mockStockTarget.mockResolvedValue({ failed: true, modelResult: { error: 'Choose the exact product. Nothing was written and no confirmation card was created.', code: 'target_clarification_required' } });
    scriptModelTurns([[adjustByName], [{ type: 'text', text: 'Which product?' }]]);
    await withServer(async (baseUrl) => {
      const { body } = await post(baseUrl, 'query', { prompt: 'Order 78 oz of Zentrovex', context: 'procurement', pageData: { route: '/admin/inventory' } });
      expect(body.pendingActions || []).toEqual([]);
    });
    expect(mockCreatePendingAction).not.toHaveBeenCalled();
    expect(modelSaw()).toContain('"is_error":true');
  });

  test('a single exact product keeps the normal card', async () => {
    mockStockTarget.mockResolvedValue({ productId: PRODUCT_A });
    scriptModelTurns([[{ ...adjustByName, input: { product_id: PRODUCT_A, ...MOVEMENT } }], [{ type: 'text', text: 'Confirm it.' }]]);
    await withServer(async (baseUrl) => {
      const { body } = await post(baseUrl, 'query', { prompt: 'Add 78 oz of Zentrovex 10% SC', context: 'procurement', pageData: { route: '/admin/inventory' } });
      expect(body.pendingActions[0].contract.product_choices).toBeUndefined();
      expect(body.pendingActions[0].contract.effects.map((e) => e.label)).toContain('Zentrovex 10% SC: restock 78 fl_oz; on hand 20 → 98 fl_oz');
    });
    expect(mockCreatePendingAction.mock.calls[0][0].params.product_id).toBe(PRODUCT_A);
  });

  test('a picker card cannot run through /confirm-action', async () => {
    mockClaimForConfirm.mockResolvedValue({ action: { ...pickerRow(), status: 'confirmed' } });
    await withServer(async (baseUrl) => {
      const { status, body } = await post(baseUrl, 'confirm-action', { pending_action_id: CHOICE_ID, contract_hash: 'hash-choice' });
      expect(status).toBe(409);
      expect(body).toMatchObject({ code: 'product_choice_required', written: false });
    });
    expect(mockExecuteProcurementTool).not.toHaveBeenCalled();
  });
});

describe('/choose-product', () => {
  test('a listed product uses up the picker and proposes the exact card for that product; nothing is written', async () => {
    mockGetPendingRow.mockResolvedValue(pickerRow());
    mockClaimForConfirm.mockResolvedValue({ action: { ...pickerRow(), status: 'confirmed' } });
    await withServer(async (baseUrl) => {
      const { status, body } = await post(baseUrl, 'choose-product', { pending_action_id: CHOICE_ID, contract_hash: 'hash-choice', product_id: PRODUCT_B.toUpperCase() });
      expect(status).toBe(200);
      expect(body.pendingAction.id).toBe(NEW_ID);
      expect(body.pendingAction.contract.effects.map((e) => e.label)).toContain('Zentrovex 20% SC: restock 78 fl_oz; on hand 0 → 78 fl_oz');
      expect(body.pendingAction.contract.product_choices).toBeUndefined();
    });
    expect(mockClaimForConfirm).toHaveBeenCalledWith(CHOICE_ID, 'admin-1', expect.objectContaining({ contractHash: 'hash-choice' }));
    const proposed = mockCreatePendingAction.mock.calls[0][0];
    expect(proposed.params).toMatchObject({ product_id: PRODUCT_B, ...MOVEMENT });
    expect(proposed.params.product_name).toBeUndefined();
    expect(proposed.params._ib_product_choices).toBeUndefined();
    // The pick is the grounding: the stock layer gets the stored product, no free text.
    expect(mockStockTarget).toHaveBeenCalledWith(expect.objectContaining({ grounded: { productId: PRODUCT_B } }));
    // The claim and the new card share one transaction.
    expect(mockClaimForConfirm.mock.calls[0][2]).toMatchObject({ trx: { isTrx: true } });
    expect(proposed.trx).toEqual({ isTrx: true });
    expect(confirmedCalls()).toHaveLength(0);
    expect(mockRecordResult).toHaveBeenCalledWith(CHOICE_ID, expect.objectContaining({ success: true, written: false, chosen_product_id: PRODUCT_B }),
      { database: { isTrx: true } });
    // The receipt reaches the model on task resume: it never carries the new card's id.
    expect(JSON.stringify(mockRecordResult.mock.calls)).not.toContain(NEW_ID);
    expect(proposed.params._ib_chosen_from).toBe(CHOICE_ID);
    expect(proposed.taskId).toBeUndefined();
  });

  test.each([
    ['a product the card never listed', FORGED],
    ['not an id at all', 'Zentrovex 20% SC'],
  ])('%s is refused and the card stays usable', async (_label, productId) => {
    mockGetPendingRow.mockResolvedValue(pickerRow());
    await withServer(async (baseUrl) => {
      const { status } = await post(baseUrl, 'choose-product', { pending_action_id: CHOICE_ID, contract_hash: 'hash-choice', product_id: productId });
      expect([400, 409]).toContain(status);
    });
    expect(mockClaimForConfirm).not.toHaveBeenCalled();
    expect(mockCreatePendingAction).not.toHaveBeenCalled();
    expect(mockExecuteProcurementTool).not.toHaveBeenCalled();
  });

  test('a refusal while making the new card rolls the choice back: nothing is recorded and the card stays usable', async () => {
    mockGetPendingRow.mockResolvedValue(pickerRow());
    mockClaimForConfirm.mockResolvedValue({ action: { ...pickerRow(), status: 'confirmed' } });
    mockExecuteProcurementTool.mockResolvedValueOnce({ error: 'Cannot convert fl_oz to lb', code: 'invalid_input' });
    await withServer(async (baseUrl) => {
      const { status, body } = await post(baseUrl, 'choose-product', { pending_action_id: CHOICE_ID, contract_hash: 'hash-choice', product_id: PRODUCT_A });
      expect(status).toBe(409);
      expect(body.error).toBe('Cannot convert fl_oz to lb');
    });
    expect(mockRecordResult).not.toHaveBeenCalled();
    expect(mockCreatePendingAction).not.toHaveBeenCalled();
    expect(mockAttachThread).not.toHaveBeenCalled();
  });

  test('an unlisted id names the reason', async () => {
    mockGetPendingRow.mockResolvedValue(pickerRow());
    await withServer(async (baseUrl) => {
      const { status, body } = await post(baseUrl, 'choose-product', { pending_action_id: CHOICE_ID, contract_hash: 'hash-choice', product_id: FORGED });
      expect(status).toBe(409);
      expect(body.code).toBe('product_not_offered');
    });
  });

  test('a card with no shortlist, or a stale contract, chooses nothing', async () => {
    mockGetPendingRow.mockResolvedValueOnce(pickerRow({ params: { product_id: PRODUCT_A, ...MOVEMENT } }));
    mockGetPendingRow.mockResolvedValueOnce(pickerRow());
    mockClaimForConfirm.mockResolvedValue({ error: 'contract_mismatch' });
    await withServer(async (baseUrl) => {
      const plain = await post(baseUrl, 'choose-product', { pending_action_id: CHOICE_ID, product_id: PRODUCT_A });
      expect(plain.body.code).toBe('not_a_product_choice');
      const stale = await post(baseUrl, 'choose-product', { pending_action_id: CHOICE_ID, contract_hash: 'old', product_id: PRODUCT_A });
      expect(stale.status).toBe(409);
    });
    expect(mockCreatePendingAction).not.toHaveBeenCalled();
  });
});

describe('/choose-product replay and history', () => {
  const nextRow = { id: NEW_ID, tool_name: 'adjust_stock', status: 'pending', summary: 'adjust_stock', contract_hash: 'hash-next',
    contract: { action_label: 'Adjust inventory stock', effects: [] }, expires_at: new Date(Date.now() + 300000).toISOString() };

  test('a retry after a lost response gets the card the same choice already made', async () => {
    mockGetPendingRow.mockResolvedValue(pickerRow({ status: 'confirmed', result: { success: true, chosen_product_id: PRODUCT_B } }));
    mockFindDerivedCard.mockResolvedValue({ ...nextRow, params: { product_id: PRODUCT_B, _ib_chosen_from: CHOICE_ID } });
    mockClaimForConfirm.mockResolvedValue({ error: 'already_used' });
    await withServer(async (baseUrl) => {
      const replay = await post(baseUrl, 'choose-product', { pending_action_id: CHOICE_ID, contract_hash: 'hash-choice', product_id: PRODUCT_B });
      expect(replay.status).toBe(200);
      expect(replay.body).toMatchObject({ replayed: true, pendingAction: { id: NEW_ID, contract_hash: 'hash-next' } });
      const other = await post(baseUrl, 'choose-product', { pending_action_id: CHOICE_ID, contract_hash: 'hash-choice', product_id: PRODUCT_A });
      expect(other.status).toBe(409);
      expect(other.body.pendingAction).toBeUndefined();
    });
    expect(mockFindDerivedCard).toHaveBeenCalledWith('_ib_chosen_from', CHOICE_ID, 'admin-1');
    expect(mockCreatePendingAction).not.toHaveBeenCalled();
    expect(mockExecuteProcurementTool).not.toHaveBeenCalled();
  });

  test('a task picker hands its step to the chosen card, so the task waits for that card', async () => {
    const ctx = { targets: [], requestedRecords: {} };
    // Task scope rules are covered by the Postgres suite; here only the hand-off.
    const validate = jest.spyOn(require('../services/intelligence-bar/task-context'), 'validateRecordTarget').mockResolvedValue(null);
    const row = pickerRow({ task_id: 'task-9', params: { ...pickerRow().params, _ib_task_context: ctx } });
    mockGetPendingRow.mockResolvedValue(row);
    mockClaimForConfirm.mockResolvedValue({ action: { ...row, status: 'confirmed' } });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, 'choose-product', { pending_action_id: CHOICE_ID, contract_hash: 'hash-choice', product_id: PRODUCT_A });
      expect([res.status, res.body.error]).toEqual([200, undefined]);
    });
    expect(mockCreatePendingAction.mock.calls[0][0]).toMatchObject({ taskId: 'task-9', inheritedTask: true });
    expect(mockCreatePendingAction.mock.calls[0][0].params._ib_task_context).toMatchObject({ requestedRecords: { product_id: PRODUCT_A } });
    validate.mockRestore();
  });

  test('the card a choice makes joins the picker card thread exchange', async () => {
    const row = pickerRow({ thread_id: 'thread-1', thread_turn_seq: 4 });
    mockGetPendingRow.mockResolvedValue(row);
    mockClaimForConfirm.mockResolvedValue({ action: { ...row, status: 'confirmed' } });
    await withServer(async (baseUrl) => {
      expect((await post(baseUrl, 'choose-product', { pending_action_id: CHOICE_ID, contract_hash: 'hash-choice', product_id: PRODUCT_A })).status).toBe(200);
    });
    expect(mockAttachThread).toHaveBeenCalledWith([NEW_ID], 'thread-1', 4, 'admin-1');
  });
});

describe('/show-again', () => {
  const expiredStock = () => ({
    id: CHOICE_ID, tool_name: 'adjust_stock', status: 'pending', context: 'procurement',
    params: { product_id: PRODUCT_A, ...MOVEMENT, _two_step_preview_fingerprint: 'old-print', _ib_owner_direct: false },
  });

  test('an expired stock card is proposed again with fresh pins and never written', async () => {
    mockGetPendingRow.mockResolvedValue(expiredStock());
    mockRetireExpiredAction.mockResolvedValue({ ...expiredStock(), status: 'cancelled' });
    await withServer(async (baseUrl) => {
      const { status, body } = await post(baseUrl, 'show-again', { pending_action_id: CHOICE_ID });
      expect(status).toBe(200);
      expect(body.pendingAction.id).toBe(NEW_ID);
      expect(body.pendingAction.contract.effects.map((e) => e.label)).toContain('Zentrovex 10% SC: restock 78 fl_oz; on hand 20 → 98 fl_oz');
    });
    // Retired inside the same transaction that stores the new card.
    expect(mockRetireExpiredAction).toHaveBeenCalledWith(CHOICE_ID, 'admin-1', { trx: { isTrx: true } });
    expect(mockCreatePendingAction.mock.calls[0][0].trx).toEqual({ isTrx: true });
    const previewInput = mockExecuteProcurementTool.mock.calls[0][1];
    expect(Object.keys(previewInput).some((k) => k.startsWith('_'))).toBe(false);
    const stored = mockCreatePendingAction.mock.calls[0][0].params;
    expect(stored._two_step_preview_fingerprint).not.toBe('old-print');
    expect(stored._ib_shown_from).toBe(CHOICE_ID);
    expect(mockStockTarget).toHaveBeenCalledWith(expect.objectContaining({ grounded: { productId: PRODUCT_A, requestId: null } }));
    expect(confirmedCalls()).toHaveLength(0);
  });

  test('a retry after a lost Show again response gets the card it already made', async () => {
    mockGetPendingRow.mockResolvedValue({ ...expiredStock(), status: 'cancelled' });
    mockRetireExpiredAction.mockResolvedValue(null);
    mockFindDerivedCard.mockResolvedValue({ id: NEW_ID, tool_name: 'adjust_stock', summary: 's', contract_hash: 'hash-new',
      contract: { action_label: 'Adjust inventory stock', effects: [] }, expires_at: new Date(Date.now() + 300000).toISOString(),
      params: { product_id: PRODUCT_A, _ib_shown_from: CHOICE_ID } });
    await withServer(async (baseUrl) => {
      const { status, body } = await post(baseUrl, 'show-again', { pending_action_id: CHOICE_ID });
      expect(status).toBe(200);
      expect(body).toMatchObject({ replayed: true, pendingAction: { id: NEW_ID, contract_hash: 'hash-new' } });
    });
    expect(mockFindDerivedCard).toHaveBeenCalledWith('_ib_shown_from', CHOICE_ID, 'admin-1');
    expect(mockCreatePendingAction).not.toHaveBeenCalled();
  });

  test('a card that is not expired, or was decided, is not shown again', async () => {
    mockGetPendingRow.mockResolvedValue(expiredStock());
    mockRetireExpiredAction.mockResolvedValue(null);
    await withServer(async (baseUrl) => {
      const { status, body } = await post(baseUrl, 'show-again', { pending_action_id: CHOICE_ID });
      expect(status).toBe(409);
      expect(body.code).toBe('not_expired');
    });
    expect(mockExecuteProcurementTool).not.toHaveBeenCalled();
    expect(mockCreatePendingAction).not.toHaveBeenCalled();
  });

  test('a fresh refusal shows as a normal refusal', async () => {
    mockGetPendingRow.mockResolvedValue(expiredStock());
    mockRetireExpiredAction.mockResolvedValue({ ...expiredStock(), status: 'cancelled' });
    mockExecuteProcurementTool.mockResolvedValue({ error: 'Product not found', code: 'product_not_found' });
    await withServer(async (baseUrl) => {
      const { status, body } = await post(baseUrl, 'show-again', { pending_action_id: CHOICE_ID });
      expect(status).toBe(409);
      expect(body.error).toBe('Product not found');
    });
    // A re-proposal never turns into a picker on its own.
    expect(mockChoiceCard).not.toHaveBeenCalled();
    expect(mockCreatePendingAction).not.toHaveBeenCalled();
  });

  test('an expired picker card re-lists its own products with fresh numbers', async () => {
    mockGetPendingRow.mockResolvedValue(pickerRow());
    mockRetireExpiredAction.mockResolvedValue({ ...pickerRow(), status: 'cancelled' });
    await withServer(async (baseUrl) => {
      const { status, body } = await post(baseUrl, 'show-again', { pending_action_id: CHOICE_ID });
      expect(status).toBe(200);
      expect(body.pendingAction.contract.product_choices).toHaveLength(2);
    });
    expect(mockChoiceCard).toHaveBeenCalledWith(expect.objectContaining({ seedIds: [PRODUCT_A, PRODUCT_B] }));
    expect(mockChoiceCard.mock.calls[0][0].prompt).toBeUndefined();
    expect(mockCreatePendingAction.mock.calls[0][0].params._ib_product_choices).toEqual([PRODUCT_A, PRODUCT_B]);
    expect(mockExecuteProcurementTool).not.toHaveBeenCalled();
  });

  test('a task-owned card is not shown again outside its task', async () => {
    mockGetPendingRow.mockResolvedValue({ ...expiredStock(), task_id: 'task-1' });
    await withServer(async (baseUrl) => {
      const { status, body } = await post(baseUrl, 'show-again', { pending_action_id: CHOICE_ID });
      expect(status).toBe(409);
      expect(body).toMatchObject({ code: 'task_owned', error: 'This card belongs to a task — continue it from the task.' });
    });
    expect(mockRetireExpiredAction).not.toHaveBeenCalled();
    expect(mockCreatePendingAction).not.toHaveBeenCalled();
  });

  test('a shown-again card joins the expired card thread exchange', async () => {
    const row = { ...expiredStock(), thread_id: 'thread-2', thread_turn_seq: 7 };
    mockGetPendingRow.mockResolvedValue(row);
    mockRetireExpiredAction.mockResolvedValue({ ...row, status: 'cancelled' });
    await withServer(async (baseUrl) => {
      expect((await post(baseUrl, 'show-again', { pending_action_id: CHOICE_ID })).status).toBe(200);
    });
    expect(mockAttachThread).toHaveBeenCalledWith([NEW_ID], 'thread-2', 7, 'admin-1');
  });

  test('an expired rate change comes back with the service the operator chose (its pinned family)', async () => {
    const CUSTOMER = '9a0c8f1e-0000-4000-8000-0000000000c1';
    require('../services/intelligence-bar/tools').UPDATABLE_FIELDS.monthly_rate = 'monthly_rate';
    const rateChange = require('../services/intelligence-bar/rate-change');
    const proposal = jest.spyOn(rateChange, 'rateChangeProposal').mockResolvedValue({ family: 'lawn', pin: 'fresh-pin', display: null });
    mockResolveCommsCustomer.mockResolvedValue({ id: CUSTOMER, first_name: 'Synthetic', last_name: 'Owner' });
    const row = { id: CHOICE_ID, tool_name: 'update_customer', status: 'pending', context: 'customers',
      params: { customer_id: CUSTOMER, updates: { monthly_rate: 120 }, _rate_family: 'lawn', _rate_ledger_pin: 'old-pin' } };
    mockGetPendingRow.mockResolvedValue(row);
    mockRetireExpiredAction.mockResolvedValue({ ...row, status: 'cancelled' });
    try {
      await withServer(async (baseUrl) => {
        const { status, body } = await post(baseUrl, 'show-again', { pending_action_id: CHOICE_ID });
        expect([status, body.error]).toEqual([200, undefined]);
      });
      expect(proposal).toHaveBeenCalledWith(CUSTOMER, 120, 'lawn');
      expect(mockCreatePendingAction.mock.calls[0][0].params).toMatchObject({ _rate_family: 'lawn', _rate_ledger_pin: 'fresh-pin' });
      expect(mockCreatePendingAction.mock.calls[0][0].params.rate_service).toBeUndefined();
    } finally {
      proposal.mockRestore();
      delete require('../services/intelligence-bar/tools').UPDATABLE_FIELDS.monthly_rate;
    }
  });

  test('another operator card is not found', async () => {
    mockGetPendingRow.mockResolvedValue(null);
    await withServer(async (baseUrl) => {
      const { status } = await post(baseUrl, 'show-again', { pending_action_id: CHOICE_ID });
      expect(status).toBe(404);
    });
    expect(mockRetireExpiredAction).not.toHaveBeenCalled();
  });
});
