'use strict';

/**
 * Ads health alerts (owner 2026-11-05, "ALERT", after the Ad health card, #7627). Every 2 hours (scheduler.js) this
 * reads Google Ads (the card's serving section in ads-health.js, plus the disapproved ads) and the portal's upload
 * log, and keeps two rows true:
 *
 * 1. Google Ads, for a person (needs-you, the bell). One standing Leads row for every enabled campaign Google says
 *    cannot serve (primary status Not eligible or Misconfigured) and every enabled ad Google disapproved in an
 *    enabled ad group of an enabled campaign. A pause (of a campaign, an ad group or an ad) and an end date are
 *    someone's own choice and never count. The row rings when a campaign or an ad joins the set, refreshes quietly
 *    when one leaves, and closes itself (done) at zero: a standing condition with episodes
 *    (docs/admin-notifications.md section 4, admin-alert-episodes.js), the shape of unassigned-timed-visits-check.js.
 * 2. Conversion uploads, for Claude (broken, Claude's queue). One engineering digest row in the Activity feed while
 *    a live Google upload row failed or Google partly refused its batch, or a live Meta upload row failed, on a try
 *    in the last 48 hours, or while Google's upload check reads Needs attention. A failed upload is our own fault,
 *    so it never rings the owner (docs/admin-notifications.md section 5, owner 2026-10-26). The writers keep one row
 *    per conversion and stamp updated_at on every try, so a retry that works clears its row; the first clean run
 *    retires the digest (ops-digest-fall-off.js).
 *
 * A source that cannot be read changes nothing: its row stays as it is until a run can read it, and the run throws
 * at the end so job_health shows the failed tick. GATE_ADS_HEALTH_ALERTS (adsHealthAlertsMode()): off = no query;
 * 'shadow' = the same reads, and one audit_log row (ads_health_alert.shadow) when either set changes, naming the
 * keys that joined and a set that emptied, with no alert written; 'true' = raise and close. It only reads Google:
 * it changes no ad or budget and sends nothing to a customer.
 */
const db = require('../../models/db');
const logger = require('../logger');
const { adsHealthAlertsMode, alertEpisodesLive } = require('../../config/feature-gates');
const { composeAdminAlert, raiseAdminAlert, breaksAlertRules, cutAtWord, MAX_WHY_CHARS } = require('../admin-alert-compose');
const { fitAction } = require('../admin-alert-names');
const { hasNewItemKeys } = require('../ops-digest');
const { formatETDayDate, formatETTime } = require('../../utils/datetime-et');
const { getCustomer } = require('./google-ads');
const Health = require('./ads-health');

const CATEGORY = 'system'; // the ads advisor's bell category (negative-keyword-actions.js); bell: true below
const AREA = 'Leads';
const GOOGLE_KEY = 'ads-health:google';
const UPLOAD_KEY = 'ads-upload-health';
const SHADOW_ACTION = 'ads_health_alert.shadow';
const LINK = '/admin/ppc'; // Ads -> Dashboard, where the Ad health card shows the same facts
const UPLOAD_WINDOW_HOURS = 48; // the uploads run daily (6:40 and 6:45 AM ET): one missed run still shows
const CANNOT_SERVE = new Set(['NOT_ELIGIBLE', 'MISCONFIGURED']);
const MAX_ADS = 200; // past this many disapproved ads the set counts as one item (composeGoogle)
const MAX_UPLOAD_ROWS = 200; // ops-digest caps itemKeys at 200
const LIST_LIMIT = 25;
const ERROR_CHARS = 200;
const DETAIL_MAX_CHARS = 2000;

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const when = (at) => `${formatETDayDate(new Date(at))} at ${formatETTime(new Date(at))}`;

// ---------------------------------------------------------------------------
// Google Ads: campaigns that cannot serve and disapproved ads
// ---------------------------------------------------------------------------

