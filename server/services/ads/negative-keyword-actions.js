'use strict';

// The ONE server step behind negative keywords (owner plan A, 2026-11-02; GATE_ADS_NEGATIVES), shared by the Ads page,
// the bell's Add / Decline buttons and the 6 AM sync:
//   - the advisor's words: queueAdvisorNegatives writes a pending row and rings at most 3 bell rows a day;
//     decideSuggestion (Add / Decline) and undoNegative act on one row.
//   - the owner's word list (ad_negative_words): addOwnerWord / removeOwnerWord / syncOwnerWords push it to Google as
//     phrase negatives on every linked Google campaign, with no bell.
// Nothing here texts, emails or calls a customer or moves money. It changes where the ads can show. Every function
// checks the gate first; gate off = no write of any kind and no Google call.

const db = require('../../models/db');
const logger = require('../logger');
const { etDateString } = require('../../utils/datetime-et');
const episodes = require('../admin-alert-episodes');
const { raiseAdminAlert, cutAtWord, breaksAlertRules, MAX_WHY_CHARS } = require('../admin-alert-compose');
const { fitAction } = require('../admin-alert-names');
const { normalizeNegative, protectedReason, competitorName, phraseMatches } = require('./negative-keywords');
const { negativeButtons } = require('./negative-keyword-buttons');

const AREA = 'Leads';
const CATEGORY = 'system';
const MATCH_TYPE = 'phrase';
// docs/admin-notifications.md section 4 rule 1: a standing backlog is never a bell. At most this many new bell rows a
// day (Eastern); the rest wait as pending on the Ads page and ring on later days, oldest first.
const MAX_NEW_BELLS = 3;
const CONVERSION_DAYS = 90;
const REASON_CHARS = 500;
const LOG_LIMIT = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// No claim about conversions here: the fallback is used exactly when the numbers behind the word are missing.
const BELL_FALLBACK_WHY = 'Suggested by the ads advisor from the last 30 days of search terms.';

const gateLive = () => require('../../config/feature-gates').adsNegativesLive() === true;
const google = () => require('./google-ads');
const bellKey = (id) => `ads-negative:${id}`;
const who = (by) => (by == null || by === '' ? null : String(by).slice(0, 64));

const MESSAGES = {
  off: 'Negative keywords are turned off.',
  invalid: 'Type one to four words, using letters and numbers only.',
  gone: 'That word is no longer there.',
  decided: 'This word was already decided.',
  not_active: 'This word is not blocking anything now.',
  owner_list: 'Remove it from your word list.',
  not_linked: 'This campaign is not linked to Google Ads, so the word cannot be blocked.',
  converted: 'A search with this word brought a conversion in the last 90 days, so it was not blocked.',
  google_unavailable: 'Google Ads did not answer. Try again later.',
  google_error: 'Google Ads did not accept the change. Try again later.',
};
const refuse = (code, message) => ({ ok: false, code, message: message || MESSAGES[code] });
const protectedMessage = (text, reason) => `"${text}" ${reason}, so blocking it could hide searches you want.`;

// ---------------------------------------------------------------------------
// Shared reads and writes
// ---------------------------------------------------------------------------

// Where a negative can run: a linked, active Google Ads campaign.
const linkedCampaigns = (conn = db) => conn('ad_campaigns')
  .where({ platform: 'google_ads', status: 'active' })
  .whereNotNull('platform_campaign_id')
  .select('id', 'campaign_name', 'platform_campaign_id')
  .orderBy('campaign_name');

// One lock per word: a save, the bell tap and the 6 AM run never double-push the same word.
const lockText = (trx, text) => trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`ads-negative:${text}`]);

// Whether the word is on the owner's list now (not removed).
const onLiveList = async (conn, text) => Boolean(await conn('ad_negative_words').where({ text, match_type: MATCH_TYPE }).whereNull('removed_at').first('id'));

// A row that left "pending" has no more use for its bell: close it in the same transaction.
const closeBell = (trx, id, resolution) => episodes.closeAdminAlertKeys(trx, [bellKey(id)], 'negative_decided', { resolution });

