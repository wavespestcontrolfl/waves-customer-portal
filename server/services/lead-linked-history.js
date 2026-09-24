const { followDuplicateLink } = require('./lead-estimate-link');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fields = ['id', 'first_name', 'last_name', 'status', 'service_interest'];
const summary = lead => lead && Object.fromEntries(fields.map(key => [key, lead[key]]));

// Read the existing explicit links only. A repeat opportunity may retain its
// marker after conversion; it is linked history, not permission to merge it.
async function readLinkedLeadHistory(database, lead) {
  let data = lead.extracted_data;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { data = null; }
  }
  const marker = data?.duplicate_of_lead_id;
  const original = typeof marker === 'string' && UUID.test(marker)
    ? await database('leads').where({ id: marker }).whereNull('deleted_at').select(fields).first()
    : null;
  let canonical = null;
  if (lead.status === 'duplicate' && original) {
    try {
      const resolved = await followDuplicateLink(database, lead);
      if (resolved && resolved.id !== lead.id && resolved.status !== 'duplicate' && !resolved.deleted_at) {
        canonical = summary(resolved);
      }
    } catch (error) {
      // Legacy malformed markers must not make the original history unreadable.
      if (error.code !== '22P02') throw error;
    }
  }
  const linked = await database('leads').whereNull('deleted_at')
    .whereRaw("extracted_data->>'duplicate_of_lead_id' = ?", [lead.id])
    .whereNot('id', lead.id).select(fields).orderBy('created_at', 'desc').orderBy('id').limit(51);
  return {
    original: original && original.id !== lead.id ? summary(original) : null,
    canonical,
    unresolved: Boolean((marker && !original) || (lead.status === 'duplicate' && !canonical)),
    linked: linked.slice(0, 50),
    hasMore: linked.length > 50,
  };
}

module.exports = { readLinkedLeadHistory };
