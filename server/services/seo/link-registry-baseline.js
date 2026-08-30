/**
 * Backlink Manager v2 — step 2: existing-profile baseline import
 * (docs/design/backlink-manager-plan.md §4 "Existing profile").
 *
 * Every ACTIVE, SCAN-TRACKED `seo_backlinks` row (the same predicate the
 * verifier uses as live evidence — a GSC-export row is history, not a link
 * that exists today) becomes, per canonical referring host:
 *
 *   - ONE registry domain (`ensureDomain`, source='existing_backlink',
 *     touch 'baseline_import', seen_at = the host's earliest first_seen). A
 *     domain the import CREATES is stamped agent_state='acquired'; a domain
 *     another feeder already knew keeps whatever state it has (first-touch
 *     provenance and state are never rewritten here).
 *   - ONE baseline acquisition path (`baseline=true`, acquisition_type
 *     'unknown', every NOT NULL boolean explicit, agent_completable=false so it
 *     can never earn an AUTO_* level, last_investigated_at=null so §6.3
 *     validity returns INVALID until the investigator replaces it). Identity
 *     is `pathKey('unknown', 'baseline:<host>')` — one per domain, found again
 *     on every re-run. It becomes the domain's best_path_id ONLY when that is
 *     still null.
 *   - ONE representative placement (`seo_link_prospects`, status 'live') per
 *     (host, target_page, location_key) — the representative is the backlink
 *     ordered `is_dofollow DESC NULLS LAST, first_seen ASC, id ASC`; an
 *     existing board row for the same key (any spelling, via findPlacementRow)
 *     is reused and its representative is never re-picked.
 *   - a `seo_link_placement_backlinks` mapping for EVERY backlink in the group
 *     (backlink_id UNIQUE → a re-run adds newly seen links, never duplicates).
 *
 * D30/D90 and every learning field stay NULL — never inferred from age (§8).
 * Idempotent to a fixed point: a second run creates nothing. One transaction
 * per run; `dryRun` performs the same reads and returns the counts with zero
 * writes and no transaction. Nothing here fetches, sends, or spends.
 */

const { ensureDomain, isNeverTargetHost, pathKey, pathLinkTypeFor, acquisitionTypeForLinkType, touchKey } = require('./link-registry');
const { canonicalProspectDomain, findPlacementRow, lockProspectDomain, targetPageOf, locationKeyOf } = require('./prospect-domain-lock');
const { SPOKE_SITE_KEYS } = require('../content-astro/spoke-sites');

const SOURCE = 'existing_backlink';
const SOURCE_DETAIL = 'baseline_import';
const OWN_HOSTS = Object.freeze(['wavespestcontrol.com', ...SPOKE_SITE_KEYS]);

// Same predicate as link-prospect-verifier.js `scanTrackedOnly` (not exported
// there; that module binds the live db at require time). Only a scan-tracked
// row is evidence a link exists today.
const scanTrackedOnly = (qb) => qb.whereNull('discovery_source').orWhere('discovery_source', 'dataforseo');

function isOwnHost(host) {
  return OWN_HOSTS.some((n) => host === n || host.endsWith(`.${n}`));
}

function hostOf(bl) {
  const fromDomain = canonicalProspectDomain(bl.source_domain);
  if (fromDomain) return fromDomain;
  try { return canonicalProspectDomain(new URL(String(bl.source_url || '')).hostname); } catch { return ''; }
}

function dateMs(v) {
  const t = v instanceof Date ? v.getTime() : Date.parse(v || '');
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t; // unknown first_seen sorts after any known date
}

// `is_dofollow DESC NULLS LAST, first_seen ASC, id ASC`
function representativeOrder(a, b) {
  const ra = a.is_dofollow === true ? 0 : a.is_dofollow === false ? 1 : 2;
  const rb = b.is_dofollow === true ? 0 : b.is_dofollow === false ? 1 : 2;
  if (ra !== rb) return ra - rb;
  const ta = dateMs(a.first_seen); const tb = dateMs(b.first_seen);
  if (ta !== tb) return ta < tb ? -1 : 1;
  return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
}

function expectedRelOfDofollow(v) {
  return v === true ? 'dofollow' : v === false ? 'nofollow' : 'unknown';
}

