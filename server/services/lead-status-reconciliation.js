const { OPEN_LEAD_STATUSES } = require('./lead-statuses');
const { isContactEvidenceType } = require('./lead-estimate-link');
const { scopeToAssessmentBookings } = require('./assessment-booking');
const ASSESSMENT_RESULT_LIMIT = 6;
function metadataOf(activity) {
  if (!activity?.metadata) return {};
  if (typeof activity.metadata === 'object') return activity.metadata || {};
  try {
    const parsed = JSON.parse(activity.metadata);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}
function atOrAfter(value, floor) {
  if (!floor) return true;
  const valueMs = new Date(value).getTime();
  const floorMs = new Date(floor).getTime();
  return Number.isFinite(valueMs) && Number.isFinite(floorMs) && valueMs >= floorMs;
}
const lifecycleFloor = (lead) => lead?.first_contact_at || lead?.created_at || null;
function exactContactActivities(lead, activities) {
  const floor = lifecycleFloor(lead);
  if (!floor) return [];
  return activities.filter((activity) => {
    const metadata = metadataOf(activity);
    return activity.activity_type === 'status_change'
      && activity.description === 'Status: new → contacted'
      && isContactEvidenceType(metadata.evidenceType)
      && atOrAfter(activity.created_at, floor);
  });
}
function assessmentQuery(database, lead, association) {
  const query = database('scheduled_services as ss')
    .leftJoin('services as svc', 'ss.service_id', 'svc.id')
    .where((builder) => builder
      .where('ss.created_at', '>=', lifecycleFloor(lead))
      .orWhere((completed) => completed
        .where('ss.status', 'completed')
        .where('ss.completed_at', '>=', lifecycleFloor(lead))))
    .where((builder) => builder
      .whereNull('ss.reservation_expires_at')
      .orWhereNotNull('ss.customer_id'))
    .modify((builder) => scopeToAssessmentBookings(builder, 'ss', 'svc'))
    .orderByRaw("CASE WHEN ss.status = 'completed' THEN COALESCE(ss.completed_at, ss.created_at) ELSE ss.created_at END DESC")
    .limit(ASSESSMENT_RESULT_LIMIT + 1)
    .select(
      'ss.id', 'ss.status', 'ss.created_at', 'ss.completed_at', 'ss.scheduled_date',
      'ss.source_estimate_id', 'ss.customer_id',
    );
  if (association === 'exact_estimate') {
    query.where('ss.source_estimate_id', lead.estimate_id);
  } else {
    query.where('ss.customer_id', lead.customer_id);
  }
  return query;
}
async function resolveAssessmentEvidence(database, lead) {
  if (!lifecycleFloor(lead)) return { association: 'unavailable', candidates: [], reason: 'missing_lifecycle_start' };
  if (lead.estimate_id) {
    const rows = await assessmentQuery(database, lead, 'exact_estimate');
    const candidates = rows.filter((row) => String(row.customer_id ?? '') === String(lead.customer_id ?? ''));
    if (rows.length) {
      return {
        association: 'exact_estimate',
        candidates: candidates.slice(0, ASSESSMENT_RESULT_LIMIT),
        conflicts: rows.filter((row) => String(row.customer_id ?? '') !== String(lead.customer_id ?? '')),
        truncated: rows.length > ASSESSMENT_RESULT_LIMIT,
      };
    }
  }
  if (!lead.customer_id) return { association: 'unavailable', candidates: [], reason: 'missing_customer_identity' };
  const [openLeads, rows] = await Promise.all([
    database('leads')
      .where({ customer_id: lead.customer_id })
      .whereNull('deleted_at')
      .whereIn('status', OPEN_LEAD_STATUSES)
      .limit(2)
      .select('id'),
    assessmentQuery(database, lead, 'customer'),
  ]);
  const uniqueCurrentLead = openLeads.length === 1 && String(openLeads[0].id) === String(lead.id);
  const unscopedRows = rows.filter((row) => row.source_estimate_id == null);
  return {
    association: uniqueCurrentLead ? 'unique_customer' : 'ambiguous_customer',
    candidates: unscopedRows.slice(0, ASSESSMENT_RESULT_LIMIT),
    conflicts: rows.filter((row) => row.source_estimate_id != null),
    truncated: rows.length > ASSESSMENT_RESULT_LIMIT,
    open_lead_count: openLeads.length,
  };
}
function buildLeadStatusReconciliation({
  lead,
  activities = [],
  assessmentResolution = { association: 'unavailable', candidates: [] },
  associatedCallCount = 0,
  associatedCallsAvailable = true,
}) {
  const findings = [];
  const exactActivities = exactContactActivities(lead, activities);
  if (lead.status === 'new') {
    if (assessmentResolution.reason === 'missing_lifecycle_start') {
      findings.push({
        code: 'lifecycle_start_unavailable', confidence: 'advisory',
        message: 'This lead has no lifecycle start time, so recent assessment and call evidence cannot be bounded safely. Review the timeline manually.',
      });
    }
    exactActivities.slice(0, 3).forEach((activity) => {
      const metadata = metadataOf(activity);
      findings.push({
        code: 'historical_contact_transition',
        confidence: 'exact',
        message: 'Verified evidence previously moved this lead from New to Contacted. A later status change returned it to New; review the timeline before changing it.',
        evidence: {
          type: metadata.evidenceType,
          id: metadata.evidenceId == null ? null : String(metadata.evidenceId),
          occurred_at: activity.created_at || null,
        },
      });
    });
    const exactEvidenceIds = new Set(exactActivities
      .map((activity) => metadataOf(activity).evidenceId)
      .filter((evidenceId) => evidenceId != null)
      .map(String));
    if (assessmentResolution.conflicts?.length) {
      findings.push({
        code: 'assessment_identity_conflict',
        confidence: 'ambiguous',
        message: 'Assessment evidence is linked to this estimate or customer but belongs to a different customer identity or estimate. Review the records manually.',
        evidence_count: assessmentResolution.conflicts.length,
      });
    }
    if (assessmentResolution.association === 'ambiguous_customer' && assessmentResolution.candidates.length) {
      findings.push({
        code: 'ambiguous_customer_assessment',
        confidence: 'ambiguous',
        message: 'A qualifying assessment exists for this customer, but more than one open lead could own it. Review the records manually.',
        evidence_count: assessmentResolution.candidates.length,
      });
    } else if (['exact_estimate', 'unique_customer'].includes(assessmentResolution.association)) {
      assessmentResolution.candidates
        .filter((candidate) => !exactEvidenceIds.has(String(candidate.id)))
        .slice(0, 3)
        .forEach((candidate) => findings.push({
          code: 'assessment_contact_candidate',
          confidence: assessmentResolution.association === 'exact_estimate' ? 'exact' : 'bounded',
          message: 'A qualifying assessment was booked or completed after this lead arrived, but no verified contact transition is recorded for it. Review before changing the status.',
          evidence: {
            type: candidate.status === 'completed' ? 'assessment_completed' : 'assessment_booked',
            id: String(candidate.id),
            occurred_at: candidate.status === 'completed'
              ? candidate.completed_at || candidate.created_at || null
              : candidate.created_at || null,
            appointment_status: candidate.status || null,
            association: assessmentResolution.association,
          },
        }));
    }
    if (!associatedCallsAvailable) {
      findings.push({
        code: 'associated_calls_unavailable',
        confidence: 'advisory',
        message: 'Associated call records could not be loaded, so this preview cannot evaluate their outcome. Review the call history manually.',
      });
    } else if (associatedCallCount > 0) {
      findings.push({
        code: 'associated_calls_unverified',
        confidence: 'advisory',
        message: 'Associated call records exist, but this preview cannot safely classify them as live contact. Review the call transcript and outcome manually.',
        evidence_count: associatedCallCount,
      });
    }
  }
  const review = findings.length > 0;
  const evaluated = lead.status === 'new';
  return {
    mode: 'read_only',
    status: evaluated ? (review ? 'review' : 'clear') : 'not_evaluated',
    current_status: lead.status,
    summary: !evaluated
      ? 'Current status was preserved. Reconciliation is evaluated only for leads in New.'
      : review
        ? 'Evidence needs review before anyone changes this lead status.'
        : 'No status conflict was found within this single-record preview.',
    findings,
    scope: {
      kind: 'single_record',
      writes: false,
      assessment_association: assessmentResolution.association,
      assessment_limit: ASSESSMENT_RESULT_LIMIT,
      assessment_truncated: !!assessmentResolution.truncated,
      calls: 'Associated calls are advisory only because no canonical persisted live-conversation resolver is available.',
      calls_available: associatedCallsAvailable,
      evaluated_statuses: ['new'],
      global_sweep: false,
    },
  };
}
async function getLeadStatusReconciliation({
  database, lead, activities = [], associatedCallCount = 0, associatedCallsAvailable = true,
}) {
  if (lead.status !== 'new') {
    return buildLeadStatusReconciliation({ lead, activities, associatedCallCount, associatedCallsAvailable });
  }
  const assessmentResolution = await resolveAssessmentEvidence(database, lead);
  return buildLeadStatusReconciliation({
    lead, activities, assessmentResolution, associatedCallCount, associatedCallsAvailable,
  });
}
module.exports = {
  buildLeadStatusReconciliation,
  getLeadStatusReconciliation,
  resolveAssessmentEvidence,
};