// One read of every search term that converted in the last 90 days, shared by a whole sync run. null = Google gave no answer.
function conversionReader() {
  let pending = null;
  return () => {
    if (!pending) pending = google().convertingSearchTerms(CONVERSION_DAYS);
    return pending;
  };
}
const hasConversion = (converting, text) => converting.some((entry) => phraseMatches(entry.term, text));

// ---------------------------------------------------------------------------
// The advisor's words: Add / Decline
// ---------------------------------------------------------------------------

/**
 * Add or decline one advisor word. One transaction with the row locked; the bell row closes in it whenever the row
 * leaves "pending". Returns { ok: true, state, message } or { ok: false, code, message }; codes: off, invalid, gone,
 * decided, not_linked, protected, converted, google_unavailable, google_error.
 */
async function decideSuggestion(id, decision, { by } = {}) {
  if (!gateLive()) return refuse('off');
  if (decision !== 'add' && decision !== 'decline') return refuse('invalid', 'The decision must be add or decline.');
  if (!UUID.test(String(id || ''))) return refuse('gone');
  const actor = who(by);

  return db.transaction(async (trx) => {
    const row = await trx('ad_negative_keywords').where({ id }).forUpdate().first();
    if (!row) return refuse('gone');
    if (row.state !== 'pending' || row.source !== 'advisor') return refuse('decided');
    const now = new Date();
    const settle = async (patch, resolution) => {
      await trx('ad_negative_keywords').where({ id }).update({ ...patch, updated_at: now });
      await closeBell(trx, id, resolution);
    };

    if (decision === 'decline') {
      await settle({ state: 'declined', decided_by: actor, decided_at: now }, 'Declined');
      return { ok: true, state: 'declined', message: `Declined "${row.text}".` };
    }

    const campaign = await trx('ad_campaigns').where({ id: row.campaign_id }).first();
    if (!campaign || campaign.platform !== 'google_ads' || !campaign.platform_campaign_id || campaign.status !== 'active') {
      return refuse('not_linked');
    }
    const blocked = protectedReason(row.text);
    if (blocked) {
      await settle({ state: 'declined', decided_by: actor, decided_at: now }, 'Not added: the word could block searches you want');
      return refuse('protected', protectedMessage(row.text, blocked));
    }
    const converting = await google().convertingSearchTerms(CONVERSION_DAYS);
    if (converting === null) return refuse('google_unavailable');
    if (hasConversion(converting, row.text)) {
      await settle({ state: 'failed', last_error: 'converted', decided_by: actor, decided_at: now },
        'Not added: a search with this word brought a conversion');
      return refuse('converted');
    }
    const added = await google().addCampaignNegativeKeyword(campaign.platform_campaign_id, row.text);
    if (!added) {
      await trx('ad_negative_keywords').where({ id }).update({ last_error: MESSAGES.google_error, updated_at: now });
      return refuse('google_error');
    }
    await settle({
      state: 'active', google_resource_name: added.resourceName, pushed_at: now, last_error: null, decided_by: actor, decided_at: now,
    }, 'Added');
    return { ok: true, state: 'active', message: `Blocked "${row.text}" in Google Ads.` };
  });
}

/**
 * Take a block the owner approved (an advisor or manual word) back out of Google. A word from the owner's own list is
 * removed from the list instead. Returns { ok: true, state: 'removed', message } or { ok: false, code, message };
 * codes: off, gone, not_active, owner_list, google_error.
 */
