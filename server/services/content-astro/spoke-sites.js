/**
 * Canonical spoke fleet — site keys that per-post `target_sites` entries
 * are matched against by the Astro content collection filter.
 *
 * The `key` field MUST match the key in the Astro repo's
 * `src/data/domains.json` — same production-domain string that each
 * spoke's Cloudflare Pages project sets as `SITE_DOMAIN` at build time
 * (e.g., "bradentonfllawncare.com"). The Astro build reads
 * `getCurrentDomainKey()` → checks `target_sites.includes(key)` → if
 * no match, the post is filtered out of that site's blog collection.
 *
 * When a post's `target_sites` is NULL or an empty array, the filter
 * falls back to "all sites" (backward-compat with pre-filter posts).
 *
 * The "Hub" entry (wavespestcontrol.com) is the canonical home —
 * www.wavespestcontrol.com/<slug>/. Choosing just the hub is the
 * recommended default for generic/evergreen posts; city-specific
 * spokes are for localized content that only makes sense on one
 * domain.
 */

const SPOKE_SITES = [
  { key: 'wavespestcontrol.com',         label: 'Hub — wavespestcontrol.com',       group: 'Hub' },
  // Lawn
  { key: 'bradentonfllawncare.com',      label: 'Bradenton Lawn Care',              group: 'Lawn' },
  { key: 'parrishfllawncare.com',        label: 'Parrish Lawn Care',                group: 'Lawn' },
  { key: 'sarasotafllawncare.com',       label: 'Sarasota Lawn Care',               group: 'Lawn' },
  { key: 'venicelawncare.com',           label: 'Venice Lawn Care',                 group: 'Lawn' },
  // Pest
  { key: 'bradentonflpestcontrol.com',   label: 'Bradenton Pest Control',           group: 'Pest' },
  { key: 'palmettoflpestcontrol.com',    label: 'Palmetto Pest Control',            group: 'Pest' },
  { key: 'parrishpestcontrol.com',       label: 'Parrish Pest Control',             group: 'Pest' },
  { key: 'sarasotaflpestcontrol.com',    label: 'Sarasota Pest Control',            group: 'Pest' },
  { key: 'veniceflpestcontrol.com',      label: 'Venice Pest Control',              group: 'Pest' },
  // Exterminator variants
  { key: 'bradentonflexterminator.com',  label: 'Bradenton Exterminator',           group: 'Exterminator' },
  { key: 'palmettoexterminator.com',     label: 'Palmetto Exterminator',            group: 'Exterminator' },
  { key: 'parrishexterminator.com',      label: 'Parrish Exterminator',             group: 'Exterminator' },
  { key: 'sarasotaflexterminator.com',   label: 'Sarasota Exterminator',            group: 'Exterminator' },
  { key: 'veniceexterminator.com',       label: 'Venice Exterminator',              group: 'Exterminator' },
];

const SPOKE_SITE_KEYS = SPOKE_SITES.map((s) => s.key);

module.exports = { SPOKE_SITES, SPOKE_SITE_KEYS };
