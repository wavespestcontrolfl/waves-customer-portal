const { etParts, parseETDateTime } = require('../utils/datetime-et');
const { isLikelyE164, isValidNanpNumber, phoneIdentityKey, toE164 } = require('../utils/phone');
const TWILIO_NUMBERS = require('../config/twilio-numbers');
const { sharedLineNumbers } = require('../config/shared-phone-lines');
const { whereNotSandboxCall } = require('./voice-agent/relay-protocol');

const TIME_ZONE = 'America/New_York';

// Keep the SQL identity expression aligned with phoneIdentityKey. It is used
// in one set query for the bounded caller keys on the response page, avoiding
// one historical lookup per row.
const CALLER_DIGITS_SQL = "regexp_replace(COALESCE(h.from_phone, ''), '[^0-9]', '', 'g')";
const CALLER_KEY_SQL = `(CASE
  WHEN ${CALLER_DIGITS_SQL} = '' THEN NULL
  WHEN (${CALLER_DIGITS_SQL} ~ '^1[0-9]{10}$'
    OR (COALESCE(h.from_phone, '') NOT LIKE '+%' AND ${CALLER_DIGITS_SQL} ~ '^[0-9]{10}$'))
    THEN right(${CALLER_DIGITS_SQL}, 10)
  ELSE '+' || ${CALLER_DIGITS_SQL}
END)`;

function callableCallerKey(value) {
  const normalized = toE164(value);
  if (!isLikelyE164(normalized)) return null;
  if (String(normalized).startsWith('+1') && !isValidNanpNumber(normalized)) return null;
  return phoneIdentityKey(value);
}

function currentETMonthWindow(now = new Date()) {
  const { year, month } = etParts(now);
  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  const endYear = month === 12 ? year + 1 : year;
  const endMonth = month === 12 ? 1 : month + 1;
  const endExclusive = `${endYear}-${String(endMonth).padStart(2, '0')}-01`;
  return {
    timezone: TIME_ZONE,
    start,
    end_exclusive: endExclusive,
    startInstant: parseETDateTime(`${start}T00:00`),
    endInstant: parseETDateTime(`${endExclusive}T00:00`),
  };
}

function parseMetadata(row) {
  if (!row?.metadata) return {};
  if (typeof row.metadata === 'object') return row.metadata;
  try { return JSON.parse(row.metadata); } catch { return {}; }
}

function registryLine(number) {
  if (!number) return null;
  return TWILIO_NUMBERS.findByNumber(number);
}

function lineName(row, registry) {
  return String(row?._source_name || registry?.label || row?.to_phone || 'Unknown line').trim();
}

function unknownEvidence(detail, basis) {
  return { kind: 'unknown', label: 'Source unknown', detail, basis };
}

function confirmedGoogleCallEvidence(row) {
  const resourceName = String(row?.google_ads_call_resource_name || '').trim();
  const aggregateConfirmed = row?._google_ads_call_confirmed === true
    || row?._google_ads_call_confirmed === 'true';
  if (!resourceName && !aggregateConfirmed) return null;
  return {
    kind: 'google_ads',
    label: 'Google Ads',
    detail: 'Matched call report',
    basis: 'Google Ads call reporting matched this call to an ad interaction.',
  };
}

function secondaryDetail(kind, name, row) {
  if (kind === 'google_business') {
    return `Maps listing · ${name.replace(/^GBP\s*[—-]\s*/i, '')}`;
  }
  if (kind === 'website' && row?._source_domain) return `Website · ${row._source_domain}`;
  if (kind === 'offline') return `Offline · ${name}`;
  return name;
}

