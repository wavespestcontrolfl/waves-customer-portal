const db = require('../models/db');
const logger = require('./logger');
const { isTypedFindingsType } = require('./service-report/activity-indicators');

// Project types that must NEVER route through the generic typed
// service-report (Specialty V1) completion flow, no matter what
// service_completion_profiles says. WDO completion is load-bearing legal
// machinery — licensee e-signature gate, signed FDACS-13645 PDF generation,
// archived filings, the combined report+invoice send — none of which V1
// completion performs. Profile rows are data: one bad WHERE clause in a
// future cutover migration could silently flip the mode and bypass every
// FDACS gate, so the exclusion is enforced in code at profile resolution
// (serializeProfile coerces the mode back) and at creation gating
// (appointmentManagedProjectTypes filters it out).
const V1_EXCLUDED_PROJECT_TYPES = new Set(['wdo_inspection']);
// Compliance project types stay in Projects (FDACS/signature/PDF gates) —
// never servable as companion sections either, or a bad profile row could
// route compliance work through a routine /complete. Superset of the
// V1 exclusions: pre-treat certificates never had a service_report profile
// to coerce, but the companion JSON path must still refuse them.
const COMPANION_EXCLUDED_TYPES = new Set([...V1_EXCLUDED_PROJECT_TYPES, 'pre_treatment_termite_certificate']);
// Types that stay CREATABLE as standalone documentation projects even though
// their routine appointment completions have fully cut over to the typed
// service-report flow. UNLIKE V1_EXCLUDED_PROJECT_TYPES this carries no
// completion-safety semantics: serializeProfile does NOT coerce these
// profiles — the exemption only keeps the Projects creation path (picker +
// create gate) open for inspection/documentation-heavy one-off jobs.
// EMPTY since 2026-07-13: the owner retired the flea + rodent_trapping
// ad-hoc lanes (directive superseding 2026-07-04) — with the termite family
// cut over (#2708), every fully-typed family now completes through the
// appointment flow only. The mechanism stays for a future exemption.
const PROJECT_CREATION_KEPT_TYPES = new Set([]);
// Retired-typed pointers (untype migrations, e.g. bed_bug in
// 20260731400000): clearing the profile pointer changes the completion
// FORM, it does not resurrect the retired Projects creation path. Without
// this code-enforced set, the pointer going NULL would drop the type from
// appointmentManagedProjectTypes and /admin/projects would re-expose the
// retired project form as a second, conflicting completion lane
// (codex P1 r1 on the bed-bug untype).
const UNTYPED_RETIRED_PROJECT_TYPES = new Set(['bed_bug']);
// Compliance project types create ONLY from their scheduled visit (owner
// ruling 2026-07-13: "we don't ever do a WDO or pre-treat without something
// scheduled"). Creation-side only — completion stays on the project flow
// (V1_EXCLUDED_PROJECT_TYPES / the special_project profiles are untouched).
// POST /admin/projects enforces it with the same linked-profile bypass the
// appointment-managed gate uses (the linked service's own project-backed
// profile must point at this exact type); pickers hide these from ad-hoc
// creation via the linkedCreationOnly flag on GET /admin/projects/types.
const PROJECT_CREATION_LINKED_ONLY_TYPES = new Set(['wdo_inspection', 'pre_treatment_termite_certificate']);

const DEFAULT_SERVICE_REPORT_PROFILE = {
  serviceKey: null,
  serviceName: null,
  category: null,
  billingType: null,
  completionMode: 'service_report',
  projectType: null,
  createsServiceRecord: true,
  portalVisibility: 'customer_portal',
  portalAttachPolicy: 'active_portal_customer',
  followupPolicy: 'none',
  defaultFollowupDays: null,
  active: true,
  notes: 'Fallback profile: standard service-report completion.',
  projectBacked: false,
  specialProject: false,
  requiresProject: false,
  findingsType: null,
  deliveryMode: 'auto_send',
  companions: [],
};

const COMPANION_DELIVERY_MODES = new Set(['auto_send', 'internal_only']);

