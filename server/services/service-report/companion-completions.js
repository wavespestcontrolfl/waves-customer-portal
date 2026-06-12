/**
 * Companion typed sections for combined services
 * (docs/design/combined-service-completions.md).
 *
 * A service_completion_profiles row may declare companion typed-findings
 * sections that ride the service's normal primary completion flow. This
 * module owns the /complete-side validation and the per-companion trend
 * resolution so admin-dispatch stays thin and the logic is unit-testable.
 *
 * Trust rule: the PROFILE authorizes companion types, never the client
 * payload — a submitted type outside profile.companions is a 409, and a
 * declared type missing from the submission is a 422 on a completed visit.
 * All per-type validation calls into the existing typed machinery
 * (validateTypedFindings / validateNextStepChips / derive-then-pin /
 * validateActivityScoreConsistency); nothing is reimplemented here.
 */
const ActivityIndicators = require('./activity-indicators');

function reject(status, body) {
  return { ok: false, status, body };
}

/**
 * Validate a companionFindings submission against the profile's declared
 * companions. Returns { ok: true, companions } with one normalized entry per
 * declared companion, in DECLARED order ({ type, values, chips,
 * activityScore, activityScoreSource }), or { ok: false, status, body }
 * shaped like the /complete route's other validation failures.
 *
 * @param {object} opts.profile              resolved completion profile
 * @param {Array}  opts.companionFindings    request payload entries
 *                 [{ type, values, nextStepChips, activityScore, activityScoreSource }]
 * @param {string} opts.primaryFindingsType  profile.findingsType (null for
 *                 recurring primaries) — used for indicator-collision checks
 */
function validateCompanionSubmission({ profile, companionFindings, primaryFindingsType = null } = {}) {
  const declared = Array.isArray(profile?.companions) ? profile.companions : [];
  const submitted = companionFindings == null ? [] : companionFindings;
  if (!Array.isArray(submitted)) {
    return reject(400, {
      error: 'companionFindings must be an array',
      code: 'companion_findings_invalid',
    });
  }

  const declaredTypes = new Set(declared.map((c) => c.type));

  // Authorization: every submitted entry must be an object naming a declared
  // type. The profile is authoritative — a type the profile doesn't declare
  // is a 409, whatever the client claims.
  const seenTypes = new Set();
  const submittedByType = new Map();
  for (const entry of submitted) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.type !== 'string' || !entry.type.trim()) {
      return reject(400, {
        error: 'Each companionFindings entry must be an object with a type',
        code: 'companion_findings_invalid',
      });
    }
    const type = entry.type.trim();
    if (!declaredTypes.has(type)) {
      return reject(409, {
        error: `This service's completion profile does not include a "${type}" companion section. Refresh and complete the visit again.`,
        code: 'companion_type_mismatch',
        companionType: type,
      });
    }
    if (seenTypes.has(type)) {
      return reject(400, {
        error: `Duplicate companion findings submitted for type "${type}"`,
        code: 'companion_duplicate_type',
        companionType: type,
      });
    }
    seenTypes.add(type);
    submittedByType.set(type, entry);
  }

  // Completeness: a completed visit completes the WHOLE combined service —
  // every declared companion must be submitted (incomplete visits never
  // reach this validator).
  const missingTypes = declared.map((c) => c.type).filter((type) => !submittedByType.has(type));
  if (missingTypes.length) {
    return reject(422, {
      error: `This service completes with companion findings for: ${missingTypes.join(', ')}. Refresh the page and complete the visit again.`,
      code: 'companion_findings_required',
      missingTypes,
    });
  }

  // Indicator uniqueness — checked before per-entry field validation because
  // it's a profile-topology error, independent of submitted values: the
  // composite unique on service_activity_scores (service_record_id,
  // indicator_key) would otherwise silently drop one section's trend row.
  const usedIndicatorKeys = new Set();
  const primaryIndicator = primaryFindingsType
    ? ActivityIndicators.getActivityIndicator(primaryFindingsType)
    : null;
  if (primaryIndicator) usedIndicatorKeys.add(primaryIndicator.indicatorKey);
  for (const companion of declared) {
    const indicator = ActivityIndicators.getActivityIndicator(companion.type);
    if (!indicator) continue;
    if (usedIndicatorKeys.has(indicator.indicatorKey)) {
      return reject(422, {
        error: `Companion section "${companion.type}" shares the ${indicator.label} trend with another section on this completion — each activity trend can only be written once per visit.`,
        code: 'companion_indicator_conflict',
        companionType: companion.type,
        indicatorKey: indicator.indicatorKey,
      });
    }
    usedIndicatorKeys.add(indicator.indicatorKey);
  }

  const normalized = [];
  for (const companion of declared) {
    const type = companion.type;
    const entry = submittedByType.get(type);
    // validateTypedFindings rejects non-object values itself — pass through.
    const values = entry.values;

    // A declared companion is by definition cut over — required fields apply.
    const findingsValidation = ActivityIndicators.validateTypedFindings({
      type,
      values,
      expectedType: type,
      enforceRequired: true,
    });
    if (!findingsValidation.ok) {
      return reject(
        findingsValidation.missing.length && !findingsValidation.errors.length ? 422 : 400,
        {
          error: 'Companion findings failed validation',
          code: 'companion_findings_invalid',
          companionType: type,
          details: findingsValidation.errors,
          missing: findingsValidation.missing,
        },
      );
    }

    const chipsValidation = ActivityIndicators.validateNextStepChips(
      entry.nextStepChips, type, values || {},
    );
    if (!chipsValidation.ok) {
      return reject(400, {
        error: chipsValidation.error,
        code: 'companion_next_step_chips_invalid',
        companionType: type,
      });
    }
    if (ActivityIndicators.nextStepRequiredForType(type) && !chipsValidation.chips.length) {
      return reject(422, {
        error: `Select at least one next step for the ${type} companion section.`,
        code: 'companion_next_step_required',
        companionType: type,
      });
    }

    // Companion findings values render verbatim on the customer report via
    // the snapshot — same banned-copy policy as the primary's free-text
    // surfaces (absence wording stays observational, never absolute).
    const copyViolations = [...new Set(
      Object.values(values || {})
        .filter((v) => typeof v === 'string')
        .flatMap((v) => ActivityIndicators.findBannedCustomerCopy(v)),
    )];
    if (copyViolations.length) {
      return reject(422, {
        error: `The ${type} companion findings contain wording we can't put on a customer report (${copyViolations.join(', ')}). Describe what was observed and done today instead of absolute claims.`,
        code: 'companion_findings_banned_copy',
        companionType: type,
        violations: copyViolations,
      });
    }

    // Activity score: strict integer 0-5 or null, same contract as the
    // primary. Trend types require a score on a completed visit — derived
    // prefill fills it when the tech didn't touch the picker.
    const activityScore = entry.activityScore == null ? null : entry.activityScore;
    if (activityScore != null
      && (!Number.isInteger(activityScore) || activityScore < 0 || activityScore > 5)) {
      return reject(400, {
        error: `activityScore for the ${type} companion section must be an integer 0-5 (or null/omitted)`,
        code: 'companion_activity_score_invalid',
        companionType: type,
      });
    }
    const indicator = ActivityIndicators.getActivityIndicator(type);
    let finalScore = null;
    let finalScoreSource = null;
    if (indicator) {
      const derived = ActivityIndicators.deriveActivityScore(type, values || {});
      if (activityScore != null) {
        finalScore = activityScore;
        finalScoreSource = entry.activityScoreSource === 'derived' && derived?.score === activityScore
          ? 'derived'
          : 'technician';
      } else if (derived) {
        finalScore = derived.score;
        finalScoreSource = 'derived';
      } else {
        return reject(422, {
          error: `${indicator.label} requires an activity score (0-5) on a completed visit (${type} companion section)`,
          code: 'companion_activity_score_required',
          companionType: type,
        });
      }
      // The FINAL score (pinned or derived) must agree with the findings at
      // the cleared boundary — same rule as the primary typed path.
      const scoreConsistency = ActivityIndicators.validateActivityScoreConsistency(
        type, values || {}, finalScore,
      );
      if (!scoreConsistency.ok) {
        return reject(422, {
          error: scoreConsistency.error,
          code: 'activity_score_inconsistent',
          companionType: type,
        });
      }
    }

    normalized.push({
      type,
      values: values || {},
      chips: chipsValidation.chips,
      activityScore: finalScore,
      activityScoreSource: finalScoreSource,
    });
  }

  return { ok: true, companions: normalized };
}

