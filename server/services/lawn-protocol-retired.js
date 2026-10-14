// A retired lawn protocol product row (Dismiss, once a completion actual references it) keeps its
// place and its actuals' link, but is no longer part of what a window plans or tells anyone to do:
// gates.retired = true (migration 20261007158000). One definition, used by every reader that lists a
// window's products for planning or instructions. Historical and attribution readers (the completion
// ledger's protocol-row lookup, the draft editor and its sync check, delete guards, the product
// family map) deliberately keep seeing retired rows.

// Narrows a lawn_protocol_products query. `table` is the name or alias the query reads the table as.
function activeProtocolProducts(query, table = 'lawn_protocol_products') {
  return query.whereRaw(`COALESCE(${table}.gates->>'retired', '') <> 'true'`);
}

function isRetiredProtocolRow(row) {
  let gates = row?.gates;
  if (typeof gates === 'string') {
    try { gates = JSON.parse(gates); } catch { gates = null; }
  }
  return !!gates && typeof gates === 'object' && gates.retired === true;
}

module.exports = { activeProtocolProducts, isRetiredProtocolRow };