/**
 * Parse a profile row's companion_types JSONB into [{type, delivery}],
 * FAIL-SAFE (combined-service-completions.md): the column is admin-mutable
 * data and every bad entry must degrade toward "less customer exposure",
 * never toward an unvalidated section or an accidental customer send.
 *  - non-array / unparseable / garbage → []
 *  - entries whose type isn't a registered typed findings type → dropped
 *    (an unknown type has no schema, no validation, no snapshot builder)
 *  - entries duplicating the profile's own findingsType → dropped (the
 *    primary already owns that section)
 *  - duplicate companion types → first entry wins, later duplicates dropped.
 *    Two entries for one type would put two schemas for the same section on
 *    the completion form; the client submits both and /complete 409s every
 *    attempt (companion_duplicate_type), stranding the tech until the DB row
 *    is hand-fixed. A 'disabled' entry claims its type too, so a stale
 *    duplicate can't resurrect a section the admin turned off.
 *  - delivery 'disabled' → dropped (section fully off)
 *  - missing/invalid delivery → coerced to 'internal_only' (never
 *    accidentally customer-facing)
 */
function parseCompanionTypes(raw, ownFindingsType = null) {
  let entries = raw;
  if (typeof entries === 'string') {
    try { entries = JSON.parse(entries); } catch { return []; }
  }
  if (!Array.isArray(entries)) return [];
  const companions = [];
  const seenTypes = new Set();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const type = typeof entry.type === 'string' ? entry.type.trim() : '';
    if (!type || !isTypedFindingsType(type)) continue;
    if (COMPANION_EXCLUDED_TYPES.has(type)) continue;
    if (ownFindingsType && type === ownFindingsType) continue;
    if (seenTypes.has(type)) continue;
    seenTypes.add(type);
    if (entry.delivery === 'disabled') continue;
    companions.push({
      type,
      delivery: COMPANION_DELIVERY_MODES.has(entry.delivery) ? entry.delivery : 'internal_only',
    });
  }
  return companions;
}

function serializeProfile(row = null) {
  // Fresh companions array per call — the constant's [] must never become a
  // shared mutable reference across resolved profiles.
  if (!row) return { ...DEFAULT_SERVICE_REPORT_PROFILE, companions: [] };
  if (row.completion_mode === 'service_report' && V1_EXCLUDED_PROJECT_TYPES.has(row.project_type)) {
    logger.warn(
      `[completion-profiles] profile ${row.service_key || row.id} claims service_report completion for excluded project type "${row.project_type}" — coercing to special_project (compliance-gated flow)`,
    );
    // The row has been flagged bad — don't half-trust it. Keep only its
    // identity (service key/name/category/billing), the project-flow pointer,
    // and active state; every BEHAVIOR field resets FAIL-CLOSED. Portal
    // policy uses the excluded types' real special-project posture (the
    // seeded wdo_inspection profile is token_only + recurring_customer —
    // "keep out of routine service-report surfaces"), NOT the registry's
    // customer_portal defaults, which would be BROADER sharing than the
    // legitimate profile this guard is protecting.
    return {
      serviceKey: row.service_key || null,
      serviceName: row.service_name_snapshot || null,
      category: row.category || null,
      billingType: row.billing_type || null,
      completionMode: 'special_project',
      projectType: row.project_type,
      findingsType: null,
      createsServiceRecord: true,
      portalVisibility: 'token_only',
      portalAttachPolicy: 'recurring_customer',
      followupPolicy: 'none',
      defaultFollowupDays: null,
      active: row.active !== false,
      notes: row.notes || null,
      projectBacked: true,
      specialProject: true,
      requiresProject: true,
      deliveryMode: 'auto_send',
      // Fail-closed branch: a flagged-bad row gets NO companion sections —
      // they're behavior, and every behavior field here resets fail-closed.
      companions: [],
    };
  }
  const completionMode = row.completion_mode || 'service_report';
  const projectBacked = completionMode === 'project_required' || completionMode === 'special_project';
  const findingsType = completionMode === 'service_report' ? (row.project_type || null) : null;
  return {
    serviceKey: row.service_key || null,
    serviceName: row.service_name_snapshot || null,
    category: row.category || null,
    billingType: row.billing_type || null,
    completionMode,
    // projectType is the PROJECT-flow pointer — null for service_report
    // profiles so stale `if (profile.projectType)` client logic can never
    // route a typed completion back into the Projects flow. The same column
    // value is exposed as findingsType when the mode is service_report:
    // that's the typed-findings schema pointer for specialty completions.
    projectType: projectBacked ? (row.project_type || null) : null,
    findingsType,
    createsServiceRecord: row.creates_service_record !== false,
    portalVisibility: row.portal_visibility || 'customer_portal',
    portalAttachPolicy: row.portal_attach_policy || 'active_portal_customer',
    followupPolicy: row.followup_policy || 'none',
    defaultFollowupDays: row.default_followup_days == null ? null : Number(row.default_followup_days),
    active: row.active !== false,
    notes: row.notes || null,
    projectBacked,
    specialProject: completionMode === 'special_project',
    requiresProject: projectBacked,
    deliveryMode: row.delivery_mode || 'auto_send',
    // Companion typed sections (combined-service-completions.md) — typed
    // findings sections that ride this service's primary completion flow,
    // each with its own frozen-at-completion delivery posture.
    companions: parseCompanionTypes(row.companion_types, findingsType),
  };
}

