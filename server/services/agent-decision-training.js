const {
  CUSTOMER_SMS_TRIAGE_WORKFLOW,
  SERVICE_SCHEDULING_WORKFLOW,
  WORKFLOW: ESTIMATE_CONVERSION_WORKFLOW,
  classifyCustomerSmsTriageIntent,
  classifyEstimateSmsIntent,
  classifyServiceSchedulingSmsIntent,
} = require('./estimate-conversion-agent');

const SCHEMA_VERSION = 'agent-decision-fixtures.v1';

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (_err) {
    return fallback;
  }
}

function arrayFrom(value) {
  const parsed = parseJson(value, value);
  if (Array.isArray(parsed)) return parsed.map((item) => String(item || '').trim()).filter(Boolean);
  if (typeof parsed === 'string') return parsed.split(/\n|,/).map((item) => item.trim()).filter(Boolean);
  return [];
}

function compactObject(value = {}) {
  return Object.fromEntries(
    Object.entries(value || {}).filter(([, item]) => item !== null && item !== undefined && item !== '')
  );
}

function redactText(value, context = {}) {
  let text = String(value || '');
  if (!text) return text;

  const names = [
    context?.customer?.first_name,
    context?.customer?.last_name,
    context?.customer?.customer_name,
    context?.estimate?.customer_name,
    context?.lead?.first_name,
    context?.lead?.last_name,
  ].map((item) => String(item || '').trim()).filter((item) => item.length >= 3);

  for (const name of names) {
    text = text.replace(new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), '[name]');
  }

  return text
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
    .replace(/\+?1?[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, '[phone]')
    .replace(/\b\d{1,6}\s+[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,5}\s+(?:St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Ln|Lane|Ct|Court|Cir|Circle|Way|Pl|Place|Blvd|Boulevard|Ter|Terrace)\b\.?/gi, '[address]')
    .replace(/https?:\/\/\S+/gi, '[url]');
}

function redactValue(value, context = {}, key = '') {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, context, key));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
      childKey,
      redactValue(childValue, context, childKey),
    ]));
  }
  if (typeof value !== 'string') return value;

  if (/(name|email|phone|address|street|line1|line2|zip|postal)/i.test(key)) {
    return `[redacted_${key}]`;
  }
  return redactText(value, context);
}

function fixtureFromDecision(row, options = {}) {
  const redact = options.redact !== false;
  const inputSnapshot = parseJson(row.input_snapshot, {});
  const context = compactObject({
    customer: inputSnapshot.customer || null,
    estimate: inputSnapshot.estimate || null,
    lead: inputSnapshot.lead || null,
    recentSmsThread: inputSnapshot.recent_sms_thread || inputSnapshot.recentSmsThread || null,
  });
  const humanVerdict = row.human_verdict || row.status || 'pending_review';
  const correctedActions = arrayFrom(row.corrected_actions);
  const recommendedActions = arrayFrom(row.recommended_actions);
  const blockedActions = arrayFrom(row.blocked_actions);
  const safetyFlags = arrayFrom(row.safety_flags);
  const body = inputSnapshot?.sms?.body || row.sms_message_body || '';

  let expectedIntent = row.detected_intent || null;
  let expectedRecommendedActions = recommendedActions;
  let expectedBlockedActions = blockedActions;
  let expectedSafetyFlags = safetyFlags;

  if (humanVerdict === 'corrected') {
    expectedRecommendedActions = correctedActions.length ? correctedActions : recommendedActions;
  } else if (humanVerdict === 'dismissed') {
    expectedIntent = null;
    expectedRecommendedActions = [];
    expectedBlockedActions = [];
    expectedSafetyFlags = [];
  }

  return {
    id: `decision_${String(row.id || '').slice(0, 8)}`,
    sourceDecisionId: row.id,
    workflow: row.workflow,
    reviewedAt: row.reviewed_at || null,
    humanVerdict,
    correctionNote: row.correction_note || null,
    input: {
      body: redact ? redactText(body, context) : body,
      context: redact ? redactValue(context, context) : context,
    },
    expected: {
      intent: expectedIntent,
      recommendedActions: expectedRecommendedActions,
      blockedActions: expectedBlockedActions,
      safetyFlags: expectedSafetyFlags,
    },
  };
}

function buildFixtureDocument({ workflow, decisions = [], exportedAt = new Date().toISOString(), redact = true } = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    exportedAt,
    workflow: workflow || null,
    caseCount: decisions.length,
    redacted: redact !== false,
    cases: decisions.map((decision) => fixtureFromDecision(decision, { redact })),
  };
}

function includesAll(actual = [], expected = []) {
  const actualSet = new Set((actual || []).map(String));
  return (expected || []).every((item) => actualSet.has(String(item)));
}

function evaluateDecisionForWorkflow(testCase = {}) {
  const workflow = testCase.workflow || ESTIMATE_CONVERSION_WORKFLOW;
  const body = testCase?.input?.body || '';
  const context = testCase?.input?.context || {};

  if (workflow === SERVICE_SCHEDULING_WORKFLOW) {
    return classifyServiceSchedulingSmsIntent(body, context);
  }
  if (workflow === CUSTOMER_SMS_TRIAGE_WORKFLOW) {
    return classifyCustomerSmsTriageIntent(body, context);
  }
  return classifyEstimateSmsIntent(body, context);
}

function evaluateFixture(testCase) {
  const actual = evaluateDecisionForWorkflow(testCase);
  const expected = testCase.expected || {};
  const failures = [];

  if ((actual.intent || null) !== (expected.intent || null)) {
    failures.push(`intent expected=${expected.intent || 'null'} actual=${actual.intent || 'null'}`);
  }
  if (!includesAll(actual.recommendedActions, expected.recommendedActions || [])) {
    failures.push('recommendedActions missing expected items');
  }
  if (!includesAll(actual.blockedActions, expected.blockedActions || [])) {
    failures.push('blockedActions missing expected items');
  }
  if (!includesAll(actual.safetyFlags, expected.safetyFlags || [])) {
    failures.push('safetyFlags missing expected items');
  }

  return {
    id: testCase.id,
    ok: failures.length === 0,
    failures,
    expected,
    actual: {
      intent: actual.intent || null,
      confidence: actual.confidence,
      recommendedActions: actual.recommendedActions || [],
      blockedActions: actual.blockedActions || [],
      safetyFlags: actual.safetyFlags || [],
      suggestedMessage: actual.suggestedMessage || null,
    },
  };
}

function evaluateFixtureDocument(document = {}) {
  const cases = Array.isArray(document.cases) ? document.cases : [];
  const results = cases.map(evaluateFixture);
  const passed = results.filter((row) => row.ok).length;
  const failed = results.length - passed;
  return {
    schemaVersion: document.schemaVersion || null,
    workflow: document.workflow || null,
    caseCount: results.length,
    passed,
    failed,
    passRate: results.length ? passed / results.length : 1,
    results,
  };
}

module.exports = {
  SCHEMA_VERSION,
  buildFixtureDocument,
  evaluateFixture,
  evaluateFixtureDocument,
  fixtureFromDecision,
  // Shared PII redaction — the voice-corpus miner rides these so corpus
  // rows and decision fixtures redact identically (one source of truth).
  redactText,
  redactValue,
  _test: {
    arrayFrom,
    evaluateDecisionForWorkflow,
    parseJson,
    redactText,
    redactValue,
  },
};
