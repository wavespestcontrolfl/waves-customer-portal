jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/audit-log', () => ({
  auditHygieneProposalApply: jest.fn(async () => 'audit-1'),
}));
jest.mock('../services/notification-service', () => ({
  notifyAdmin: jest.fn(async () => undefined),
}));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));

const { isEnabled } = require('../config/feature-gates');
const { auditHygieneProposalApply } = require('../services/audit-log');
const NotificationService = require('../services/notification-service');
const {
  runAutoApplySweep,
  applyNormalizationProposal,
  isAutoApplyEligible,
  _test: { valuesEqual, parseEvidence },
} = require('../services/data-hygiene/auto-apply');

const greenProposal = (o = {}) => ({
  id: 'prop-1',
  status: 'pending',
  source: 'normalization',
  is_sensitive: false,
  tier: 'high',
  confidence: '0.990',
  resource_type: 'customer',
  resource_id: 'cust-1',
  scope_type: 'customer',
  scope_id: 'cust-1',
  field: 'email',
  current_value: ' Bob@Example.COM ',
  proposed_value: 'bob@example.com',
  rule_id: 'email.lowercase_trim',
  rule_version: 1,
  evidence: { auto_apply_eligible: true },
  ...o,
});

describe('isAutoApplyEligible (the green bar)', () => {
  test('green normalization proposal passes', () => {
    expect(isAutoApplyEligible(greenProposal()).eligible).toBe(true);
  });
  test.each([
    ['not pending', { status: 'approved' }, 'not_pending'],
    ['sensitive', { is_sensitive: true }, 'sensitive'],
    ['extraction source', { source: 'extraction' }, 'not_normalization'],
    ['medium tier', { tier: 'medium' }, 'tier_not_high'],
    ['below confidence floor', { confidence: '0.90' }, 'below_confidence_floor'],
    ['unknown resource type', { resource_type: 'property_preferences' }, 'unknown_resource_type'],
    ['field not allowlisted', { field: 'notes' }, 'field_not_allowlisted'],
    ['evidence not marked eligible', { evidence: { auto_apply_eligible: false } }, 'not_marked_eligible'],
    ['missing evidence flag', { evidence: {} }, 'not_marked_eligible'],
    ['empty proposed value', { proposed_value: '' }, 'empty_proposed_value'],
    ['null proposed value', { proposed_value: null }, 'empty_proposed_value'],
  ])('%s -> ineligible', (_label, overrides, reason) => {
    const verdict = isAutoApplyEligible(greenProposal(overrides));
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toBe(reason);
  });
  test('customer_account state field NOT allowlisted (accounts have no state column)', () => {
    const verdict = isAutoApplyEligible(greenProposal({ resource_type: 'customer_account', field: 'state' }));
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toBe('field_not_allowlisted');
  });
  test('malformed JSON evidence fails closed', () => {
    const verdict = isAutoApplyEligible(greenProposal({ evidence: '{not json' }));
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toBe('not_marked_eligible');
  });
  test('stringified JSON evidence parses (jsonb comes back as object, text as string)', () => {
    expect(isAutoApplyEligible(greenProposal({ evidence: '{"auto_apply_eligible":true}' })).eligible).toBe(true);
  });
});

describe('valuesEqual / parseEvidence', () => {
  test('null == undefined', () => expect(valuesEqual(null, undefined)).toBe(true));
  test('string vs number compares as string', () => expect(valuesEqual(5, '5')).toBe(true));
  test('null vs value differs', () => expect(valuesEqual(null, 'x')).toBe(false));
  test('parseEvidence null -> {}', () => expect(parseEvidence(null)).toEqual({}));
  test('parseEvidence malformed -> null', () => expect(parseEvidence('{')).toBe(null));
});

function makeTrx({ targetRow, proposalRow }) {
  const updates = [];
  const trx = jest.fn((table) => {
    const q = {};
    q.where = jest.fn(() => q);
    q.forUpdate = jest.fn(() => q);
    q.first = jest.fn(async () => (table === 'data_hygiene_proposals' ? proposalRow : targetRow));
    q.update = jest.fn(async (patch) => {
      updates.push({ table, patch });
      return 1;
    });
    return q;
  });
  trx.fn = { now: () => 'NOW' };
  trx._updates = updates;
  return trx;
}