function recordedSourceEvidence(row) {
  const metadata = parseMetadata(row);
  const type = String(metadata.numberType || row?._recorded_number_type || '').trim().toLowerCase();
  if (!type || type === 'unknown') return null;
  const location = String(metadata.location || row?._recorded_location || '').trim().slice(0, 120);
  const domain = String(metadata.domain || row?._recorded_domain || '').trim().slice(0, 120);
  if (type === 'google_ads') return {
    kind: 'google_ads', label: 'Google Ads', detail: location || 'Google Ads call line',
    basis: 'When the call arrived, the dialed number was assigned to this Google Ads call placement.',
  };
  if (type === 'facebook') return {
    kind: 'meta_ads', label: 'Meta Ads', detail: location || 'Meta Ads call line',
    basis: 'When the call arrived, the dialed number was assigned to this Meta Ads call placement.',
  };
  if (type === 'gbp_tracking') return {
    kind: 'google_business', label: 'Google Business Profile',
    detail: `Maps listing · ${(location || 'Google Business Profile').replace(/^GBP\s*[—-]\s*/i, '')}`,
    basis: 'When the call arrived, the dialed number was assigned to this Google Maps listing.',
  };
  if (['domain_tracking', 'pest_domain', 'lawn_domain'].includes(type)) return {
    kind: 'website', label: 'Website', detail: domain ? `Website · ${domain}` : (location || 'Website call line'),
    basis: 'When the call arrived, the dialed number was assigned only to this website placement.',
  };
  if (type === 'van_tracking') return {
    kind: 'offline', label: 'Offline', detail: location || 'Vehicle tracking line',
    basis: 'When the call arrived, the dialed number was assigned to this offline placement.',
  };
  if (['location', 'tech_line', 'unassigned', 'internal_alert', 'customer_chat'].includes(type)) {
    return unknownEvidence(location || 'Shared company line', 'When the call arrived, this was not a line dedicated to one discovery source.');
  }
  return null;
}

/**
 * Attribution is allowed only when the dialed line itself proves the source.
 * Call timing, caller geography and extracted conversation fields never enter
 * this resolver. In particular, the hub/main and office NAP lines are shared
 * and therefore cannot prove that a call came from the website.
 */
function sourceEvidence(row) {
  // This column is written only after google-call-bridge accepts and commits
  // one real call-report match. Bridge proposals and ambiguous candidates
  // live outside this column and therefore remain unknown. A confirmed match
  // outranks the dialed line because Google call assets can use a shared
  // office number that cannot prove paid source on its own.
  const confirmedGoogle = confirmedGoogleCallEvidence(row);
  if (confirmedGoogle) return confirmedGoogle;
  const recorded = recordedSourceEvidence(row);
  if (recorded) return recorded;
  const number = toE164(row?.to_phone);
  const registry = registryLine(number);
  const sourceType = String(row?._source_type || '').toLowerCase();
  const name = lineName(row, registry);
  const sharedNumber = sharedLineNumbers(TWILIO_NUMBERS).includes(number);

  if (sourceType === 'google_ads' || registry?.type === 'google_ads') {
    return {
      kind: 'google_ads',
      label: 'Google Ads',
      detail: secondaryDetail('google_ads', name, row),
      basis: 'The dialed number is currently assigned to this Google Ads call placement.',
    };
  }
  if (sourceType === 'facebook' || registry?.type === 'facebook') {
    return {
      kind: 'meta_ads',
      label: 'Meta Ads',
      detail: secondaryDetail('meta_ads', name, row),
      basis: 'The dialed number is currently assigned to this Meta Ads call placement.',
    };
  }
  if (sourceType === 'gbp' || registry?.type === 'gbp_tracking') {
    return {
      kind: 'google_business',
      label: 'Google Business Profile',
      detail: secondaryDetail('google_business', name, row),
      basis: 'The dialed number is currently assigned to this Google Maps listing.',
    };
  }
  if (sourceType === 'vehicle' || registry?.type === 'van_tracking') {
    return {
      kind: 'offline',
      label: 'Offline',
      detail: secondaryDetail('offline', name, row),
      basis: 'The dialed number is currently assigned to this offline placement.',
    };
  }
  if (sharedNumber) {
    return unknownEvidence(name, 'This number is shared by the office and website, so the call’s discovery source is unknown.');
  }
  if (sourceType === 'spoke_site'
    || sourceType === 'website_organic'
    || ['domain_tracking', 'pest_domain', 'lawn_domain'].includes(registry?.type)
    || (sourceType === 'main_site' && row?._source_domain)) {
    return {
      kind: 'website',
      label: 'Website',
      detail: secondaryDetail('website', name, row),
      basis: 'The dialed number is currently assigned only to this website placement.',
    };
  }
  if (sourceType || registry) {
    return unknownEvidence(name, 'This line is registered, but it is not dedicated to one discovery source.');
  }
  return unknownEvidence('Unmapped line', 'The dialed number has no registered source assignment.');
}

