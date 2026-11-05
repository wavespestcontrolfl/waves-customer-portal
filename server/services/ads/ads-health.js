/**
 * Ad health card data (owner 2026-11-04, PPC gap page option A). GET /api/admin/ads/health serves it behind
 * GATE_ADS_HEALTH_CARD (routes/admin-ads.js). It only reads: Google Ads queries and portal tables. It sends
 * nothing, moves no money and changes no ad.
 *
 * Each source fails on its own. A Google section that cannot be read comes back as { error }, and a timeline
 * source that cannot be read adds a line to `notes`, so the rest of the card still shows.
 */
const { enums, errors: errorEnums } = require('google-ads-api');
const db = require('../../models/db');
const logger = require('../logger');
const { getCustomer } = require('./google-ads');
const { executeGoogleAdsOpsTool } = require('../intelligence-bar/google-ads-ops-tools');
const { etDateString, addETDays, parseETDateTime } = require('../../utils/datetime-et');

// Google keeps 30 days of change history, counted back from now, so the window is today plus the 29 days before.
const WINDOW_DAYS = 30;
const MAX_TIMELINE = 60;
const UPLOAD_SUMMARY = 'offline_conversion_upload_conversion_action_summary';
const CHANGE_FIELDS = [
  'change_date_time', 'user_email', 'client_type', 'change_resource_type', 'resource_change_operation',
  'changed_fields', 'old_resource', 'new_resource', 'campaign',
].map((field) => `change_event.${field}`).join(', ');

// The client can return enum fields as numbers (google-ads-ops-tools.js reads them the same way).
function enumName(table, value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return table?.[value] ?? String(value);
  return value;
}