describe('applyNormalizationProposal', () => {
  beforeEach(() => jest.clearAllMocks());

  test('applies when live value matches, audits, stamps auto_applied for auto', async () => {
    const proposal = greenProposal();
    const trx = makeTrx({ targetRow: { id: 'cust-1', email: ' Bob@Example.COM ' }, proposalRow: proposal });
    const result = await applyNormalizationProposal({ trx, proposal, reviewedVia: 'auto' });
    expect(result.outcome).toBe('applied');
    const tableUpdate = trx._updates.find((u) => u.table === 'customers');
    expect(tableUpdate.patch.email).toBe('bob@example.com');
    const proposalUpdate = trx._updates.find((u) => u.table === 'data_hygiene_proposals');
    expect(proposalUpdate.patch.status).toBe('auto_applied');
    expect(proposalUpdate.patch.reviewed_via).toBe('auto');
    expect(auditHygieneProposalApply).toHaveBeenCalledWith(expect.objectContaining({
      is_sensitive: false,
      vault_id: null,
      reviewed_via: 'auto',
    }));
  });

  test('human path stamps approved, not auto_applied', async () => {
    const proposal = greenProposal();
    const trx = makeTrx({ targetRow: { id: 'cust-1', email: ' Bob@Example.COM ' }, proposalRow: proposal });
    await applyNormalizationProposal({ trx, proposal, reviewedVia: 'ui', reviewerId: 'tech-9' });
    const proposalUpdate = trx._updates.find((u) => u.table === 'data_hygiene_proposals');
    expect(proposalUpdate.patch.status).toBe('approved');
    expect(proposalUpdate.patch.reviewer_id).toBe('tech-9');
  });

  test('live value drifted -> marks stale, does NOT touch the target row', async () => {
    const proposal = greenProposal();
    const trx = makeTrx({ targetRow: { id: 'cust-1', email: 'changed@example.com' }, proposalRow: proposal });
    const result = await applyNormalizationProposal({ trx, proposal, reviewedVia: 'auto' });
    expect(result.outcome).toBe('stale');
    expect(trx._updates.find((u) => u.table === 'customers')).toBeUndefined();
    expect(trx._updates.find((u) => u.table === 'data_hygiene_proposals').patch.status).toBe('stale');
    expect(auditHygieneProposalApply).not.toHaveBeenCalled();
  });

  test('target row missing -> stale, no crash', async () => {
    const proposal = greenProposal();
    const trx = makeTrx({ targetRow: undefined, proposalRow: proposal });
    const result = await applyNormalizationProposal({ trx, proposal, reviewedVia: 'auto' });
    expect(result.outcome).toBe('stale');
  });
});

describe('runAutoApplySweep', () => {
  function makeDbi({ candidates, proposalRows }) {
    const dbi = jest.fn((table) => {
      const q = {};
      q.where = jest.fn(() => q);
      q.orderBy = jest.fn(() => q);
      q.limit = jest.fn(async () => candidates);
      q.count = jest.fn(() => q);
      q.first = jest.fn(async () => ({ n: 3 }));
      return q;
    });
    dbi.transaction = jest.fn(async (fn) => {
      const id = dbi._txnCount || 0;
      dbi._txnCount = id + 1;
      const proposal = proposalRows[id];
      const trx = makeTrx({
        targetRow: proposal ? { id: proposal.resource_id, [proposal.field]: proposal.current_value } : undefined,
        proposalRow: proposal,
      });
      dbi._lastTrx = trx;
      return fn(trx);
    });
    return dbi;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    isEnabled.mockReturnValue(true);
  });

  test('gate off -> no-op', async () => {
    isEnabled.mockReturnValue(false);
    const result = await runAutoApplySweep({ dbi: jest.fn() });
    expect(result).toEqual({ skipped: 'gate_off' });
  });

  test('applies green candidates and sends ONE digest', async () => {
    const p1 = greenProposal({ id: 'p1' });
    const p2 = greenProposal({ id: 'p2', field: 'phone', rule_id: 'phone.e164', current_value: '(941) 555-0100', proposed_value: '+19415550100' });
    const dbi = makeDbi({ candidates: [p1, p2], proposalRows: [p1, p2] });
    const result = await runAutoApplySweep({ dbi });
    expect(result.applied).toBe(2);
    expect(result.errors).toBe(0);
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    const [category, title] = NotificationService.notifyAdmin.mock.calls[0];
    expect(category).toBe('system');
    expect(title).toContain('2 fixes auto-applied');
  });

  test('candidate reviewed by a human mid-sweep (re-check under lock) is skipped', async () => {
    const p1 = greenProposal({ id: 'p1' });
    const locked = { ...p1, status: 'rejected' };
    const dbi = makeDbi({ candidates: [p1], proposalRows: [locked] });
    const result = await runAutoApplySweep({ dbi });
    expect(result.applied).toBe(0);
    expect(result.skipped).toBe(1);
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('one failing row does not poison the batch', async () => {
    const p1 = greenProposal({ id: 'p1' });
    const p2 = greenProposal({ id: 'p2' });
    const dbi = makeDbi({ candidates: [p1, p2], proposalRows: [p1, p2] });
    dbi.transaction
      .mockImplementationOnce(async () => { throw new Error('deadlock'); });
    const result = await runAutoApplySweep({ dbi });
    expect(result.errors).toBe(1);
    expect(result.applied).toBe(1);
  });

  test('no applies -> no digest bell (quiet when nothing happened)', async () => {
    const dbi = makeDbi({ candidates: [], proposalRows: [] });
    const result = await runAutoApplySweep({ dbi });
    expect(result.applied).toBe(0);
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });
});
