'use strict';

// The saved property a portal service request was filed under: POST /requests
// stores it in `metadata.property`, and two otherwise identical tickets may
// name two different homes. Shared by the admin request list and the
// Communications Portal tab so staff can tell those tickets apart. Never
// returns the raw metadata.
function requestProperty(metadata) {
  let meta = metadata;
  if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch { return null; } }
  const p = meta && typeof meta === 'object' ? meta.property : null;
  if (!p || typeof p !== 'object') return null;
  return {
    id: p.id != null ? String(p.id) : null,
    isPrimary: p.isPrimary === true,
    label: p.label || null,
    address: p.address || null,
  };
}

module.exports = { requestProperty };