async function tableAvailable(knex) {
  // try/catch, not just .catch(): if knex.schema itself is unavailable the
  // property access throws before a promise exists, and the rejection would
  // escape appointmentManagedProjectTypes' fail-open contract (500ing every
  // project create instead of degrading to "no types managed").
  try {
    return await knex.schema.hasTable('service_completion_profiles');
  } catch {
    return false;
  }
}

function serviceNameCandidates(serviceType) {
  const raw = String(serviceType || '').trim();
  if (!raw) return [];

  const candidates = [raw];
  const suffixless = raw.replace(/\s+service$/i, '').trim();
  if (suffixless && suffixless.toLowerCase() !== raw.toLowerCase()) {
    candidates.push(suffixless);
  }
  // Visit-count program suffix: the German roach cleanout pricer labels
  // its line "German Roach Cleanout — 2 Visit Program" (the count is the
  // severity tier's visit total), so the catalog name it belongs to is
  // the part before the dash. Same normalization class as the trailing
  // " Service" strip above — narrow by design: it requires the literal
  // "N Visit Program" tail.
  const programless = raw.replace(/\s*[—–-]\s*\d+\s*visit\s*program\s*$/i, '').trim();
  if (programless && !candidates.some((c) => c.toLowerCase() === programless.toLowerCase())) {
    candidates.push(programless);
  }

  const expanded = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const key = candidate.toLowerCase();
    if (!seen.has(key)) {
      expanded.push(candidate);
      seen.add(key);
    }
    if (/^pest\s+and\s+rodent\s+control$/i.test(candidate)) {
      const alias = 'Pest & Rodent Control';
      const aliasKey = alias.toLowerCase();
      if (!seen.has(aliasKey)) {
        expanded.push(alias);
        seen.add(aliasKey);
      }
    }
  }
  return expanded;
}

async function lookupServiceForScheduledService(scheduledService = {}, knex = db) {
  if (!scheduledService) return null;
  if (scheduledService.service_id) {
    const byId = await knex('services')
      .where({ id: scheduledService.service_id })
      .first('service_key', 'name', 'category', 'billing_type');
    if (byId) return byId;
  }

  const serviceType = String(scheduledService.service_type || scheduledService.serviceType || '').trim();
  if (!serviceType) return null;
  const serviceTypeCandidates = serviceNameCandidates(serviceType);

  for (const candidate of serviceTypeCandidates) {
    const exact = await knex('services')
      .whereRaw('lower(name) = lower(?)', [candidate])
      .first('service_key', 'name', 'category', 'billing_type');
    if (exact) return exact;
  }

  // short_name is a DISPLAY abbreviation with no uniqueness constraint, and the
  // live catalog really does share it across services that behave differently:
  // "Lawn Care" is carried by FIVE active rows (lawn_care_quarterly / _recurring
  // / _6week / _monthly — all recurring — plus lawn_care_one_time), and
  // "Mosquito" by two (mosquito_monthly recurring + mosquito_one_time).
  //
  // An unordered `.first()` therefore picked NONDETERMINISTICALLY among them.
  // It happens to return a recurring row today only because of physical heap
  // order — which an ordinary admin edit in the Service Library rewrites. If
  // lawn_care_one_time ever surfaced first, every visit labelled "Lawn Care"
  // would resolve billing_type 'one_time' ⇒ typedOneTimeBilling TRUE ⇒
  // shouldAutoInvoiceCompletion mints a completion invoice for a RECURRING lawn
  // customer whose plan already covers the visit (and swaps the visit onto the
  // typed one_time_lawn_treatment form and token_only portal visibility).
  //
  // So an ambiguous abbreviation resolves NOTHING. The caller falls back to the
  // generic service-report profile, which is what an unmatched label already
  // does — never a coin flip between a recurring and a one-time identity, where
  // one side bills the customer. Same fail-closed rule the accept-path catalog
  // lookup uses for duplicate engine keys (#3328 r3).
  const shortNameMatches = await knex('services')
    .whereRaw('lower(short_name) = lower(?)', [serviceType])
    .limit(2)
    .select('service_key', 'name', 'category', 'billing_type')
    .catch(() => []);
  if (shortNameMatches.length === 1) return shortNameMatches[0];
  if (shortNameMatches.length > 1) {
    logger.warn(`[completion-profiles] short name "${serviceType}" is shared by multiple catalog services — refusing to guess an identity (give the rows distinct short names)`);
  }
  return null;
}

