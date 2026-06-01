const SCHEMA_VERSION = 'reply-training-fixtures.v1';

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (_err) {
    return fallback;
  }
}

function fixtureFromReplyExample(row) {
  const context = parseJson(row.context_snapshot, {});
  const metadata = parseJson(row.metadata, {});
  return {
    id: `reply_${String(row.id || '').slice(0, 8)}`,
    sourceExampleId: row.id,
    channel: row.channel || 'sms',
    scenarioLabel: row.scenario_label || 'general_customer_reply',
    capturedAt: row.captured_at || row.created_at || null,
    status: row.status || 'captured',
    input: {
      inboundBody: row.inbound_body || context?.pairedInbound?.body || '',
      context: {
        conversation: context.conversation || null,
        customer: context.customer || null,
        smsThread: context.smsThread || [],
        recentCalls: context.recentCalls || [],
        recentServices: context.recentServices || [],
        recentEstimates: context.recentEstimates || [],
        recentLeads: context.recentLeads || [],
      },
    },
    expected: {
      replyVerdict: row.review_verdict || null,
      outboundReply: row.review_verdict === 'no_reply_needed' ? null : row.outbound_body || '',
      noReplyNeeded: row.review_verdict === 'no_reply_needed' || !!metadata.noReplyNeeded,
      tone: metadata.tone || 'friendly_professional_waves',
      agentDraft: row.agent_draft || null,
      agentDraftEdited: row.agent_draft_edited,
    },
  };
}

function buildReplyFixtureDocument({ examples = [], exportedAt = new Date().toISOString() } = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    exportedAt,
    workflow: 'customer_reply_sms',
    caseCount: examples.length,
    cases: examples.map(fixtureFromReplyExample),
  };
}

module.exports = {
  SCHEMA_VERSION,
  buildReplyFixtureDocument,
  fixtureFromReplyExample,
  _test: {
    parseJson,
  },
};
