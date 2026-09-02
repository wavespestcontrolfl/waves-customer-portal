const {
  DEFAULT_ALLOWED_REVIEW_REASONS,
  DEFAULT_STALE_CLAIM_MINUTES,
  isStaleAutoSendClaim,
  leadEstimateAutoSendAuditRow,
  leadEstimateAutoSendConfigFromEnv,
  leadEstimateAutoSendEligibility,
  mergeAutoSendMetadata,
  staleAutoSendRecoveryDecision,
} = require('../services/lead-estimate-auto-send');

function generatedEstimate(overrides = {}) {
  const now = new Date('2026-05-26T12:00:00.000Z');
  return {
    id: 'estimate-1',
    source: 'lead_webhook',
    status: 'draft',
    // The lane fails closed without the explicit engine-verified stamp.
    pricing_authority: 'SERVER',
    customer_phone: '+19415550101',
    customer_email: 'lead@example.com',
    created_at: new Date(now.getTime() - 10 * 60 * 1000).toISOString(),
    estimate_data: {
      automation: {
        leadEstimateAutomation: {
          status: 'ready',
          confidence: 'medium',
          minimumConfidence: 'medium',
          review: ['property_measurements_defaulted'],
          missing: [],
        },
        draftEstimateAutomation: {
          status: 'generated',
          generated: true,
          quoteRequired: false,
          review: ['property_measurements_defaulted'],
        },
      },
    },
    ...overrides,
  };
}