async function undoNegative(id, { by } = {}) {
  if (!gateLive()) return refuse('off');
  if (!UUID.test(String(id || ''))) return refuse('gone');
  const actor = who(by);

  const seen = await db('ad_negative_keywords').where({ id }).first('text');
  if (!seen) return refuse('gone');
  return db.transaction(async (trx) => {
    // The word's lock first, as the sync takes it: a list change and this undo never cross.
    await lockText(trx, seen.text);
    const row = await trx('ad_negative_keywords').where({ id }).forUpdate().first();
    if (!row) return refuse('gone');
    if (row.state !== 'active' || !row.google_resource_name) return refuse('not_active');
    // A word on the owner's live list is his list's block, whoever added it first: the next sync would block it
    // again, so it is undone by taking it off the list.
    if (row.source === 'owner_list' || await onLiveList(trx, row.text)) return refuse('owner_list');
    const now = new Date();
    const removed = await google().removeCampaignNegativeKeyword(row.google_resource_name);
    if (!removed) {
      await trx('ad_negative_keywords').where({ id }).update({ last_error: MESSAGES.google_error, updated_at: now });
      return refuse('google_error');
    }
    await trx('ad_negative_keywords').where({ id }).update({
      state: 'removed', removed_at: now, last_error: null, decided_by: actor, updated_at: now,
    });
    return { ok: true, state: 'removed', message: `Undone: "${row.text}" is no longer blocked in Google Ads.` };
  });
}

// ---------------------------------------------------------------------------
// The owner's word list
// ---------------------------------------------------------------------------

// Push one owner_list row to its campaign: the conversion check first, then the Google write. Updates the row and counts.
async function pushRow(trx, row, campaign, readConverting, counts, now) {
  const update = (patch) => trx('ad_negative_keywords').where({ id: row.id }).update({ ...patch, updated_at: now });
  const converting = await readConverting();
  if (converting === null) {
    await update({ last_error: MESSAGES.google_unavailable });
    counts.failed += 1;
    counts.googleFailed += 1;
    return;
  }
  if (hasConversion(converting, row.text)) {
    // Retried every day: it goes once the conversion is older than 90 days.
    await update({ state: 'failed', last_error: 'converted' });
    counts.failed += 1;
    return;
  }
  const added = await google().addCampaignNegativeKeyword(campaign.platform_campaign_id, row.text);
  if (!added) {
    await update({ state: 'failed', last_error: MESSAGES.google_error });
    counts.failed += 1;
    counts.googleFailed += 1;
    return;
  }
  await update({ state: 'active', google_resource_name: added.resourceName, pushed_at: now, last_error: null });
  counts.pushed += 1;
}

// One live word on every linked campaign, under the word's lock.
async function ensureWord(word, campaigns, readConverting, counts) {
  await db.transaction(async (trx) => {
    await lockText(trx, word.text);
    const current = await trx('ad_negative_words').where({ id: word.id }).first();
    if (!current || current.removed_at) return;
    const rows = await trx('ad_negative_keywords').where({ text: word.text, match_type: MATCH_TYPE }).forUpdate();
    const byCampaign = new Map(rows.map((r) => [String(r.campaign_id), r]));
    const now = new Date();
    for (const campaign of campaigns) {
      let row = byCampaign.get(String(campaign.id));
      if (!row) {
        const [inserted] = await trx('ad_negative_keywords')
          .insert({ campaign_id: campaign.id, text: word.text, match_type: MATCH_TYPE, source: 'owner_list', state: 'pending' })
          .onConflict(['campaign_id', 'text', 'match_type']).ignore()
          .returning('*');
        if (!inserted) continue; // an advisor row landed meanwhile: the next run sees it
        row = inserted;
      } else if (row.state === 'active') {
        continue; // already blocking, whoever added it
      } else if (row.source !== 'owner_list' || row.state === 'declined' || row.state === 'removed') {
        // The owner's list wins over a declined or removed row and over a word still waiting on his yes.
        if (row.source === 'advisor' && row.state === 'pending') await closeBell(trx, row.id, 'Your word list now blocks this word');
        [row] = await trx('ad_negative_keywords').where({ id: row.id })
          .update({ source: 'owner_list', state: 'pending', last_error: null, updated_at: now }).returning('*');
      }
      await pushRow(trx, row, campaign, readConverting, counts, now);
    }
  });
}