// Every enabled ad Google disapproved in an enabled ad group of an enabled campaign, filtered by Google. The card's
// disapprovals read lists the first 50 ads not fully approved, which can hide a disapproved one past them, and a set
// that may be incomplete must never read as clean. A paused campaign's ads never count: the pause is someone's own
// choice, and a disapproval there rings at the first check after the campaign is turned back on.
async function readDisapprovedAds(customer) {
  const rows = await customer.query(`
    SELECT campaign.name, ad_group.name, ad_group_ad.ad.id, ad_group_ad.policy_summary.policy_topic_entries
    FROM ad_group_ad
    WHERE ad_group_ad.policy_summary.approval_status = 'DISAPPROVED'
      AND ad_group_ad.status = 'ENABLED'
      AND ad_group.status = 'ENABLED'
      AND campaign.status = 'ENABLED'
    LIMIT ${MAX_ADS + 1}`);
  const ads = rows.slice(0, MAX_ADS).map((row) => ({
    campaign: row.campaign?.name || null,
    adGroup: row.ad_group?.name || null,
    adId: row.ad_group_ad?.ad?.id != null ? String(row.ad_group_ad.ad.id) : null,
    topics: (row.ad_group_ad?.policy_summary?.policy_topic_entries || []).map((entry) => entry.topic).filter(Boolean),
  }));
  return { ads: ads.filter((ad) => ad.adId), capped: rows.length > MAX_ADS };
}

// The card's serving section and the disapproved ads, or null when Google Ads is not set up. A read that fails throws.
async function readGoogle() {
  const customer = getCustomer();
  if (!customer) return null;
  const [serving, disapproved] = await Promise.all([Health.servingSection(), readDisapprovedAds(customer)]);
  if (serving?.error) throw new Error(serving.error);
  return { serving, disapproved };
}

// What stops an ad from serving now: an enabled campaign Google says cannot serve, and the disapproved ads.
function googleProblems({ serving, disapproved }) {
  return {
    campaigns: (serving.campaigns || []).filter((c) => c.status === 'ENABLED' && CANNOT_SERVE.has(c.primaryStatus)),
    ads: disapproved.ads,
    adsCapped: disapproved.capped,
  };
}

const reasonWords = (c) => (c.reasons || []).map(Health.words).join(', ');
const topicWords = (ad) => (ad.topics || []).map(Health.words).join(', ');

function googleAction({ campaigns, ads }) {
  const c = campaigns.length;
  const a = ads.length;
  if (c && a) return `fix ${plural(c, 'Google Ads campaign')} and ${plural(a, 'disapproved ad')}`;
  if (c > 1) return `fix ${c} Google Ads campaigns that cannot serve`;
  if (c === 1) {
    const fallback = () => 'fix a Google Ads campaign that cannot serve';
    return breaksAlertRules(campaigns[0].name) ? fallback() : fitAction(AREA, campaigns[0].name, [(n) => `fix ${n} in Google Ads`, fallback]);
  }
  return a === 1 ? 'fix a disapproved Google ad' : `fix ${a} disapproved Google ads`;
}

// The first problem in words. Campaign and ad group names are typed in Google Ads, so a name that would break the
// alert rule (an underscore, a bracket) gives way to a why without names; the full text still names everything.
function googleWhy({ campaigns, ads }) {
  if (campaigns.length) {
    const c = campaigns[0];
    const named = `${c.name} cannot serve: ${reasonWords(c) || Health.words(c.primaryStatus)}.`;
    if (!breaksAlertRules(named)) return cutAtWord(named, MAX_WHY_CHARS);
    return `Google says ${plural(campaigns.length, 'campaign')} cannot serve; the full text names ${campaigns.length === 1 ? 'it' : 'them'}.`;
  }
  const ad = ads[0];
  const topics = topicWords(ad);
  const named = `Google disapproved an ad in ${ad.adGroup || 'an ad group'} (${ad.campaign})${topics ? `: ${topics}` : ''}.`;
  if (!breaksAlertRules(named)) return cutAtWord(named, MAX_WHY_CHARS);
  return `Google disapproved ${plural(ads.length, 'ad')}; the full text names ${ads.length === 1 ? 'it' : 'them'}.`;
}

