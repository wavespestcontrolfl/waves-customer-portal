'use strict';

const {
  isGenericCallLeadSource,
  shouldPreserveExistingLeadSource,
  findRecentEpisodeSiblingCalls,
  reconcilePriorEpisodeOnCallCompletion,
  isPhotoSubmissionSms,
  transcriptRequestedPhotos,
  isPhotoFollowUpToRecentCall,
  resolveFirstTouchCallLeadSource,
  _test: { isVisitReServiceRow },
} = require('../services/call-episode-reconciliation');
const { EPISODE_SAFE_SWEEP_RULES } = require('../services/triage-auto-resolve');

function makeChain(result) {
  const chain = {
    modify: jest.fn((fn) => { if (typeof fn === 'function') fn(chain); return chain; }),
    where: jest.fn((arg) => { if (typeof arg === 'function') arg(chain); return chain; }),
    whereNot: jest.fn().mockReturnThis(),
    whereIn: jest.fn().mockReturnThis(),
    whereNotIn: jest.fn().mockReturnThis(),
    whereNull: jest.fn().mockReturnThis(),
    whereExists: jest.fn((fn) => {
      const sub = {
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        whereIn: jest.fn().mockReturnThis(),
        whereNull: jest.fn().mockReturnThis(),
        whereRaw: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
      };
      if (typeof fn === 'function') fn.call(sub);
      return chain;
    }),
    from: jest.fn().mockReturnThis(),
    orWhere: jest.fn((arg) => { if (typeof arg === 'function') arg(chain); return chain; }),
    whereNotNull: jest.fn().mockReturnThis(),
    whereRaw: jest.fn().mockReturnThis(),
    orWhereRaw: jest.fn().mockReturnThis(),
    join: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    timeout: jest.fn().mockReturnThis(),
    count: jest.fn().mockReturnThis(),
    select: jest.fn().mockResolvedValue(result),
    first: jest.fn().mockResolvedValue(Array.isArray(result) ? result[0] : result),
    update: jest.fn().mockResolvedValue(typeof result === 'number' ? result : 0),
  };
  return chain;
}

describe('PR B2: 48h sibling lookup', () => {
  test('queries real call_log columns for strictly earlier non-spam sibling calls of the same customer', async () => {
    const callRows = [{ id: 'call-1', twilio_call_sid: 'CA1', customer_id: 'cust-1', metadata: {}, created_at: '2026-11-28T06:00:00Z' }];
    const callChain = makeChain(callRows);
    const conn = jest.fn(() => callChain);

    const found = await findRecentEpisodeSiblingCalls(conn, {
      customerId: 'cust-1',
      currentCallId: 'call-2',
      anchorCreatedAt: '2026-11-28T10:00:00Z',
    });
    expect(found).toHaveLength(1);
    expect(found[0].id).toBe('call-1');
    expect(callChain.select.mock.calls[0]).not.toContain('lead_id');
  });
});

