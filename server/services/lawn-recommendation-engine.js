/**
 * Rule-based lawn recommendation cards.
 *
 * KnowledgeBridge can explain context; this module decides whether a
 * recommendation card exists. Customer-visible upsells require multiple
 * signals and human approval.
 */

const db = require('../models/db');

const CUSTOMER_COPY_BLOCKLIST = [
  /callback\s+risk/i,
  /\bchurn\b/i,
  /\bupsell\b/i,
  /\bmargin\b/i,
  /AI\s+predicted/i,
  /artificial\s+intelligence\s+predicted/i,
];

const TIER_RANK = {
  bronze: 1,
  silver: 2,
  gold: 3,
  platinum: 4,
};

function parseJsonObject(value, fallback = {}) {
  if (value == null) return fallback;
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function parseJsonArray(value, fallback = []) {
  if (value == null) return fallback;
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : fallback;
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function isCustomerCopySafe(copy = '') {
  return !CUSTOMER_COPY_BLOCKLIST.some((pattern) => pattern.test(String(copy)));
}

function normalizeTier(tier) {
  return String(tier || '').trim().toLowerCase();
}

function scoreRecommendation(signals = []) {
  const uniqueSignals = new Set(signals.map((signal) => signal.key).filter(Boolean));
  if (uniqueSignals.size >= 4) return 0.9;
  if (uniqueSignals.size >= 3) return 0.8;
  if (uniqueSignals.size >= 2) return 0.72;
  if (uniqueSignals.size === 1) return 0.55;
  return 0;
}

function maxFindingSeverity(findings = []) {
  return findings.reduce((max, finding) => Math.max(max, Number(finding.severity) || 0), 0);
}

function assessmentSignal(assessment = {}) {
  if (!assessment?.confirmed_by_tech) return [];
  const signals = [{ key: 'confirmed_assessment', value: true, source: 'lawn_assessments' }];
  if ((Number(assessment.overall_score) || 100) < 70) {
    signals.push({
      key: 'moderate_pressure_latest_assessment',
      value: Number(assessment.overall_score),
      source: 'lawn_assessments',
    });
  }
  const stressFlags = parseJsonObject(assessment.stress_flags, {});
  for (const [key, value] of Object.entries(stressFlags)) {
    if (value === true) signals.push({ key: `tech_confirmed_${key}`, value: true, source: 'lawn_assessments' });
  }
  return signals;
}

function snapshotSignals(snapshot = {}) {
  const findings = parseJsonArray(snapshot.findings);
  const signals = [];
  if (maxFindingSeverity(findings) >= 2) {
    signals.push({
      key: 'moderate_or_higher_snapshot_finding',
      value: maxFindingSeverity(findings),
      source: 'property_health_snapshots',
    });
  }
  if (findings.length >= 2) {
    signals.push({
      key: 'multiple_current_findings',
      value: findings.length,
      source: 'property_health_snapshots',
    });
  }
  return signals;
}

function customerSafeCopy(card = {}) {
  if (card.type === 'tier_upgrade') {
    return 'Your lawn has needed extra attention recently. WaveGuard Gold may be a better fit because it provides more proactive monitoring and follow-up coverage.';
  }
  if (card.type === 'follow_up') {
    return 'We recommend a follow-up review so we can compare this area against the latest service and decide whether another action is needed.';
  }
  if (card.type === 'customer_education') {
    return 'Irrigation, mowing height, rainfall, and heat can affect how quickly your lawn responds after service.';
  }
  return card.customer_copy || '';
}

function evaluateTierUpgrade(inputs = {}) {
  const customer = inputs.customer || {};
  const currentTier = normalizeTier(customer.waveguard_tier);
  const currentRank = TIER_RANK[currentTier] || 0;
  const targetRank = TIER_RANK.gold;
  const baseSignals = [
    ...assessmentSignal(inputs.assessment),
    ...snapshotSignals(inputs.snapshot),
    ...(inputs.signals || []),
  ];
  const distinctSignals = Array.from(new Map(baseSignals.map((signal) => [signal.key, signal])).values());
  const confidence = scoreRecommendation(distinctSignals);

  if (currentRank >= targetRank || distinctSignals.length < 2 || confidence < 0.7 || !inputs.assessment?.confirmed_by_tech) {
    return null;
  }

  const card = {
    customer_id: inputs.customerId || customer.id || inputs.snapshot?.customer_id,
    snapshot_id: inputs.snapshot?.id || null,
    domain: 'lawn',
    type: 'tier_upgrade',
    title: 'WaveGuard Gold may be a better fit',
    priority: confidence >= 0.8 ? 'high' : 'medium',
    confidence,
    status: 'needs_admin_review',
    customer_visible: false,
    requires_human_approval: true,
    trigger_signals: distinctSignals,
    recommended_action: {
      action_type: 'upgrade_plan',
      plan: 'WaveGuard Gold',
      cta_label: 'Ask about Gold coverage',
    },
    guardrails: {
      min_signal_count: 2,
      no_single_photo_upsell: true,
      admin_approval_required: true,
    },
    internal_reason: `Gold candidate: ${distinctSignals.length} evidence signals from assessment/snapshot context.`,
  };
  card.customer_copy = customerSafeCopy(card);
  return isCustomerCopySafe(card.customer_copy) ? card : null;
}

function evaluateFollowUp(inputs = {}) {
  const findings = parseJsonArray(inputs.snapshot?.findings);
  const severity = maxFindingSeverity(findings);
  const stressFlags = parseJsonObject(inputs.assessment?.stress_flags, {});
  const followUpFlag = stressFlags.follow_up_needed === true || stressFlags.disease_suspicion === true;
  if (severity < 3 && !followUpFlag) return null;

  const signals = [
    { key: 'significant_current_condition', value: severity, source: 'property_health_snapshots' },
    ...(followUpFlag ? [{ key: 'tech_follow_up_signal', value: true, source: 'lawn_assessments' }] : []),
  ];
  const card = {
    customer_id: inputs.customerId || inputs.snapshot?.customer_id,
    snapshot_id: inputs.snapshot?.id || null,
    domain: 'lawn',
    type: 'follow_up',
    title: 'Follow-up review recommended',
    priority: severity >= 4 ? 'high' : 'medium',
    confidence: Math.max(0.7, scoreRecommendation(signals)),
    status: 'needs_admin_review',
    customer_visible: false,
    requires_human_approval: true,
    customer_copy: customerSafeCopy({ type: 'follow_up' }),
    internal_reason: 'Follow-up candidate based on significant condition or technician follow-up signal.',
    trigger_signals: signals,
    recommended_action: { action_type: 'schedule_follow_up', cta_label: 'Request follow-up' },
    guardrails: { admin_approval_required: true },
  };
  return isCustomerCopySafe(card.customer_copy) ? card : null;
}

function evaluateCustomerEducation(inputs = {}) {
  const weather = parseJsonObject(inputs.snapshot?.weather_context, {});
  const stressFlags = parseJsonObject(inputs.assessment?.stress_flags, {});
  const hasEducationSignal = Boolean(weather.customer_copy) || stressFlags.drought_stress === true || stressFlags.recent_scalp === true;
  if (!hasEducationSignal) return null;

  const signals = [
    ...(weather.customer_copy ? [{ key: 'weather_context_available', value: true, source: 'lawn_assessments.fawn_snapshot' }] : []),
    ...(stressFlags.drought_stress ? [{ key: 'tech_confirmed_drought_stress', value: true, source: 'lawn_assessments' }] : []),
    ...(stressFlags.recent_scalp ? [{ key: 'tech_confirmed_recent_scalp', value: true, source: 'lawn_assessments' }] : []),
  ];
  const card = {
    customer_id: inputs.customerId || inputs.snapshot?.customer_id,
    snapshot_id: inputs.snapshot?.id || null,
    domain: 'lawn',
    type: 'customer_education',
    title: 'How to support recovery',
    priority: 'low',
    confidence: Math.max(0.6, scoreRecommendation(signals)),
    status: 'draft',
    customer_visible: false,
    requires_human_approval: false,
    customer_copy: customerSafeCopy({ type: 'customer_education' }),
    internal_reason: 'Education card based on weather or technician-observed stress factors.',
    trigger_signals: signals,
    recommended_action: { action_type: 'customer_education', cta_label: 'View lawn care tips' },
    guardrails: { no_upsell_language: true },
  };
  return isCustomerCopySafe(card.customer_copy) ? card : null;
}

function evaluateAddonOpportunity() {
  return null;
}

function serializeCard(card) {
  return {
    ...card,
    confidence: Number(card.confidence.toFixed(3)),
    trigger_signals: JSON.stringify(card.trigger_signals || []),
    recommended_action: JSON.stringify(card.recommended_action || {}),
    guardrails: JSON.stringify(card.guardrails || {}),
    outcome: JSON.stringify(card.outcome || {}),
  };
}

async function generateRecommendationCards({ snapshotId, assessmentId, customerId, trx = null } = {}) {
  if (!snapshotId) throw new Error('snapshotId is required');

  // Run inside the caller's transaction when supplied so card generation is
  // serialized under the same per-assessment advisory lock as the snapshot
  // insert — otherwise an overlapping confirm could orphan these cards.
  const exec = trx || db;

  const snapshot = await exec('property_health_snapshots').where({ id: snapshotId, domain: 'lawn' }).first();
  if (!snapshot) {
    const err = new Error('Snapshot not found');
    err.code = 'snapshot_not_found';
    throw err;
  }

  const resolvedCustomerId = customerId || snapshot.customer_id;
  const resolvedAssessmentId = assessmentId || snapshot.assessment_id;
  const [customer, assessment] = await Promise.all([
    exec('customers').where({ id: resolvedCustomerId }).first(),
    resolvedAssessmentId ? exec('lawn_assessments').where({ id: resolvedAssessmentId }).first() : Promise.resolve(null),
  ]);

  if (!assessment?.confirmed_by_tech) return [];

  const inputs = {
    snapshot,
    assessment,
    customer: customer || {},
    customerId: resolvedCustomerId,
  };

  const candidates = [
    evaluateTierUpgrade(inputs),
    evaluateFollowUp(inputs),
    evaluateCustomerEducation(inputs),
    evaluateAddonOpportunity(inputs),
  ].filter(Boolean);

  if (!candidates.length) return [];

  const inserted = await exec('property_recommendation_cards')
    .insert(candidates.map(serializeCard))
    .returning('*');

  const eventRows = inserted.map((card) => ({
    recommendation_id: card.id,
    snapshot_id: card.snapshot_id,
    customer_id: card.customer_id,
    event_type: 'generated',
    actor_type: 'system',
    metadata: JSON.stringify({ type: card.type, status: card.status }),
  }));
  if (eventRows.length) await exec('property_recommendation_events').insert(eventRows);

  return inserted;
}

module.exports = {
  CUSTOMER_COPY_BLOCKLIST,
  generateRecommendationCards,
  evaluateTierUpgrade,
  evaluateFollowUp,
  evaluateCustomerEducation,
  evaluateAddonOpportunity,
  scoreRecommendation,
  customerSafeCopy,
  isCustomerCopySafe,
  _test: {
    parseJsonObject,
    parseJsonArray,
    normalizeTier,
    maxFindingSeverity,
    assessmentSignal,
    snapshotSignals,
  },
};