// GOOGLE_ADS_MOBILE_APP -> "Google Ads mobile app", CAMPAIGN_BUDGET -> "Campaign budget".
function words(name) {
  const text = String(name || '').toLowerCase().replace(/_/g, ' ').replace(/^google ads\b/, 'Google Ads');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const dollars = (value) => (value === null || value === undefined ? 'none' : `$${Number(value).toFixed(2)}`);
const micros = (value) => (value === null || value === undefined ? 'none' : dollars(Number(value) / 1e6));
const iso = (value) => new Date(value).toISOString();
const errorText = (err) => String(err?.errors?.[0]?.message || err?.message || 'unknown error').slice(0, 200);

// Google gives times as wall-clock text in the account's time zone, e.g. "2026-11-02 11:49:56.098059". Google fixes
// the zone when an account is made, and the Waves account is America/New_York (checked 2026-11-05).
function googleTime(text) {
  if (!text) return null;
  const at = parseETDateTime(String(text).slice(0, 19).replace(' ', 'T'));
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

// A timeline source that cannot be read becomes a note.
async function attempt(label, notes, fallback, read) {
  try {
    return await read();
  } catch (err) {
    logger.warn(`[ads-health] ${label} failed: ${errorText(err)}`);
    notes.push(`${label} could not be read: ${errorText(err)}`);
    return fallback;
  }
}

async function servingSection() {
  const result = await executeGoogleAdsOpsTool('get_google_ads_serving_status');
  if (result.error) return { error: result.error };
  return {
    campaigns: (result.campaigns || []).map((c) => ({
      id: c.id,
      name: c.name,
      status: c.status,
      primaryStatus: c.primary_status,
      reasons: c.primary_status_reasons || [],
      dailyBudget: c.daily_budget,
    })),
  };
}

async function disapprovalSection() {
  const result = await executeGoogleAdsOpsTool('get_google_ads_disapprovals');
  if (result.error) return { error: result.error };
  return {
    total: result.total,
    truncated: Boolean(result.truncated),
    ads: (result.ads || []).map((ad) => ({
      campaign: ad.campaign,
      adGroup: ad.ad_group,
      adId: ad.ad_id,
      status: ad.status,
      approvalStatus: ad.approval_status,
      topics: (ad.policy_topics || []).map((entry) => entry.topic).filter(Boolean),
    })),
  };
}

// An alert's error is a one-of such as { conversion_upload_error: 12 }; its names are in
// errors.ConversionUploadErrorEnum.ConversionUploadError.
function alertName(error) {
  const [key, value] = Object.entries(error || {})[0] || [];
  if (!key) return 'UNKNOWN';
  const type = key.split('_').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('');
  return enumName(errorEnums[`${type}Enum`]?.[type], value);
}

function uploadAction(summary) {
  const days = summary.daily_summaries || [];
  const total = (field) => days.reduce((sum, day) => sum + Number(day[field] || 0), 0);
  return {
    name: summary.conversion_action_name,
    status: enumName(enums.OfflineConversionDiagnosticStatus, summary.status),
    lastUploadAt: googleTime(summary.last_upload_date_time),
    accepted: total('successful_count'),
    failed: total('failed_count'),
    pending: total('pending_count'),
    uploadDays: days.length,
    alerts: (summary.alerts || []).map((alert) => ({
      error: alertName(alert.error),
      percent: typeof alert.error_percentage === 'number' ? Math.round(alert.error_percentage * 1000) / 10 : null,
    })),
  };
}

// Google's own check of the uploads it accepted, per conversion action.
async function uploadCheckSection(customer) {
  try {
    const rows = await customer.query(`SELECT ${UPLOAD_SUMMARY}.conversion_action_name, ${UPLOAD_SUMMARY}.status,
      ${UPLOAD_SUMMARY}.last_upload_date_time, ${UPLOAD_SUMMARY}.daily_summaries, ${UPLOAD_SUMMARY}.alerts
      FROM ${UPLOAD_SUMMARY}`);
    return { actions: rows.map((row) => uploadAction(row[UPLOAD_SUMMARY])) };
  } catch (err) {
    logger.warn(`[ads-health] Google upload check failed: ${errorText(err)}`);
    return { error: `Google's upload check could not be read: ${errorText(err)}` };
  }
}

// Status and budget changes read as before → after. Any other change names its fields.
const BEFORE_AFTER = {
  CAMPAIGN: {
    field: 'status',
    text: (before, after) => `Status ${words(enumName(enums.CampaignStatus, before?.campaign?.status))} → ${words(enumName(enums.CampaignStatus, after?.campaign?.status))}`,
  },
  CAMPAIGN_BUDGET: {
    field: 'amount_micros',
    text: (before, after) => `Budget ${micros(before?.campaign_budget?.amount_micros)} → ${micros(after?.campaign_budget?.amount_micros)}`,
  },
};

function describeChange(ce) {
  const type = enumName(enums.ChangeEventResourceType, ce.change_resource_type);
  const operation = enumName(enums.ResourceChangeOperation, ce.resource_change_operation);
  const paths = ce.changed_fields?.paths || [];
  const pair = BEFORE_AFTER[type];
  if (operation === 'UPDATE' && pair && paths.includes(pair.field)) {
    const others = paths.filter((path) => path !== pair.field);
    return { what: pair.text(ce.old_resource, ce.new_resource), detail: others.length ? `Also changed: ${others.join(', ')}` : null };
  }
  return { what: `${words(operation)} ${words(type).toLowerCase()}`, detail: paths.length ? `Changed: ${paths.join(', ')}` : null };
}

// GAQL has no OR, so this takes two queries. The first gets every change not made through the API: people, rules
// and Google's own tools. The second gets the API's campaign changes, which are the portal's Pause and Enable
// buttons (they keep no portal log). The portal's budget pushes and negative keywords come from its own tables,
// which also say why.
async function googleChanges(customer, firstDay, lastDay) {
  const select = `SELECT ${CHANGE_FIELDS} FROM change_event
    WHERE change_event.change_date_time >= '${firstDay}' AND change_event.change_date_time <= '${lastDay}'`;
  const order = `ORDER BY change_event.change_date_time DESC LIMIT ${MAX_TIMELINE}`;
  const [others, portal] = await Promise.all([
    customer.query(`${select} AND change_event.client_type != 'GOOGLE_ADS_API' ${order}`),
    customer.query(`${select} AND change_event.client_type = 'GOOGLE_ADS_API' AND change_event.change_resource_type = 'CAMPAIGN' ${order}`),
  ]);
  return [...others, ...portal].map(({ change_event: ce }) => {
    const client = enumName(enums.ChangeClientType, ce.client_type);
    const api = client === 'GOOGLE_ADS_API';
    return {
      at: googleTime(ce.change_date_time),
      source: 'google',
      who: api ? 'Waves portal' : ce.user_email || 'Google',
      via: api ? 'Google Ads API' : words(client),
      campaignId: ce.campaign ? String(ce.campaign).split('/').pop() : null,
      ...describeChange(ce),
    };
  });
}

// ad_budget_log.trigger: 'auto' = the 2-hour budget job, 'advisor' = an advisor Apply, 'manual' = an admin.
const BUDGET_ACTOR = { auto: 'Budget job', advisor: 'Ads advisor (Apply)' };

async function budgetChanges(since) {
  const rows = await db('ad_budget_log')
    .where('created_at', '>=', since)
    .orderBy('created_at', 'desc')
    .limit(MAX_TIMELINE)
    .select('created_at', 'campaign_name', 'previous_mode', 'new_mode', 'previous_budget', 'new_budget', 'reason', 'trigger',
      'google_ads_updated');
  // google_ads_updated false = the change was saved in the portal only (live push off, or the push failed), so
  // Google may still run the old amount. The Ads page's budget history shows the same flag as "Sent to Google".
  return rows.map((row) => ({
    at: iso(row.created_at),
    source: 'waves',
    who: BUDGET_ACTOR[row.trigger] || 'Admin',
    via: 'Waves portal',
    campaign: row.campaign_name,
    what: `Budget ${dollars(row.previous_budget)} → ${dollars(row.new_budget)}`
      + (row.previous_mode === row.new_mode ? '' : ` (${row.previous_mode || 'none'} → ${row.new_mode})`)
      + (row.google_ads_updated ? '' : ', not sent to Google Ads'),
    detail: row.reason || null,
  }));
}

// A lifted hold leaves no budget log row, only metadata.budget_hold_cleared (the latest one) on the campaign.
async function holdLifts(since) {
  const rows = await db('ad_campaigns as c')
    .joinRaw("LEFT JOIN technicians t ON t.id::text = c.metadata -> 'budget_hold_cleared' ->> 'by'")
    .where('c.platform', 'google_ads')
    .whereRaw("(c.metadata -> 'budget_hold_cleared' ->> 'at')::timestamptz >= ?", [since])
    .select('c.campaign_name', 't.name as who', db.raw("c.metadata -> 'budget_hold_cleared' AS cleared"));
  return rows.map((row) => ({
    at: iso(row.cleared.at),
    source: 'waves',
    who: row.who || 'Admin',
    via: 'Waves portal',
    campaign: row.campaign_name,
    what: 'Hold lifted',
    detail: row.cleared.mode ? `It held the ad at ${row.cleared.mode} until ${row.cleared.until}.` : null,
  }));
}

// One row per action, minute, campaign and person, so a batch (the 16-word starter list) reads as one line. These
// tables keep no history, so each event claims only what its row proves (negative-keyword-actions.js):
// - blocked: pushed_at is set only when Google accepted the block. decided_by names the advisor word's Add only
//   while removed_at is empty, because an Undo writes the undoer over it. Owner list rows read 'Owner word list'.
// - not_blocked: a person acted on an advisor word and it was not blocked: a Decline, or an Add that the portal
//   refused (a protected word reads 'declined', a converting one 'failed'). The row does not say which, so the
//   event names the outcome and the person who acted, not a choice.
// - unblocked: an Undo, the only way an advisor or manual word is removed. It runs only on a word live in Google and
//   saves only after Google removed it, so decided_by is the undoer.
// - delisted: a word taken off the owner's list, by ad_negative_words.removed_by. Google is told only for the
//   campaigns where the word was live, and the rows do not keep that, so this is the list change, not a Google one.
const NEGATIVE_EVENTS_SQL = `
  WITH ev AS (
    SELECT 'blocked' AS kind, k.pushed_at AS at, k.text, k.campaign_id,
           CASE WHEN k.source = 'owner_list' THEN 'Owner word list' WHEN k.removed_at IS NULL THEN k.decided_by END AS actor
      FROM ad_negative_keywords k
     WHERE k.pushed_at >= ?
    UNION ALL
    SELECT 'not_blocked', k.decided_at, k.text, k.campaign_id, k.decided_by
      FROM ad_negative_keywords k
     WHERE k.source <> 'owner_list' AND k.state IN ('declined', 'failed') AND k.decided_at >= ?
    UNION ALL
    SELECT 'unblocked', k.removed_at, k.text, k.campaign_id, k.decided_by
      FROM ad_negative_keywords k
     WHERE k.source <> 'owner_list' AND k.removed_at >= ?
    UNION ALL
    SELECT 'delisted', w.removed_at, w.text, NULL::uuid, w.removed_by
      FROM ad_negative_words w
     WHERE w.removed_at >= ?
  )
  SELECT ev.kind, date_trunc('minute', ev.at) AS at, c.campaign_name, COALESCE(t.name, ev.actor) AS who,
         count(*)::int AS n, string_agg(ev.text, ', ' ORDER BY ev.text) AS words
    FROM ev
    LEFT JOIN ad_campaigns c ON c.id = ev.campaign_id
    LEFT JOIN technicians t ON t.id::text = ev.actor
   GROUP BY 1, 2, 3, 4
   ORDER BY 2 DESC
   LIMIT ${MAX_TIMELINE}`;

const some = (n, noun) => (n === 1 ? `a ${noun}` : `${n} ${noun}s`);
const NEGATIVE_WHAT = {
  blocked: (n) => `Blocked ${some(n, 'negative keyword')}`,
  not_blocked: (n) => (n === 1 ? 'Advisor word not blocked' : `${n} advisor words not blocked`),
  unblocked: (n) => `Unblocked ${some(n, 'negative keyword')}`,
  delisted: (n) => `Took ${some(n, 'word')} off the negative word list`,
};

async function negativeChanges(since) {
  const { rows } = await db.raw(NEGATIVE_EVENTS_SQL, [since, since, since, since]);
  return rows.map((row) => ({
    at: iso(row.at),
    source: 'waves',
    who: row.who || 'Waves portal',
    via: 'Waves portal',
    campaign: row.campaign_name || null,
    what: NEGATIVE_WHAT[row.kind](row.n),
    detail: row.words,
  }));
}

// The portal's own upload rows for the window: sent, waiting, refused, and partial. A partial row was in a Google
// batch that Google partly refused (data-manager.js 'partial_success'): Google gives only totals, so no one knows
// which rows failed.
async function uploadCounts(query, since) {
  const rows = await query.where('created_at', '>=', since).groupBy('status').select('status', db.raw('count(*)::int AS n'));
  const count = (status) => rows.find((row) => row.status === status)?.n || 0;
  return { sent: count('sent'), pending: count('pending'), failed: count('failed'), partial: count('partial_success') };
}

async function buildAdsHealth(now = new Date()) {
  const firstDay = etDateString(addETDays(now, 1 - WINDOW_DAYS));
  const lastDay = etDateString(addETDays(now, 1));
  const since = parseETDateTime(`${firstDay}T00:00`);
  const notes = [];
  const customer = getCustomer();
  const configured = Boolean(customer);
  const [serving, disapprovals, uploadCheck, googleRows, budgetRows, holdRows, negativeRows, googleUploads, metaUploads] = await Promise.all([
    configured ? servingSection() : null,
    configured ? disapprovalSection() : null,
    configured ? uploadCheckSection(customer) : null,
    configured ? attempt('Google change history', notes, [], () => googleChanges(customer, firstDay, lastDay)) : [],
    attempt('The budget log', notes, [], () => budgetChanges(since)),
    attempt('Lifted holds', notes, [], () => holdLifts(since)),
    attempt('Negative keyword decisions', notes, [], () => negativeChanges(since)),
    // Live uploads only: Google validation runs (validate_only) and Meta test events are dry runs.
    attempt('Google upload counts', notes, null, () => uploadCounts(db('google_ads_conversion_uploads').where('validate_only', false), since)),
    attempt('Meta upload counts', notes, null, () => uploadCounts(db('meta_conversion_uploads').where('test_mode', false), since)),
  ]);
  const names = new Map((serving?.campaigns || []).map((c) => [c.id, c.name]));
  const googleNamed = googleRows.map(({ campaignId, ...row }) => ({
    ...row,
    campaign: campaignId ? names.get(campaignId) || `Campaign ${campaignId}` : null,
  }));
  const timeline = [...googleNamed, ...budgetRows, ...holdRows, ...negativeRows]
    .filter((row) => row.at)
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, MAX_TIMELINE);
  return {
    generatedAt: now.toISOString(),
    google: { configured, serving, disapprovals, uploadCheck },
    uploads: { google: googleUploads, meta: metaUploads },
    timeline,
    notes,
  };
}

module.exports = { buildAdsHealth };