function googleDetail({ campaigns, ads, adsCapped }) {
  const lines = ['Google Ads shows a problem that stops ads from serving. Fix it in Google Ads. This alert closes itself '
    + 'at the first check after Google shows the fix (the check runs every 2 hours).'];
  if (campaigns.length) {
    lines.push('', 'Campaigns that cannot serve:');
    for (const c of campaigns.slice(0, LIST_LIMIT)) {
      lines.push(`- ${c.name}: ${Health.words(c.primaryStatus)}${reasonWords(c) ? ` (${reasonWords(c)})` : ''}`);
    }
  }
  if (ads.length) {
    lines.push('', adsCapped ? `Disapproved ads (more than ${MAX_ADS}; the first ones Google listed):` : 'Disapproved ads:');
    for (const ad of ads.slice(0, LIST_LIMIT)) {
      lines.push(`- ${ad.campaign}, ${ad.adGroup || 'ad group'}, ad ${ad.adId}${topicWords(ad) ? `: ${topicWords(ad)}` : ''}`);
    }
  }
  return lines.join('\n').slice(0, DETAIL_MAX_CHARS);
}

function composeGoogle(problems) {
  // Past MAX_ADS the read returns a first page in no fixed order, so a new ad cannot be told from one that moved onto
  // the page: the ads then count as one item, which rings once and not on each shift.
  const adKeys = problems.adsCapped ? [`ad:over-${MAX_ADS}`] : problems.ads.map((ad) => `ad:${ad.adId}`);
  const itemKeys = [...problems.campaigns.map((c) => `campaign:${c.id}`), ...adKeys].sort();
  return {
    spec: {
      area: AREA,
      action: googleAction(problems),
      why: itemKeys.length ? googleWhy(problems) : '',
      severity: 'needs-you',
      link: LINK,
      subject: { type: 'check', id: GOOGLE_KEY },
      doneWhen: 'count_zero',
      who: 'person',
    },
    detail: itemKeys.length ? googleDetail(problems) : '',
    itemKeys,
    count: itemKeys.length,
  };
}

function writeOutcome(result) {
  if (result.suppressed) return 'suppressed';
  if (!result.deduped) return 'raised';
  if (result.refreshed) return result.rung === false ? 'refreshed' : 'raised';
  return 'unchanged';
}

async function raiseGoogle(trx, composed) {
  const opts = {
    dedupeKey: GOOGLE_KEY,
    trx,
    // Under GATE_ADMIN_BELL_POLICY the 'system' category is silent unless the call site tags it.
    bell: true,
    refreshOnDedupe: true,
    // A refresh rings only when a campaign or an ad joins the set. (A comeback after the row closed rings through
    // raiseAdminAlertWithReopen, which ignores this.)
    ringOnRefresh: (_existing, existingMeta) => hasNewItemKeys(composed.itemKeys, existingMeta?.itemKeys),
    // A refresh that rings moves the row to the top of the newest-first bell.
    bumpOnRefresh: true,
    detail: composed.detail,
    metadata: { itemKeys: composed.itemKeys, count: composed.count },
  };
  if (!alertEpisodesLive()) return raiseAdminAlert(CATEGORY, composed.spec, opts);
  const alert = composeAdminAlert(composed.spec);
  return require('../admin-alert-episodes').raiseAdminAlertWithReopen(CATEGORY, alert.headline, alert.why, {
    ...opts, link: alert.link, metadata: { ...opts.metadata, ...alert.metadata },
  });
}

// One run at a time per row: the advisory lock notifyAdmin takes for this key.
async function applyGoogle(composed, now) {
  return db.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`admin:${GOOGLE_KEY}`]);
    if (!composed.count) {
      const closed = alertEpisodesLive()
        ? Number(await require('../admin-alert-episodes').closeAdminAlertKeys(trx, [GOOGLE_KEY], 'count_zero', {
          now, resolution: 'Cleared: Google shows every enabled campaign able to serve and no disapproved ad',
        })) || 0
        : 0;
      return { count: 0, outcome: closed ? 'closed' : 'clear' };
    }
    const result = await raiseGoogle(trx, composed);
    if (!result) throw new Error('the Google Ads alert row was not written');
    return { count: composed.count, outcome: writeOutcome(result) };
  });
}

// ---------------------------------------------------------------------------
// Conversion uploads: our own failures, for Claude
// ---------------------------------------------------------------------------

// Live rows only (validate_only / test_mode runs are dry runs), tried in the window, newest first.
function failedUploads(table, dryRunColumn, statuses, since) {
  return db(table).where(dryRunColumn, false).whereIn('status', statuses).where('updated_at', '>=', since)
    .orderBy('updated_at', 'desc').limit(MAX_UPLOAD_ROWS)
    .select('id', 'conversion_type', 'status', 'error_message', 'updated_at');
}