async function profileByServiceKey(serviceKey, knex = db) {
  if (!serviceKey || !(await tableAvailable(knex))) return null;
  return knex('service_completion_profiles')
    .where({ service_key: serviceKey, active: true })
    .first();
}

async function resolveCompletionProfileForScheduledService(scheduledService = {}, knex = db) {
  const service = await lookupServiceForScheduledService(scheduledService, knex);
  const profile = service?.service_key
    ? await profileByServiceKey(service.service_key, knex)
    : null;
  if (profile) return serializeProfile(profile);

  return {
    ...DEFAULT_SERVICE_REPORT_PROFILE,
    companions: [],
    serviceKey: service?.service_key || null,
    serviceName: service?.name || scheduledService.service_type || scheduledService.serviceType || null,
    category: service?.category || null,
    billingType: service?.billing_type || null,
  };
}

async function resolveCompletionProfileForServiceId(serviceId, knex = db) {
  const scheduledService = await knex('scheduled_services')
    .where({ id: serviceId })
    .first('id', 'service_id', 'service_type');
  if (!scheduledService) return null;
  return resolveCompletionProfileForScheduledService(scheduledService, knex);
}

/**
 * Project types that are "appointment-managed": at least one ACTIVE profile
 * routes them through the typed service-report completion flow
 * (completion_mode='service_report' with a project_type pointer) AND no
 * active project_required profile still points at the type — i.e. the type
 * has FULLY cut over. While any key of the type remains project_required
 * (Phase 1's excluded keys, the Phase-1b single-key shadow), ad hoc /
 * unlinked project creation must stay available for those keys; LINKED
 * creation is independently guarded by the linked service's own profile in
 * POST /admin/projects, which is where the dual-entry risk actually lives.
 * Keyed to live cutover state — NOT registry metadata.
 */
async function appointmentManagedProjectTypes(knex = db) {
  if (!(await tableAvailable(knex))) return new Set();
  try {
    const stillBacked = await knex('service_completion_profiles')
      .whereIn('completion_mode', ['project_required', 'special_project'])
      .where({ active: true })
      .whereNotNull('project_type')
      .distinct(['project_type', 'completion_mode']);
    // Original partially-cutover semantics stay keyed to project_required
    // (rows without a completion_mode in test doubles default there too).
    const backed = new Set(stillBacked
      .filter((row) => (row.completion_mode || 'project_required') === 'project_required')
      .map((row) => row.project_type)
      .filter(Boolean));
    // The RETIREMENT override is wider: ANY active project-backed mode
    // (project_required OR special_project — serializeProfile treats both
    // as project-backed) outranks the code retirement (codex P2 r11).
    const retirementOverridden = new Set(stillBacked.map((row) => row.project_type).filter(Boolean));
    const rows = await knex('service_completion_profiles')
      .where({ completion_mode: 'service_report', active: true })
      .whereNotNull('project_type')
      .distinct('project_type');
    return new Set([
      ...rows
        .map((row) => row.project_type)
        .filter(Boolean)
        // Partially-cutover types (some keys still project_required) stay
        // creatable — see docblock.
        .filter((type) => !backed.has(type))
        // Code-enforced V1 exclusions (see V1_EXCLUDED_PROJECT_TYPES) — a
        // flipped profile row must not retire the Projects creation path for
        // a type whose completion the V1 flow cannot legally perform.
        .filter((type) => !V1_EXCLUDED_PROJECT_TYPES.has(type))
        // Owner-kept documentation types (see PROJECT_CREATION_KEPT_TYPES) —
        // creatable as standalone projects; completion routing untouched.
        .filter((type) => !PROJECT_CREATION_KEPT_TYPES.has(type)),
      // Untyped-retired types stay appointment-managed by code — their
      // pointer is NULL so the query above can no longer see them. But an
      // ACTIVE project-backed profile (project_required OR special_project)
      // outranks the retirement (the migration loud-skips drifted rows, and
      // the surviving profile still requires the Projects lane — codex P2
      // r7 + r11).
      ...[...UNTYPED_RETIRED_PROJECT_TYPES].filter((type) => !retirementOverridden.has(type)),
    ]);
  } catch {
    return new Set();
  }
}