function laneOf(bl) {
  return bl.link_type ? pathLinkTypeFor(bl.link_type) : 'citation';
}

function earliestFirstSeen(rows) {
  let best = null;
  for (const r of rows) {
    const t = dateMs(r.first_seen);
    if (t === Number.POSITIVE_INFINITY) continue;
    if (best == null || t < best) best = t;
  }
  return best == null ? null : new Date(best);
}

/** The §3.2 row for a domain's baseline path (domain_id filled by the caller). */
function baselinePathRow(host, representative, backlinkCount) {
  return {
    // The lane the scan recorded (directory/citation/social → self_service_account,
    // editorial → editorial_outreach, resource → resource_outreach, none → unknown)
    // through the shared board-lane mapping — never a blanket 'unknown'.
    acquisition_type: acquisitionTypeForLinkType(representative.link_type),
    submission_url: representative.source_url || null,
    estimated_cost_cents: null,
    renewal_cost_cents: null,
    renewal_period: null,
    merchant_binding: null,
    account_required: false,
    email_verification: false,
    payment_required: false,
    legal_attestation: false,
    legal_terms_hash: null,
    agent_completable: false,
    terms_accepted_by_send: false,
    execution_after_send: true,
    baseline: true,
    expected_rel: expectedRelOfDofollow(representative.is_dofollow),
    expected_indexability: 'unknown',
    expected_persistence: 'unknown',
    link_type: laneOf(representative),
    confidence: 0.1,
    last_investigated_at: null,
    investigation: JSON.stringify({ baseline: true, backlink_count: backlinkCount }),
    path_key: pathKey(acquisitionTypeForLinkType(representative.link_type), `baseline:${host}`),
  };
}

/** The §3.3 placement row for a group's representative (domain_id/path_id filled by the caller). */
function placementRow(host, targetPage, locationKey, representative) {
  return {
    target_domain: host,
    target_url: representative.source_url || null,
    target_page: targetPage,
    link_type: laneOf(representative),
    source: SOURCE,
    source_detail: SOURCE_DETAIL,
    status: 'live',
    location_key: locationKey,
    live_url: representative.source_url || null,
    is_dofollow: typeof representative.is_dofollow === 'boolean' ? representative.is_dofollow : null,
    first_live_at: representative.first_seen || null,
    backlink_id: representative.id,
    anchor_text: representative.anchor_text || null,
    domain_rating: representative.domain_rating == null ? null : representative.domain_rating,
  };
}

// An active seo_backlinks row from host → page is proof the link is live. A
// reused board row that does not already say so is brought to the evidence
// with the verifier's own guard (link-prospect-verifier.markLive): an
// un-pitched 'prospect' only while its outreach is unsent (none/drafted, never
// sent) — it is also un-claimed so the worker never pitches a live link;
// 'placed' / 'lost' rows are promoted; a row mid-outreach (contacted,
// negotiating, sending …) is left to the send finalizer / operator
// reconciliation. live/indexed rows only gain a missing live_url/backlink_id.
const PLACEMENT_COLUMNS = ['id', 'status', 'target_page', 'live_url', 'first_live_at', 'backlink_id'];
async function reconcilePlacement(q, placement, rep, now) {
  const isLive = ['live', 'indexed'].includes(placement.status);
  if (isLive && placement.live_url && placement.backlink_id) return 0; // representative already identified
  // A row that is already live keeps the live_url it verified; a promoted row takes the scan's.
  const patch = { live_url: (isLive ? placement.live_url || rep.source_url : rep.source_url || placement.live_url) || null, backlink_id: placement.backlink_id || rep.id, updated_at: now };
  let u = q('seo_link_prospects').where({ id: placement.id, status: placement.status });
  if (!isLive) {
    if (placement.status === 'prospect') {
      u = u.where((b) => b.whereNull('outreach_status').orWhere('outreach_status', 'none').orWhere('outreach_status', 'drafted')).whereNull('outreach_sent_at');
      Object.assign(patch, { claimed_at: null, claimed_by: null, outreach_status: 'none', outreach_send_token: null });
    } else if (!['placed', 'lost'].includes(placement.status)) return 0;
    patch.status = 'live';
    if (typeof rep.is_dofollow === 'boolean') patch.is_dofollow = rep.is_dofollow;
    if (!placement.first_live_at) patch.first_live_at = rep.first_seen || now;
  }
  return (await u.update(patch)) ? 1 : 0;
}