async function readUploads(now) {
  const since = new Date(now.getTime() - UPLOAD_WINDOW_HOURS * 3600 * 1000);
  const customer = getCustomer();
  const [google, meta, check] = await Promise.all([
    failedUploads('google_ads_conversion_uploads', 'validate_only', ['failed', 'partial_success'], since),
    failedUploads('meta_conversion_uploads', 'test_mode', ['failed'], since),
    customer ? Health.uploadCheckSection(customer) : null,
  ]);
  if (check?.error) throw new Error(check.error);
  return { google, meta, attention: (check?.actions || []).filter((action) => action.status === 'NEEDS_ATTENTION') };
}

function uploadLine(source, row) {
  const error = String(row.error_message || 'no error text').replace(/\s+/g, ' ').slice(0, ERROR_CHARS);
  return `- ${source}, ${row.conversion_type}, ${Health.words(row.status)}, last try ${when(row.updated_at)}: ${error}`;
}

function uploadText({ google, meta, attention }) {
  const lines = [`A live conversion upload to Google or Meta failed on a try in the last ${UPLOAD_WINDOW_HOURS} hours, or `
    + "Google's own upload check reads Needs attention. Read the rows below, then server/services/ads/data-manager.js "
    + '(Google) or server/services/ads/meta-data-manager.js (Meta). A retry that works clears a row; this row retires '
    + 'itself at the first clean check (every 2 hours).'];
  if (google.length) lines.push('', 'Google uploads:', ...google.slice(0, LIST_LIMIT).map((row) => uploadLine('Google', row)));
  if (meta.length) lines.push('', 'Meta uploads:', ...meta.slice(0, LIST_LIMIT).map((row) => uploadLine('Meta', row)));
  if (attention.length) {
    lines.push('', "Google's upload check, Needs attention:");
    for (const action of attention) {
      const alerts = (action.alerts || []).map((a) => `${Health.words(a.error)}${a.percent != null ? ` (${a.percent}%)` : ''}`);
      lines.push(`- ${action.name}${alerts.length ? `: ${alerts.join(', ')}` : ''}`);
    }
  }
  return lines.join('\n').slice(0, DETAIL_MAX_CHARS);
}

function composeUploads(found) {
  const { google, meta, attention } = found;
  const partial = google.filter((row) => row.status === 'partial_success').length;
  const counts = [
    google.length ? `Google ${google.length}${partial ? ` (${partial} partly refused)` : ''}` : '',
    meta.length ? `Meta ${meta.length}` : '',
  ].filter(Boolean);
  const parts = [
    counts.length ? `Failed uploads in 2 days: ${counts.join(', ')}` : '',
    attention.length ? `Google flags ${plural(attention.length, 'action')} as Needs attention` : '',
  ].filter(Boolean);
  const itemKeys = [
    ...google.map((row) => `google:${row.id}`),
    ...meta.map((row) => `meta:${row.id}`),
    ...attention.map((action) => `check:${action.name}`),
  ].sort();
  return {
    spec: {
      area: 'System',
      action: 'fix the ad conversion uploads',
      why: cutAtWord(`${parts.join('; ')}.`, MAX_WHY_CHARS),
      severity: 'broken',
      link: LINK,
      subject: { type: 'check', id: UPLOAD_KEY },
      doneWhen: 'count_zero',
      who: 'claude',
    },
    text: itemKeys.length ? uploadText(found) : '',
    itemKeys,
    count: itemKeys.length,
  };
}

