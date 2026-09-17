const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};
const mockSendCustomerMessage = jest.fn();
const mockShorten = jest.fn();
const mockProcessTrigger = jest.fn();
const mockSendTemplate = jest.fn();
const mockEmailSend = jest.fn();
const mockIsConfigured = jest.fn();
const mockIsEnabled = jest.fn();
const mockGetTemplate = jest.fn();

function query(result) {
  const chain = {
    where: jest.fn(() => chain),
    whereRaw: jest.fn(() => chain),
    whereIn: jest.fn(() => chain),
    whereNull: jest.fn(() => chain),
    whereNotNull: jest.fn(() => chain),
    whereNot: jest.fn(() => chain),
    forUpdate: jest.fn(() => chain),
    orderBy: jest.fn(() => chain),
    select: jest.fn(async () => result),
    first: jest.fn(async () => result),
    modify: jest.fn((fn) => { fn(chain); return chain; }),
    orWhereNull: jest.fn(() => chain),
    orWhereNotNull: jest.fn(() => chain),
    update: jest.fn(async () => 1),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
    catch: (reject) => Promise.resolve(result).catch(reject),
  };
  return chain;
}

const mockDb = jest.fn((table) => {
  if (table === 'estimates') return mockDb.__estimateQueries.shift();
  throw new Error(`Unexpected table ${table}`);
});
mockDb.__estimateQueries = [];
mockDb.raw = jest.fn((sql) => sql);
mockDb.transaction = jest.fn(async (run) => run(mockDb));

jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => mockLogger);
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: mockSendCustomerMessage,
}));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: mockShorten,
}));
jest.mock('../services/email-template-automation-executor', () => ({
  processTrigger: mockProcessTrigger,
}));
jest.mock('../services/email-template-library', () => ({
  sendTemplate: mockSendTemplate,
}));
jest.mock('../services/email', () => ({
  send: mockEmailSend,
}));
jest.mock('../services/sendgrid-mail', () => ({
  isConfigured: mockIsConfigured,
}));
jest.mock('../config/feature-gates', () => ({
  isEnabled: mockIsEnabled,
  termiteAnnualPlanSelectionEnabled: jest.requireActual('../config/feature-gates').termiteAnnualPlanSelectionEnabled,
}));
jest.mock('../routes/admin-sms-templates', () => ({
  getTemplate: mockGetTemplate,
}));

const EstimateAutoRenew = require('../services/estimate-auto-renew');

function staleEstimate(overrides = {}) {
  return {
    id: 'estimate-1',
    token: 'estimate-token',
    customer_id: 'customer-1',
    customer_name: 'Sam Customer',
    customer_phone: null,
    customer_email: 'sam@example.com',
    status: 'sent',
    created_at: '2026-05-01T12:00:00.000Z',
    renewal_count: 0,
    ...overrides,
  };
}