// One deterministic source row per phone. Historical seed reruns did not put a
// UNIQUE constraint on lead_sources.twilio_phone_number, so joining the table
// directly could duplicate calls and inflate both the list and monthly totals.
function sourceRegistryQuery(conn) {
  return conn('lead_sources')
    .distinctOn('twilio_phone_number')
    .whereNotNull('twilio_phone_number')
    .select('twilio_phone_number', 'name', 'source_type', 'domain', 'landing_page_url', 'is_active')
    .orderBy('twilio_phone_number', 'asc')
    .orderByRaw('is_active DESC NULLS LAST, updated_at DESC NULLS LAST, id ASC');
}

function addSourceRegistryJoin(query, conn, callAlias = 'cl') {
  return query.leftJoin(sourceRegistryQuery(conn).as('call_source'), `${callAlias}.to_phone`, 'call_source.twilio_phone_number');
}

function sourceSelectColumns(conn) {
  return [
    'call_source.name as _source_name',
    'call_source.source_type as _source_type',
    'call_source.domain as _source_domain',
    'call_source.landing_page_url as _source_landing_page_url',
    conn.raw('call_source.is_active as _source_is_active'),
  ];
}

function stripPrivateSourceColumns(row) {
  const clean = { ...row };
  delete clean._source_name;
  delete clean._source_type;
  delete clean._source_domain;
  delete clean._source_landing_page_url;
  delete clean._source_is_active;
  delete clean._google_ads_call_confirmed;
  return clean;
}

function sourceSortExpression(conn, callAlias = 'cl') {
  const shared = sharedLineNumbers(TWILIO_NUMBERS);
  const google = Object.values(TWILIO_NUMBERS.paidTracking).filter((line) => line.source === 'google_ads').map((line) => line.number);
  const meta = Object.values(TWILIO_NUMBERS.paidTracking).filter((line) => line.source === 'facebook').map((line) => line.number);
  const gbp = Object.values(TWILIO_NUMBERS.gbpTracking).map((line) => line.number);
  const websites = [
    ...TWILIO_NUMBERS.domainTracking,
    ...TWILIO_NUMBERS.lawnDomainTracking,
  ].map((line) => line.number).filter((number) => !shared.includes(number));
  const offline = [TWILIO_NUMBERS.tracking.vanWrap.number];
  const marks = (values) => values.map(() => '?').join(', ');
  return conn.raw(`CASE
    WHEN ${callAlias}.direction = 'outbound' THEN 'Outbound call'
    WHEN NULLIF(BTRIM(${callAlias}.google_ads_call_resource_name), '') IS NOT NULL THEN 'Google Ads'
    WHEN ${callAlias}.metadata->>'numberType' = 'google_ads' THEN 'Google Ads'
    WHEN ${callAlias}.metadata->>'numberType' = 'facebook' THEN 'Meta Ads'
    WHEN ${callAlias}.metadata->>'numberType' = 'gbp_tracking' THEN 'Google Business Profile'
    WHEN ${callAlias}.metadata->>'numberType' = 'van_tracking' THEN 'Offline'
    WHEN ${callAlias}.metadata->>'numberType' IN ('location', 'tech_line', 'unassigned', 'internal_alert', 'customer_chat') THEN 'Source unknown'
    WHEN ${callAlias}.metadata->>'numberType' IN ('domain_tracking', 'pest_domain', 'lawn_domain') THEN 'Website'
    WHEN ${callAlias}.to_phone IN (${marks(google)}) OR call_source.source_type = 'google_ads' THEN 'Google Ads'
    WHEN ${callAlias}.to_phone IN (${marks(meta)}) OR call_source.source_type = 'facebook' THEN 'Meta Ads'
    WHEN ${callAlias}.to_phone IN (${marks(gbp)}) OR call_source.source_type = 'gbp' THEN 'Google Business Profile'
    WHEN ${callAlias}.to_phone IN (${marks(offline)}) OR call_source.source_type = 'vehicle' THEN 'Offline'
    WHEN ${callAlias}.to_phone IN (${marks(shared)}) THEN 'Source unknown'
    WHEN ${callAlias}.to_phone IN (${marks(websites)})
      OR call_source.source_type IN ('spoke_site', 'website_organic')
      OR (call_source.source_type = 'main_site' AND call_source.domain IS NOT NULL)
      THEN 'Website'
    ELSE 'Source unknown'
  END`, [...google, ...meta, ...gbp, ...offline, ...shared, ...websites]);
}

