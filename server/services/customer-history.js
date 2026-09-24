const { phoneIdentityKey } = require('../utils/phone');
const {
  draftIdSql,
  draftReplyToMessageIdSql,
  loadPriorOutboundBodies,
} = require('./sms-response-policy');
const { signMediaForClient } = require('./sms-media');

const TIMELINE_TYPES = new Set([
  'all', 'interaction', 'sms', 'call', 'service', 'invoice', 'estimate',
  'payment', 'scheduled_service', 'review', 'activity',
]);
const COMM_CHANNELS = new Set(['all', 'sms', 'voice']);
const DEFAULT_COMMS_LIMIT = 100;
const DEFAULT_TIMELINE_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_SEARCH_LENGTH = 200;
const MAX_CURSOR_LENGTH = 16_384;

class HistoryValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HistoryValidationError';
    this.status = 400;
  }
}

function oneQueryValue(value, name) {
  if (Array.isArray(value) || (value != null && typeof value !== 'string')) {
    throw new HistoryValidationError(`${name} must be a single value`);
  }
  return value;
}

function parseLimit(value, fallback) {
  value = oneQueryValue(value, 'limit');
  if (value == null || value === '') return fallback;
  if (!/^\d+$/.test(value)) throw new HistoryValidationError(`limit must be an integer from 1 to ${MAX_LIMIT}`);
  const limit = Number(value);
  if (limit < 1 || limit > MAX_LIMIT) throw new HistoryValidationError(`limit must be an integer from 1 to ${MAX_LIMIT}`);
  return limit;
}

function parseChoice(value, fallback, choices, name) {
  value = oneQueryValue(value, name);
  const parsed = value == null || value === '' ? fallback : value;
  if (!choices.has(parsed)) throw new HistoryValidationError(`Invalid ${name}`);
  return parsed;
}

function parseSearch(value) {
  value = oneQueryValue(value, 'search');
  const search = String(value || '').trim().replace(/\s+/g, ' ');
  if (search.length > MAX_SEARCH_LENGTH) {
    throw new HistoryValidationError(`search must be at most ${MAX_SEARCH_LENGTH} characters`);
  }
  return search;
}

function encodeCursor(payload) {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function decodeCursor(value) {
  value = oneQueryValue(value, 'cursor');
  if (value == null || value === '') return null;
  if (value.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new HistoryValidationError('Invalid cursor');
  }
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    if (Buffer.from(decoded).toString('base64url') !== value) throw new Error('non-canonical cursor');
    const cursor = JSON.parse(decoded);
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) throw new Error('invalid payload');
    return cursor;
  } catch {
    throw new HistoryValidationError('Invalid cursor');
  }
}

function validDate(value) {
  return typeof value === 'string' && value.length <= 40 && !Number.isNaN(Date.parse(value));
}

function validateBaseCursor(cursor, { kind, customerId, filter }) {
  if (!cursor) return;
  if (cursor.v !== 1 || cursor.kind !== kind || cursor.customerId !== customerId
    || cursor.filter !== filter || !validDate(cursor.readBefore)) {
    throw new HistoryValidationError('Cursor does not match this request');
  }
}

function parseCommsRequest(query, customerId) {
  const limit = parseLimit(query.limit, DEFAULT_COMMS_LIMIT);
  const channel = parseChoice(query.channel, 'all', COMM_CHANNELS, 'channel');
  const cursor = decodeCursor(query.cursor);
  validateBaseCursor(cursor, { kind: 'comms', customerId, filter: channel });
  if (cursor && (!cursor.last || !validDate(cursor.last.at)
    || typeof cursor.last.id !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(cursor.last.id))) {
    throw new HistoryValidationError('Invalid cursor');
  }
  return { limit, channel, cursor };
}