describe('lead estimate auto-send policy', () => {
  test('production config defaults to five minute delay, ten-row limit, and conservative review allowlist', () => {
    expect(leadEstimateAutoSendConfigFromEnv({})).toEqual({
      delayMinutes: 5,
      limit: 10,
      staleClaimMinutes: DEFAULT_STALE_CLAIM_MINUTES,
      allowedReviewReasons: DEFAULT_ALLOWED_REVIEW_REASONS,
      sendMethod: 'both',
    });

    expect(leadEstimateAutoSendConfigFromEnv({
      LEAD_ESTIMATE_AUTO_SEND_DELAY_MINUTES: '12',
      LEAD_ESTIMATE_AUTO_SEND_LIMIT: '3',
      LEAD_ESTIMATE_AUTO_SEND_STALE_CLAIM_MINUTES: '45',
      LEAD_ESTIMATE_AUTO_SEND_ALLOWED_REVIEW_REASONS: 'property_measurements_defaulted,email_missing_sms_only',
      LEAD_ESTIMATE_AUTO_SEND_METHOD: 'sms',
    })).toEqual({
      delayMinutes: 12,
      limit: 3,
      staleClaimMinutes: 45,
      allowedReviewReasons: ['property_measurements_defaulted', 'email_missing_sms_only'],
      sendMethod: 'sms',
    });
  });

  test('allows generated draft lead estimates after delay when only allowed review reasons are present', () => {
    const now = new Date('2026-05-26T12:00:00.000Z');

    expect(leadEstimateAutoSendEligibility(generatedEstimate(), {
      now,
      delayMinutes: 5,
      allowedReviewReasons: ['property_measurements_defaulted'],
    })).toEqual({ eligible: true, reason: null });
  });

  test('DEFAULT config parks measurements-defaulted drafts — synthetic sqft must never auto-send unreviewed', () => {
    const now = new Date('2026-05-26T12:00:00.000Z');

    // The fixture's quote priced off the synthetic 2,000/8,000 sqft defaults
    // (review: property_measurements_defaulted). With no explicit allow-list
    // override, that draft parks for a human pass instead of sending.
    expect(leadEstimateAutoSendEligibility(generatedEstimate(), {
      now,
      delayMinutes: 5,
    })).toMatchObject({
      eligible: false,
      reason: 'disallowed_review_reasons',
      review: ['property_measurements_defaulted'],
    });
  });

  test('blocks manual-review, premature, and disallowed-review estimates', () => {
    const now = new Date('2026-05-26T12:00:00.000Z');

    expect(leadEstimateAutoSendEligibility(generatedEstimate({
      estimate_data: {
        automation: {
          draftEstimateAutomation: {
            status: 'manual_review_required',
            generated: false,
          },
        },
      },
    }), { now })).toMatchObject({
      eligible: false,
      reason: 'not_generated',
    });

    expect(leadEstimateAutoSendEligibility(generatedEstimate({
      created_at: new Date(now.getTime() - 2 * 60 * 1000).toISOString(),
      // Explicit allow so this case exercises the DELAY branch — the fixture's
      // measurements-defaulted review reason is no longer allowed by default.
    }), { now, delayMinutes: 5, allowedReviewReasons: ['property_measurements_defaulted'] })).toMatchObject({
      eligible: false,
      reason: 'delay_not_elapsed',
    });

    expect(leadEstimateAutoSendEligibility(generatedEstimate({
      estimate_data: {
        automation: {
          leadEstimateAutomation: {
            status: 'ready',
            confidence: 'medium',
            review: ['city_or_zip_missing'],
          },
          draftEstimateAutomation: {
            status: 'generated',
            generated: true,
            review: ['city_or_zip_missing'],
          },
        },
      },
    }), {
      now,
      allowedReviewReasons: ['property_measurements_defaulted'],
    })).toMatchObject({
      eligible: false,
      reason: 'disallowed_review_reasons',
      review: ['city_or_zip_missing'],
    });
  });

  test('never auto-sends a price the engine did not verify — only the explicit SERVER stamp is eligible', () => {
    const now = new Date('2026-05-26T12:00:00.000Z');
    const opts = { now, delayMinutes: 5, allowedReviewReasons: ['property_measurements_defaulted'] };
    expect(leadEstimateAutoSendEligibility(generatedEstimate({ pricing_authority: 'CLIENT_FALLBACK' }), opts))
      .toEqual({ eligible: false, reason: 'pricing_authority_not_server' });
    expect(leadEstimateAutoSendEligibility(generatedEstimate({ pricing_authority: null }), opts))
      .toEqual({ eligible: false, reason: 'pricing_authority_not_server' });
    expect(leadEstimateAutoSendEligibility(generatedEstimate({ pricing_authority: 'LOCKED' }), opts))
      .toEqual({ eligible: false, reason: 'pricing_authority_not_server' });
    // An authored proposal on a generated draft that still carries SERVER is
    // never automation's to send (GH codex P1 r30).
    const withProposal = generatedEstimate();
    withProposal.estimate_data = { ...withProposal.estimate_data, proposal: { enabled: true, buildings: [] } };
    expect(leadEstimateAutoSendEligibility(withProposal, opts)).toEqual({ eligible: false, reason: 'authored_proposal' });
    expect(leadEstimateAutoSendEligibility(generatedEstimate({ pricingAuthority: 'server', pricing_authority: undefined }), opts))
      .toEqual({ eligible: true, reason: null });
    expect(leadEstimateAutoSendEligibility(generatedEstimate({ pricing_authority: 'SERVER' }), opts))
      .toEqual({ eligible: true, reason: null });
  });

  test('treats fresh claims as active and old claims as recoverable', () => {
    const now = new Date('2026-05-26T12:00:00.000Z');

    expect(isStaleAutoSendClaim({
      claimedAt: '2026-05-26T11:45:01.000Z',
    }, now, 15)).toBe(false);
    expect(isStaleAutoSendClaim({
      claimedAt: '2026-05-26T11:44:59.000Z',
    }, now, 15)).toBe(true);

    expect(leadEstimateAutoSendEligibility(generatedEstimate({
      estimate_data: {
        automation: {
          draftEstimateAutomation: {
            status: 'generated',
            generated: true,
          },
          autoSend: {
            claimedAt: '2026-05-26T11:59:00.000Z',
          },
        },
      },
    }), { now, staleClaimMinutes: 30 })).toMatchObject({
      eligible: false,
      reason: 'already_claimed',
    });

    expect(leadEstimateAutoSendEligibility(generatedEstimate({
      estimate_data: {
        automation: {
          draftEstimateAutomation: {
            status: 'generated',
            generated: true,
          },
          autoSend: {
            claimedAt: '2026-05-26T11:00:00.000Z',
          },
        },
      },
    }), { now, staleClaimMinutes: 30 })).toEqual({
      eligible: true,
      reason: null,
    });
  });

  test('blocks stale SMS claims instead of auto-retrying uncertain deliveries', () => {
    const now = new Date('2026-05-26T12:00:00.000Z');

    expect(staleAutoSendRecoveryDecision({ sendMethod: 'email' }, {}, now)).toEqual({
      includedSms: false,
      patch: {
        claimedAt: null,
        claimed_at: null,
        recoveredAt: '2026-05-26T12:00:00.000Z',
        recoveredReason: 'stale_claim',
      },
    });

    expect(staleAutoSendRecoveryDecision({ sendMethod: 'both' }, {}, now)).toEqual({
      includedSms: true,
      patch: {
        claimedAt: null,
        claimed_at: null,
        recoveredAt: '2026-05-26T12:00:00.000Z',
        recoveredReason: 'stale_claim',
        blockedAt: '2026-05-26T12:00:00.000Z',
        blockedReason: 'stale_claim_sms_idempotency_unknown',
        result: 'blocked',
      },
    });
  });

  test('builds read-only audit rows for would-send, waiting, and blocked estimates', () => {
    const now = new Date('2026-05-26T12:00:00.000Z');

    expect(leadEstimateAutoSendAuditRow(generatedEstimate(), {
      now,
      delayMinutes: 5,
      allowedReviewReasons: ['property_measurements_defaulted'],
    })).toMatchObject({
      id: 'estimate-1',
      action: 'would_send',
      wouldSend: true,
      eligibility: { eligible: true, reason: null },
      contact: { hasPhone: true, hasEmail: true },
      automation: {
        status: 'generated',
        generated: true,
        review: ['property_measurements_defaulted'],
      },
    });

    expect(leadEstimateAutoSendAuditRow(generatedEstimate({
      created_at: new Date(now.getTime() - 2 * 60 * 1000).toISOString(),
    }), { now, delayMinutes: 5, allowedReviewReasons: ['property_measurements_defaulted'] })).toMatchObject({
      action: 'waiting',
      wouldSend: false,
      eligibility: { eligible: false, reason: 'delay_not_elapsed' },
    });

    expect(leadEstimateAutoSendAuditRow(generatedEstimate({
      customer_phone: null,
      customer_email: null,
    }), { now, allowedReviewReasons: ['property_measurements_defaulted'] })).toMatchObject({
      action: 'blocked',
      wouldSend: false,
      eligibility: { eligible: false, reason: 'missing_delivery_contact' },
      contact: { hasPhone: false, hasEmail: false },
    });
  });

  test('audit rows distinguish stale email recovery from stale SMS replay block', () => {
    const now = new Date('2026-05-26T12:00:00.000Z');
    const staleClaim = '2026-05-26T11:00:00.000Z';

    expect(leadEstimateAutoSendAuditRow(generatedEstimate({
      status: 'sending',
      send_method: 'email',
      estimate_data: {
        automation: {
          draftEstimateAutomation: {
            status: 'generated',
            generated: true,
          },
          autoSend: {
            claimedAt: staleClaim,
            sendMethod: 'email',
          },
        },
      },
    }), { now, staleClaimMinutes: 30 })).toMatchObject({
      action: 'stale_recover_then_send',
      wouldSend: true,
      staleClaim: true,
      staleRecovery: {
        includedSms: false,
        wouldRecover: true,
        wouldBlock: false,
      },
    });

    expect(leadEstimateAutoSendAuditRow(generatedEstimate({
      status: 'sending',
      send_method: 'both',
      estimate_data: {
        automation: {
          draftEstimateAutomation: {
            status: 'generated',
            generated: true,
          },
          autoSend: {
            claimedAt: staleClaim,
            sendMethod: 'both',
          },
        },
      },
    }), { now, staleClaimMinutes: 30 })).toMatchObject({
      action: 'stale_block_sms_replay',
      wouldSend: false,
      staleClaim: true,
      eligibility: {
        eligible: false,
        reason: 'stale_claim_sms_idempotency_unknown',
      },
      staleRecovery: {
        includedSms: true,
        wouldRecover: false,
        wouldBlock: true,
      },
    });

    expect(leadEstimateAutoSendAuditRow(generatedEstimate({
      status: 'sending',
      send_method: 'email',
      estimate_data: {
        automation: {
          draftEstimateAutomation: {
            status: 'generated',
            generated: true,
          },
          autoSend: {
            claimedAt: staleClaim,
            attemptedAt: '2026-05-26T11:05:00.000Z',
            sendMethod: 'email',
          },
        },
      },
    }), { now, staleClaimMinutes: 30 })).toMatchObject({
      action: 'blocked',
      wouldSend: false,
      staleClaim: true,
      eligibility: {
        eligible: false,
        reason: 'not_draft',
      },
      staleRecovery: null,
    });
  });

  test('preserves automation data when adding auto-send metadata', () => {
    const next = mergeAutoSendMetadata(generatedEstimate().estimate_data, {
      claimedAt: '2026-05-26T12:05:00.000Z',
      sendMethod: 'both',
    });

    expect(next.automation.leadEstimateAutomation.confidence).toBe('medium');
    expect(next.automation.draftEstimateAutomation.status).toBe('generated');
    expect(next.automation.autoSend).toEqual({
      claimedAt: '2026-05-26T12:05:00.000Z',
      sendMethod: 'both',
    });
  });
});