function applyCallListOrder(query, conn, { sort, order } = {}) {
  const direction = String(order || '').toLowerCase() === 'asc' ? 'asc' : 'desc';
  if (sort === 'source') {
    query.orderBy(sourceSortExpression(conn), direction)
      .orderByRaw(`COALESCE(call_source.name, cl.to_phone) ${direction}`)
      .orderBy('cl.created_at', 'desc')
      .orderBy('cl.id', 'desc');
    return query;
  }
  return query.orderBy('cl.created_at', direction).orderBy('cl.id', direction);
}

async function loadCallerHistory(conn, calls) {
  const keys = [...new Set(calls
    .filter((call) => call.direction === 'inbound')
    .map((call) => callableCallerKey(call.from_phone))
    .filter(Boolean))];
  if (!keys.length) return new Map();

  const rows = await conn('call_log as h')
    .where('h.direction', 'inbound')
    .modify((qb) => whereNotSandboxCall(qb, 'h.source'))
    .whereRaw(`${CALLER_KEY_SQL} = ANY(?::text[])`, [keys])
    .select(
      conn.raw(`${CALLER_KEY_SQL} as caller_key`),
      conn.raw('(array_agg(h.id ORDER BY h.created_at ASC, h.id ASC))[1] as first_call_id'),
    )
    .groupByRaw(CALLER_KEY_SQL);
  return new Map(rows.map((row) => [row.caller_key, String(row.first_call_id)]));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Stamps are provisional while a processor owns the call. Match the settled
// predicate used by admin-leads and call attribution: token NULL plus status
// processed (or legacy NULL). An operator unlink and conflicting origin/relay
// stamps fail closed instead of falling through to a possibly repointed SID.
function leadLinkage(row) {
  const metadata = parseMetadata(row);
  // A durable non-lead verdict can retain a CallSid (and, transiently, a
  // retired stamp), but it must not present that CRM row as this call's
  // confirmed acquisition. google-call-bridge applies the same veto before
  // attributing a settled report match.
  if (metadata.no_attribution === true) return { kind: 'blocked', reason: 'no_attribution' };
  const hasOverride = Object.prototype.hasOwnProperty.call(metadata, 'customer_link_override');
  const override = hasOverride && metadata.customer_link_override && typeof metadata.customer_link_override === 'object'
    ? metadata.customer_link_override : null;
  if (hasOverride && !String(override?.customer_id || '').trim()) return { kind: 'blocked', reason: 'operator_unlinked' };

  const status = row?.processing_status == null ? null : String(row.processing_status).toLowerCase();
  if (row?.processing_token != null || (status !== null && status !== 'processed')) {
    return { kind: 'blocked', reason: 'call_unsettled' };
  }

  const rawIds = [metadata.lead_id, metadata.relay_lead_id]
    .filter((value) => value !== null && value !== undefined && String(value).trim() !== '')
    .map(String);
  if (rawIds.some((id) => !UUID_RE.test(id))) return { kind: 'blocked', reason: 'invalid_stamp' };
  const ids = [...new Set(rawIds)];
  if (ids.length > 1) return { kind: 'blocked', reason: 'conflicting_stamps' };
  const ownerId = hasOverride ? String(override.customer_id) : (row?.customer_id ? String(row.customer_id) : null);
  if (ids.length === 1) return { kind: 'stamped', leadId: ids[0], ownerId };
  return row?.twilio_call_sid ? { kind: 'sid', sid: row.twilio_call_sid, ownerId } : { kind: 'none', ownerId };
}

function relatedLeadId(row) {
  const linkage = leadLinkage(row);
  return linkage.kind === 'stamped' ? linkage.leadId : null;
}

function leadMatchesOwner(lead, linkage) {
  return !!lead && !(linkage.ownerId && lead.customer_id && String(linkage.ownerId) !== String(lead.customer_id));
}

async function loadRelatedLeads(conn, calls) {
  const linkageByCall = new Map(calls.map((call) => [call.id, leadLinkage(call)]));
  const stampedIds = [...new Set([...linkageByCall.values()]
    .filter((linkage) => linkage.kind === 'stamped')
    .map((linkage) => linkage.leadId))];
  const stampedRows = stampedIds.length
    ? await conn('leads').whereIn('id', stampedIds).whereNull('deleted_at').select('id', 'status', 'customer_id')
    : [];
  const stampedById = new Map(stampedRows.map((row) => [String(row.id), row]));

  const unstampedSids = [...new Set([...linkageByCall.values()]
    .filter((linkage) => linkage.kind === 'sid')
    .map((linkage) => linkage.sid))];
  const sidRows = unstampedSids.length
    ? await conn('leads').whereIn('twilio_call_sid', unstampedSids).whereNull('deleted_at').select('id', 'status', 'customer_id', 'twilio_call_sid')
    : [];
  const bySid = new Map();
  for (const lead of sidRows) {
    const list = bySid.get(lead.twilio_call_sid) || [];
    list.push(lead);
    bySid.set(lead.twilio_call_sid, list);
  }

  const result = new Map();
  for (const call of calls) {
    const linkage = linkageByCall.get(call.id);
    let lead = null;
    if (linkage.kind === 'stamped') lead = stampedById.get(String(linkage.leadId));
    if (linkage.kind === 'sid') {
      const candidates = bySid.get(linkage.sid) || [];
      if (candidates.length === 1) [lead] = candidates;
    }
    if (!leadMatchesOwner(lead, linkage)) lead = null;
    result.set(call.id, lead ? { id: lead.id, status: lead.status || null } : null);
  }
  return result;
}

async function decorateCalls(conn, calls) {
  const [firstCallByKey, leadByCall] = await Promise.all([
    loadCallerHistory(conn, calls),
    loadRelatedLeads(conn, calls),
  ]);
  return calls.map((raw) => {
    const callerKey = raw.direction === 'inbound' ? callableCallerKey(raw.from_phone) : null;
    const firstId = callerKey ? firstCallByKey.get(callerKey) : null;
    return {
      ...stripPrivateSourceColumns(raw),
      caller_history: firstId ? (String(raw.id) === firstId ? 'first' : 'returning') : null,
      source_evidence: sourceEvidence(raw),
      related_lead: leadByCall.get(raw.id) || null,
    };
  });
}

function shapeCurrentMonthRows(rows, window) {
  const groups = new Map();
  let total = 0;
  for (const row of rows) {
    const count = Number(row.count) || 0;
    const evidence = sourceEvidence(row);
    const key = [evidence.kind, evidence.label, evidence.detail].join('\u0000');
    const existing = groups.get(key);
    if (existing) existing.count += count;
    else groups.set(key, { kind: evidence.kind, label: evidence.label, detail: evidence.detail, count });
    total += count;
  }
  return {
    timezone: window.timezone,
    start: window.start,
    end_exclusive: window.end_exclusive,
    total,
    sources: [...groups.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label) || a.detail.localeCompare(b.detail)),
  };
}

