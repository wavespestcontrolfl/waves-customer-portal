/**
 * SQL for the ROUTE an opportunity_queue row writes. Dependency-free so the
 * queue (claim fence) and the miner (mine-time fences, sweeps) share one
 * definition. `alias` is an internal table alias literal, never user input;
 * omit it for unqualified columns. No literal '?' anywhere — knex counts it
 * as a bind placeholder (chr(63) stands in).
 */
const HUB_DOMAIN = 'wavespestcontrol.com';

function col(alias, name) {
  return alias ? `${alias}.${name}` : name;
}

// Twin of the miner's routeIdentity(): registrable host (www / port
// stripped) + '::' + query/hash-free path with trailing slashes trimmed.
function routeIdentitySql(alias) {
  const p = col(alias, 'page_url');
  return `(regexp_replace(regexp_replace(split_part(split_part(lower(${p}), '//', 2), '/', 1), '^www[.]', ''), ':.*$', '')`
    + ` || '::' || regexp_replace(regexp_replace(split_part(split_part(${p}, '#', 1), chr(63), 1), '^[a-z]+://[^/]+', ''), '/+$', ''))`;
}

// The slug a queued ARTICLE row is bound to publish at, for every
// pinned-article producer: operator intercept and category seeds
// (intercept_brief / category_brief).
function pinnedArticlePathSql(alias) {
  const m = col(alias, 'signal_metadata');
  return `COALESCE(${m}->'intercept_brief'->>'slug', ${m}->'category_brief'->>'slug')`;
}

// The route a row writes: its page (edits) or its pinned slug on the hub
// (articles). NULL when the row writes no known route.
function writeRouteSql(alias) {
  return `COALESCE(${routeIdentitySql(alias)}, '${HUB_DOMAIN}::' || regexp_replace(${pinnedArticlePathSql(alias)}, '/+$', ''))`;
}

module.exports = { routeIdentitySql, pinnedArticlePathSql, writeRouteSql };