describe('claimLeadEstimateAutoSend — the claim itself re-asserts engine-authoritative pricing', () => {
  const { claimLeadEstimateAutoSend } = require('../services/lead-estimate-auto-send');

  function recordingDatabase() {
    const rawGuards = [];
    let patch = null;
    const chain = {
      where: () => chain,
      whereNull: () => chain,
      whereRaw: (sql) => { rawGuards.push(String(sql)); return chain; },
      update: (p) => { patch = p; return chain; },
      returning: async () => [{ id: 'estimate-1', status: 'sending', ...(patch || {}) }],
    };
    const database = () => chain;
    database.fn = { now: () => 'NOW()' };
    return { database, rawGuards, patchRef: () => patch };
  }

  test('the UPDATE requires the explicit SERVER stamp atomically, regardless of the send gate', async () => {
    const { database, rawGuards } = recordingDatabase();
    const claimed = await claimLeadEstimateAutoSend(database, generatedEstimate(), { now: new Date('2026-05-26T12:10:00.000Z') });
    expect(claimed?.status).toBe('sending');
    expect(rawGuards).toEqual(expect.arrayContaining([
      expect.stringContaining("UPPER(pricing_authority) = 'SERVER'"),
      expect.stringContaining("estimate_data->'proposal' IS NULL"),
    ]));
  });
});

