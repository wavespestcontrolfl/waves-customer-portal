jest.mock('../models/db', () => {
  const db = jest.fn();
  db.transaction = jest.fn(async (run) => run(db));
  db.raw = jest.fn((sql) => ({ sql }));
  db.fn = { now: () => 'NOW()' };
  return db;
});
jest.mock('../services/estimate-extension', () => ({ fixedBidBlocksExtension: jest.fn(async () => false), extendEstimate: jest.fn() }));

const db = require('../models/db');
const { fixedBidBlocksExtension } = require('../services/estimate-extension');
const { claimEstimateExtensionRequest } = require('../routes/estimate-public');

function table(row, updated = 1) {
  const b = {};
  for (const m of ['where', 'whereRaw', 'orWhere', 'whereNull', 'forUpdate']) b[m] = jest.fn((k) => { if (typeof k === 'function') k(b); return b; });
  b.first = jest.fn(async () => row);
  b.update = jest.fn(async () => updated);
  return b;
}

// Same builder, but `.first()` returns a DIFFERENT row on the re-read after
// `.forUpdate()` than on the initial peek — models a concurrent group change
// landing between the peek and the post-lock re-read.
function tableWithReread(peekedRow, rereadRow, updated = 1) {
  const b = {};
  for (const m of ['where', 'whereRaw', 'orWhere', 'whereNull']) b[m] = jest.fn((k) => { if (typeof k === 'function') k(b); return b; });
  let rereadNext = false;
  b.forUpdate = jest.fn(() => { rereadNext = true; return b; });
  b.first = jest.fn(async () => (rereadNext ? rereadRow : peekedRow));
  b.update = jest.fn(async () => updated);
  return b;
}
const dedupe = (b) => b.whereNull('extension_requested_at');