// A removed word comes out of Google: owner_list rows still active are removed there, waiting or failed ones just close.
// A failed Google remove leaves that row active with last_error (the nightly sync retries).
async function dropWord(trx, text, counts) {
  const rows = await trx('ad_negative_keywords')
    .where({ text, match_type: MATCH_TYPE, source: 'owner_list' })
    .whereIn('state', ['active', 'pending', 'failed'])
    .forUpdate();
  const now = new Date();
  for (const row of rows) {
    const patch = { state: 'removed', removed_at: now, last_error: null, updated_at: now };
    if (row.state === 'active' && row.google_resource_name) {
      const removed = await google().removeCampaignNegativeKeyword(row.google_resource_name);
      if (!removed) {
        await trx('ad_negative_keywords').where({ id: row.id }).update({ last_error: MESSAGES.google_error, updated_at: now });
        counts.failed += 1;
        counts.googleFailed += 1;
        continue;
      }
      counts.removed += 1;
    }
    await trx('ad_negative_keywords').where({ id: row.id }).update(patch);
  }
}

async function sweepRemovedWord(text, counts) {
  await db.transaction(async (trx) => {
    await lockText(trx, text);
    const word = await trx('ad_negative_words').where({ text }).first();
    if (!word || !word.removed_at) return; // added again meanwhile
    await dropWord(trx, text, counts);
  });
}

/**
 * Make Google match the owner's word list: every live word is an active phrase negative on every linked campaign, every
 * removed word is gone from Google. `texts` limits the run to those words (a save). Also the 6 AM step.
 * Returns { pushed, failed, removed, googleFailed } (plus skipped: 'off' with the gate off). `failed` counts every word
 * not sent, a word held back because a search with it converted included; `googleFailed` only the ones Google did not
 * answer or refused, which the 6 AM job reports as a failure.
 */
async function syncOwnerWords({ texts } = {}) {
  const counts = { pushed: 0, failed: 0, removed: 0, googleFailed: 0 };
  if (!gateLive()) return { ...counts, skipped: 'off' };
  const only = Array.isArray(texts) ? texts : null;
  const wordsQuery = db('ad_negative_words').where({ match_type: MATCH_TYPE }).orderBy('text');
  if (only) wordsQuery.whereIn('text', only);
  const words = await wordsQuery;
  const live = words.filter((w) => !w.removed_at);
  const readConverting = conversionReader();
  if (live.length) {
    const campaigns = await linkedCampaigns();
    for (const word of live) await ensureWord(word, campaigns, readConverting, counts);
  }
  // Removed words that still have a row in Google (or waiting): a save reaches its own, the 6 AM run reaches all.
  const leftovers = await db('ad_negative_keywords as k')
    .join('ad_negative_words as w', 'w.text', 'k.text')
    .whereNotNull('w.removed_at')
    .where({ 'k.source': 'owner_list', 'k.match_type': MATCH_TYPE })
    .whereIn('k.state', ['active', 'pending', 'failed'])
    .modify((q) => { if (only) q.whereIn('w.text', only); })
    .distinct('w.text');
  for (const { text } of leftovers) await sweepRemovedWord(text, counts);
  return counts;
}

// A word with its per-campaign state, for the Ads page. Linked campaigns with no row yet read "pending" (waiting to be sent).
async function buildWords(conn, words) {
  if (!words.length) return [];
  const [campaigns, rows] = await Promise.all([
    linkedCampaigns(conn),
    conn('ad_negative_keywords as k').join('ad_campaigns as c', 'c.id', 'k.campaign_id')
      .whereIn('k.text', words.map((w) => w.text)).where('k.match_type', MATCH_TYPE)
      .select('k.text', 'k.campaign_id', 'k.state', 'k.last_error', 'c.campaign_name'),
  ]);
  return words.map((word) => {
    const seen = new Map();
    for (const campaign of campaigns) seen.set(String(campaign.id), { campaignId: campaign.id, campaignName: campaign.campaign_name, state: 'pending', lastError: null });
    for (const r of rows.filter((x) => x.text === word.text)) {
      seen.set(String(r.campaign_id), { campaignId: r.campaign_id, campaignName: r.campaign_name, state: r.state, lastError: r.last_error || null });
    }
    return { id: word.id, text: word.text, addedAt: word.created_at, campaigns: [...seen.values()] };
  });
}