describe('updateAutoSendMetadata — a pricing-authority block is written only while the row is still not SERVER (GH codex P2 r6)', () => {
  const { updateAutoSendMetadata, AUTO_SEND_BLOCK_STILL_NOT_SERVER_SQL } = require('../services/lead-estimate-auto-send');

  function recordingDatabase({ rowsAfterGuard = null } = {}) {
    const rawGuards = [];
    let patch = null;
    const chain = {
      where: () => chain,
      whereNull: () => chain,
      whereRaw: (sql) => { rawGuards.push(String(sql)); return chain; },
      update: (p) => { patch = p; return chain; },
      returning: async () => (rawGuards.length && rowsAfterGuard ? rowsAfterGuard : [{ id: 'estimate-1', status: 'draft', ...(patch || {}) }]),
    };
    const database = () => chain;
    database.fn = { now: () => 'NOW()' };
    database.raw = (sql) => sql;
    return { database, rawGuards };
  }

  test('the guard predicate rides on the UPDATE and a zero-row result reports no block', async () => {
    const { database, rawGuards } = recordingDatabase({ rowsAfterGuard: [] });
    const blocked = await updateAutoSendMetadata(database, { id: 'estimate-1', status: 'draft' }, { blockedAt: 'now', blockedReason: 'pricing_authority_not_server' }, 'draft', {}, (q) => q.whereRaw(AUTO_SEND_BLOCK_STILL_NOT_SERVER_SQL));
    expect(rawGuards).toEqual([AUTO_SEND_BLOCK_STILL_NOT_SERVER_SQL]);
    expect(AUTO_SEND_BLOCK_STILL_NOT_SERVER_SQL).toContain("<> 'SERVER'");
    expect(blocked).toBeUndefined();
  });

  test('without a guard the metadata write is unconditional, as before', async () => {
    const { database, rawGuards } = recordingDatabase();
    const blocked = await updateAutoSendMetadata(database, { id: 'estimate-1', status: 'draft' }, { blockedAt: 'now', blockedReason: 'quote_required' }, 'draft', {});
    expect(rawGuards).toEqual([]);
    expect(blocked?.id).toBe('estimate-1');
  });

  test('a null status writes NO status column — a block never moves a row a concurrent send carried past the stale candidate status (pre-push codex P1)', async () => {
    let written = null;
    const chain = {
      where: () => chain,
      whereNull: () => chain,
      whereRaw: () => chain,
      update: (p) => { written = p; return chain; },
      returning: async () => [{ id: 'estimate-1', status: 'sending' }],
    };
    const database = () => chain;
    database.fn = { now: () => 'NOW()' };
    database.raw = (sql) => sql;
    await updateAutoSendMetadata(database, { id: 'estimate-1', status: 'draft' }, { blockedAt: 'now', blockedReason: 'quote_required' }, null, {});
    expect(written).not.toHaveProperty('status');
    expect(written).toHaveProperty('estimate_data');
  });
});