describe('PR B2: Post-finalization delegation to triage-auto-resolve, customer-email-fanout, and booked-lead bell retirement', () => {
  test('delegates card settlement using actual resolution wall clock, enforces atomic SQL generation fence, and checks services table', async () => {
    expect(EPISODE_SAFE_SWEEP_RULES.has('address_moot')).toBe(true);
    expect(EPISODE_SAFE_SWEEP_RULES.has('quiet_aged')).toBe(false);
    expect(EPISODE_SAFE_SWEEP_RULES.has('quote_fulfilled')).toBe(false);

    const triageReconciler = jest.fn().mockResolvedValue({ applied: 2 });
    const emailResolver = jest.fn().mockResolvedValue(1);
    const bellWhereInCalls = [];
    const bellWhereRawCalls = [];
    let bellWhereExistsCalled = false;
    const resolvedAt = new Date('2026-11-28T11:30:00Z');

    const conn = jest.fn((table) => {
      if (table === 'call_log') {
        const c = makeChain([
          { id: 'call-1', twilio_call_sid: 'CA-call-1', customer_id: 'cust-1', metadata: { lead_id: 'lead-1' }, created_at: '2026-11-28T06:00:00Z' },
        ]);
        c.first = jest.fn().mockResolvedValue({ processing_generation: 7, processing_token: null });
        return c;
      }
      if (table === 'customers') return makeChain({ id: 'cust-1', email: 'jane@example.com', active: true });
      if (table === 'scheduled_services') return makeChain({ id: 'svc-2', status: 'confirmed', is_callback: false, service_type: 'One-Time Pest Control Service', service_id: 'cat-1' });
      if (table === 'services') return makeChain({ service_key: 'one_time_pest', name: 'One-Time Pest Control Service' });
      if (table === 'leads') return makeChain({ id: 'lead-1', twilio_call_sid: 'CA-call-1' });
      if (table === 'notifications') {
        const c = makeChain(1);
        c.whereIn = jest.fn((col, vals) => { bellWhereInCalls.push({ col, vals }); return c; });
        c.whereRaw = jest.fn((sql, bindings) => { bellWhereRawCalls.push({ sql, bindings }); return c; });
        c.orWhereRaw = jest.fn((sql, bindings) => { bellWhereRawCalls.push({ sql, bindings }); return c; });
        c.whereExists = jest.fn((fn) => {
          bellWhereExistsCalled = true;
          const sub = {
            from: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            whereIn: jest.fn().mockReturnThis(),
            whereNull: jest.fn().mockReturnThis(),
            whereRaw: jest.fn().mockReturnThis(),
            select: jest.fn().mockReturnThis(),
          };
          if (typeof fn === 'function') fn.call(sub);
          return c;
        });
        c.update = jest.fn().mockResolvedValue(1);
        return c;
      }
      return makeChain([]);
    });
    conn.raw = jest.fn((sql) => sql);

    const res = await reconcilePriorEpisodeOnCallCompletion(conn, {
      call: { id: 'call-2', created_at: '2026-11-28T10:00:00Z' },
      resolvedAt,
      customerId: 'cust-1',
      leadId: 'lead-1',
      procGeneration: 7,
      extracted: { is_spam: false, is_voicemail: false },
      appointmentResult: { scheduledServiceId: 'svc-2' },
      bridgeNeedsConfirmation: [],
      triageReconciler,
      emailResolver,
    });

    expect(res).toEqual({ cardsResolved: 3, bellsRetired: 1 });
    expect(triageReconciler).toHaveBeenCalledWith({ callIds: ['call-1'], now: resolvedAt });
    expect(emailResolver).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: 'cust-1',
        email: 'jane@example.com',
        reasonCodes: ['customer_email_missing'],
        restrictToCallLogIds: ['call-1'],
      }),
      conn,
    );
    expect(bellWhereExistsCalled).toBe(true);
    expect(bellWhereInCalls).toContainEqual({
      col: 'title',
      vals: ['Untracked call lead', 'New call lead', 'New voicemail lead'],
    });
    expect(bellWhereRawCalls).toEqual([
      { sql: "metadata->>'leadId' = ?", bindings: ['lead-1'] },
      { sql: "metadata->>'callSid' IN (?)", bindings: ['CA-call-1'] },
    ]);
  });

  test('aborts reconciliation when processing_generation is stale or claim token is still held', async () => {
    const triageReconciler = jest.fn();
    const conn = jest.fn(() => makeChain({ processing_generation: 8, processing_token: null }));
    const res = await reconcilePriorEpisodeOnCallCompletion(conn, {
      call: { id: 'call-2', created_at: '2026-11-28T10:00:00Z' },
      customerId: 'cust-1',
      leadId: 'lead-1',
      procGeneration: 7,
      triageReconciler,
    });
    expect(res).toEqual({ cardsResolved: 0, bellsRetired: 0 });
    expect(triageReconciler).not.toHaveBeenCalled();
  });

  test('retires voicemail-first lead bell with no siblings, rejects rescheduled/re-service/rodent_trapping_followup/lookup-error visits, and honors address_unit_conflict hold', async () => {
    expect(isVisitReServiceRow({ is_callback: true, service_type: 'Pest' })).toBe(true);
    expect(isVisitReServiceRow({ is_callback: false, service_type: 'Covered Re-Service' })).toBe(true);
    expect(isVisitReServiceRow({ is_callback: false, service_type: 'One-Time Pest Control' })).toBe(false);

    const makeConn = (visitRow, serviceRow = { service_key: 'one_time_pest', name: 'One-Time Pest' }, serviceThrows = false) => {
      const c = jest.fn((table) => {
        if (table === 'call_log') {
          const ch = makeChain([]);
          ch.first = jest.fn().mockResolvedValue({ processing_generation: 2, processing_token: null });
          return ch;
        }
        if (table === 'scheduled_services') return makeChain(visitRow);
        if (table === 'services') {
          const ch = makeChain(serviceRow);
          if (serviceThrows) ch.first = jest.fn().mockRejectedValue(new Error('db down'));
          return ch;
        }
        if (table === 'leads') return makeChain({ id: 'lead-vm', twilio_call_sid: 'CA-vm-1' });
        if (table === 'notifications') {
          const ch = makeChain(1);
          ch.update = jest.fn().mockResolvedValue(1);
          return ch;
        }
        return makeChain([]);
      });
      c.raw = jest.fn((sql) => sql);
      return c;
    };

    // Voicemail-first confirmed booking retires bell
    await expect(reconcilePriorEpisodeOnCallCompletion(
      makeConn({ id: 'svc-1', status: 'confirmed', is_callback: false, service_type: 'One-Time Pest', service_id: 'cat-1' }),
      { call: { id: 'call-2', created_at: '2026-11-28T10:00:00Z' }, customerId: 'cust-1', leadId: 'lead-vm', procGeneration: 2, appointmentResult: { scheduledServiceId: 'svc-1' } },
    )).resolves.toEqual({ cardsResolved: 0, bellsRetired: 1 });

    // Rescheduled status does NOT retire bell
    await expect(reconcilePriorEpisodeOnCallCompletion(
      makeConn({ id: 'svc-2', status: 'rescheduled', is_callback: false, service_type: 'One-Time Pest', service_id: 'cat-1' }),
      { call: { id: 'call-2', created_at: '2026-11-28T10:00:00Z' }, customerId: 'cust-1', leadId: 'lead-vm', procGeneration: 2, appointmentResult: { scheduledServiceId: 'svc-2' } },
    )).resolves.toEqual({ cardsResolved: 0, bellsRetired: 0 });

    // rodent_trapping_followup from services table does NOT retire bell
    await expect(reconcilePriorEpisodeOnCallCompletion(
      makeConn(
        { id: 'svc-3', status: 'confirmed', is_callback: false, service_type: 'Follow-Up Visit', service_id: 'cat-rt' },
        { service_key: 'rodent_trapping_followup', name: 'Rodent Trap Check' },
      ),
      { call: { id: 'call-2', created_at: '2026-11-28T10:00:00Z' }, customerId: 'cust-1', leadId: 'lead-vm', procGeneration: 2, appointmentResult: { scheduledServiceId: 'svc-3' } },
    )).resolves.toEqual({ cardsResolved: 0, bellsRetired: 0 });

    // Services table lookup error fails CLOSED (keeps alert open)
    await expect(reconcilePriorEpisodeOnCallCompletion(
      makeConn({ id: 'svc-4', status: 'confirmed', is_callback: false, service_type: 'Service', service_id: 'cat-1' }, null, true),
      { call: { id: 'call-2', created_at: '2026-11-28T10:00:00Z' }, customerId: 'cust-1', leadId: 'lead-vm', procGeneration: 2, appointmentResult: { scheduledServiceId: 'svc-4' } },
    )).resolves.toEqual({ cardsResolved: 0, bellsRetired: 0 });

    // Null service_id fails CLOSED (requires verified catalog service row)
    await expect(reconcilePriorEpisodeOnCallCompletion(
      makeConn({ id: 'svc-5', status: 'confirmed', is_callback: false, service_type: 'Service', service_id: null }),
      { call: { id: 'call-2', created_at: '2026-11-28T10:00:00Z' }, customerId: 'cust-1', leadId: 'lead-vm', procGeneration: 2, appointmentResult: { scheduledServiceId: 'svc-5' } },
    )).resolves.toEqual({ cardsResolved: 0, bellsRetired: 0 });

    // address_unit_conflict hold blocks bell retirement
    await expect(reconcilePriorEpisodeOnCallCompletion(
      makeConn({ id: 'svc-1', status: 'confirmed', is_callback: false, service_type: 'One-Time Pest', service_id: 'cat-1' }),
      { call: { id: 'call-2', created_at: '2026-11-28T10:00:00Z' }, customerId: 'cust-1', leadId: 'lead-vm', procGeneration: 2, appointmentResult: { scheduledServiceId: 'svc-1' }, bridgeNeedsConfirmation: ['address_unit_conflict'] },
    )).resolves.toEqual({ cardsResolved: 0, bellsRetired: 0 });
  });
});