/**
 * Put a word on the owner's list (or take it off the removed pile) and send it to Google. A competitor's name is allowed
 * here: that block is the owner's call. Returns { ok: true, word } or { ok: false, code, message }; codes: off, invalid,
 * protected.
 */
async function addOwnerWord(text, { by } = {}) {
  if (!gateLive()) return refuse('off');
  const word = normalizeNegative(text);
  if (!word) return refuse('invalid');
  const blocked = protectedReason(word);
  if (blocked) return refuse('protected', protectedMessage(word, blocked));
  const actor = who(by);

  const saved = await db.transaction(async (trx) => {
    await lockText(trx, word);
    const now = new Date();
    const existing = await trx('ad_negative_words').where({ text: word }).forUpdate().first();
    if (!existing) {
      const [row] = await trx('ad_negative_words').insert({ text: word, match_type: MATCH_TYPE, added_by: actor }).returning('*');
      return row;
    }
    if (!existing.removed_at) return existing;
    const [row] = await trx('ad_negative_words').where({ id: existing.id })
      .update({ removed_at: null, removed_by: null, added_by: actor, updated_at: now }).returning('*');
    return row;
  });
  await syncOwnerWords({ texts: [word] });
  const [view] = await buildWords(db, [saved]);
  return { ok: true, word: view };
}

/**
 * Take a word off the owner's list. Its active rows come out of Google; a Google remove that fails leaves that row active
 * with the error, and the nightly sync tries again. Returns { ok: true, word: { id, text, removedAt }, failed } where
 * failed is how many campaigns could not be reached, or { ok: false, code, message }; codes: off, gone.
 */
async function removeOwnerWord(wordId, { by } = {}) {
  if (!gateLive()) return refuse('off');
  if (!UUID.test(String(wordId || ''))) return refuse('gone');
  const actor = who(by);
  const first = await db('ad_negative_words').where({ id: wordId }).first();
  if (!first) return refuse('gone');

  const counts = { pushed: 0, failed: 0, removed: 0, googleFailed: 0 };
  const word = await db.transaction(async (trx) => {
    await lockText(trx, first.text);
    const current = await trx('ad_negative_words').where({ id: wordId }).forUpdate().first();
    if (!current) return null;
    const now = new Date();
    let saved = current;
    if (!current.removed_at) {
      [saved] = await trx('ad_negative_words').where({ id: wordId })
        .update({ removed_at: now, removed_by: actor, updated_at: now }).returning('*');
    }
    await dropWord(trx, current.text, counts);
    return saved;
  });
  if (!word) return refuse('gone');
  return { ok: true, word: { id: word.id, text: word.text, removedAt: word.removed_at }, failed: counts.failed };
}

// ---------------------------------------------------------------------------
// The Ads page
// ---------------------------------------------------------------------------

const iso = (value) => (value ? new Date(value).toISOString() : null);

