/**
 * Send requires engine-authoritative pricing (validation audit SEC-002,
 * 2026-09-02).
 *
 * An admin save whose server recompute failed or had no replayable inputs
 * persists the BROWSER preview as a NON-authoritative price
 * (estimates.pricing_authority = CLIENT_FALLBACK — fail-open by design so a
 * broken engine never blocks the save). Nothing re-verified that price
 * before delivery. The FIRST send of such a row is refused while
 * GATE_SEND_REQUIRES_SERVER_PRICING is on and logged as a would-block while
 * it is off; a delivered row keeps its follow-ups and an authored proposal
 * (the manual quote) is exempt, exactly like the neighbouring gates.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

jest.mock('../models/db', () => {
  const db = jest.fn();
  db.fn = { now: jest.fn(() => 'NOW()') };
  db.raw = jest.fn((sql) => sql);
  db.transaction = jest.fn();
  return db;
});
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => next(),
  requireTechOrAdmin: (req, res, next) => next(),
  requireAdmin: (req, res, next) => next(),
}));
jest.mock('../services/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));
jest.mock('../services/short-url', () => ({ shortenOrPassthrough: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/estimate-pricing-audit', () => ({
  buildEstimatePricingAudit: jest.fn(),
  buildEstimatePricingRiskBatch: jest.fn(),
  getLatestEstimatePricingAuditSnapshot: jest.fn(),
  saveEstimatePricingAuditSnapshot: jest.fn(),
}));
jest.mock('../services/lead-estimate-link', () => ({ markLinkedLeadEstimateSent: jest.fn() }));
jest.mock('../services/estimate-manual-acceptance', () => ({ markEstimateManuallyAccepted: jest.fn() }));
jest.mock('../services/admin-estimate-persistence', () => ({
  createOrReuseAdminEstimate: jest.fn(),
  reviseAdminEstimate: jest.fn(),
  estimateExpiresAt: jest.fn(),
  estimateViewUrl: jest.fn(() => 'https://example.test/estimate/tok'),
}));
jest.mock('../services/notification-service', () => ({
  notifyAdmin: jest.fn(async () => ({})),
  notifyCustomer: jest.fn(async () => ({})),
}));
jest.mock('../services/estimate-clarify-asks', () => ({ clearEstimateRepricePending: jest.fn(async () => ({})) }));
jest.mock('../routes/estimate-public', () => ({ acceptanceServiceLists: jest.fn(), bookingServiceFor: jest.fn() }));
jest.mock('../services/email-template-library', () => ({ sendTemplate: jest.fn() }));
jest.mock('../services/sendgrid-mail', () => ({ isConfigured: jest.fn(() => false) }));

// Gate values are fixed at module load; this passthrough flips the one gate
// under test per case.
const mockGateState = { sendRequiresServerPricing: false };
jest.mock('../config/feature-gates', () => {
  const actual = jest.requireActual('../config/feature-gates');
  return {
    ...actual,
    isEnabled: (gate) => (gate === 'sendRequiresServerPricing'
      ? mockGateState.sendRequiresServerPricing
      : actual.isEnabled(gate)),
  };
});

const logger = require('../services/logger');
const adminEstimatesRouter = require('../routes/admin-estimates');
const {
  assertEstimateSendable,
  sendRequiresServerPricingFor,
  SERVER_PRICING_AUTHORITY_SQL,
  assertAutoSendPricingAuthority,
  notifyPricingFallbackAfterCommit,
  shadowLogFallbackDelivery,
  GATED_SEND_AUTHORITY_SQL,
} = adminEstimatesRouter._internals;
const { createOrReuseAdminEstimate, reviseAdminEstimate } = require('../services/admin-estimate-persistence');
const { notifyAdmin } = require('../services/notification-service');

function routeHandler(router, path, method) {
  const layer = router.stack.find((entry) => entry.route?.path === path && entry.route?.methods?.[method]);
  if (!layer) throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
function makeRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

const fallbackDraft = (extra = {}) => ({
  id: 'est-client-fallback-1',
  status: 'draft',
  token: 'tok-client-fallback-test',
  monthly_total: 87,
  sent_at: null,
  pricing_authority: 'CLIENT_FALLBACK',
  estimate_data: {
    result: { recurring: { services: [{ name: 'Pest Control', service: 'pest_control', mo: 87 }] } },
  },
  ...extra,
});

function caughtBy(row, opts) {
  try {
    assertEstimateSendable(row, opts);
    return null;
  } catch (err) {
    return err;
  }
}

describe('assertEstimateSendable — engine-authoritative pricing gate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGateState.sendRequiresServerPricing = true;
  });

  it('refuses the FIRST send of a CLIENT_FALLBACK row with 409 + code while the gate is on', () => {
    const err = caughtBy(fallbackDraft());
    expect(err).toBeTruthy();
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe('CLIENT_FALLBACK_PRICING');
    expect(err.message).toMatch(/save again/i);
  });

  it('matches the stamp case-insensitively', () => {
    expect(caughtBy(fallbackDraft({ pricing_authority: 'client_fallback' }))?.code).toBe('CLIENT_FALLBACK_PRICING');
  });

  it('lets only the explicit SERVER stamp through; unstamped or unknown stamps are refused with their own code', () => {
    expect(caughtBy(fallbackDraft({ pricing_authority: 'SERVER' }))).toBeNull();
    expect(caughtBy(fallbackDraft({ pricing_authority: 'server' }))).toBeNull();
    for (const authority of [null, undefined, '', 'SOMETHING_NEW']) {
      const err = caughtBy(fallbackDraft({ pricing_authority: authority }));
      expect(err?.statusCode).toBe(409);
      expect(err?.code).toBe('PRICING_AUTHORITY_NOT_SERVER');
      expect(err?.message).toMatch(/no engine verification stamp/i);
    }
  });

  it('blocks a delivered row too — a revision of a live link can fall back, and its resend must not deliver it', () => {
    expect(caughtBy(fallbackDraft({ status: 'sent', sent_at: '2026-09-01T12:00:00.000Z' }))?.code).toBe('CLIENT_FALLBACK_PRICING');
  });

  it('does NOT exempt a proposal blob without the authoring path\'s category stamp (legacy browser-supplied flag; GH codex P1)', () => {
    mockGateState.sendRequiresServerPricing = true;
    const forged = fallbackDraft({ estimate_data: { proposal: { enabled: true, buildings: [{ name: 'Tower A', lineItems: [] }] } } });
    expect(sendRequiresServerPricingFor(forged)).toBe(true);
    expect(sendRequiresServerPricingFor({ ...forged, category: 'RESIDENTIAL' })).toBe(true);
    // category is NOT provenance (the estimator engine and Agent Estimate
    // create COMMERCIAL rows too) — only the editor's server-owned marker is.
    expect(sendRequiresServerPricingFor({ ...forged, category: 'COMMERCIAL' })).toBe(true);
    expect(sendRequiresServerPricingFor(fallbackDraft({ estimate_data: { proposal: { enabled: true, provenance: { source: 'proposal-editor' }, buildings: [] } } }))).toBe(false);
    expect(sendRequiresServerPricingFor(fallbackDraft({ estimate_data: { proposal: { enabled: true, provenance: { source: 'browser' }, buildings: [] } } }))).toBe(true);
    expect(() => assertEstimateSendable(forged)).toThrow();
  });

  it('a proposal authored BEFORE the provenance marker stays sendable with the gate off, and fails closed at the authority gate (not as quote-required) with it on (GH codex P0 r9)', () => {
    const legacyProposal = fallbackDraft({
      category: 'COMMERCIAL',
      estimate_data: { proposal: { enabled: true, buildings: [{ name: 'Tower A', lineItems: [] }] }, result: { recurring: { services: [{ quoteRequired: true }] } } },
    });
    mockGateState.sendRequiresServerPricing = false;
    expect(() => assertEstimateSendable(legacyProposal)).not.toThrow();
    mockGateState.sendRequiresServerPricing = true;
    expect(() => assertEstimateSendable(legacyProposal)).toThrow(/pricing engine|engine-verified|verify/i);
    expect(() => assertEstimateSendable(legacyProposal)).not.toThrow(/manual review/i);
  });

  it('exempts an authored proposal — its line items ARE the quote', () => {
    expect(caughtBy(fallbackDraft({
      estimate_data: { proposal: { enabled: true, provenance: { source: 'proposal-editor' }, buildings: [{ name: 'Tower A', lineItems: [] }] } },
    }))).toBeNull();
  });

  it('with the gate off the send proceeds and the pre-read assert itself logs nothing (the funnel counts)', () => {
    mockGateState.sendRequiresServerPricing = false;
    expect(caughtBy(fallbackDraft())).toBeNull();
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringMatching(/shadow/));
  });
});

describe('shadowLogFallbackDelivery — one would-block per delivery attempt, gate off only', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('logs exactly once for a CLIENT_FALLBACK delivery while the gate is off', () => {
    mockGateState.sendRequiresServerPricing = false;
    expect(shadowLogFallbackDelivery(fallbackDraft())).toBe(true);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/shadow.*est-client-fallback-1.*CLIENT_FALLBACK/));
  });

  it('counts unstamped legacy rows too — everything the gate will refuse', () => {
    mockGateState.sendRequiresServerPricing = false;
    expect(shadowLogFallbackDelivery(fallbackDraft({ pricing_authority: null }))).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/shadow.*est-client-fallback-1.*authority NULL/));
  });

  it('stays silent for engine-priced rows, authored proposals, and while the gate is on (the assert refuses instead)', () => {
    mockGateState.sendRequiresServerPricing = false;
    expect(shadowLogFallbackDelivery(fallbackDraft({ pricing_authority: 'SERVER' }))).toBe(false);
    expect(shadowLogFallbackDelivery(fallbackDraft({ estimate_data: { proposal: { enabled: true, provenance: { source: 'proposal-editor' }, buildings: [] } } }))).toBe(false);
    mockGateState.sendRequiresServerPricing = true;
    expect(shadowLogFallbackDelivery(fallbackDraft())).toBe(false);
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringMatching(/shadow/));
  });
});

describe('GATED_SEND_AUTHORITY_SQL — the gated manual claims re-assert the WHOLE verdict in SQL on the row as it is at claim time (pre-push codex P0)', () => {
  it('is SERVER, or an authored proposal by provenance; a constant with no placeholders', () => {
    expect(GATED_SEND_AUTHORITY_SQL).toContain("UPPER(pricing_authority) = 'SERVER'");
    expect(GATED_SEND_AUTHORITY_SQL).toContain("estimate_data->'proposal'->'provenance'->>'source' = 'proposal-editor'");
    expect(GATED_SEND_AUTHORITY_SQL).not.toContain('category');
    // Strict JSONB equality to literal true — no ::boolean cast (a malformed
    // legacy value must not throw, and textual booleans must not pass).
    expect(GATED_SEND_AUTHORITY_SQL).toContain("estimate_data->'proposal'->'enabled' = 'true'::jsonb");
    expect(GATED_SEND_AUTHORITY_SQL).not.toContain('::boolean');
    expect(GATED_SEND_AUTHORITY_SQL).not.toContain('?');
  });
});

describe('sendRequiresServerPricingFor — the predicate the send CLAIMS re-assert', () => {
  // The claims add SEND_CLAIM_PRICING_AUTHORITY_SQL to their WHERE exactly
  // when this returns true, so a revision that stamps CLIENT_FALLBACK between
  // the pre-read check and the claim loses the race (pre-push codex P0).
  beforeEach(() => { mockGateState.sendRequiresServerPricing = true; });

  it('applies to a first send of an ordinary estimate while the gate is on', () => {
    expect(sendRequiresServerPricingFor(fallbackDraft())).toBe(true);
    expect(sendRequiresServerPricingFor(fallbackDraft({ pricing_authority: 'SERVER' }))).toBe(true);
  });

  it('never applies with the gate off or to an authored proposal; delivered rows are NOT exempt', () => {
    mockGateState.sendRequiresServerPricing = false;
    expect(sendRequiresServerPricingFor(fallbackDraft())).toBe(false);
    mockGateState.sendRequiresServerPricing = true;
    expect(sendRequiresServerPricingFor(fallbackDraft({ sent_at: '2026-09-01T12:00:00.000Z' }))).toBe(true);
    expect(sendRequiresServerPricingFor(fallbackDraft({
      estimate_data: { proposal: { enabled: true, provenance: { source: 'proposal-editor' }, buildings: [] } },
    }))).toBe(false);
    expect(sendRequiresServerPricingFor(fallbackDraft({
      estimate_data: JSON.stringify({ proposal: { enabled: true, provenance: { source: 'proposal-editor' }, buildings: [] } }),
    }))).toBe(false);
  });

  it('the claim predicate every gated send re-asserts requires the explicit SERVER stamp', () => {
    expect(SERVER_PRICING_AUTHORITY_SQL).toBe("UPPER(pricing_authority) = 'SERVER'");
  });
});

describe('post-commit pricing-fallback bell (SEC-002 / pre-push codex P1)', () => {
  const req = (body = {}, params = {}) => ({ body, params, technicianId: 'tech-1', technician: { id: 'tech-1' }, techRole: 'admin' });
  beforeEach(() => { jest.clearAllMocks(); });

  it('rings once per estimate after a committed create whose recompute failed, keyed for dedupe', async () => {
    createOrReuseAdminEstimate.mockResolvedValue({
      estimate: { id: 'est-cf-9', token: 'tok-cf-9', customer_id: 'cust-cf-9', customer_name: 'Pat Tester', pricing_authority: 'CLIENT_FALLBACK' },
      reused: false, memberLinkageWarning: null, pricingFallbackReason: 'ENGINE_ERROR',
    });
    const res = makeRes();
    await routeHandler(adminEstimatesRouter, '/', 'post')(req({}), res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(201);
    expect(notifyAdmin).toHaveBeenCalledTimes(1);
    expect(notifyAdmin).toHaveBeenCalledWith(
      'estimate',
      expect.stringContaining('Estimate saved without engine pricing'),
      expect.stringContaining('client fallback'),
      expect.objectContaining({ bell: true, dedupeKey: 'estimate-pricing-fallback:est-cf-9', dedupeWindowMs: 6 * 60 * 60 * 1000, metadata: expect.objectContaining({ estimateId: 'est-cf-9', customerId: 'cust-cf-9', reason: 'ENGINE_ERROR' }) }),
    );
  });

  it('stays silent for a server-priced create and for a NO_INPUTS fallback', async () => {
    createOrReuseAdminEstimate.mockResolvedValue({ estimate: { id: 'est-ok', token: 't' }, reused: false, memberLinkageWarning: null, pricingFallbackReason: null });
    await routeHandler(adminEstimatesRouter, '/', 'post')(req({}), makeRes(), jest.fn());
    createOrReuseAdminEstimate.mockResolvedValue({ estimate: { id: 'est-legacy', token: 't' }, reused: false, memberLinkageWarning: null, pricingFallbackReason: 'NO_INPUTS' });
    await routeHandler(adminEstimatesRouter, '/', 'post')(req({}), makeRes(), jest.fn());
    expect(notifyAdmin).not.toHaveBeenCalled();
  });

  it('a dryRun revise preflight never rings; the committed revise does', async () => {
    const revised = { id: 'est-cf-7', token: 'tok-cf-7', status: 'draft', customer_name: 'Pat Tester' };
    reviseAdminEstimate.mockResolvedValue({ estimate: revised, dryRun: true, memberLinkageWarning: null, pricingFallbackReason: 'ENGINE_ERROR' });
    await routeHandler(adminEstimatesRouter, '/:id', 'put')(req({ dryRun: true }, { id: 'est-cf-7' }), makeRes(), jest.fn());
    expect(notifyAdmin).not.toHaveBeenCalled();
    reviseAdminEstimate.mockResolvedValue({ estimate: revised, memberLinkageWarning: null, pricingFallbackReason: 'ENGINE_ERROR' });
    await routeHandler(adminEstimatesRouter, '/:id', 'put')(req({}, { id: 'est-cf-7' }), makeRes(), jest.fn());
    expect(notifyAdmin).toHaveBeenCalledTimes(1);
    expect(notifyAdmin.mock.calls[0][3].dedupeKey).toBe('estimate-pricing-fallback:est-cf-7');
  });

  it('the helper ignores rows without an id and reasons other than ENGINE_ERROR', () => {
    notifyPricingFallbackAfterCommit({ id: null }, 'ENGINE_ERROR');
    notifyPricingFallbackAfterCommit({ id: 'x' }, 'NO_INPUTS');
    notifyPricingFallbackAfterCommit({ id: 'x' }, null);
    expect(notifyAdmin).not.toHaveBeenCalled();
  });
});

describe('assertAutoSendPricingAuthority — automation publishes only an engine-verified price, gate or no gate', () => {
  it('refuses a CLIENT_FALLBACK row even with the gate off (422 + code)', () => {
    mockGateState.sendRequiresServerPricing = false;
    let caught = null;
    try { assertAutoSendPricingAuthority(fallbackDraft()); } catch (e) { caught = e; }
    expect(caught?.statusCode).toBe(422);
    expect(caught?.code).toBe('PRICING_AUTHORITY_NOT_SERVER');
    expect(caught?.message).toMatch(/never auto-sent/i);
    expect(() => assertAutoSendPricingAuthority({ pricing_authority: 'client_fallback' })).toThrow();
  });

  it('fails closed on null, unknown and locked stamps; only the explicit SERVER stamp passes', () => {
    expect(() => assertAutoSendPricingAuthority({ pricing_authority: 'SERVER' })).not.toThrow();
    expect(() => assertAutoSendPricingAuthority({ pricing_authority: 'server' })).not.toThrow();
    expect(() => assertAutoSendPricingAuthority({ pricing_authority: 'LOCKED' })).toThrow();
    expect(() => assertAutoSendPricingAuthority({ pricing_authority: 'SOMETHING_NEW' })).toThrow();
    expect(() => assertAutoSendPricingAuthority({ pricing_authority: null })).toThrow();
    expect(() => assertAutoSendPricingAuthority({})).toThrow();
    expect(SERVER_PRICING_AUTHORITY_SQL).toBe("UPPER(pricing_authority) = 'SERVER'");
  });
});

describe('shadowLogFallbackDelivery — only a REAL provider handoff counts (GH codex P2 on #3750)', () => {
  test('a suppressed-only attempt (SMS gate / template policy / owner kill: ok but real:false) logs nothing', () => {
    mockGateState.sendRequiresServerPricing = false;
    if (jest.isMockFunction(logger.warn)) logger.warn.mockClear();
    expect(shadowLogFallbackDelivery(fallbackDraft(), { handoff: false })).toBe(false);
    if (jest.isMockFunction(logger.warn)) expect(logger.warn).not.toHaveBeenCalled();
    expect(shadowLogFallbackDelivery(fallbackDraft(), { handoff: true })).toBe(true);
  });

  test('a proposal blob without the authoring path\'s category stamp logs like any other fallback delivery (GH codex P1)', () => {
    mockGateState.sendRequiresServerPricing = false;
    expect(shadowLogFallbackDelivery(fallbackDraft({ estimate_data: { proposal: { enabled: true, buildings: [] } } }))).toBe(true);
    expect(shadowLogFallbackDelivery(fallbackDraft({ category: 'RESIDENTIAL', estimate_data: { proposal: { enabled: true, buildings: [] } } }))).toBe(true);
  });
});

describe('findGroupSiblingBlockingSend — grouped schedules preflight every sibling (GH codex P2 on #3750)', () => {
  const { findGroupSiblingBlockingSend } = adminEstimatesRouter._internals;
  const anchor = { id: 'est-anchor', estimate_group_id: 'grp-1', pricing_authority: 'SERVER', estimate_data: '{}' };
  function fakeDatabase(rows) {
    const calls = { wheres: [], whereNots: [], whereNulls: [], whereIns: [], forUpdate: false };
    const builder = {
      forUpdate: () => { calls.forUpdate = true; return builder; },
      where: (c) => { calls.wheres.push(c); return builder; },
      whereNot: (c) => { calls.whereNots.push(c); return builder; },
      whereNull: (c) => { calls.whereNulls.push(c); return builder; },
      whereIn: (col, vals) => { calls.whereIns.push([col, vals]); return builder; },
      select: async () => rows,
    };
    const database = jest.fn(() => builder);
    return { database, calls };
  }

  beforeEach(() => { mockGateState.sendRequiresServerPricing = true; });
  afterAll(() => { mockGateState.sendRequiresServerPricing = false; });

  test('an ungrouped estimate never touches the database', async () => {
    const { database } = fakeDatabase([]);
    expect(await findGroupSiblingBlockingSend({ ...anchor, estimate_group_id: null }, { database })).toBeNull();
    expect(database).not.toHaveBeenCalled();
  });

  test('enumerates siblings exactly like the group claim: same group, not self, unarchived, unlocked, active statuses', async () => {
    const { database, calls } = fakeDatabase([]);
    expect(await findGroupSiblingBlockingSend(anchor, { database })).toBeNull();
    expect(calls.wheres).toEqual([{ estimate_group_id: 'grp-1' }]);
    expect(calls.whereNots).toEqual([{ id: 'est-anchor' }]);
    expect(calls.whereNulls).toEqual(['archived_at', 'price_locked_at']);
    // Published (sent/viewed) siblings are judged too — the group link
    // renders their price (GH codex P1 r6); accepted/declined stay out.
    expect(calls.whereIns).toEqual([['status', ['draft', 'scheduled', 'send_failed', 'sent', 'viewed']]]);
    expect(calls.forUpdate).toBe(false);
  });

  test('forUpdate locks the sibling rows for the caller\'s scheduling transaction (GH codex P2 r5)', async () => {
    const { database, calls } = fakeDatabase([]);
    expect(await findGroupSiblingBlockingSend(anchor, { database, forUpdate: true })).toBeNull();
    expect(calls.forUpdate).toBe(true);
  });

  test('gate on: a CLIENT_FALLBACK sibling blocks with the claim\'s code (409); a NULL stamp blocks as NOT_SERVER', async () => {
    const fallback = { id: 'est-sib-cf', status: 'draft', pricing_authority: 'CLIENT_FALLBACK', estimate_data: '{}' };
    const server = { id: 'est-sib-ok', status: 'scheduled', pricing_authority: 'SERVER', estimate_data: '{}' };
    const blocked = await findGroupSiblingBlockingSend(anchor, { database: fakeDatabase([server, fallback]).database });
    expect(blocked).toMatchObject({ statusCode: 409, code: 'CLIENT_FALLBACK_PRICING', sibling: { id: 'est-sib-cf' } });
    const nullStamp = { id: 'est-sib-null', status: 'draft', pricing_authority: null, estimate_data: '{}' };
    expect(await findGroupSiblingBlockingSend(anchor, { database: fakeDatabase([nullStamp]).database }))
      .toMatchObject({ statusCode: 409, code: 'PRICING_AUTHORITY_NOT_SERVER', sibling: { id: 'est-sib-null' } });
  });

  test('gate on: a PUBLISHED fallback sibling (sent gate-off) blocks — the group link would deliver its price (GH codex P1 r6)', async () => {
    const publishedFallback = { id: 'est-sib-sent', status: 'sent', pricing_authority: 'CLIENT_FALLBACK', estimate_data: '{}' };
    expect(await findGroupSiblingBlockingSend(anchor, { database: fakeDatabase([publishedFallback]).database }))
      .toMatchObject({ statusCode: 409, code: 'CLIENT_FALLBACK_PRICING', sibling: { id: 'est-sib-sent' } });
    const viewedNull = { id: 'est-sib-viewed', status: 'viewed', pricing_authority: null, estimate_data: '{}' };
    expect(await findGroupSiblingBlockingSend(anchor, { database: fakeDatabase([viewedNull]).database, autoSend: true }))
      .toMatchObject({ statusCode: 422, code: 'PRICING_AUTHORITY_NOT_SERVER' });
  });

  test('gate on: SERVER siblings pass, and an authored-proposal sibling keeps the manual-send exemption', async () => {
    const server = { id: 'est-sib-ok', status: 'draft', pricing_authority: 'SERVER', estimate_data: '{}' };
    expect(await findGroupSiblingBlockingSend(anchor, { database: fakeDatabase([server]).database })).toBeNull();
    const proposal = { id: 'est-sib-prop', status: 'draft', pricing_authority: 'CLIENT_FALLBACK', estimate_data: JSON.stringify({ proposal: { enabled: true, provenance: { source: 'proposal-editor' }, buildings: [] } }) };
    expect(await findGroupSiblingBlockingSend(anchor, { database: fakeDatabase([proposal]).database })).toBeNull();
    // …but a sibling whose proposal blob lacks the authoring path's category stamp blocks (GH codex P1).
    const forged = { ...proposal, id: 'est-sib-forged', category: 'COMMERCIAL', estimate_data: JSON.stringify({ proposal: { enabled: true, buildings: [] } }) };
    expect(await findGroupSiblingBlockingSend(anchor, { database: fakeDatabase([forged]).database }))
      .toMatchObject({ statusCode: 409, code: 'CLIENT_FALLBACK_PRICING', sibling: { id: 'est-sib-forged' } });
  });

  test('gate off: manual schedules pass; automation still refuses a non-SERVER sibling (422)', async () => {
    mockGateState.sendRequiresServerPricing = false;
    const fallback = { id: 'est-sib-cf', status: 'draft', pricing_authority: 'CLIENT_FALLBACK', estimate_data: '{}' };
    expect(await findGroupSiblingBlockingSend(anchor, { database: fakeDatabase([fallback]).database })).toBeNull();
    expect(await findGroupSiblingBlockingSend(anchor, { database: fakeDatabase([fallback]).database, autoSend: true }))
      .toMatchObject({ statusCode: 422, code: 'PRICING_AUTHORITY_NOT_SERVER' });
  });
});

describe('pricing-authority-gate — the one verdict shared by sends, follow-ups and persistence (GH codex P1 r12)', () => {
  const gate = require('../services/pricing-authority-gate');
  test('SQL and JS forms agree: SERVER passes; an editor-authored proposal passes; NULL / CLIENT_FALLBACK / un-marked proposals fail closed', () => {
    expect(gate.SERVER_PRICING_AUTHORITY_SQL).toBe("UPPER(pricing_authority) = 'SERVER'");
    expect(gate.GATED_SEND_AUTHORITY_SQL).toBe(GATED_SEND_AUTHORITY_SQL);
    expect(gate.rowPassesGatedSendAuthority({ pricing_authority: 'SERVER' })).toBe(true);
    expect(gate.rowPassesGatedSendAuthority({ pricing_authority: null, estimate_data: JSON.stringify({ proposal: { enabled: true, provenance: { source: 'proposal-editor' } } }) })).toBe(true);
    expect(gate.rowPassesGatedSendAuthority({ pricing_authority: 'CLIENT_FALLBACK', estimate_data: { proposal: { enabled: true } } })).toBe(false);
    expect(gate.rowPassesGatedSendAuthority({ pricing_authority: null, estimate_data: 'not json' })).toBe(false);
    expect(gate.rowPassesGatedSendAuthority({})).toBe(false);
  });
});

describe('pricing-authority-gate — group-aware verdict (GH codex P1 r14)', () => {
  const gate = require('../services/pricing-authority-gate');
  function fakeDb(siblings, { throwOnRead = false } = {}) {
    const calls = { whereIns: [], whereFns: 0 };
    const chain = {
      where: (c) => { if (typeof c === 'function') { calls.whereFns += 1; c({ whereNull: () => ({ orWhere: () => chain }) }); } return chain; },
      whereNot: () => chain, whereNull: () => chain,
      whereIn: (col, vals) => { calls.whereIns.push([col, vals]); return chain; },
      select: async () => { if (throwOnRead) throw new Error('db down'); return siblings; },
    };
    const database = jest.fn(() => chain);
    return { database, calls };
  }
  const anchor = { id: 'est-a', estimate_group_id: 'grp-1', pricing_authority: 'SERVER', estimate_data: '{}' };

  test('a SERVER anchor beside a published fallback sibling is NOT deliverable; all-SERVER (or editor-authored) siblings are; ungrouped rows never query', async () => {
    mockGateState.sendRequiresServerPricing = true;
    const bad = fakeDb([{ id: 'est-b', pricing_authority: 'CLIENT_FALLBACK', estimate_data: '{}' }]);
    expect(await gate.estimateDeliverableUnderGate(bad.database, anchor)).toBe(false);
    // The CUSTOMER-VIEWABLE set (sending/sent/viewed, unexpired) — not the
    // send claims' publishable set: an unsent draft never blocks a nudge.
    expect(bad.calls.whereIns).toEqual([['status', ['sending', 'sent', 'viewed']]]);
    expect(bad.calls.whereFns).toBe(1);
    const good = fakeDb([
      { id: 'est-b', pricing_authority: 'SERVER', estimate_data: '{}' },
      { id: 'est-c', pricing_authority: null, estimate_data: JSON.stringify({ proposal: { enabled: true, provenance: { source: 'proposal-editor' } } }) },
    ]);
    expect(await gate.estimateDeliverableUnderGate(good.database, anchor)).toBe(true);
    const ungrouped = fakeDb([{ id: 'x', pricing_authority: 'CLIENT_FALLBACK' }]);
    expect(await gate.estimateDeliverableUnderGate(ungrouped.database, { ...anchor, estimate_group_id: null })).toBe(true);
    expect(ungrouped.database).not.toHaveBeenCalled();
  });

  test('fails closed on a sibling read error; gate off is always deliverable; a fallback anchor never reaches the group read', async () => {
    mockGateState.sendRequiresServerPricing = true;
    const down = fakeDb([], { throwOnRead: true });
    expect(await gate.estimateDeliverableUnderGate(down.database, anchor)).toBe(false);
    const untouched = fakeDb([]);
    expect(await gate.estimateDeliverableUnderGate(untouched.database, { ...anchor, pricing_authority: 'CLIENT_FALLBACK' })).toBe(false);
    expect(untouched.database).not.toHaveBeenCalled();
    mockGateState.sendRequiresServerPricing = false;
    expect(await gate.estimateDeliverableUnderGate(down.database, { ...anchor, pricing_authority: 'CLIENT_FALLBACK' })).toBe(true);
  });
});
