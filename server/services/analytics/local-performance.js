const db = require('../../models/db');
const GA4 = require('./google-analytics');
const { etDateString, addETDays } = require('../../utils/datetime-et');
const {
  WAVES_LOCATIONS,
  findGbpLocationByUtmContent,
  gbpTrackingUrlForLocation,
  isGbpUtmCampaign,
} = require('../../config/locations');

function dateOnly(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.split('T')[0];
  return new Date(value).toISOString().split('T')[0];
}

function number(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function addDateStringDays(value, days) {
  const d = new Date(`${String(value || '').slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return value;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0];
}

function newProfileRow(loc) {
  return {
    id: loc.id,
    name: loc.name,
    googleLocationId: loc.googleLocationId,
    utmContent: loc.gbpUtmContent,
    websitePath: loc.gbpWebsitePath,
    trackingUrl: gbpTrackingUrlForLocation(loc),
    gbp: {
      calls: 0,
      websiteClicks: 0,
      directionRequests: 0,
      bookings: 0,
      messages: 0,
      menus: 0,
      searchViews: 0,
      mapsViews: 0,
      interactions: 0,
      days: 0,
      lastDate: null,
    },
    ga4: {
      sessions: 0,
      users: 0,
      conversions: 0,
    },
    crm: {
      leads: 0,
      qualifiedLeads: 0,
      bookedJobs: 0,
      acceptedEstimateRevenue: 0,
      withClickId: 0,
      withUserData: 0,
      dataManagerEligible: 0,
    },
  };
}

function buildProfileMap() {
  return new Map(WAVES_LOCATIONS.map((loc) => [loc.id, newProfileRow(loc)]));
}

function profileForContent(content, profileMap) {
  const loc = findGbpLocationByUtmContent(content);
  return loc ? profileMap.get(loc.id) : null;
}

function acceptedEstimateRevenue(row) {
  if (row.estimate_status !== 'accepted') return 0;
  const monthly = number(row.estimate_monthly);
  const annual = number(row.estimate_annual);
  const oneTime = number(row.estimate_onetime);
  return (monthly > 0 ? monthly * 12 : annual) + oneTime;
}

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function contentFromLead(row) {
  if (row.gbp_location_id) {
    const loc = WAVES_LOCATIONS.find((item) => item.googleLocationId === row.gbp_location_id);
    if (loc) return loc.gbpUtmContent;
  }

  const data = parseJsonObject(row.extracted_data);
  return data?.attribution?.utm?.content
    || data?.utm?.content
    || data?.utm_content
    || null;
}

function estimateLeadId(row) {
  const data = parseJsonObject(row.estimate_data);
  return data.lead_id ? String(data.lead_id) : null;
}

function estimateRank(row) {
  const status = String(row?.status || '').toLowerCase();
  const statusRank = status === 'accepted' ? 3 : (['sent', 'viewed'].includes(status) ? 2 : 1);
  const timeRank = Date.parse(row?.accepted_at || row?.updated_at || row?.created_at || 0) || 0;
  return [statusRank, timeRank];
}

function betterEstimate(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  const [aStatus, aTime] = estimateRank(a);
  const [bStatus, bTime] = estimateRank(b);
  if (bStatus !== aStatus) return bStatus > aStatus ? b : a;
  return bTime > aTime ? b : a;
}

function mergeEstimateFields(rows, estimates) {
  const byEstimateId = new Map();
  const byLeadId = new Map();

  for (const estimate of estimates || []) {
    byEstimateId.set(String(estimate.id), estimate);
    const leadId = estimateLeadId(estimate);
    if (leadId) byLeadId.set(leadId, betterEstimate(byLeadId.get(leadId), estimate));
  }

  return (rows || []).map((row) => {
    const direct = row.estimate_id ? byEstimateId.get(String(row.estimate_id)) : null;
    const wizard = byLeadId.get(String(row.id));
    const estimate = betterEstimate(direct, wizard);
    return {
      ...row,
      estimate_status: estimate?.status || null,
      estimate_monthly: estimate?.monthly_total || null,
      estimate_annual: estimate?.annual_total || null,
      estimate_onetime: estimate?.onetime_total || null,
    };
  });
}

function sumProfileTotals(profiles) {
  return profiles.reduce((acc, profile) => {
    acc.calls += profile.gbp.calls;
    acc.websiteClicks += profile.gbp.websiteClicks;
    acc.directionRequests += profile.gbp.directionRequests;
    acc.bookings += profile.gbp.bookings;
    acc.messages += profile.gbp.messages;
    acc.menus += profile.gbp.menus;
    acc.searchViews += profile.gbp.searchViews;
    acc.mapsViews += profile.gbp.mapsViews;
    acc.interactions += profile.gbp.interactions;
    acc.ga4Sessions += profile.ga4.sessions;
    acc.ga4Users += profile.ga4.users;
    acc.ga4Conversions += profile.ga4.conversions;
    acc.leads += profile.crm.leads;
    acc.qualifiedLeads += profile.crm.qualifiedLeads;
    acc.bookedJobs += profile.crm.bookedJobs;
    acc.acceptedEstimateRevenue += profile.crm.acceptedEstimateRevenue;
    acc.dataManagerEligible += profile.crm.dataManagerEligible;
    acc.withClickId += profile.crm.withClickId;
    acc.withUserData += profile.crm.withUserData;
    return acc;
  }, {
    calls: 0,
    websiteClicks: 0,
    directionRequests: 0,
    bookings: 0,
    messages: 0,
    menus: 0,
    searchViews: 0,
    mapsViews: 0,
    interactions: 0,
    ga4Sessions: 0,
    ga4Users: 0,
    ga4Conversions: 0,
    leads: 0,
    qualifiedLeads: 0,
    bookedJobs: 0,
    acceptedEstimateRevenue: 0,
    dataManagerEligible: 0,
    withClickId: 0,
    withUserData: 0,
  });
}

async function getGbpRows(since, endDate) {
  try {
    return await db('gbp_performance_daily')
      .where('date', '>=', since)
      .where('date', '<', addDateStringDays(endDate, 1));
  } catch (err) {
    return { error: err.message, rows: [] };
  }
}

async function getCrmRows(since, endDate) {
  try {
    const rows = await db('leads')
      .where('leads.first_contact_at', '>=', since)
      .where('leads.first_contact_at', '<', addDateStringDays(endDate, 1))
      .leftJoin('lead_sources as ls', 'leads.lead_source_id', 'ls.id')
      .where((q) => {
        q.where('ls.source_type', 'gbp')
          .orWhereRaw("COALESCE(leads.extracted_data::text, '') ILIKE '%\"campaign\":\"gbp\"%'")
          .orWhereRaw("COALESCE(leads.extracted_data::text, '') ILIKE '%\"source\":\"gbp\"%'");
      })
      .select(
        'leads.id',
        'leads.status',
        'leads.is_qualified',
        'leads.email',
        'leads.phone',
        'leads.gclid',
        'leads.wbraid',
        'leads.gbraid',
        'leads.estimate_id',
        'leads.extracted_data',
        'ls.gbp_location_id'
      );

    if (!rows.length) return rows;

    const leadIds = rows.map((row) => String(row.id));
    const estimateIds = rows.map((row) => row.estimate_id).filter(Boolean).map(String);
    const estimates = await db('estimates')
      .where((q) => {
        if (estimateIds.length) q.whereIn('id', estimateIds);
        if (leadIds.length) {
          q.orWhere((qq) => {
            qq.where('source', 'quote_wizard')
              .whereIn(db.raw("estimate_data->>'lead_id'"), leadIds);
          });
        }
      })
      .select(
        'id',
        'status',
        'source',
        'estimate_data',
        'monthly_total',
        'annual_total',
        'onetime_total',
        'accepted_at',
        'updated_at',
        'created_at'
      );

    return mergeEstimateFields(rows, estimates);
  } catch (err) {
    return { error: err.message, rows: [] };
  }
}

async function buildLocalPerformance({ periodDays = 30 } = {}) {
  const days = Math.min(Math.max(parseInt(periodDays, 10) || 30, 7), 180);
  const since = etDateString(addETDays(new Date(), -days));
  const endDate = etDateString(addETDays(new Date(), -1));
  const profileMap = buildProfileMap();
  const daily = new Map();
  const warnings = [];

  const gbpResult = await getGbpRows(since, endDate);
  const gbpRows = Array.isArray(gbpResult) ? gbpResult : gbpResult.rows;
  if (gbpResult.error) warnings.push({ source: 'gbp_performance_daily', message: gbpResult.error });

  for (const row of gbpRows) {
    const profile = profileMap.get(row.location_id);
    if (!profile) continue;
    const d = dateOnly(row.date);
    const calls = number(row.calls);
    const websiteClicks = number(row.website_clicks);
    const directionRequests = number(row.direction_requests);
    const bookings = number(row.bookings);
    const searchViews = number(row.search_views);
    const mapsViews = number(row.maps_views);
    const interactions = calls + websiteClicks + directionRequests + bookings;

    profile.gbp.calls += calls;
    profile.gbp.websiteClicks += websiteClicks;
    profile.gbp.directionRequests += directionRequests;
    profile.gbp.bookings += bookings;
    profile.gbp.searchViews += searchViews;
    profile.gbp.mapsViews += mapsViews;
    profile.gbp.interactions += interactions;
    profile.gbp.days += 1;
    if (d && (!profile.gbp.lastDate || d > profile.gbp.lastDate)) profile.gbp.lastDate = d;

    if (d) {
      const day = daily.get(d) || { date: d, calls: 0, websiteClicks: 0, directionRequests: 0, bookings: 0, interactions: 0 };
      day.calls += calls;
      day.websiteClicks += websiteClicks;
      day.directionRequests += directionRequests;
      day.bookings += bookings;
      day.interactions += interactions;
      daily.set(d, day);
    }
  }

  const ga4 = await GA4.getGbpUtmTraffic(since, endDate);
  if (ga4.error) warnings.push({ source: 'ga4_utm', message: ga4.error });
  for (const row of ga4.data || []) {
    if (!isGbpUtmCampaign(row)) continue;
    const profile = profileForContent(row.content, profileMap);
    if (!profile) continue;
    profile.ga4.sessions += number(row.sessions);
    profile.ga4.users += number(row.users);
    profile.ga4.conversions += number(row.conversions);
  }

  const crmResult = await getCrmRows(since, endDate);
  const crmRows = Array.isArray(crmResult) ? crmResult : crmResult.rows;
  if (crmResult.error) warnings.push({ source: 'crm_attribution', message: crmResult.error });
  for (const row of crmRows) {
    const profile = profileForContent(contentFromLead(row), profileMap);
    if (!profile) continue;
    const hasClickId = !!(row.gclid || row.wbraid || row.gbraid);
    const hasUserData = !!(row.email || row.phone);
    const booked = row.estimate_status === 'accepted' || ['booked', 'converted', 'won'].includes(String(row.status || '').toLowerCase());

    profile.crm.leads += 1;
    if (row.is_qualified === true || row.is_qualified === 'true') profile.crm.qualifiedLeads += 1;
    if (booked) profile.crm.bookedJobs += 1;
    if (hasClickId) profile.crm.withClickId += 1;
    if (hasUserData) profile.crm.withUserData += 1;
    if (hasClickId || hasUserData) profile.crm.dataManagerEligible += 1;
    profile.crm.acceptedEstimateRevenue += acceptedEstimateRevenue(row);
  }

  const profiles = [...profileMap.values()];
  const totals = sumProfileTotals(profiles);

  return {
    configuredProfiles: profiles.length,
    period: { days, since, endDate },
    profiles,
    blended: {
      gbp: {
        interactions: totals.interactions,
        websiteClicks: totals.websiteClicks,
        calls: totals.calls,
        directionRequests: totals.directionRequests,
        bookings: totals.bookings,
        messages: totals.messages,
        menus: totals.menus,
        searchViews: totals.searchViews,
        mapsViews: totals.mapsViews,
      },
      ga4Website: {
        sessions: totals.ga4Sessions,
        users: totals.ga4Users,
        conversions: totals.ga4Conversions,
      },
      crm: {
        leads: totals.leads,
        qualifiedLeads: totals.qualifiedLeads,
        bookedJobs: totals.bookedJobs,
        acceptedEstimateRevenue: totals.acceptedEstimateRevenue,
      },
      dataManagerReadiness: {
        leads: totals.leads,
        withClickId: totals.withClickId,
        withUserData: totals.withUserData,
        eligible: totals.dataManagerEligible,
      },
    },
    daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)),
    setup: {
      ga4BusinessProfileLink: {
        status: 'manual_check_required',
        expectedLinkedProfiles: profiles.length,
        note: 'GA4 native Google Business Profile metrics are aggregate-only when multiple profiles are linked.',
      },
      utmWebsiteLinks: profiles.map((profile) => ({
        id: profile.id,
        name: profile.name,
        trackingUrl: profile.trackingUrl,
      })),
      dataManagerUpload: {
        status: 'not_implemented_in_portal',
        recommendedConversions: ['Waves - Qualified Lead', 'Waves - Completed Job Revenue'],
      },
    },
    warnings,
  };
}

module.exports = {
  buildLocalPerformance,
  _internals: {
    acceptedEstimateRevenue,
    addDateStringDays,
    contentFromLead,
    estimateLeadId,
    isGbpUtmCampaign,
    mergeEstimateFields,
    profileForContent,
  },
};