describe('PR B2: Suppress false "Quote asked by text" on delivery-only photo SMS', () => {
  test('suppresses delivery-only captions / bare media and keeps mixed or arbitrary trailing captions eligible for triage', async () => {
    expect(isPhotoSubmissionSms({ triggerBody: 'Here are the pictures of the ants.', hasMedia: true })).toBe(true);
    expect(isPhotoSubmissionSms({ triggerBody: 'Photos of the ants', hasMedia: true })).toBe(true);
    expect(isPhotoSubmissionSms({ triggerBody: 'Attached is the photo you asked for', hasMedia: false })).toBe(true);
    expect(isPhotoSubmissionSms({ triggerBody: 'Here is the photo of the wasp nest', hasMedia: true })).toBe(true);
    expect(isPhotoSubmissionSms({ triggerBody: '', hasMedia: true })).toBe(true);

    // Mixed captions, pricing/scheduling asks, and arbitrary trailing wording stay in triage
    expect(isPhotoSubmissionSms({ triggerBody: 'Here are the photos, what would treatment run me', hasMedia: true })).toBe(false);
    expect(isPhotoSubmissionSms({ triggerBody: 'Here are the photos, let me know your availability Friday', hasMedia: true })).toBe(false);
    expect(isPhotoSubmissionSms({ triggerBody: 'Here are the photos. Please schedule termite treatment too', hasMedia: true })).toBe(false);
    expect(isPhotoSubmissionSms({ triggerBody: 'Please send me a bid for termite treatment', hasMedia: true })).toBe(false);
    expect(isPhotoSubmissionSms({ triggerBody: 'Can you give me a ballpark for termite treatment?', hasMedia: true })).toBe(false);
    expect(isPhotoSubmissionSms({ triggerBody: 'Wasp nest by porch', hasMedia: true })).toBe(false);

    expect(transcriptRequestedPhotos('Agent: Could you text me a picture of those bugs?\nCaller: Sure, sending now.')).toBe(true);
    expect(transcriptRequestedPhotos('Agent: I will send you a photo of the trap setup.\nCaller: Sounds good.')).toBe(false);
    expect(transcriptRequestedPhotos("Agent: Please don't send photos of the neighbor's yard.\nCaller: Okay.")).toBe(false);
    expect(transcriptRequestedPhotos('Caller: Can I text you a picture of the bugs?\nAgent: Let me check.')).toBe(false);

    const callChain = makeChain([
      { id: 'call-1', transcription: 'Agent: Go ahead and send us a photo of the wasp nest.\nCaller: Okay!' },
    ]);
    const connWithAgentAsk = jest.fn(() => callChain);
    await expect(isPhotoFollowUpToRecentCall(connWithAgentAsk, {
      phone: '+19415550199',
      triggerBody: 'Here is the photo of the wasp nest',
      hasMedia: true,
      now: '2026-11-28T10:00:00Z',
    })).resolves.toBe(true);
    expect(callChain.whereRaw.mock.calls.some(([sql]) => /NOT LIKE 'outbound%'/i.test(sql))).toBe(true);
  });
});