/**
 * Per-companion prior-score / visit-sequence / trend resolution — the same
 * queries the primary typed path runs in admin-dispatch's completion trx
 * (latest prior score for the trend + an UNBOUNDED count for the visit
 * sequence, both keyed on the customer's indicator). Runs inside the
 * caller's transaction.
 *
 * Returns { activity, visitSequence } where activity matches the shape
 * buildTypedReportSnapshot expects (null when the type has no indicator or
 * no score).
 */
async function resolveCompanionActivity(trx, {
  customerId,
  indicatorKey,
  completionServiceDate,
  score,
  scoreSource,
  type,
  values,
}) {
  const indicator = ActivityIndicators.getActivityIndicator(type);
  if (!indicator || score == null) return { activity: null, visitSequence: 1 };
  const priorScoreRow = await trx('service_activity_scores')
    .where({
      customer_id: customerId,
      indicator_key: indicatorKey,
    })
    .where('service_date', '<=', completionServiceDate)
    .orderBy('service_date', 'desc')
    .orderBy('created_at', 'desc')
    .first('score');
  const [priorCountRow] = await trx('service_activity_scores')
    .where({
      customer_id: customerId,
      indicator_key: indicatorKey,
    })
    .where('service_date', '<=', completionServiceDate)
    .count('* as count');
  const priorScore = priorScoreRow ? Number(priorScoreRow.score) : null;
  const visitSequence = Number(priorCountRow?.count || 0) + 1;
  const derived = ActivityIndicators.deriveActivityScore(type, values || {});
  return {
    activity: {
      indicatorKey,
      label: indicator.label,
      score,
      source: scoreSource,
      derivedFrom: derived
        ? { field: derived.field, value: derived.value, initialDerivedScore: derived.score }
        : null,
      trend: ActivityIndicators.trendDirection(score, priorScore),
      trendWord: ActivityIndicators.trendWordForScores(score, priorScore),
    },
    visitSequence,
  };
}

module.exports = {
  validateCompanionSubmission,
  resolveCompanionActivity,
};
