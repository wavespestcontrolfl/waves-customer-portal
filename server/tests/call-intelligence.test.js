// The normalized call-intelligence view: generated vs human values are
// distinguishable, processing state is honest, and the next action comes
// from the open commitments before anything else. Fixtures fictitious.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { buildCallIntelligence, describeProcessing, nextAction } = require('../services/call-intelligence');

const V2 = {
  meta: { call_summary: 'Caller has ants in the kitchen and wants a price.', is_voicemail: false, is_spam: false, schema_version: '1.10.0' },
  caller: { name_full: 'Test Caller', relationship_to_property: 'owner', preferred_contact_method: 'email' },
  property: { service_address: { street_line_1: '123 Fixture Ln', city: 'Bradenton', state: 'FL', postal_code: '34201' }, property_type: 'single_family', pets_on_property: { present: true, species_notes: 'two dogs' } },
  service_request: { primary_service_category: 'pest_general', service_intent: 'quote_only', urgency: 'within_one_week', quoted_price_usd: 149, quote_promised: true, pests_observed: [{ pest_type: 'ants_general' }] },
  scheduling: { status: 'requested' },
  sentiment_and_lead: { sentiment: 'neutral', lead_quality: 'warm', objections_raised: ['price'], buying_signals: ['asked how soon'] },
  confidence: { overall: 0.8, service_address: 0.9 },
  evidence: [{ field_path: '/service_request/quoted_price_usd', quote: 'about a hundred forty nine', speaker: 'agent' }],
  triage_flags: ['quote_promised'],
  recommended_disposition: 'estimate_send',
};

const CALL = {
  id: 'call-1',
  twilio_call_sid: 'CA' + '1'.repeat(32),
  direction: 'inbound',
  created_at: '2026-09-01T14:00:00Z',
  duration_seconds: 120,
  processing_status: 'processed',
  transcription_status: 'completed',
  transcription_provider: 'openai',
  review_status: null,
  v2_extraction_status: 'valid',
  processing_generation: 2,
  ai_extraction_prompt_version: 'v5-abc',
  ai_extraction_model: 'fixture-model',
  ai_extraction_enriched: JSON.stringify(V2),
  transcription: 'Agent: it is about a hundred forty nine.',
  transcript_structured: JSON.stringify({ segments: [{ index: 0, speaker: 'A', start_ms: 0, end_ms: 3000, text: 'it is about a hundred forty nine.' }] }),
  metadata: JSON.stringify({ lead_id: 'lead-9', processing_timings: { total_ms: 4200, transcription_ms: 1500 } }),
  customer_id: 'cust-1',
  first_name: 'Test',
  last_name: 'Customer',
  recording_sid: 'RE' + '1'.repeat(32),
};

