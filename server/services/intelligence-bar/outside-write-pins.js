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
