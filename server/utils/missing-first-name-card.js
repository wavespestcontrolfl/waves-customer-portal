'use strict';

// The missing_first_name card (GATE_CALL_FIRST_NAME_ADVISORY) is ONE open card per call
// whose payload lists EVERY customer the call left owing a first name:
// payload.customer_ids = [uuid, ...]. Cards filed before the list shape carry the
// scalar payload.customer_id, read here as a one-element list.
//
// The same merge-chain resolution (liveSurvivorSql) also serves the household_address_match
// card (GATE_CALL_HOUSEHOLD_HOLD): its one suggested customer is opened — and the auto-resolve
// rule recognises the call as linked to it — through a merge to the live survivor.

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

// SQL scalar: is the listed customer `idExpr` (text) fulfilled — live with a nonblank first
// name? A customer merged away (soft-deleted, with an active merge-journal row; an undone
// merge does not count) is judged on the record it was merged INTO, following a chain of
// merges, so a merge never strands the card (codex #5559 r17). A listed id whose row is
// gone with no active merge is not fulfilled. Shared by Resolve and the auto-resolve sweep.
function owedCustomerNamedSql(idExpr) {
  return `(
    with recursive hop(cid, depth) as (
      select ${idExpr}, 0
      union all
      select j.winner_customer_id::text, hop.depth + 1
      from hop
      join customers dead on dead.id::text = hop.cid and dead.deleted_at is not null
      join lateral (
        select m.winner_customer_id from customer_merge_journal m
        where m.loser_customer_id::text = hop.cid and m.undone_at is null
        order by m.created_at desc limit 1
      ) j on true
      where hop.depth < 8
    )
    select coalesce(bool_or(c.deleted_at is null and btrim(coalesce(c.first_name, '')) <> ''), false)
    from hop join customers c on c.id::text = hop.cid
  )`;
}

// SQL scalar: the live record the office should OPEN for the customer `idExpr` (text) — the id
// itself while it is live, else the live survivor its ACTIVE merge chain ends at (an undone
// merge is not followed); NULL when the id has neither. The same hops as owedCustomerNamedSql.
// Shared by the first-name card's links and the household-hold card's link / auto-resolve rule.
function liveSurvivorSql(idExpr) {
  return `(
    with recursive hop(cid, depth) as (
      select ${idExpr}, 0
      union all
      select j.winner_customer_id::text, hop.depth + 1
      from hop
      join customers dead on dead.id::text = hop.cid and dead.deleted_at is not null
      join lateral (
        select m.winner_customer_id from customer_merge_journal m
        where m.loser_customer_id::text = hop.cid and m.undone_at is null
        order by m.created_at desc limit 1
      ) j on true
      where hop.depth < 8
    )
    select hop.cid from hop join customers c on c.id::text = hop.cid and c.deleted_at is null
    order by hop.depth desc limit 1
  )`;
}

// The record the office should OPEN for each listed customer: the id itself while it is
// live, else the live survivor its active merge chain (liveSurvivorSql) ends at; a listed
// id with neither is returned unchanged.
// Returns [{ id, open_id }] in listing order (codex #5559 r18).
async function owedCustomerOpenTargets(conn, payload) {
  const ids = owedCustomerIds(payload);
  if (!ids.length) return [];
  const result = await conn.raw(`
    select ids.id, ${liveSurvivorSql('ids.id')} as open_id
    from unnest(?::text[]) with ordinality as ids(id, ord) order by ids.ord`, [ids]);
  const byId = new Map((result?.rows || []).map((r) => [String(r.id), r.open_id ? String(r.open_id) : null]));
  return ids.map((id) => ({ id, open_id: byId.get(id) || id }));
}

// The household-hold card's suggested customer (payload.suggested_customer_id), UUID-guarded,
// or null. The ONE customer the card points at.
function suggestedCustomerId(payload) {
  const id = String(parsePayload(payload).suggested_customer_id || '').trim();
  return UUID_RE.test(id) ? id : null;
}

// { id, open_id } for the household-hold card's suggested customer (open_id follows an active
// merge chain to the live survivor; the id itself when it has none), or null with no valid id.
async function suggestedCustomerOpenTarget(conn, payload) {
  const id = suggestedCustomerId(payload);
  if (!id) return null;
  const result = await conn.raw(`select ${liveSurvivorSql('?::text')} as open_id`, [id]);
  const open = result?.rows?.[0]?.open_id;
  return { id, open_id: open ? String(open) : id };
}

// True only when the card lists at least one customer and EVERY listed customer is
// fulfilled per owedCustomerNamedSql. The same rule the auto-resolve sweep applies.
async function everyOwedCustomerNamed(conn, payload) {
  const ids = owedCustomerIds(payload);
  if (!ids.length) return false;
  const result = await conn.raw(
    `select ${owedCustomerNamedSql('ids.id')} as named from unnest(?::text[]) as ids(id)`, [ids],
  );
  const rows = result?.rows || [];
  return rows.length === ids.length && rows.every((r) => r.named === true);
}

module.exports = {
  UUID_RE, owedCustomerIds, owedCustomerNamedSql, everyOwedCustomerNamed, owedCustomerOpenTargets,
  liveSurvivorSql, suggestedCustomerId, suggestedCustomerOpenTarget,
};