describe('buildCallIntelligence', () => {
  test('normalizes outcome, intent, prices with quote type, evidence anchored to segments, and links', () => {
    const view = buildCallIntelligence({ call: CALL, commitments: [], outcomes: null });
    expect(view.summary).toBe('Caller has ants in the kitchen and wants a price.');
    expect(view.outcome).toMatchObject({ recommended_disposition: 'estimate_send', lead_quality: 'warm', sentiment: 'neutral' });
    expect(view.intent).toMatchObject({ primary_service_category: 'pest_general', urgency: 'within_one_week', pests_observed: ['ants_general'] });
    expect(view.prices).toMatchObject({ quoted_price_usd: 149, quote_type: 'estimate_to_follow', quote_promised: true });
    expect(view.property.address).toBe('123 Fixture Ln, Bradenton, FL, 34201');
    expect(view.property.pets_on_property).toBe(true);
    expect(view.evidence[0]).toMatchObject({ matched: true, segment_index: 0, start_ms: 0 });
    expect(view.links).toEqual({
      customer_id: 'cust-1', customer_name: 'Test Customer', lead_id: 'lead-9',
      customer_link: { source: 'generated', customer_id: 'cust-1' },
    });
    expect(view.processing).toMatchObject({ status: 'processed', phase: 'complete', generation: 2, timings: { total_ms: 4200 } });
  });

  test('an operator customer link is reported as human-set with who/when and the previous value', () => {
    const call = { ...CALL, metadata: JSON.stringify({ customer_link_override: { customer_id: 'cust-2', previous_customer_id: 'cust-1', by: 'tech-1', at: '2026-09-01T15:00:00Z' } }), customer_id: 'cust-2' };
    const view = buildCallIntelligence({ call, commitments: [] });
    expect(view.links.customer_link).toEqual({ source: 'human', customer_id: 'cust-2', by: 'tech-1', at: '2026-09-01T15:00:00Z', previous_customer_id: 'cust-1' });
  });

  test('next action is the earliest-due open Waves commitment, and says whether it was detected or office-added', () => {
    const commitments = [
      { id: 'c2', party: 'waves', kind: 'send_estimate', description: 'Send the estimate', status: 'open', due_at: '2026-09-03T00:00:00Z', source: 'ai', human_state: null },
      { id: 'c1', party: 'waves', kind: 'callback', description: 'Call back', status: 'open', due_at: '2026-09-02T00:00:00Z', source: 'human', human_state: 'confirmed' },
      { id: 'c3', party: 'customer', kind: 'send_photos', description: 'Text photos', status: 'open', due_at: null, source: 'ai', human_state: null },
      { id: 'c4', party: 'waves', kind: 'send_report', description: 'Email report', status: 'open', due_at: '2026-09-01T00:00:00Z', source: 'ai', human_state: 'dismissed' },
    ];
    const view = buildCallIntelligence({ call: CALL, commitments });
    expect(view.next_action).toMatchObject({ commitment_id: 'c1', owner: 'office', basis: 'office_added' });
    expect(nextAction({ commitments: [], disposition: null, v2: V2, reviewStatus: 'open' })).toMatchObject({ kind: 'review' });
    expect(nextAction({ commitments: [], disposition: 'estimate_send', v2: null, reviewStatus: null })).toMatchObject({ kind: 'estimate_send', basis: 'disposition' });
    // The rules layer's persisted disposition outranks the model's recommendation; the model fills in only when nothing was stamped (codex gh-r17 P1).
    expect(nextAction({ commitments: [], disposition: 'complaint_escalated', v2: { recommended_disposition: 'estimate_send' }, reviewStatus: null })).toMatchObject({ kind: 'complaint_escalated', owner: 'owner', basis: 'disposition' });
    expect(nextAction({ commitments: [], disposition: null, v2: { recommended_disposition: 'estimate_send' }, reviewStatus: null })).toMatchObject({ kind: 'estimate_send', basis: 'recommended_disposition' });
    expect(nextAction({ commitments: [], disposition: null, v2: null, reviewStatus: null })).toBeNull();
  });

  test('a schema-rejected V2 candidate is not presented as intelligence — only a valid V2 is (codex gh-r10 P1)', () => {
    const view = buildCallIntelligence({ call: { ...CALL, call_summary: null, v2_extraction_status: 'schema_failed' }, commitments: [] });
    expect(view.summary).toBeNull();
    // A POPULATED legacy column is not a fallback either: call_summary /
    // lead_quality / sentiment on call_log are V1 output (codex gh-r14 P1).
    const legacy = buildCallIntelligence({ call: { ...CALL, call_summary: 'legacy V1 summary', lead_quality: 'hot', sentiment: 'positive', v2_extraction_status: 'schema_failed' }, commitments: [] });
    expect(legacy.summary).toBeNull();
    expect(legacy.outcome.lead_quality).toBeNull();
    expect(legacy.outcome.sentiment).toBeNull();
    expect(view.intent.primary_service_category).toBeNull();
    expect(view.prices.quoted_price_usd ?? null).toBeNull();
    expect(view.processing.v2_extraction_status).toBe('schema_failed');
  });

  test('a call with no V2 extraction renders honestly empty — the legacy V1 extraction is never revived (AGENTS.md; codex gh-r8 P1)', () => {
    const view = buildCallIntelligence({ call: { ...CALL, call_summary: null, ai_extraction_enriched: null, ai_extraction: JSON.stringify({ call_summary: 'legacy summary', first_name: 'Test', quote_promised: true, matched_service: 'General Pest Control', email: 'x@example.com', address_line1: '1 Legacy Ln' }), transcript_structured: null }, commitments: [] });
    expect(view.summary).toBeNull();
    expect(view.intent.specific_service_name).toBeNull();
    expect(view.prices.quote_promised).toBeNull();
    expect(view.caller.name).toBeNull();
    expect(view.caller.email_captured).toBe(false);
    expect(view.property.address).toBeNull();
    expect(view.transcript_segments).toBeNull();
    expect(view.evidence).toEqual([]);
  });
});

describe('describeProcessing — honest phases', () => {
  const base = { recording_url: 'https://api.twilio.com/x.mp3', extraction_attempts: 0 };
  test.each([
    [{ processing_status: null }, 'queued', false],
    [{ processing_status: null, recording_url: null }, 'waiting_for_recording', false],
    [{ processing_status: 'processing', processing_heartbeat_at: new Date(Date.now() - 60000).toISOString() }, 'processing', false],
    [{ processing_status: 'processed' }, 'complete', false],
    [{ processing_status: 'no_transcription' }, 'failed_retrying', true],
    [{ processing_status: 'extraction_failed', extraction_attempts: 1 }, 'failed_retrying', true],
    [{ processing_status: 'extraction_failed', extraction_attempts: 3 }, 'failed', false],
    // Older than the sweep's retry window: no automatic retry is coming (codex gh-r9 P2).
    [{ processing_status: 'extraction_failed', extraction_attempts: 1, created_at: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString() }, 'failed', false],
    [{ processing_status: 'customer_creation_failed' }, 'failed', false],
    [{ processing_status: 'lead_creation_failed' }, 'failed', false],
    [{ processing_status: 'something_new' }, 'unknown', false],
  ])('%o → %s', (row, phase, retryable) => {
    const out = describeProcessing({ ...base, ...row });
    expect(out.phase).toBe(phase);
    expect(out.retryable).toBe(retryable);
  });

  test('a claim whose heartbeat went quiet says so instead of "processing"', () => {
    const out = describeProcessing({ ...base, processing_status: 'processing', processing_heartbeat_at: new Date(Date.now() - 15 * 60000).toISOString() });
    expect(out.detail).toMatch(/heartbeat stopped 15 min ago/);
  });

  test('schema validation errors are surfaced, capped, and never the raw model output', () => {
    const errors = Array.from({ length: 9 }, (_, i) => ({ instancePath: `/f${i}`, message: 'must be string' }));
    const out = describeProcessing({ ...base, processing_status: 'processed', ai_extraction_validation_errors: JSON.stringify(errors) });
    expect(out.validation_errors).toHaveLength(5);
  });
});
