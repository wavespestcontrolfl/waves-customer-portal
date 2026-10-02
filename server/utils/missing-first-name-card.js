'use strict';

// The missing_first_name card (GATE_CALL_FIRST_NAME_ADVISORY) is ONE open card per call
// whose payload lists EVERY customer the call left owing a first name:
// payload.customer_ids = [uuid, ...]. Cards filed before the list shape carry the
// scalar payload.customer_id, read here as a one-element list.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parsePayload(payload) {
  if (payload && typeof payload === 'object') return payload;
  try { return JSON.parse(payload) || {}; } catch { return {}; }
}

// The customers this card is owed on, de-duplicated, in filing order.
function owedCustomerIds(payload) {
  const p = parsePayload(payload);
  const raw = Array.isArray(p.customer_ids) ? p.customer_ids : (p.customer_id ? [p.customer_id] : []);
  return [...new Set(raw.map((id) => String(id || '').trim()).filter((id) => UUID_RE.test(id)))];
}

// True only when the card lists at least one customer and EVERY listed customer is
// live (not soft-deleted) with a nonblank first name. A listed id whose row is gone
// is not fulfilled. The same rule the auto-resolve sweep applies in SQL.
async function everyOwedCustomerNamed(conn, payload) {
  const ids = owedCustomerIds(payload);
  if (!ids.length) return false;
  const rows = await conn('customers').whereIn('id', ids).whereNull('deleted_at').select('id', 'first_name');
  const named = new Set(rows.filter((r) => String(r.first_name || '').trim() !== '').map((r) => String(r.id)));
  return ids.every((id) => named.has(id));
}

module.exports = { UUID_RE, owedCustomerIds, everyOwedCustomerNamed };