async function findActivePath(q, domainId, key) {
  return q('seo_link_acquisition_paths').where({ domain_id: domainId, path_key: key }).whereNull('superseded_by').first('id');
}

/**
 * Group the scan-tracked profile by canonical host → [{ host, rows, groups }],
 * where `groups` is keyed by `${target_page}|${location_key}` with rows sorted
 * by the representative order. Never-target / own hosts land in `skipped`.
 */
function groupProfile(rows) {
  const byHost = new Map();
  const skipped = [];
  for (const bl of rows) {
    const host = hostOf(bl);
    if (!host) { skipped.push({ backlink_id: bl.id, reason: 'no_host' }); continue; }
    if (isOwnHost(host)) { skipped.push({ backlink_id: bl.id, reason: 'own_domain' }); continue; }
    if (isNeverTargetHost(host)) { skipped.push({ backlink_id: bl.id, reason: 'never_target' }); continue; }
    if (!byHost.has(host)) byHost.set(host, { host, rows: [], groups: new Map() });
    const d = byHost.get(host);
    d.rows.push(bl);
    const targetPage = targetPageOf(bl.target_url);
    const locationKey = locationKeyOf(null); // inbound profile rows carry no GBP location
    const gk = `${targetPage}|${locationKey}`;
    if (!d.groups.has(gk)) d.groups.set(gk, { targetPage, locationKey, rows: [] });
    d.groups.get(gk).rows.push(bl);
  }
  const domains = [...byHost.values()].sort((a, b) => (a.host < b.host ? -1 : a.host > b.host ? 1 : 0));
  for (const d of domains) {
    d.rows.sort(representativeOrder);
    for (const g of d.groups.values()) g.rows.sort(representativeOrder);
  }
  return { domains, skipped };
}

/**
 * importExistingBacklinks(db, { dryRun = false, limit = null, now = new Date() })
 *   → { dryRun, scanned, domainsCreated, domainsTouched, placementsCreated,
 *       placementsExisting, mappingsCreated, pathsCreated, skipped: [{ backlink_id, reason }] }
 * `limit` caps the number of domains processed (hosts in name order).
 */