describe('PR B2: Preserve first-touch lead_source across repeat calls & tracking lines with shared-line identity guard', () => {
  test('preserves Call 1 Google Ads source for same caller, honors referrals, and refuses inheritance on shared lines or conflicting names', async () => {
    expect(isGenericCallLeadSource('phone_call')).toBe(true);
    expect(isGenericCallLeadSource('phone_tracking')).toBe(true);
    expect(isGenericCallLeadSource('google_ads')).toBe(false);
    expect(shouldPreserveExistingLeadSource('google_ads', 'phone_call')).toBe(true);

    const fakeTwilioNumbers = {
      findByNumber: (n) => (n === '+19415551111' ? { type: 'paid', domain: null } : null),
      getLeadSourceFromNumber: (n) => (n === '+19415551111'
        ? { source: 'google_ads', area: 'Google Ads Bradenton' }
        : { source: 'unknown' }),
    };

    // Same caller: Call 1 Google Ads voicemail followed by Call 2 inbound GBP call -> preserves first-touch google_ads
    const connRepeatTracking = jest.fn((table) => {
      if (table === 'customers') return makeChain([]);
      if (table === 'call_log') return makeChain([{ twilio_call_sid: 'CA-call-1', to_phone: '+19415551111', created_at: '2026-11-28T07:00:00Z', ai_extraction: { first_name: 'Jane', last_name: 'Smith' } }]);
      if (table === 'leads') return makeChain([{ created_at: '2026-11-28T07:02:00Z', twilio_call_sid: 'CA-call-1', first_name: 'Jane', last_name: 'Smith', source_type: 'phone_tracking', name: 'Website Line' }]);
      return makeChain([]);
    });
    await expect(resolveFirstTouchCallLeadSource(connRepeatTracking, {
      contactPhone: '+19415550199',
      currentCallId: 'call-2',
      currentCallCreatedAt: '2026-11-28T10:00:00Z',
      currentLeadSource: { source: 'google_business', area: 'Bradenton GBP' },
      callerFirstName: 'Jane',
      callerLastName: 'Smith',
      twilioNumbers: fakeTwilioNumbers,
    })).resolves.toEqual({ source: 'google_ads', detail: 'Google Ads Bradenton' });

    // Conflicting name on same phone -> retains currentLeadSource (does not inherit another person's channel)
    const connConflictName = jest.fn((table) => {
      if (table === 'customers') return makeChain([]);
      if (table === 'call_log') return makeChain([{ twilio_call_sid: 'CA-call-1', to_phone: '+19415551111', created_at: '2026-11-28T07:00:00Z', ai_extraction: { first_name: 'Bob', last_name: 'Jones' } }]);
      if (table === 'leads') return makeChain([{ created_at: '2026-11-28T07:02:00Z', twilio_call_sid: 'CA-call-1', first_name: 'Bob', last_name: 'Jones', source_type: 'google_ads', name: 'Google Ads' }]);
      return makeChain([]);
    });
    await expect(resolveFirstTouchCallLeadSource(connConflictName, {
      contactPhone: '+19415550199',
      currentCallId: 'call-2',
      currentCallCreatedAt: '2026-11-28T10:00:00Z',
      currentLeadSource: { source: 'google_business', area: 'Bradenton GBP' },
      callerFirstName: 'Jane',
      callerLastName: 'Smith',
      twilioNumbers: fakeTwilioNumbers,
    })).resolves.toEqual({ source: 'google_business', area: 'Bradenton GBP' });

    // Conflicting first name sharing the same surname -> retains currentLeadSource
    const connConflictFirst = jest.fn((table) => {
      if (table === 'customers') return makeChain([]);
      if (table === 'call_log') return makeChain([{ twilio_call_sid: 'CA-call-1', to_phone: '+19415551111', created_at: '2026-11-28T07:00:00Z', ai_extraction: { first_name: 'Bob', last_name: 'Smith' } }]);
      if (table === 'leads') return makeChain([{ created_at: '2026-11-28T07:02:00Z', twilio_call_sid: 'CA-call-1', first_name: 'Bob', last_name: 'Smith', source_type: 'google_ads', name: 'Google Ads' }]);
      return makeChain([]);
    });
    await expect(resolveFirstTouchCallLeadSource(connConflictFirst, {
      contactPhone: '+19415550199',
      currentCallId: 'call-2',
      currentCallCreatedAt: '2026-11-28T10:00:00Z',
      currentLeadSource: { source: 'google_business', area: 'Bradenton GBP' },
      callerFirstName: 'Jane',
      callerLastName: 'Smith',
      twilioNumbers: fakeTwilioNumbers,
    })).resolves.toEqual({ source: 'google_business', area: 'Bradenton GBP' });

    // Ambiguous shared phone (2 active customers) -> retains currentLeadSource
    const connSharedLine = jest.fn((table) => {
      if (table === 'customers') return makeChain([{ id: 'c1' }, { id: 'c2' }]);
      return makeChain([]);
    });
    await expect(resolveFirstTouchCallLeadSource(connSharedLine, {
      contactPhone: '+19415550199',
      currentCallId: 'call-2',
      currentCallCreatedAt: '2026-11-28T10:00:00Z',
      currentLeadSource: { source: 'google_business', area: 'Bradenton GBP' },
      callerFirstName: 'Jane',
      callerLastName: 'Smith',
      twilioNumbers: fakeTwilioNumbers,
    })).resolves.toEqual({ source: 'google_business', area: 'Bradenton GBP' });

    // Explicit referral on Call 1 still wins over Call 1's dialed tracking number
    const connWithReferralLead = jest.fn((table) => {
      if (table === 'customers') return makeChain([]);
      if (table === 'call_log') return makeChain([{ twilio_call_sid: 'CA-call-1', to_phone: '+19415551111', created_at: '2026-11-28T07:00:00Z', ai_extraction: {} }]);
      if (table === 'leads') return makeChain([{ created_at: '2026-11-28T07:02:00Z', twilio_call_sid: 'CA-call-1', source_type: 'referral', name: 'Customer Referral' }]);
      return makeChain([]);
    });
    await expect(resolveFirstTouchCallLeadSource(connWithReferralLead, {
      contactPhone: '+19415550199',
      currentCallId: 'call-2',
      currentCallCreatedAt: '2026-11-28T10:00:00Z',
      currentLeadSource: { source: 'phone_call' },
      twilioNumbers: fakeTwilioNumbers,
    })).resolves.toEqual({ source: 'referral', detail: 'Customer Referral' });
  });
});