// A broken alert is composed, then written as an engineering digest (docs/admin-notifications.md section 7): the
// Activity feed reads ops_digest rows only, and an engineering row never reaches the bell.
async function applyUploads(composed) {
  if (!composed.count) {
    const retired = await require('../ops-digest-fall-off').retireIfClean(UPLOAD_KEY, { resolvedBy: 'ads-health-alerts:clean-run' });
    return { count: 0, outcome: retired ? 'retired' : 'clear' };
  }
  const alert = composeAdminAlert(composed.spec);
  const result = await require('../ops-digest').deliverOpsDigest({
    key: UPLOAD_KEY,
    subject: 'FIX: ad conversion uploads need a look',
    headline: alert.headline,
    summary: alert.why,
    text: composed.text,
    audience: 'engineering',
    link: alert.link,
    dedupeKey: UPLOAD_KEY,
    refreshOnDedupe: true,
    fallOff: true,
    count: composed.count,
    itemKeys: composed.itemKeys,
    metadata: alert.metadata,
    // Claude's queue only, as owner-alerts.js: no email path, so a row that cannot be written reads as a miss.
    sendEmail: async () => ({ ok: false, error: 'ads health alerts have no email path' }),
  });
  // deliverOpsDigest catches a failed row write and takes the email path, which this alert does not have: a lost
  // row must fail the tick (job_health), not read as a healthy run.
  if (result?.channel !== 'in_app') throw new Error('the upload alert row was not written');
  return { count: composed.count, outcome: 'recorded' };
}

// ---------------------------------------------------------------------------
// Shadow: what would ring or close, in audit_log, only when it changes
// ---------------------------------------------------------------------------

const parseMeta = (raw) => {
  if (raw && typeof raw === 'object') return raw;
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
};

// One set's change since the last shadow row. A set this run could not read keeps the last row's keys.
function shadowSection(prior, current) {
  const before = Array.isArray(prior?.itemKeys) ? prior.itemKeys : [];
  if (!current) return { itemKeys: before, joined: [], emptied: false, changed: false, unread: true };
  const seen = new Set(before);
  const joined = current.itemKeys.filter((key) => !seen.has(key));
  return {
    itemKeys: current.itemKeys,
    joined,
    emptied: before.length > 0 && current.itemKeys.length === 0,
    changed: joined.length > 0 || current.itemKeys.length !== before.length,
  };
}

async function recordShadow({ google, uploads }, now) {
  const prior = await db('audit_log').where({ action: SHADOW_ACTION }).orderBy('created_at', 'desc').first('metadata');
  const before = parseMeta(prior?.metadata);
  const sections = { google: shadowSection(before.google, google), uploads: shadowSection(before.uploads, uploads) };
  if (!sections.google.changed && !sections.uploads.changed) return { recorded: false };
  await require('../audit-log').recordAuditEvent({
    actor_type: 'system', action: SHADOW_ACTION, resource_type: 'notifications', metadata: { at: now.toISOString(), ...sections },
  });
  return { recorded: true, google: sections.google.joined.length, uploads: sections.uploads.joined.length };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Every 2 hours. Returns { skipped } when the gate is off, else { mode, ... } with each row's outcome. A read or
 * write that fails leaves that row as it was and makes the run throw at the end, after the other row's work.
 */
async function runAdsHealthAlerts({ now = new Date(), mode = adsHealthAlertsMode() } = {}) {
  if (mode !== 'shadow' && mode !== 'true') return { skipped: 'off' };
  const failures = [];
  const guard = async (label, work) => {
    try {
      return await work();
    } catch (err) {
      failures.push(`${label}: ${err.message}`);
      logger.warn(`[ads-health-alerts] ${label} failed: ${err.message}`);
      return undefined;
    }
  };
  const google = await guard('Google Ads read', readGoogle); // null: Google Ads is not set up
  const uploads = await guard('upload read', () => readUploads(now));
  const googleSet = google ? composeGoogle(googleProblems(google)) : null;
  const uploadSet = uploads ? composeUploads(uploads) : null;
  let result;
  if (mode === 'shadow') {
    result = { mode, ...(await guard('shadow record', () => recordShadow({ google: googleSet, uploads: uploadSet }, now))) };
  } else {
    result = {
      mode,
      google: googleSet ? await guard('Google Ads alert', () => applyGoogle(googleSet, now)) : null,
      uploads: uploadSet ? await guard('upload alert', () => applyUploads(uploadSet)) : null,
    };
  }
  logger.info(`[ads-health-alerts] ${JSON.stringify(result)}`);
  if (failures.length) throw new Error(`ads health alerts: ${failures.join('; ')}`);
  return result;
}

module.exports = {
  runAdsHealthAlerts,
  GOOGLE_KEY,
  UPLOAD_KEY,
  SHADOW_ACTION,
  _private: { readGoogle, readUploads, googleProblems, composeGoogle, composeUploads, shadowSection },
};