async function importExistingBacklinks(db, { dryRun = false, limit = null, now = new Date() } = {}) {
  const rows = await db('seo_backlinks')
    .where({ status: 'active' })
    .where(scanTrackedOnly)
    .orderBy('id', 'asc')
    .select('id', 'source_url', 'source_domain', 'target_url', 'anchor_text', 'domain_rating', 'first_seen', 'is_dofollow', 'link_type');

  const { domains: allDomains, skipped } = groupProfile(rows);
  const domains = Number.isFinite(Number(limit)) && Number(limit) > 0 ? allDomains.slice(0, Number(limit)) : allDomains;
  const out = {
    dryRun: !!dryRun, scanned: rows.length,
    domainsCreated: 0, domainsTouched: 0, placementsCreated: 0, placementsExisting: 0, placementsReconciled: 0,
    mappingsCreated: 0, pathsCreated: 0, skipped,
  };
  if (!domains.length) return out;

  const work = async (q) => {
    for (const d of domains) {
      const representative = d.rows[0];
      const seenAt = earliestFirstSeen(d.rows);
      const path = baselinePathRow(d.host, representative, d.rows.length);

      // ---- domain ------------------------------------------------------
      let domainId; let domainCreated = false;
      if (dryRun) {
        const existing = await q('seo_link_domains').where({ domain: d.host }).first('id', 'best_path_id');
        domainCreated = !existing;
        domainId = existing ? existing.id : null;
        if (domainCreated) out.domainsTouched += 1;
        else {
          const touched = await q('seo_link_domain_sources').where({ domain_id: domainId, touch_key: touchKey(SOURCE, null, SOURCE_DETAIL) }).first('id');
          if (!touched) out.domainsTouched += 1;
        }
      } else {
        const dom = await ensureDomain(q, { domain: d.host, source: SOURCE, sourceDetail: SOURCE_DETAIL, seenAt });
        domainId = dom.id; domainCreated = dom.created;
        if (dom.touched) out.domainsTouched += 1;
        if (dom.created) {
          await q('seo_link_domains').where({ id: domainId }).update({ agent_state: 'acquired', updated_at: now });
        }
      }
      if (domainCreated) out.domainsCreated += 1;

      // ---- baseline path (one per domain) ---------------------------------
      let pathId = null;
      const existingPath = domainId ? await findActivePath(q, domainId, path.path_key) : null;
      if (existingPath) pathId = existingPath.id;
      else if (dryRun) out.pathsCreated += 1;
      else {
        const ins = await q('seo_link_acquisition_paths').insert({ ...path, domain_id: domainId, created_at: now, updated_at: now })
          .onConflict(q.raw('(domain_id, path_key) WHERE superseded_by IS NULL')).ignore()
          .returning(['id']);
        if (ins && ins.length) { pathId = ins[0].id; out.pathsCreated += 1; } else {
          const again = await findActivePath(q, domainId, path.path_key);
          if (!again) throw new Error(`link-registry-baseline: lost race creating path ${path.path_key} for ${d.host}`);
          pathId = again.id;
        }
        const dom = await q('seo_link_domains').where({ id: domainId }).first('id', 'best_path_id');
        if (dom && dom.best_path_id == null) {
          await q('seo_link_domains').where({ id: domainId }).whereNull('best_path_id').update({ best_path_id: pathId, updated_at: now });
        }
      }

      // ---- placements + mappings -----------------------------------------
      // Board admission goes through the shared per-domain advisory lock like
      // every other seo_link_prospects writer: no concurrent writer can admit a
      // differently spelled, canonically equal (host, page) between the lookup
      // and the insert. Transaction-scoped, so it needs the real transaction.
      if (!dryRun) await lockProspectDomain(q, d.host);
      for (const g of d.groups.values()) {
        const rep = g.rows[0];
        let placement = await findPlacementRow(q, d.host, g.targetPage, { location: g.locationKey, columns: PLACEMENT_COLUMNS });
        if (placement) { out.placementsExisting += 1; if (!dryRun) out.placementsReconciled += await reconcilePlacement(q, placement, rep, now); }
        else if (dryRun) out.placementsCreated += 1;
        else {
          const ins = await q('seo_link_prospects')
            .insert({ ...placementRow(d.host, g.targetPage, g.locationKey, rep), domain_id: domainId, path_id: pathId, created_at: now, updated_at: now })
            // constraintless ON CONFLICT: matches the legacy 2-col unique AND the v2
            // location_key key during the rolling deploy (see the step-1 route test)
            .onConflict().ignore()
            .returning(['id']);
          if (ins && ins.length) { placement = ins[0]; out.placementsCreated += 1; } else {
            placement = await findPlacementRow(q, d.host, g.targetPage, { location: g.locationKey, columns: PLACEMENT_COLUMNS });
            if (!placement) throw new Error(`link-registry-baseline: lost race creating placement ${d.host} → ${g.targetPage}`);
            out.placementsExisting += 1;
            out.placementsReconciled += await reconcilePlacement(q, placement, rep, now);
          }
        }

        const ids = g.rows.map((r) => r.id);
        if (dryRun || !placement) {
          const mapped = new Set((await q('seo_link_placement_backlinks').whereIn('backlink_id', ids).select('backlink_id')).map((m) => m.backlink_id));
          out.mappingsCreated += ids.filter((id) => !mapped.has(id)).length;
        } else {
          const ins = await q('seo_link_placement_backlinks')
            .insert(ids.map((backlink_id) => ({ prospect_id: placement.id, backlink_id, created_at: now })))
            .onConflict('backlink_id').ignore()
            .returning(['id']);
          out.mappingsCreated += ins ? ins.length : 0;
        }
      }
    }
  };

  if (dryRun) await work(db);
  else await db.transaction(work);
  return out;
}

module.exports = {
  importExistingBacklinks,
  _internals: { groupProfile, representativeOrder, baselinePathRow, placementRow, hostOf, isOwnHost, scanTrackedOnly, SOURCE, SOURCE_DETAIL },
};