/**
 * Decide the customer-facing delivery posture for a completion, BEFORE the
 * service report token is minted.
 *
 *  - Typed specialty completions (findingsType set) keep their existing
 *    behavior: the profile's delivery_mode (auto_send | internal_only |
 *    disabled) drives delivery, with a global kill env.
 *  - Non-typed completions normally auto_send the routine Service Report.
 *    EXCEPT internal-only consultations (completion_mode 'internal_only',
 *    e.g. the Waves Assessment): an advisory walkthrough, not a treatment —
 *    there is no customer-facing report. We force delivery to 'disabled'
 *    (so no public report token is minted) and suppress customer comms (no
 *    completion SMS/email, no review request). The service_records audit row
 *    is still written by the completion path.
 *
 * Pure function (env read at the call site) so the gate is unit-testable.
 */
function resolveCompletionDeliveryPosture({
  typedFindingsType = null,
  completionMode = null,
  profileDeliveryMode = null,
  specialtyDeliveryDisabled = false,
  profileCategory = null,
} = {}) {
  const isInternalOnly = !typedFindingsType && completionMode === 'internal_only';
  let typedDeliveryMode;
  if (typedFindingsType) {
    typedDeliveryMode = specialtyDeliveryDisabled ? 'disabled' : (profileDeliveryMode || 'auto_send');
  } else {
    // Untyped lanes default to auto_send, but ops kill switches SURVIVE an
    // untype (bed_bug, 20260731400000): an explicitly suppressing profile
    // delivery_mode, and the specialty-wide env kill for specialty-category
    // profiles, must not be bypassed by clearing the typed pointer —
    // otherwise the next completion mints a public report and sends
    // customer comms against an active switch (codex P1 r3).
    // internal_only is preserved as its OWN posture, not collapsed to
    // disabled: internal_only still mints the staff-reviewable shadow
    // report token while suppressing customer delivery; disabled mints
    // nothing (codex P2 r5).
    const profileMode = String(profileDeliveryMode || '');
    const suppressedBySpecialtyKill = specialtyDeliveryDisabled && String(profileCategory || '') === 'specialty';
    if (isInternalOnly || suppressedBySpecialtyKill || profileMode === 'disabled') {
      typedDeliveryMode = 'disabled';
    } else if (profileMode === 'internal_only') {
      typedDeliveryMode = 'internal_only';
    } else {
      typedDeliveryMode = 'auto_send';
    }
  }
  // Equivalent to the previous expression for every typed input and every
  // pre-existing untyped input (untyped mode was auto_send unless
  // isInternalOnly); the suppressing untyped modes above now suppress too.
  const suppressCustomerComms = isInternalOnly || typedDeliveryMode !== 'auto_send';
  return { typedDeliveryMode, suppressCustomerComms, isInternalOnly };
}

module.exports = {
  resolveCompletionProfileForScheduledService,
  resolveCompletionProfileForServiceId,
  serializeProfile,
  resolveCompletionDeliveryPosture,
  appointmentManagedProjectTypes,
  DEFAULT_SERVICE_REPORT_PROFILE,
  V1_EXCLUDED_PROJECT_TYPES,
  PROJECT_CREATION_KEPT_TYPES,
  PROJECT_CREATION_LINKED_ONLY_TYPES,
};