/** The Ads page's three lists: the owner's words, the advisor words waiting on a yes, and what was decided. */
async function listNegatives() {
  const [wordRows, pendingRows, logRows] = await Promise.all([
    db('ad_negative_words').whereNull('removed_at').where({ match_type: MATCH_TYPE }).orderBy('text'),
    db('ad_negative_keywords as k').join('ad_campaigns as c', 'c.id', 'k.campaign_id')
      .where({ 'k.source': 'advisor', 'k.state': 'pending' })
      .orderBy('k.created_at', 'asc').orderBy('k.id')
      .select('k.id', 'k.text', 'k.campaign_id', 'k.reason', 'k.metrics', 'k.created_at', 'k.notified_at', 'c.campaign_name'),
    db('ad_negative_keywords as k').join('ad_campaigns as c', 'c.id', 'k.campaign_id')
      .whereNot('k.state', 'pending')
      .orderBy('k.updated_at', 'desc').orderBy('k.id')
      .limit(LOG_LIMIT)
      .select('k.id', 'k.text', 'k.campaign_id', 'k.source', 'k.state', 'k.decided_at', 'k.pushed_at', 'k.removed_at', 'k.last_error', 'c.campaign_name'),
  ]);
  const words = (await buildWords(db, wordRows)).map((w) => ({ ...w, addedAt: iso(w.addedAt) }));
  const listed = new Set(wordRows.map((w) => w.text));
  return {
    words,
    pending: pendingRows.map((r) => ({
      id: r.id,
      text: r.text,
      campaignId: r.campaign_id,
      campaignName: r.campaign_name,
      reason: r.reason || null,
      metrics: r.metrics || null,
      createdAt: iso(r.created_at),
      notifiedAt: iso(r.notified_at),
    })),
    log: logRows.map((r) => ({
      id: r.id,
      text: r.text,
      campaignId: r.campaign_id,
      campaignName: r.campaign_name,
      source: r.source,
      state: r.state,
      decidedAt: iso(r.decided_at),
      pushedAt: iso(r.pushed_at),
      removedAt: iso(r.removed_at),
      lastError: r.last_error || null,
      // A word on the live list is undone by taking it off the list (undoNegative refuses it).
      canUndo: r.state === 'active' && r.source !== 'owner_list' && !listed.has(r.text),
    })),
  };
}

// ---------------------------------------------------------------------------
// The advisor's words: rows and bells
// ---------------------------------------------------------------------------

// What the bell says about a word. `plain` is bid-desk's cleaning: the search term is a customer's own words, so code-shaped
// tokens are cleaned out and a text that still breaks the copy rules is replaced by the fallback.
function plain(text, fallback) {
  const cleaned = String(text || '')
    .replace(/\b[0-9a-f]{12,}\b/gi, ' ')
    .replace(/\d{4}-\d{2}-\d{2}/g, ' ')
    .replace(/[[\]!_]/g, ' ')
    .replace(/([.?!])\s+(?=[A-Z])/g, ', ')
    .replace(/\s+/g, ' ').trim();
  return cleaned && !breaksAlertRules(cleaned) ? cleaned : fallback;
}

function parseJson(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value || 'null'); } catch { return null; }
}

function whyFor(metrics) {
  const clicks = Number(metrics?.clicks);
  const cost = Number(metrics?.cost);
  const term = plain(metrics?.term, null);
  if (!metrics || !term || !Number.isFinite(clicks) || !Number.isFinite(cost) || Number(metrics.conversions) > 0) return BELL_FALLBACK_WHY;
  const why = cutAtWord(`${clicks} ${clicks === 1 ? 'click' : 'clicks'}, $${cost.toFixed(2)}, no conversions in 30 days, from "${term}".`, MAX_WHY_CHARS);
  return breaksAlertRules(why) ? BELL_FALLBACK_WHY : why;
}

/** The bell row for one pending advisor word (pure). */
function negativeBellSpec(row) {
  const metrics = parseJson(row.metrics);
  return {
    spec: {
      area: AREA,
      action: fitAction(AREA, `"${row.text}"`, [(n) => `block ${n} in Google Ads`, (n) => `block ${n}`]),
      why: whyFor(metrics),
      severity: 'needs-you',
      link: `/admin/ppc?tab=advisor&negative=${row.id}`, // the page itself: /admin/ads redirects and drops the query
      subject: { type: 'check', id: row.id },
      doneWhen: 'negative_decided',
      who: 'person',
      buttons: negativeButtons(),
    },
    detail: row.reason || BELL_FALLBACK_WHY,
  };
}