function parseTimelineRequest(query, customerId, sourceKeys, optionalSourceKeys = new Set()) {
  const limit = parseLimit(query.limit, DEFAULT_TIMELINE_LIMIT);
  const type = parseChoice(query.type, 'all', TIMELINE_TYPES, 'type');
  const search = parseSearch(query.search);
  const filter = JSON.stringify({ type, search });
  const cursor = decodeCursor(query.cursor);
  validateBaseCursor(cursor, { kind: 'timeline', customerId, filter });
  if (cursor) {
    if (!cursor.positions || typeof cursor.positions !== 'object' || Array.isArray(cursor.positions)) {
      throw new HistoryValidationError('Invalid cursor');
    }
    if (!Array.isArray(cursor.missing)
      || cursor.missing.some(source => !optionalSourceKeys.has(source))
      || new Set(cursor.missing).size !== cursor.missing.length) {
      throw new HistoryValidationError('Invalid cursor');
    }
    for (const [source, position] of Object.entries(cursor.positions)) {
      if (!sourceKeys.has(source) || !position || typeof position !== 'object'
        || (position.at != null && !validDate(position.at))
        || typeof position.key !== 'string' || position.key.length > 200) {
        throw new HistoryValidationError('Invalid cursor');
      }
    }
  }
  return { limit, type, search, filter, cursor };
}

function applySearch(query, expression, terms) {
  for (const term of terms) {
    query.whereRaw(`position(lower(?) in lower(${expression})) > 0`, [term]);
  }
}

function applyKeyset(query, eventAt, eventKey, position) {
  if (!position) return;
  if (position.at == null) {
    query.whereRaw(`(${eventAt}) IS NULL AND (${eventKey}) COLLATE "C" < ? COLLATE "C"`, [position.key]);
    return;
  }
  query.whereRaw(
    `((${eventAt}) < ? OR (${eventAt}) IS NULL OR ((${eventAt}) = ? AND (${eventKey}) COLLATE "C" < ? COLLATE "C"))`,
    [position.at, position.at, position.key],
  );
}

