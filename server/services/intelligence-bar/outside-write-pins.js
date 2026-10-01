/**
 * Intelligence Bar — outside-write execution pins
 * server/services/intelligence-bar/outside-write-pins.js
 *
 * /confirm-action re-runs each outside-write tool's (mutation-free) preview
 * and refuses unless its fingerprint still matches the card the operator
 * approved. Once it does, THAT live preview is the approved target: this
 * turns it into the `_verified_*` pins the confirmed executor acts on. The
 * executors never re-resolve the operator's raw strings (issue_short_id,
 * zone_name, project_name, service_name, label, domain) at commit time.
 *
 * Returns {} when the preview lacks the pinned fields, so the executor sees
 * no pin and refuses (`missing_verified_pin`) instead of guessing.
 */

const present = (v) => v !== undefined && v !== null && v !== '';

function outsideWritePins(toolName, preview) {
  if (!preview || typeof preview !== 'object') return {};
  const pins = {};
  const put = (key, value) => { if (present(value)) pins[key] = value; };
  switch (toolName) {
    case 'resolve_sentry_issue':
    case 'ignore_sentry_issue':
      put('_verified_sentry_issue_id', preview.issue?.id);
      break;
    case 'assign_sentry_issue':
      put('_verified_sentry_issue_id', preview.issue?.id);
      put('_verified_sentry_assignee_id', preview.assignee?.id);
      break;
    case 'purge_cloudflare_cache':
      put('_verified_cloudflare_zone_id', preview.zone?.id);
      break;
    case 'retry_cloudflare_pages_build':
      put('_verified_cloudflare_project_name', preview.project);
      put('_verified_cloudflare_deployment_id', preview.deployment?.id);
      break;
    case 'redeploy_railway_service':
    case 'restart_railway_service':
      put('_verified_railway_service_id', preview.service?.id);
      // May be null (a service with no deployment yet) — the executor treats
      // an absent pin as "no deployment" and re-asserts it against live state.
      if (preview.service && 'latest_deployment_id' in preview.service) {
        pins._verified_railway_deployment_id = preview.service.latest_deployment_id || null;
      }
      break;
    case 'set_railway_gate':
      // Compare-and-swap inputs for the commit path: the portal service and
      // production environment ids, the gate name, the value to set, and the
      // prior state (null when unset or non-boolean). A non-boolean prior
      // rides as a keyed digest only — its value is never pinned.
      put('_verified_railway_service_id', preview.target?.service_id);
      put('_verified_railway_environment_id', preview.target?.environment_id);
      put('_verified_railway_gate_name', preview.gate);
      put('_verified_railway_gate_value', preview.new_value);
      put('_verified_railway_gate_prior_kind', preview.prior_kind);
      pins._verified_railway_gate_prior = preview.prior_value ?? null;
      pins._verified_railway_gate_prior_digest = preview.prior_value_digest ?? null;
      break;
    case 'set_growthbook_feature':
      put('_verified_growthbook_feature_id', preview.feature);
      put('_verified_growthbook_environment', preview.environment);
      put('_verified_growthbook_new_state', preview.new_state);
      if (typeof preview.prior_enabled === 'boolean') pins._verified_growthbook_prior_enabled = preview.prior_enabled;
      // The feature's dateUpdated (and live revision), so an edit made
      // anywhere — including the GrowthBook UI — between card and confirm
      // makes the commit refuse.
      pins._verified_growthbook_feature_updated = preview.feature_version ?? null;
      pins._verified_growthbook_revision = preview.revision_version ?? null;
      break;
    case 'rerun_failed_github_checks':
      put('_verified_github_pr_number', preview.pr?.number);
      put('_verified_github_head_sha', preview.pr?.head_sha);
      if (Array.isArray(preview.workflow_runs) && preview.workflow_runs.length) {
        pins._verified_github_run_ids = preview.workflow_runs.map((r) => String(r.id));
      }
      break;
    case 'add_github_pr_label':
      put('_verified_github_pr_number', preview.pr?.number);
      put('_verified_github_label', preview.label);
      break;
    case 'request_codex_review':
      put('_verified_github_pr_number', preview.pr?.number);
      break;
    case 'submit_gsc_sitemap':
      put('_verified_gsc_property', preview.property);
      put('_verified_gsc_sitemap_url', preview.sitemap_url);
      break;
    default:
      break;
  }
  return pins;
}

module.exports = { outsideWritePins };