describe('estimate auto-renew email automation cutover', () => {
  test('an ordinary grouped row is not renewed or emailed while any live sibling holds a fixed date (pre-push codex P1 on #4309)', async () => {
    const grouped = staleEstimate({ estimate_group_id: 'synthetic-group', estimate_data: { proposal: { enabled: true } } });
    const siblingRead = query([{ estimate_data: { proposal: { enabled: true, validThrough: '2026-09-22' } } }]);
    mockDb.__estimateQueries = [query([grouped]), siblingRead];
    const { renewed } = await EstimateAutoRenew.checkAll();
    expect(renewed).toBe(0);
    expect(siblingRead.whereIn).toHaveBeenCalledWith('status', ['draft', 'scheduled', 'sending', 'send_failed', 'sent', 'viewed', 'expired']);
    expect(mockDb.transaction).not.toHaveBeenCalled();
    expect(mockDb.__estimateQueries).toHaveLength(0);
    expect(mockProcessTrigger).not.toHaveBeenCalled();
    expect(mockSendTemplate).not.toHaveBeenCalled();
    expect(mockEmailSend).not.toHaveBeenCalled();
  });

  test('a grouped renewal re-reads the fixed verdict under the group lock before writing', async () => {
    const grouped = staleEstimate({ estimate_group_id: 'synthetic-group', estimate_data: { proposal: { enabled: true } } });
    const preflight = query([]);
    // The transaction's own FOR UPDATE re-read (GH codex P2 r4 on #4309) —
    // still in the same group at this point.
    const peek = query({ estimate_group_id: 'synthetic-group' });
    const reread = query({ ...grouped });
    const locked = query([{ estimate_data: { proposal: { enabled: true, validThrough: '2026-09-22' } } }]);
    const update = query([]);
    mockDb.__estimateQueries = [query([grouped]), preflight, peek, reread, locked, update];
    const { renewed } = await EstimateAutoRenew.checkAll();
    expect(renewed).toBe(0);
    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    expect(reread.forUpdate).toHaveBeenCalled();
    expect(mockDb.raw).toHaveBeenCalledWith(expect.stringMatching(/pg_advisory_xact_lock/), ['estimate-group-send', 'synthetic-group']);
    expect(update.update).not.toHaveBeenCalled();
    expect(mockProcessTrigger).not.toHaveBeenCalled();
    expect(mockEmailSend).not.toHaveBeenCalled();
  });

  test('a candidate moved into a fixed-validity group between the outer read and the transaction is not renewed (GH codex P2 r4 on #4309)', async () => {
    // Outer read sees it ungrouped — no group lock, no fixed-sibling check
    // would run under the OLD (pre-fix) logic, which trusted est.estimate_group_id.
    const ungroupedAtOuterRead = staleEstimate({ estimate_group_id: null, estimate_data: { proposal: { enabled: true } } });
    // Top-level preflight (still using the stale outer-read est) sees no group, so it never queries siblings.
    // Between that read and the transaction, an operator moves the row into a group with a live fixed sibling.
    const peek = query({ estimate_group_id: 'new-fixed-group' });
    const reread = query({ ...ungroupedAtOuterRead, estimate_group_id: 'new-fixed-group' });
    const lockedSiblingCheck = query([{ estimate_data: { proposal: { enabled: true, validThrough: '2026-10-01' } } }]);
    const update = query([]);
    mockDb.__estimateQueries = [query([ungroupedAtOuterRead]), peek, reread, lockedSiblingCheck, update];

    const { renewed } = await EstimateAutoRenew.checkAll();

    expect(renewed).toBe(0);
    expect(reread.forUpdate).toHaveBeenCalled();
    expect(mockDb.raw).toHaveBeenCalledWith(expect.stringMatching(/pg_advisory_xact_lock/), ['estimate-group-send', 'new-fixed-group']);
    expect(update.update).not.toHaveBeenCalled();
    expect(mockProcessTrigger).not.toHaveBeenCalled();
    expect(mockSendTemplate).not.toHaveBeenCalled();
    expect(mockEmailSend).not.toHaveBeenCalled();
  });

  test('a candidate whose group changed (not just appeared) between the outer read and the transaction is not renewed when the new group has a fixed sibling', async () => {
    // Outer read sees an old, harmless group — the top-level preflight clears it.
    const staleGroupEst = staleEstimate({ estimate_group_id: 'old-group', estimate_data: { proposal: { enabled: true } } });
    const preflightOldGroup = query([]); // no fixed siblings in the old group
    // Re-read under the transaction finds it now in a different group.
    const peek = query({ estimate_group_id: 'new-group' });
    const reread = query({ ...staleGroupEst, estimate_group_id: 'new-group' });
    const newGroupSiblingCheck = query([{ estimate_data: { proposal: { enabled: true, validThrough: '2026-10-15' } } }]);
    const update = query([]);
    mockDb.__estimateQueries = [query([staleGroupEst]), preflightOldGroup, peek, reread, newGroupSiblingCheck, update];

    const { renewed } = await EstimateAutoRenew.checkAll();

    expect(renewed).toBe(0);
    expect(mockDb.raw).toHaveBeenCalledWith(expect.stringMatching(/pg_advisory_xact_lock/), ['estimate-group-send', 'new-group']);
    expect(update.update).not.toHaveBeenCalled();
    expect(mockProcessTrigger).not.toHaveBeenCalled();
    expect(mockEmailSend).not.toHaveBeenCalled();
  });

  test('a fixed bid deadline is never renewed or emailed automatically', async () => {
    mockDb.__estimateQueries = [query([staleEstimate({ estimate_data: { proposal: { enabled: true, validThrough: '2026-09-22' } } })])];
    await EstimateAutoRenew.checkAll();
    expect(mockDb.__estimateQueries).toHaveLength(0);
    expect(mockProcessTrigger).not.toHaveBeenCalled();
    expect(mockSendTemplate).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb.__estimateQueries = [];
    mockShorten.mockResolvedValue('https://portal.example/estimate/short');
    mockIsConfigured.mockReturnValue(true);
    // Every gate on — except the pricing-authority send gate (#3750).
    mockIsEnabled.mockImplementation((key) => key !== 'sendRequiresServerPricing');
    mockProcessTrigger.mockResolvedValue({
      automation_count: 1,
      results: [{ run: { id: 'run-1', status: 'sent' } }],
    });
    mockSendTemplate.mockResolvedValue({ sent: true, message: { id: 'message-1' } });
  });

  test('a candidate that stays ungrouped still renews, with the update pinned to estimate_group_id IS NULL (regression guard)', async () => {
    const estimate = staleEstimate();
    const reread = query(estimate);
    const update = query(1);
    mockDb.__estimateQueries.push(query([estimate]), query(estimate), reread, update, query(estimate), query({ ...estimate, renewal_count: 1 }));

    await expect(EstimateAutoRenew.checkAll()).resolves.toEqual({ renewed: 1 });

    expect(reread.forUpdate).toHaveBeenCalled();
    expect(mockDb.raw).not.toHaveBeenCalledWith(expect.stringMatching(/pg_advisory_xact_lock/), expect.anything());
    expect(update.whereNull).toHaveBeenCalledWith('estimate_group_id');
    expect(update.update).toHaveBeenCalled();
  });

  test('uses the email template automation executor when the gate is enabled', async () => {
    const estimate = staleEstimate();
    mockDb.__estimateQueries.push(query([estimate]), query(estimate), query(estimate), query(1), query(estimate), query({ ...estimate, renewal_count: 1 }));

    await expect(EstimateAutoRenew.checkAll()).resolves.toEqual({ renewed: 1 });

    expect(mockProcessTrigger).toHaveBeenCalledWith(expect.objectContaining({
      triggerEventKey: 'estimate.auto_renewed',
      triggerEventId: 'estimate_auto_renew:estimate-1',
      entityType: 'estimate',
      entityId: 'estimate-1',
      recipient: {
        email: 'sam@example.com',
        type: 'customer',
        id: 'customer-1',
      },
      executeImmediately: true,
      payload: expect.objectContaining({
        estimate_id: 'estimate-1',
        customer_id: 'customer-1',
        customer_email: 'sam@example.com',
        first_name: 'Sam',
        estimate_url: 'https://portal.example/estimate/short',
        estimate_status: 'sent',
        status: 'sent',
        renewal_count: 1,
      }),
    }));
    expect(mockSendTemplate).not.toHaveBeenCalled();
    expect(mockEmailSend).not.toHaveBeenCalled();
  });

  test('a zero-comms opted-out estimate is never renewed or emailed (uncapped audit r4 P1)', async () => {
    // Publish-without-delivery mints (report click-to-estimate) stamp
    // estimate_data.noEngagementAutomation — renewal would both EXTEND the
    // estimate and email the customer; the lane promises neither.
    const optedOut = staleEstimate({
      id: 'estimate-optout',
      estimate_data: JSON.stringify({ noEngagementAutomation: true }),
    });
    const normal = staleEstimate();
    mockDb.__estimateQueries.push(query([optedOut, normal]), query(normal), query(normal), query(1), query(normal), query({ ...normal, renewal_count: 1 }));

    await expect(EstimateAutoRenew.checkAll()).resolves.toEqual({ renewed: 1 });

    // Only the normal estimate got the update + email — nothing for optout.
    expect(mockProcessTrigger).toHaveBeenCalledTimes(1);
    expect(mockProcessTrigger).toHaveBeenCalledWith(expect.objectContaining({
      entityId: 'estimate-1',
    }));

    // Hydrated-jsonb shape (object, not string) opts out identically.
    jest.clearAllMocks();
    // Every gate on — except the pricing-authority send gate (#3750).
    mockIsEnabled.mockImplementation((key) => key !== 'sendRequiresServerPricing');
    mockProcessTrigger.mockResolvedValue({ automation_count: 1, results: [] });
    mockDb.__estimateQueries = [query([staleEstimate({
      id: 'estimate-optout-2',
      estimate_data: { noEngagementAutomation: true },
    })])];
    await expect(EstimateAutoRenew.checkAll()).resolves.toEqual({ renewed: 0 });
    expect(mockProcessTrigger).not.toHaveBeenCalled();
    expect(mockSendTemplate).not.toHaveBeenCalled();
    expect(mockEmailSend).not.toHaveBeenCalled();
  });

  test('keeps the direct template send fallback when the automation gate is disabled', async () => {
    mockIsEnabled.mockReturnValue(false);
    const estimate = staleEstimate();
    mockDb.__estimateQueries.push(query([estimate]), query(estimate), query(estimate), query(1), query(estimate), query({ ...estimate, renewal_count: 1 }));

    await expect(EstimateAutoRenew.checkAll()).resolves.toEqual({ renewed: 1 });

    expect(mockProcessTrigger).not.toHaveBeenCalled();
    expect(mockSendTemplate).toHaveBeenCalledWith(expect.objectContaining({
      templateKey: 'estimate.extension_notice',
      to: 'sam@example.com',
      recipientType: 'customer',
      recipientId: 'customer-1',
      triggerEventId: 'estimate_auto_renew:estimate-1',
      categories: ['estimate_auto_renew'],
      payload: expect.objectContaining({
        estimate_id: 'estimate-1',
        new_expires_at: expect.any(String),
      }),
    }));
  });
  describe('annual offer replay at renewal and dispatch boundaries', () => {
    const { annualPlanOfferFingerprint } = require('../services/estimate-offer-version');
    let previousAnnual;
    let previousCancel;

    function annualEstimate() {
      return staleEstimate({
        estimate_data: { result: { lineItems: [{ service: 'termite_bait', plan: 'annual_protection', annual: 299 }] } },
      });
    }

    function deliveredAnnualEstimate() {
      const row = annualEstimate();
      return { ...row, estimate_data: { ...row.estimate_data, deliveryState: {
        firstDeliveredAt: '2026-09-12T00:00:00Z',
        annualPlanOfferFingerprint: annualPlanOfferFingerprint(row),
      } } };
    }

    beforeEach(() => {
      previousAnnual = process.env.GATE_TERMITE_ANNUAL_PLAN;
      previousCancel = process.env.GATE_CANCEL_FLOW_V2;
      process.env.GATE_TERMITE_ANNUAL_PLAN = 'false';
      process.env.GATE_CANCEL_FLOW_V2 = 'false';
    });
    afterEach(() => {
      if (previousAnnual === undefined) delete process.env.GATE_TERMITE_ANNUAL_PLAN;
      else process.env.GATE_TERMITE_ANNUAL_PLAN = previousAnnual;
      if (previousCancel === undefined) delete process.env.GATE_CANCEL_FLOW_V2;
      else process.env.GATE_CANCEL_FLOW_V2 = previousCancel;
    });

    test.each(['missing', 'stale'])('the locked annual row with a %s witness neither consumes its renewal nor emails', async (witness) => {
      // The candidate looked valid before the lock. An editor changed its
      // offer or removed the witness before renewal acquired the full row.
      const outer = deliveredAnnualEstimate();
      const current = witness === 'missing' ? annualEstimate() : { ...outer, notes: 'synthetic revision' };
      const reread = query(current);
      const update = query(1);
      mockDb.__estimateQueries = [query([outer]), query(current), reread, update];

      await expect(EstimateAutoRenew.checkAll()).resolves.toEqual({ renewed: 0 });

      expect(reread.forUpdate).toHaveBeenCalled();
      expect(reread.first).toHaveBeenCalledWith();
      expect(update.update).not.toHaveBeenCalled();
      expect(mockShorten).not.toHaveBeenCalled();
      expect(mockProcessTrigger).not.toHaveBeenCalled();
      expect(mockSendTemplate).not.toHaveBeenCalled();
      expect(mockEmailSend).not.toHaveBeenCalled();
    });

    test('closure during the locked fixed-sibling read refuses the renewal update', async () => {
      process.env.GATE_TERMITE_ANNUAL_PLAN = 'true';
      process.env.GATE_CANCEL_FLOW_V2 = 'true';
      const estimate = { ...annualEstimate(), estimate_group_id: 'synthetic-group' };
      const siblingRead = query([]);
      siblingRead.select.mockImplementationOnce(async () => {
        process.env.GATE_TERMITE_ANNUAL_PLAN = 'false';
        return [];
      });
      const update = query(1);
      mockDb.__estimateQueries = [query([estimate]), query([]), query(estimate), query(estimate), siblingRead, update];

      await expect(EstimateAutoRenew.checkAll()).resolves.toEqual({ renewed: 0 });

      expect(update.update).not.toHaveBeenCalled();
      expect(mockProcessTrigger).not.toHaveBeenCalled();
      expect(mockSendTemplate).not.toHaveBeenCalled();
      expect(mockEmailSend).not.toHaveBeenCalled();
    });

    test('an exact delivered annual offer still renews while dark with shortening and automation preparation outside the lock', async () => {
      const estimate = deliveredAnnualEstimate();
      const reread = query(estimate);
      const update = query(1);
      mockDb.__estimateQueries = [query([estimate]), query(estimate), reread, update, query(estimate), query({ ...estimate, renewal_count: 1 })];
      let transactionActive = false;
      const originalTransaction = mockDb.transaction.getMockImplementation();
      mockDb.transaction.mockImplementation(async (run) => {
        transactionActive = true;
        try { return await run(mockDb); } finally { transactionActive = false; }
      });
      mockShorten.mockImplementationOnce(async () => {
        expect(transactionActive).toBe(false);
        return 'https://portal.example/estimate/short';
      });
      mockProcessTrigger.mockImplementationOnce(async () => {
        expect(transactionActive).toBe(false);
        return { automation_count: 1, results: [] };
      });
      try {
        await expect(EstimateAutoRenew.checkAll()).resolves.toEqual({ renewed: 1 });
        expect(update.update).toHaveBeenCalledWith(expect.objectContaining({
          expires_at: expect.any(Date), renewal_count: expect.any(String),
        }));
        expect(mockProcessTrigger).toHaveBeenCalledTimes(1);
        expect(mockDb.__estimateQueries).toHaveLength(0);
      } finally {
        mockDb.transaction.mockImplementation(originalTransaction);
      }
    });

    test.each(['GATE_TERMITE_ANNUAL_PLAN', 'GATE_CANCEL_FLOW_V2'])('closure of %s during shortening suppresses dispatch of a committed renewal', async (switchName) => {
      process.env.GATE_TERMITE_ANNUAL_PLAN = 'true';
      process.env.GATE_CANCEL_FLOW_V2 = 'true';
      const estimate = annualEstimate();
      const update = query(1);
      mockDb.__estimateQueries = [query([estimate]), query(estimate), query(estimate), update, query(estimate), query({ ...estimate, renewal_count: 1 })];
      mockShorten.mockImplementationOnce(async () => {
        process.env[switchName] = 'false';
        return 'https://portal.example/estimate/short';
      });

      await expect(EstimateAutoRenew.checkAll()).resolves.toEqual({ renewed: 1 });

      expect(update.update).toHaveBeenCalled();
      expect(mockProcessTrigger).not.toHaveBeenCalled();
      expect(mockSendTemplate).not.toHaveBeenCalled();
      expect(mockEmailSend).not.toHaveBeenCalled();
    });

    test.each([null, 'synthetic-group'])('the dispatch lock rejects an annual offer edited after renewal (group %s)', async (groupId) => {
      const estimate = { ...deliveredAnnualEstimate(), estimate_group_id: groupId };
      // Fingerprint includes group membership, so stamp the grouped shape.
      estimate.estimate_data.deliveryState.annualPlanOfferFingerprint = annualPlanOfferFingerprint(estimate);
      const dispatchRow = { ...estimate, notes: 'synthetic edit after renewal', renewal_count: 1 };
      const update = query(1);
      const dispatchRead = query(dispatchRow);
      mockDb.__estimateQueries = [query([estimate])];
      if (groupId) mockDb.__estimateQueries.push(query([]));
      mockDb.__estimateQueries.push(query(estimate), query(estimate));
      if (groupId) mockDb.__estimateQueries.push(query([]));
      mockDb.__estimateQueries.push(update, query(dispatchRow), dispatchRead);

      await expect(EstimateAutoRenew.checkAll()).resolves.toEqual({ renewed: 1 });

      expect(update.update).toHaveBeenCalled();
      expect(dispatchRead.forUpdate).toHaveBeenCalled();
      expect(mockDb.transaction).toHaveBeenCalledTimes(2);
      expect(mockShorten).not.toHaveBeenCalled();
      expect(mockProcessTrigger).not.toHaveBeenCalled();
      expect(mockSendTemplate).not.toHaveBeenCalled();
      expect(mockEmailSend).not.toHaveBeenCalled();
      expect(mockDb.__estimateQueries).toHaveLength(0);
      if (groupId) expect(mockDb.raw).toHaveBeenCalledWith(expect.stringMatching(/pg_advisory_xact_lock/), ['estimate-group-send', groupId]);
    });

    test.each(['missing', 'stale', 'delivered', 'ordinary'])('the actual provider handoff judges a %s current witness under the row lock', async (witness) => {
      const current = witness === 'missing' ? annualEstimate()
        : witness === 'stale' ? { ...deliveredAnnualEstimate(), notes: 'synthetic revised terms' }
          : witness === 'delivered' ? deliveredAnnualEstimate() : staleEstimate();
      const reread = query(current);
      mockDb.__estimateQueries = [query(current), reread];
      const provider = jest.fn(async () => undefined);

      await expect(EstimateAutoRenew.withProviderHandoff(current.id, provider))
        .resolves.toEqual({ ok: ['delivered', 'ordinary'].includes(witness) });

      expect(reread.forUpdate).toHaveBeenCalled();
      expect(provider).toHaveBeenCalledTimes(['delivered', 'ordinary'].includes(witness) ? 1 : 0);
      expect(mockDb.__estimateQueries).toHaveLength(0);
    });

    test('a template preparation edit is rejected at its definitive provider boundary', async () => {
      mockIsEnabled.mockReturnValue(false);
      const estimate = deliveredAnnualEstimate();
      const changed = { ...estimate, notes: 'synthetic edit during template preparation', renewal_count: 1 };
      mockDb.__estimateQueries = [query([estimate]), query(estimate), query(estimate), query(1),
        query(estimate), query({ ...estimate, renewal_count: 1 }), query(changed), query(changed)];
      const provider = jest.fn();
      mockSendTemplate.mockImplementationOnce(async ({ withProviderHandoff }) => {
        const verdict = await withProviderHandoff(provider);
        return { sent: verdict.ok, aborted: !verdict.ok };
      });

      await expect(EstimateAutoRenew.checkAll()).resolves.toEqual({ renewed: 1 });

      expect(mockSendTemplate).toHaveBeenCalledTimes(1);
      expect(provider).not.toHaveBeenCalled();
      expect(mockEmailSend).not.toHaveBeenCalled();
      expect(mockLogger.error).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('Email suppressed'));
      expect(mockDb.__estimateQueries).toHaveLength(0);
    });

    test('a direct-template provider-guard infrastructure error is reported as an email failure', async () => {
      mockIsEnabled.mockReturnValue(false);
      const estimate = deliveredAnnualEstimate();
      const update = query(1);
      const guardRead = query(estimate);
      guardRead.first.mockRejectedValueOnce(new Error('synthetic lock timeout'));
      mockDb.__estimateQueries = [query([estimate]), query(estimate), query(estimate), update,
        query(estimate), query({ ...estimate, renewal_count: 1 }), query(estimate), guardRead];
      const provider = jest.fn();
      mockSendTemplate.mockImplementationOnce(async ({ withProviderHandoff }) => {
        // The real library converts a pre-provider guard error to an abort.
        try { await withProviderHandoff(provider); } catch {
          return { sent: false, aborted: true, reason: 'aborted_by_caller_before_dispatch' };
        }
        throw new Error('expected guard rejection');
      });

      await expect(EstimateAutoRenew.checkAll()).resolves.toEqual({ renewed: 1 });

      expect(update.update).toHaveBeenCalled();
      expect(provider).not.toHaveBeenCalled();
      expect(mockEmailSend).not.toHaveBeenCalled();
      expect(mockLogger.error).toHaveBeenCalledWith('[est-auto-renew] Email failed: synthetic lock timeout');
      expect(mockLogger.warn).not.toHaveBeenCalledWith(expect.stringContaining('Email suppressed'));
      expect(mockDb.__estimateQueries).toHaveLength(0);
    });

    test('an edit during template failure is also refused by the SMTP provider guard', async () => {
      mockIsEnabled.mockReturnValue(false);
      const estimate = deliveredAnnualEstimate();
      const changed = { ...estimate, notes: 'synthetic edit during template failure', renewal_count: 1 };
      mockDb.__estimateQueries = [query([estimate]), query(estimate), query(estimate), query(1),
        query(estimate), query({ ...estimate, renewal_count: 1 }), query(changed), query(changed)];
      mockSendTemplate.mockRejectedValueOnce(new Error('active template not found'));

      await expect(EstimateAutoRenew.checkAll()).resolves.toEqual({ renewed: 1 });

      expect(mockSendTemplate).toHaveBeenCalledTimes(1);
      expect(mockEmailSend).not.toHaveBeenCalled();
      expect(mockDb.__estimateQueries).toHaveLength(0);
    });

    test('a gate closed after template failure suppresses SMTP fallback', async () => {
      process.env.GATE_TERMITE_ANNUAL_PLAN = 'true';
      process.env.GATE_CANCEL_FLOW_V2 = 'true';
      mockIsEnabled.mockReturnValue(false);
      const estimate = annualEstimate();
      mockDb.__estimateQueries = [query([estimate]), query(estimate), query(estimate), query(1), query(estimate), query({ ...estimate, renewal_count: 1 })];
      mockSendTemplate.mockImplementationOnce(async () => {
        process.env.GATE_TERMITE_ANNUAL_PLAN = 'false';
        throw new Error('active template not found');
      });

      await expect(EstimateAutoRenew.checkAll()).resolves.toEqual({ renewed: 1 });

      expect(mockSendTemplate).toHaveBeenCalledTimes(1);
      expect(mockEmailSend).not.toHaveBeenCalled();
    });

    test('a gate closed after automation lookup suppresses the template fallback', async () => {
      process.env.GATE_TERMITE_ANNUAL_PLAN = 'true';
      process.env.GATE_CANCEL_FLOW_V2 = 'true';
      const estimate = annualEstimate();
      mockDb.__estimateQueries = [query([estimate]), query(estimate), query(estimate), query(1), query(estimate), query({ ...estimate, renewal_count: 1 })];
      mockProcessTrigger.mockImplementationOnce(async () => {
        process.env.GATE_TERMITE_ANNUAL_PLAN = 'false';
        return { automation_count: 0, results: [] };
      });

      await expect(EstimateAutoRenew.checkAll()).resolves.toEqual({ renewed: 1 });

      expect(mockProcessTrigger).toHaveBeenCalledTimes(1);
      expect(mockSendTemplate).not.toHaveBeenCalled();
      expect(mockEmailSend).not.toHaveBeenCalled();
    });
  });

});

test('a grouped candidate whose membership moves between the group lock and the row lock is left for the next sweep (GH codex P2 r4 on #4309)', async () => {
  const grouped = { id: 'synthetic-drift', status: 'sent', customer_email: 'drift@example.invalid', estimate_group_id: 'group-a', estimate_data: { proposal: { enabled: true } }, expires_at: new Date(Date.now() - 1000), renewal_count: 0 };
  const update = query([]);
  mockDb.__estimateQueries = [query([grouped]), query([]), query({ estimate_group_id: 'group-a' }), query({ ...grouped, estimate_group_id: 'group-b' }), update];
  const { renewed } = await EstimateAutoRenew.checkAll();
  expect(renewed).toBe(0);
  expect(update.update).not.toHaveBeenCalled();
});