async function loadCurrentMonth(conn, now = new Date()) {
  const window = currentETMonthWindow(now);
  let query = conn('call_log as cl')
    .where('cl.direction', 'inbound')
    .where('cl.created_at', '>=', window.startInstant)
    .where('cl.created_at', '<', window.endInstant)
    .modify((qb) => whereNotSandboxCall(qb, 'cl.source'));
  query = addSourceRegistryJoin(query, conn, 'cl');
  const rows = await query
    .select(
      'cl.to_phone',
      ...sourceSelectColumns(conn),
      conn.raw("(NULLIF(BTRIM(cl.google_ads_call_resource_name), '') IS NOT NULL) as _google_ads_call_confirmed"),
      conn.raw("cl.metadata->>'numberType' as _recorded_number_type"),
      conn.raw("cl.metadata->>'location' as _recorded_location"),
      conn.raw("cl.metadata->>'domain' as _recorded_domain"),
    )
    .count({ count: '*' })
    .groupBy(
      'cl.to_phone',
      'call_source.name',
      'call_source.source_type',
      'call_source.domain',
      'call_source.landing_page_url',
      'call_source.is_active',
    )
    .groupByRaw("(NULLIF(BTRIM(cl.google_ads_call_resource_name), '') IS NOT NULL), cl.metadata->>'numberType', cl.metadata->>'location', cl.metadata->>'domain'");
  return shapeCurrentMonthRows(rows, window);
}

module.exports = {
  addSourceRegistryJoin,
  applyCallListOrder,
  decorateCalls,
  loadCurrentMonth,
  sourceSelectColumns,
  _private: {
    CALLER_KEY_SQL,
    callableCallerKey,
    currentETMonthWindow,
    leadLinkage,
    leadMatchesOwner,
    relatedLeadId,
    shapeCurrentMonthRows,
    sourceEvidence,
    sourceRegistryQuery,
    sourceSortExpression,
    stripPrivateSourceColumns,
  },
};
