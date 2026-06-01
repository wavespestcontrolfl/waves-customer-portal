const path = require('path');

const {
  _internals: {
    classifyScenario,
    shouldCaptureReply,
  },
} = require('../services/reply-training-capture');
const {
  buildReplyFixtureDocument,
  fixtureFromReplyExample,
} = require('../services/reply-training-fixtures');
const {
  DEFAULT_REPLY_FIXTURE_OUTPUT,
  assertSafeReplyFixtureOutput,
  isPathInside,
} = require('../services/reply-training-export-path');

describe('reply training capture', () => {
  test('captures only admin-authored outbound SMS replies with body text', () => {
    expect(shouldCaptureReply({
      channel: 'sms',
      direction: 'outbound',
      authorType: 'admin',
      adminUserId: 'tech-1',
      messageType: 'manual',
      body: 'I can help with that.',
    })).toBe(true);

    expect(shouldCaptureReply({
      channel: 'sms',
      direction: 'outbound',
      authorType: 'system',
      messageType: 'review_request',
      body: 'How was your service?',
    })).toBe(false);

    expect(shouldCaptureReply({
      channel: 'email',
      direction: 'outbound',
      authorType: 'admin',
      body: 'Email reply',
    })).toBe(false);
  });

  test('classifies common Waves customer reply scenarios', () => {
    expect(classifyScenario({
      inboundBody: "Turner may be free but they didn't look in the attic for Bora-Care.",
      outboundBody: 'I understand. We can take a closer look and explain our approach.',
    })).toBe('competitor_comparison');

    expect(classifyScenario({
      inboundBody: 'Can you come next Tuesday morning?',
      outboundBody: 'Tuesday morning should work. I can offer 9-11 or 11-1.',
    })).toBe('scheduling');

    expect(classifyScenario({
      inboundBody: 'Is it safe for my dog after you spray?',
      outboundBody: 'Yes, once dry. We use labeled products and targeted applications.',
    })).toBe('safety_or_prep_question');
  });

  test('exports captured replies as customer reply fixtures', () => {
    const fixture = fixtureFromReplyExample({
      id: '12345678-aaaa-bbbb-cccc-123456789000',
      channel: 'sms',
      scenario_label: 'service_scope_or_pest_question',
      inbound_body: 'Do you treat the lanai too?',
      outbound_body: 'Yes, we include the lanai sweep-down and targeted treatment as part of the visit.',
      context_snapshot: {
        customer: { id: 'customer-1', name: 'Carrie Eckert' },
        smsThread: [
          { direction: 'inbound', body: 'Do you treat the lanai too?' },
        ],
        recentCalls: [],
        recentServices: [],
        recentEstimates: [],
        recentLeads: [],
      },
    });

    expect(fixture).toMatchObject({
      sourceExampleId: '12345678-aaaa-bbbb-cccc-123456789000',
      scenarioLabel: 'service_scope_or_pest_question',
      input: {
        inboundBody: 'Do you treat the lanai too?',
        context: {
          customer: { name: 'Carrie Eckert' },
        },
      },
      expected: {
        outboundReply: expect.stringContaining('lanai sweep-down'),
      },
    });

    const document = buildReplyFixtureDocument({ examples: [{
      id: '12345678-aaaa-bbbb-cccc-123456789000',
      channel: 'sms',
      inbound_body: 'Do you treat the lanai too?',
      outbound_body: 'Yes, we include the lanai sweep-down.',
      context_snapshot: {},
    }] });

    expect(document).toMatchObject({
      schemaVersion: 'reply-training-fixtures.v1',
      workflow: 'customer_reply_sms',
      caseCount: 1,
    });
  });

  test('exports no-reply-needed reviewed examples without a final reply', () => {
    const fixture = fixtureFromReplyExample({
      id: '12345678-aaaa-bbbb-cccc-123456789000',
      channel: 'sms',
      scenario_label: 'general_customer_reply',
      inbound_body: 'Thank you!',
      outbound_body: null,
      agent_draft: 'You are welcome!',
      review_verdict: 'no_reply_needed',
      context_snapshot: {},
      metadata: { noReplyNeeded: true },
    });

    expect(fixture.expected).toMatchObject({
      replyVerdict: 'no_reply_needed',
      outboundReply: null,
      noReplyNeeded: true,
      agentDraft: 'You are welcome!',
    });
  });

  test('keeps raw reply fixture exports outside the repo unless explicitly allowed', () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const repoLocalOutput = path.join(repoRoot, 'server', 'fixtures', 'reply-training', 'local.json');

    expect(isPathInside(repoRoot, DEFAULT_REPLY_FIXTURE_OUTPUT)).toBe(false);
    expect(assertSafeReplyFixtureOutput(undefined, { repoRoot })).toBe(path.resolve(DEFAULT_REPLY_FIXTURE_OUTPUT));
    expect(() => assertSafeReplyFixtureOutput(repoLocalOutput, { repoRoot })).toThrow(/--allow-pii/);
    expect(assertSafeReplyFixtureOutput(repoLocalOutput, { repoRoot, allowPii: true })).toBe(repoLocalOutput);
  });
});