describe('notify-only extension claim (GH codex P1 r5 on #4309)', () => {
  beforeEach(() => { jest.clearAllMocks(); fixedBidBlocksExtension.mockResolvedValue(false); });
  test('a grouped row takes the group lock, re-judges the CURRENT group, and only then burns the dedupe window', async () => {
    const b = table({ id: 'e1', estimate_group_id: 'g1', estimate_data: {} });
    db.mockReturnValue(b);
    await expect(claimEstimateExtensionRequest('e1', dedupe)).resolves.toEqual({ claimed: 1, blocked: false });
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(db.raw).toHaveBeenCalledWith(expect.stringMatching(/pg_advisory_xact_lock/), ['estimate-group-send', 'g1']);
    expect(fixedBidBlocksExtension).toHaveBeenCalledWith(db, expect.objectContaining({ estimate_group_id: 'g1' }));
    expect(b.update).toHaveBeenCalledWith({ extension_requested_at: 'NOW()' });
  });
  test('a fixed hold that appeared since the preflight blocks BEFORE the claim — nothing is burned, the answer is the generic 404', async () => {
    const b = table({ id: 'e1', estimate_group_id: 'g1', estimate_data: {} });
    db.mockReturnValue(b);
    fixedBidBlocksExtension.mockResolvedValue(true);
    await expect(claimEstimateExtensionRequest('e1', dedupe)).resolves.toEqual({ claimed: 0, blocked: true });
    expect(b.update).not.toHaveBeenCalled();
  });
  test('an ungrouped row takes no group lock; a lost dedupe race is a plain zero, not a block', async () => {
    const b = table({ id: 'e2', estimate_group_id: null, estimate_data: {} }, 0);
    db.mockReturnValue(b);
    await expect(claimEstimateExtensionRequest('e2', dedupe)).resolves.toEqual({ claimed: 0, blocked: false });
    expect(db.raw).not.toHaveBeenCalledWith(expect.stringMatching(/pg_advisory_xact_lock/), expect.anything());
  });
  test('a row that vanished is a block', async () => {
    db.mockReturnValue(table(null));
    await expect(claimEstimateExtensionRequest('gone', dedupe)).resolves.toEqual({ claimed: 0, blocked: true });
  });
  test('a group change between the peek and the post-lock re-read blocks — the stale peek is never judged or claimed on (GH codex P1 r6 on #4309)', async () => {
    const peeked = { id: 'e1', estimate_group_id: 'g1', estimate_data: {} };
    const reread = { id: 'e1', estimate_group_id: 'g2', estimate_data: {} };
    const b = tableWithReread(peeked, reread);
    db.mockReturnValue(b);
    await expect(claimEstimateExtensionRequest('e1', dedupe)).resolves.toEqual({ claimed: 0, blocked: true });
    // Locked the group seen at the peek (g1), then re-read FOR UPDATE and
    // found the row has since moved to g2 — refused before any fixed-hold
    // check or claim on either group's stale/new state.
    expect(db.raw).toHaveBeenCalledWith(expect.stringMatching(/pg_advisory_xact_lock/), ['estimate-group-send', 'g1']);
    expect(fixedBidBlocksExtension).not.toHaveBeenCalled();
    expect(b.update).not.toHaveBeenCalled();
  });
  test('an ungrouped proposal that gains a fixed hold while waiting for the row lock cannot burn the claim', async () => {
    const peeked = { id: 'e1', estimate_group_id: null, estimate_data: {} };
    const fresh = { ...peeked, estimate_data: { proposal: { enabled: true, validThrough: '2099-12-31' } } };
    const b = tableWithReread(peeked, fresh);
    db.mockReturnValue(b);
    fixedBidBlocksExtension.mockImplementation(async (_conn, row) => Boolean(row.estimate_data.proposal?.validThrough));
    await expect(claimEstimateExtensionRequest('e1', dedupe)).resolves.toEqual({ claimed: 0, blocked: true });
    expect(b.forUpdate).toHaveBeenCalledTimes(1);
    expect(fixedBidBlocksExtension).toHaveBeenCalledWith(db, fresh);
    expect(b.update).not.toHaveBeenCalled();
  });
  test('an initially ungrouped row moved into a group while waiting refuses before checking or claiming', async () => {
    const peeked = { id: 'e1', estimate_group_id: null, estimate_data: {} };
    const b = tableWithReread(peeked, { ...peeked, estimate_group_id: 'new-group' });
    db.mockReturnValue(b);
    await expect(claimEstimateExtensionRequest('e1', dedupe)).resolves.toEqual({ claimed: 0, blocked: true });
    expect(fixedBidBlocksExtension).not.toHaveBeenCalled();
    expect(b.update).not.toHaveBeenCalled();
  });

  test.each([false, true])('a locked annual rewrite blocks claim before any stamp (auto-grant: %s)', async (autoGrant) => {
    const priorAnnual = process.env.GATE_TERMITE_ANNUAL_PLAN;
    const priorCancellation = process.env.GATE_CANCEL_FLOW_V2;
    process.env.GATE_CANCEL_FLOW_V2 = 'true';
    delete process.env.GATE_TERMITE_ANNUAL_PLAN;
    try {
      const quarterly = { id: 'e1', status: 'sent', estimate_group_id: 'g1',
        estimate_data: { result: { results: { tmBait: { plan: 'quarterly' } } } } };
      const annual = { ...quarterly, estimate_data: { result: { results: { tmBait: { plan: 'annual_protection' } } } } };
      const b = tableWithReread(quarterly, annual);
      db.mockReturnValue(b);
      await expect(claimEstimateExtensionRequest('e1', dedupe, autoGrant))
        .resolves.toEqual({ claimed: 0, blocked: true });
      expect(b.forUpdate).toHaveBeenCalledTimes(1);
      expect(fixedBidBlocksExtension).not.toHaveBeenCalled();
      expect(b.update).not.toHaveBeenCalled();
    } finally {
      if (priorAnnual === undefined) delete process.env.GATE_TERMITE_ANNUAL_PLAN;
      else process.env.GATE_TERMITE_ANNUAL_PLAN = priorAnnual;
      if (priorCancellation === undefined) delete process.env.GATE_CANCEL_FLOW_V2;
      else process.env.GATE_CANCEL_FLOW_V2 = priorCancellation;
    }
  });

  test('the auto-grant claim atomically records both lifetime and dedupe stamps', async () => {
    const b = table({ id: 'e1', status: 'sent', estimate_group_id: null, estimate_data: {} });
    db.mockReturnValue(b);
    await expect(claimEstimateExtensionRequest('e1', dedupe, true))
      .resolves.toEqual({ claimed: 1, blocked: false });
    expect(b.whereNull).toHaveBeenCalledWith('extension_auto_granted_at');
    expect(b.update).toHaveBeenCalledWith({
      extension_requested_at: 'NOW()', extension_auto_granted_at: 'NOW()',
    });
  });

  test.each(['claim', 'service'])('the public route hides an annual %s refusal behind the generic 404', async (phase) => {
    const priorAnnual = process.env.GATE_TERMITE_ANNUAL_PLAN;
    delete process.env.GATE_TERMITE_ANNUAL_PLAN;
    const token = 'estimate-auto-race';
    const quarterly = { id: 'e1', token, status: 'expired', sent_at: '2026-09-01T12:00:00Z',
      expires_at: '2026-09-02T12:00:00Z', estimate_group_id: null,
      estimate_data: { result: { results: { tmBait: { plan: 'quarterly' } } } } };
    const annual = { ...quarterly,
      estimate_data: { result: { results: { tmBait: { plan: 'annual_protection' } } } } };
    const b = tableWithReread(quarterly, phase === 'claim' ? annual : quarterly);
    db.mockReturnValue(b);
    if (phase === 'service') {
      const annualError = Object.assign(new Error('Annual offer changed'), {
        statusCode: 409, code: 'TERMITE_ANNUAL_PLAN_DISABLED',
      });
      require('../services/estimate-extension').extendEstimate.mockRejectedValueOnce(annualError);
    }
    const express = require('express');
    const app = express();
    app.use('/api/estimates', require('../routes/estimate-public'));
    app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ error: err.message }));
    const server = await new Promise((resolve) => { const listening = app.listen(0, () => resolve(listening)); });
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/estimates/${token}/extension-request`, { method: 'POST' });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'Estimate not found' });
      if (phase === 'claim') expect(b.update).not.toHaveBeenCalled();
      else expect(b.update).toHaveBeenCalledWith({ extension_requested_at: null, extension_auto_granted_at: null });
    } finally {
      await new Promise((resolve) => server.close(resolve));
      if (priorAnnual === undefined) delete process.env.GATE_TERMITE_ANNUAL_PLAN;
      else process.env.GATE_TERMITE_ANNUAL_PLAN = priorAnnual;
    }
  });

});