function money(value) {
  return Number(value || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function eventSource(config) {
  return {
    ...config,
    async load({ db, customerId, readBefore, searchTerms, position, limit }) {
      const query = config.query(db, customerId, readBefore)
        .select(config.columns)
        .select(db.raw(`${config.eventAt} AS event_at`))
        // node-postgres rounds timestamps to JavaScript milliseconds. Keep an
        // exact SQL cursor value and a microsecond merge key.
        .select(db.raw(`CASE WHEN (${config.eventAt}) IS NULL THEN NULL ELSE (${config.eventAt})::text END AS event_cursor_at`))
        .select(db.raw(`CASE WHEN (${config.eventAt}) IS NULL THEN NULL ELSE floor(extract(epoch FROM (${config.eventAt})) * 1000000)::text END AS event_sort_us`))
        .select(db.raw(`${config.eventKey} AS event_key`));
      applySearch(query, config.search, searchTerms);
      applyKeyset(query, config.eventAt, config.eventKey, position);
      return query.orderByRaw(`(${config.eventAt}) DESC NULLS LAST, (${config.eventKey}) COLLATE "C" DESC`).limit(limit + 1);
    },
  };
}

function simpleQuery(table, alias, snapshotColumn = `${alias}.created_at`) {
  return (db, customerId, readBefore) => db(`${table} as ${alias}`)
    .where(`${alias}.customer_id`, customerId)
    .where((scope) => scope.where(`${snapshotColumn}`, '<=', readBefore).orWhereNull(snapshotColumn));
}

function lifecycleSource({ key, table, alias, type, lifecycle, title, description, columns }) {
  const eventAt = `${alias}.${lifecycle}_at`;
  const eventKey = `'${key}:' || ${alias}.id::text`;
  return eventSource({
    key, type, eventAt, eventKey,
    columns,
    query: (db, customerId, readBefore) => db(`${table} as ${alias}`)
      .where(`${alias}.customer_id`, customerId)
      .whereNotNull(eventAt)
      .where(eventAt, '<=', readBefore),
    search: `concat_ws(' ', ${title}, ${description})`,
    map: (row) => ({
      id: row.event_key, type, title: row.title, description: row.description || '',
      date: row.event_at, metadata: row.metadata,
    }),
  });
}

function buildTimelineSources(db) {
  const sources = [
    eventSource({
      key: 'interaction', type: 'interaction', eventAt: 'i.created_at', eventKey: "'interaction:' || i.id::text",
      columns: ['i.interaction_type', 'i.subject', 'i.body'],
      query: simpleQuery('customer_interactions', 'i'),
      search: "concat_ws(' ', coalesce(nullif(i.subject, ''), i.interaction_type || ' interaction'), i.body)",
      map: row => ({ id: row.event_key, type: 'interaction', title: row.subject || `${row.interaction_type} interaction`, description: row.body || '', date: row.event_at, metadata: { interactionType: row.interaction_type } }),
    }),
    eventSource({
      key: 'sms', type: 'sms', eventAt: 'm.created_at', eventKey: "'sms:' || m.id::text",
      columns: ['m.direction', 'm.body', 'm.delivery_status'],
      query: (knex, customerId, readBefore) => knex('messages as m')
        .join('conversations as conv', 'm.conversation_id', 'conv.id')
        .where('conv.customer_id', customerId).where('m.channel', 'sms').where('m.created_at', '<=', readBefore),
      search: "concat_ws(' ', CASE WHEN m.direction = 'inbound' THEN 'SMS received' ELSE 'SMS outbound · ' || coalesce(nullif(m.delivery_status, ''), 'delivery not recorded') END, m.body)",
      map: row => ({ id: row.event_key, type: 'sms', title: row.direction === 'inbound' ? 'SMS received' : `SMS outbound · ${row.delivery_status || 'delivery not recorded'}`, description: row.body || '', date: row.event_at, metadata: { direction: row.direction } }),
    }),
    eventSource({
      key: 'voice', type: 'call', eventAt: 'm.created_at', eventKey: "'voice:' || m.id::text",
      columns: ['m.ai_summary', 'm.body', 'm.duration_seconds', 'c.id as call_id', 'c.call_summary', 'c.disposition'],
      query: (knex, customerId, readBefore) => knex('messages as m')
        .join('conversations as conv', 'm.conversation_id', 'conv.id')
        .joinRaw(`LEFT JOIN LATERAL (
          SELECT cl.id, cl.call_summary, cl.disposition
          FROM call_log cl
          WHERE cl.customer_id = ? AND cl.twilio_call_sid = m.twilio_sid AND cl.created_at <= ?
          ORDER BY cl.created_at DESC, cl.id DESC LIMIT 1
        ) c ON TRUE`, [customerId, readBefore])
        .where('conv.customer_id', customerId).where('m.channel', 'voice').where('m.created_at', '<=', readBefore),
      search: "concat_ws(' ', 'Phone call', coalesce(nullif(m.ai_summary, ''), nullif(c.call_summary, ''), m.body), c.disposition)",
      map: row => ({ id: row.event_key, type: 'call', title: 'Phone call', description: [row.ai_summary || row.call_summary || row.body, row.disposition].filter(Boolean).join(' · '), date: row.event_at, metadata: { durationSeconds: row.duration_seconds, callId: row.call_id || null } }),
    }),
    eventSource({
      key: 'legacy_call', type: 'call', eventAt: 'c.created_at', eventKey: "'legacy_call:' || c.id::text",
      columns: ['c.id as call_id', 'c.call_summary', 'c.disposition', 'c.status'],
      query: (knex, customerId, readBefore) => knex('call_log as c')
        .where('c.customer_id', customerId).where('c.created_at', '<=', readBefore)
        .where((calls) => calls.whereNull('c.twilio_call_sid').orWhereNotExists(function excludeMirroredVoice() {
          this.select(knex.raw('1')).from('messages as vm')
            .join('conversations as vc', 'vm.conversation_id', 'vc.id')
            .where('vc.customer_id', customerId).where('vm.channel', 'voice')
            .where('vm.created_at', '<=', readBefore).whereRaw('vm.twilio_sid = c.twilio_call_sid');
        })),
      search: "concat_ws(' ', 'Phone call', c.call_summary, coalesce(nullif(c.disposition, ''), c.status))",
      map: row => ({ id: row.event_key, type: 'call', title: 'Phone call', description: [row.call_summary, row.disposition || row.status].filter(Boolean).join(' · '), date: row.event_at, metadata: { callId: row.call_id } }),
    }),
    eventSource({
      key: 'service', type: 'service', eventAt: 's.service_date', eventKey: "'service:' || s.id::text",
      columns: ['s.service_type', 't.name as tech_name'],
      query: (knex, customerId, readBefore) => simpleQuery('service_records', 's')(knex, customerId, readBefore)
        .leftJoin('technicians as t', 's.technician_id', 't.id'),
      search: "concat_ws(' ', 'Service:', s.service_type, CASE WHEN t.name IS NULL THEN 'Service recorded' ELSE 'Performed by ' || t.name END)",
      map: row => ({ id: row.event_key, type: 'service', title: `Service: ${row.service_type}`, description: row.tech_name ? `Performed by ${row.tech_name}` : 'Service recorded', date: row.event_at, metadata: { serviceType: row.service_type, techName: row.tech_name } }),
    }),
  ];

  for (const lifecycle of ['created', 'sent', 'viewed', 'paid']) {
    const key = `invoice_${lifecycle}`;
    const title = `concat('Invoice ', inv.invoice_number, ' ${lifecycle}')`;
    const description = "concat_ws(' · ', inv.service_type, 'Current status: ' || inv.status)";
    sources.push(lifecycleSource({
      key, table: 'invoices', alias: 'inv', type: 'invoice', lifecycle, title, description,
      columns: [
        'inv.id', 'inv.invoice_number', 'inv.status', 'inv.service_type',
        db.raw("concat('Invoice ', inv.invoice_number, ' ', ?::text) AS title", [lifecycle]),
        db.raw("concat_ws(' · ', inv.service_type, 'Current status: ' || inv.status) AS description"),
        db.raw("jsonb_build_object('invoiceId', inv.id) AS metadata"),
      ],
    }));
  }

  for (const lifecycle of ['created', 'sent', 'viewed', 'accepted', 'declined']) {
    const key = `estimate_${lifecycle}`;
    const title = `'Estimate ${lifecycle}'`;
    const description = "'Current status: ' || est.status";
    sources.push(lifecycleSource({ key, table: 'estimates', alias: 'est', type: 'estimate', lifecycle, title, description,
      columns: ['est.id', 'est.status', db.raw('? AS title', [`Estimate ${lifecycle}`]), db.raw("'Current status: ' || est.status AS description"), db.raw("jsonb_build_object('estimateId', est.id) AS metadata")] }));
  }

  sources.push(
    eventSource({
      key: 'payment', type: 'payment', eventAt: 'p.payment_date', eventKey: "'payment:' || p.id::text",
      columns: ['p.id as payment_id', 'p.amount', 'p.description', 'p.status'], query: simpleQuery('payments', 'p'),
      search: "concat_ws(' ', 'Payment · ' || coalesce(nullif(p.status, ''), 'status not recorded') || ':', to_char(p.amount, 'FM$999,999,990.00'), p.amount::text, p.description)",
      map: row => ({ id: row.event_key, type: 'payment', title: `Payment · ${row.status || 'status not recorded'}: ${money(row.amount)}`, description: row.description || '', date: row.event_at, metadata: { paymentId: row.payment_id, amount: Number(row.amount || 0), status: row.status } }),
    }),
    eventSource({
      key: 'scheduled', type: 'scheduled_service', eventAt: 'ss.scheduled_date', eventKey: "'scheduled:' || ss.id::text",
      columns: ['ss.id as scheduled_service_id', 'ss.service_type', 'ss.status'], query: simpleQuery('scheduled_services', 'ss'),
      search: "concat_ws(' ', 'Scheduled:', ss.service_type, 'Current status:', ss.status)",
      map: row => ({ id: row.event_key, type: 'scheduled_service', title: `Scheduled: ${row.service_type}`, description: `Current status: ${row.status}`, date: row.event_at, metadata: { scheduledServiceId: row.scheduled_service_id, serviceType: row.service_type, status: row.status } }),
    }),
    eventSource({
      key: 'review', type: 'review', optionalLabel: 'Reviews', eventAt: 'r.review_created_at', eventKey: "'review:' || r.id::text",
      columns: ['r.star_rating', 'r.review_text'], query: simpleQuery('google_reviews', 'r'),
      search: "concat_ws(' ', 'Google review:', r.star_rating::text || '/5', r.review_text)",
      map: row => ({ id: row.event_key, type: 'review', title: `Google review: ${row.star_rating}/5`, description: row.review_text || '', date: row.event_at, metadata: { starRating: row.star_rating } }),
    }),
    eventSource({
      key: 'activity', type: 'activity', optionalLabel: 'Account activity', eventAt: 'a.created_at', eventKey: "'activity:' || a.id::text",
      columns: ['a.action', 'a.description'], query: simpleQuery('activity_log', 'a'),
      search: "concat_ws(' ', a.action, a.description)",
      map: row => ({ id: row.event_key, type: 'activity', title: row.action, description: row.description || '', date: row.event_at, metadata: { action: row.action } }),
    }),
  );
  return sources;
}

function compareEvents(a, b) {
  if (a.event_sort_us == null && b.event_sort_us != null) return 1;
  if (a.event_sort_us != null && b.event_sort_us == null) return -1;
  if (a.event_sort_us != null && b.event_sort_us != null) {
    const left = BigInt(a.event_sort_us);
    const right = BigInt(b.event_sort_us);
    if (left !== right) return left > right ? -1 : 1;
  }
  const leftKey = String(a.event_key);
  const rightKey = String(b.event_key);
  return leftKey === rightKey ? 0 : (leftKey > rightKey ? -1 : 1);
}

async function listCustomerTimeline(db, customerId, query = {}) {
  const sources = buildTimelineSources(db);
  const sourceKeys = new Set(sources.map(source => source.key));
  const optionalSourceKeys = new Set(sources.filter(source => source.optionalLabel).map(source => source.key));
  const parsed = parseTimelineRequest(query, customerId, sourceKeys, optionalSourceKeys);
  const readBefore = parsed.cursor?.readBefore || new Date().toISOString();
  const positions = parsed.cursor?.positions || {};
  const searchTerms = parsed.search.toLocaleLowerCase('en-US').split(' ').filter(Boolean);
  const selected = sources.filter(source => parsed.type === 'all' || source.type === parsed.type);
  const cursorMissing = new Set(parsed.cursor?.missing || []);
  const sourceResults = await Promise.all(selected.map(async (source) => {
    if (cursorMissing.has(source.key)) return { rows: [], missing: source.optionalLabel, missingKey: source.key };
    try {
      const rows = await source.load({ db, customerId, readBefore, searchTerms, position: positions[source.key], limit: parsed.limit });
      return { rows: rows.map(row => ({ ...row, source })), missing: null, missingKey: null };
    } catch (error) {
      if (!source.optionalLabel) throw error;
      return { rows: [], missing: source.optionalLabel, missingKey: source.key };
    }
  }));
  const missingSources = [...new Set(sourceResults.map(result => result.missing).filter(Boolean))];
  const missingKeys = [...new Set(sourceResults.map(result => result.missingKey).filter(Boolean))];
  const candidates = sourceResults.flatMap(result => result.rows).sort(compareEvents);
  const pageRows = candidates.slice(0, parsed.limit);
  const hasMore = candidates.length > parsed.limit;
  let nextCursor = null;
  if (hasMore) {
    const nextPositions = { ...positions };
    for (const row of pageRows) nextPositions[row.source.key] = { at: row.event_cursor_at, key: row.event_key };
    nextCursor = encodeCursor({ v: 1, kind: 'timeline', customerId, filter: parsed.filter, readBefore, positions: nextPositions, missing: missingKeys });
  }
  return {
    timeline: pageRows.map(row => row.source.map(row)), missingSources,
    limit: parsed.limit, type: parsed.type, search: parsed.search, hasMore, nextCursor,
  };
}

function mapCommsMessage(message, customer, twilioNumbers) {
  const numberCfg = twilioNumbers?.findByNumber?.(message.our_endpoint_id) || null;
  let media = [];
  try { media = typeof message.media === 'string' ? JSON.parse(message.media) : (message.media || []); } catch { media = []; }
  const { courtesyOnly, spamEnforced } = require('./sms-response-policy').responseFlags({
    direction: message.direction, body: message.body, media,
    metadata: message.metadata, legacyMetadata: message.response_metadata,
    auditMetadata: message.response_audit_metadata,
    priorOutboundBody: message.response_prior_outbound_body,
  });
  const responseMessageType = message.response_message_type || message.message_type;
  const responseStatus = message.response_status || message.delivery_status;
  const responseIsAnswer = require('./sms-response-policy').outboundIsAnswer({
    direction: message.direction, messageType: responseMessageType, status: responseStatus,
    isClickFollowup: message.response_is_click_followup === true,
    replyToMessageId: message.response_reply_to_message_id,
  });
  return {
    id: message.id, conversationId: message.conversation_id, channel: message.channel,
    direction: message.direction, body: message.body, aiSummary: message.ai_summary,
    messageType: message.message_type, durationSeconds: message.duration_seconds, media,
    responseMessageType, responseStatus, responseIsAnswer,
    responseReplyToMessageId: message.response_reply_to_message_id || null,
    responseCreatedAt: message.response_created_at || message.created_at,
    answeredBy: message.answered_by, isRead: !!message.is_read,
    courtesyOnly, spamEnforced,
    deliveryStatus: message.delivery_status, recordingSid: message.recording_sid,
    createdAt: message.created_at, ourEndpointId: message.our_endpoint_id,
    ourEndpointLabel: numberCfg?.label || null,
    contactPhone: message.contact_phone || customer.phone || null,
  };
}

// mapCommsMessage stays synchronous (existing callers/tests destructure it
// as a pure mapper), so signing the stored media into viewer-usable URLs —
// same signMediaForClient the general /communications/log inbox uses — is a
// separate async pass over its output. Without this, mapped messages carry
// only the raw stored media (key/contentType, no url), which is unusable
// for rendering or for the Analyze-photos flow off Customer 360's composer.
async function signCommsMedia(mapped) {
  return Promise.all(mapped.map(async (message) => ({
    ...message, media: await signMediaForClient(message.media),
  })));
}

async function listCustomerComms(db, customer, query = {}) {
  const customerId = customer.id;
  const parsed = parseCommsRequest(query, customerId);
  const readBefore = parsed.cursor?.readBefore || new Date().toISOString();
  const responseDraftId = draftIdSql("COALESCE(sms_audit.metadata->>'draft_id', sms_response.metadata->>'draft_id', m.metadata->>'draft_id')");
  const responseReplyToMessageId = draftReplyToMessageIdSql('mdx.sms_log_id');
  const selectCommsColumns = queryBuilder => queryBuilder
    .joinRaw(`LEFT JOIN LATERAL (
      SELECT sl.message_type, sl.status, sl.metadata, sl.created_at
      FROM sms_log sl
      WHERE sl.twilio_sid = m.twilio_sid AND sl.direction = m.direction
      ORDER BY sl.created_at DESC, sl.id DESC LIMIT 1
    ) sms_response ON true`)
    .joinRaw(`LEFT JOIN LATERAL (
      SELECT mal.metadata
      FROM messaging_audit_log mal
      WHERE mal.provider_message_id = m.twilio_sid AND mal.channel = 'sms'
      ORDER BY mal.created_at DESC, mal.id DESC LIMIT 1
    ) sms_audit ON true`)
    .joinRaw(`LEFT JOIN LATERAL (
      SELECT mdx.intent = 'click_followup' AS is_click_followup,
             ${responseReplyToMessageId} AS reply_to_message_id
      FROM message_drafts mdx
      WHERE mdx.id = ${responseDraftId}
      LIMIT 1
    ) sms_answer ON true`)
    .select(
      'm.id', 'm.conversation_id', 'm.channel', 'm.direction', 'm.body',
      'm.ai_summary', 'm.message_type', 'm.duration_seconds', 'm.media', 'm.answered_by',
      'm.is_read', 'm.delivery_status', 'm.recording_sid', 'm.metadata', 'm.created_at',
      'c.customer_id', 'c.our_endpoint_id', 'c.contact_phone',
    )
    .select(
      'sms_response.message_type as response_message_type',
      'sms_response.status as response_status',
      'sms_response.metadata as response_metadata',
      'sms_response.created_at as response_created_at',
      'sms_audit.metadata as response_audit_metadata',
      'sms_answer.is_click_followup as response_is_click_followup',
      'sms_answer.reply_to_message_id as response_reply_to_message_id',
    );
  const rowsQuery = selectCommsColumns(db('messages as m')
    .leftJoin('conversations as c', 'm.conversation_id', 'c.id')
    .where('c.customer_id', customerId)
    .whereIn('m.channel', parsed.channel === 'all' ? ['sms', 'voice'] : [parsed.channel])
    .where('m.created_at', '<=', readBefore))
    .select(db.raw('m.created_at::text AS cursor_created_at'));
  if (parsed.cursor) {
    rowsQuery.whereRaw('(m.created_at < ? OR (m.created_at = ? AND m.id < ?))',
      [parsed.cursor.last.at, parsed.cursor.last.at, parsed.cursor.last.id]);
  }
  const rows = await rowsQuery.orderBy('m.created_at', 'desc').orderBy('m.id', 'desc').limit(parsed.limit + 1);
  const hasMore = rows.length > parsed.limit;
  const pageRows = rows.slice(0, parsed.limit);
  const priorOutboundBodies = await loadPriorOutboundBodies(db, pageRows, {
    customerScoped: true, fallbackCustomerPhone: customer.phone,
  });
  for (const row of pageRows) {
    if (priorOutboundBodies.has(String(row.id))) {
      row.response_prior_outbound_body = priorOutboundBodies.get(String(row.id));
    }
  }
  const last = pageRows[pageRows.length - 1];
  const nextCursor = hasMore && last ? encodeCursor({
    v: 1, kind: 'comms', customerId, filter: parsed.channel, readBefore,
    last: { at: last.cursor_created_at, id: last.id },
  }) : null;
  const conversationIds = await db('conversations').where({ customer_id: customerId }).pluck('id');
  let twilioNumbers;
  try { twilioNumbers = require('../config/twilio-numbers'); } catch { twilioNumbers = null; }
  const comms = await signCommsMedia(pageRows.map(message => mapCommsMessage(message, customer, twilioNumbers)));
  const primaryPhoneKey = phoneIdentityKey(customer.phone);
  let composerComms = [];
  if (primaryPhoneKey) {
    const composerRows = await selectCommsColumns(db('messages as m')
      .join('conversations as c', 'm.conversation_id', 'c.id')
      .joinRaw(`CROSS JOIN LATERAL (
        SELECT btrim(CASE WHEN c.contact_phone IS NULL OR c.contact_phone = '' THEN ? ELSE c.contact_phone END) AS phone_text
      ) AS composer_contact`, [customer.phone])
      .joinRaw(`CROSS JOIN LATERAL (
        SELECT regexp_replace(composer_contact.phone_text, '[^0-9]', '', 'g') AS phone_digits
      ) AS composer_phone`)
      .where('c.customer_id', customerId)
      .where('m.channel', 'sms')
      .where('m.created_at', '<=', readBefore)
      .whereNotNull('c.our_endpoint_id')
      .whereRaw("btrim(c.our_endpoint_id) <> ''")
      .whereRaw(
        `CASE
          WHEN composer_phone.phone_digits = '' THEN NULL
          WHEN composer_phone.phone_digits ~ '^1[0-9]{10}$'
            OR (left(composer_contact.phone_text, 1) <> '+' AND composer_phone.phone_digits ~ '^[0-9]{10}$')
            THEN right(composer_phone.phone_digits, 10)
          ELSE '+' || composer_phone.phone_digits
        END = ?`,
        [primaryPhoneKey],
      ))
      .orderBy('m.created_at', 'desc')
      .orderBy('m.id', 'desc')
      .limit(1);
    const composerPriorOutboundBodies = await loadPriorOutboundBodies(db, composerRows, {
      customerScoped: true, fallbackCustomerPhone: customer.phone,
    });
    for (const row of composerRows) {
      if (composerPriorOutboundBodies.has(String(row.id))) {
        row.response_prior_outbound_body = composerPriorOutboundBodies.get(String(row.id));
      }
    }
    composerComms = await signCommsMedia(composerRows.map(message => mapCommsMessage(message, customer, twilioNumbers)));
  }
  return {
    comms, composerComms, total: comms.length, limit: parsed.limit, channel: parsed.channel,
    hasMore, nextCursor, readScope: { conversationIds, readBefore },
  };
}

module.exports = {
  HistoryValidationError,
  TIMELINE_TYPES,
  listCustomerComms,
  listCustomerTimeline,
  _private: { decodeCursor, encodeCursor, parseCommsRequest, parseTimelineRequest, compareEvents, mapCommsMessage, signCommsMedia },
};