// The search term behind a word: the campaign's highest-spend term the word would block.
async function bestTerm(conn, campaignId, text) {
  const terms = await conn('ad_search_terms').where({ campaign_id: campaignId })
    .whereRaw('lower(search_term) LIKE ?', [`%${text.replace(/[\\%_]/g, '\\$&')}%`])
    .orderBy('cost', 'desc').limit(50)
    .select('search_term', 'clicks', 'cost', 'conversions');
  const best = terms.find((t) => phraseMatches(t.search_term, text));
  return best
    ? { term: best.search_term, clicks: Number(best.clicks) || 0, cost: Number(best.cost) || 0, conversions: Number(best.conversions) || 0 }
    : null;
}

/**
 * Ring the bells for pending advisor words: at most 3 new bell rows per Eastern day, oldest word first. The count, the
 * pick and the stamps run under one lock. Returns how many rang.
 */
async function ringNegativeBells({ now = new Date() } = {}) {
  if (!gateLive()) return 0;
  const today = etDateString(now);
  return db.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', ['ads-negative:bells']);
    const [{ count }] = await trx('ad_negative_keywords').whereNotNull('notified_at')
      .whereRaw("(notified_at AT TIME ZONE 'America/New_York')::date = ?::date", [today]).count({ count: '*' });
    const allowance = MAX_NEW_BELLS - Number(count);
    if (allowance <= 0) return 0;
    const candidates = await trx('ad_negative_keywords').where({ source: 'advisor', state: 'pending' }).whereNull('notified_at')
      .orderBy('created_at', 'asc').orderBy('id').limit(allowance).select('id');
    let rang = 0;
    for (const { id } of candidates) {
      try {
        await trx.transaction(async (sp) => {
          const fresh = await sp('ad_negative_keywords').where({ id }).forUpdate().first();
          if (!fresh || fresh.state !== 'pending' || fresh.source !== 'advisor' || fresh.notified_at) return;
          const { spec, detail } = negativeBellSpec(fresh);
          await raiseAdminAlert(CATEGORY, spec, { bell: true, dedupeKey: bellKey(id), detail, metadata: { negativeId: id }, trx: sp });
          await sp('ad_negative_keywords').where({ id }).update({ notified_at: now, updated_at: now });
          rang += 1;
        });
      } catch (err) {
        logger.warn(`[ads-negatives] bell for ${id} failed: ${err.message}`);
      }
    }
    return rang;
  });
}

/**
 * After a model-written advisor report is stored: a pending row for each add_negative that carries a safe word, then the
 * day's bells. Returns { queued, rang }. A failure is the caller's to log; it never fails the report.
 */
async function queueAdvisorNegatives(advice, { now = new Date() } = {}) {
  if (!gateLive()) return { queued: 0, rang: 0, skipped: 'off' };
  let queued = 0;
  for (const rec of Array.isArray(advice?.recommendations) ? advice.recommendations : []) {
    if (!rec || rec.apply_action !== 'add_negative' || !rec.apply_value || !rec.campaign_id) continue;
    const text = normalizeNegative(rec.apply_value);
    // The advisor's validation already drops these; checked again so a stale report can never queue one.
    if (!text || protectedReason(text) || competitorName(text)) continue;
    try {
      const metrics = await bestTerm(db, rec.campaign_id, text);
      const inserted = await db('ad_negative_keywords').insert({
        campaign_id: rec.campaign_id,
        text,
        match_type: MATCH_TYPE,
        source: 'advisor',
        state: 'pending',
        reason: String(rec.reasoning || '').slice(0, REASON_CHARS) || null,
        metrics: metrics ? JSON.stringify(metrics) : null,
      }).onConflict(['campaign_id', 'text', 'match_type']).ignore().returning('id');
      if (inserted && inserted.length) queued += 1;
    } catch (err) {
      logger.warn(`[ads-negatives] could not queue "${text}": ${err.message}`);
    }
  }
  const rang = await ringNegativeBells({ now });
  return { queued, rang };
}

module.exports = {
  decideSuggestion,
  undoNegative,
  addOwnerWord,
  removeOwnerWord,
  syncOwnerWords,
  listNegatives,
  queueAdvisorNegatives,
  ringNegativeBells,
  negativeBellSpec,
  bellKey,
  MAX_NEW_BELLS,
  MESSAGES,
};
