/**
 * Canonical spoke fleet — site keys that per-post `target_sites` entries
 * are matched against by the Astro content collection filter.
 *
 * The `key` field MUST match the Cloudflare Pages project slug (same
 * slug each CF project uses in its deploy URLs, e.g. 'bradenton-lawn'
 * in bradenton-lawn.pages.dev). In the Astro repo, the same key is
 * exposed at build time as `PUBLIC_SITE_KEY`, and the blog content
 * collection drops any post whose `target_sites` doesn't include it.
 *
 * When a post's `target_sites` is NULL or an empty array, the filter
 * falls back to "all sites" (backward-compat with pre-filter posts).
 * When `target_sites` contains `'all'`, same behavior — it explicitly
 * opts back into the old fleet-wide publish.
 *
 * The "Hub" entry (wavespestcontrol-astro) is the canonical home —
 * www.wavespestcontrol.com/<slug>/. Choosing just the hub is the
 * recommended default for generic/evergreen posts; city-specific
 * spokes are for localized content that only makes sense on one
 * domain.
 */

const SPOKE_SITES = [
  { key: 'wavespestcontrol-astro',  label: 'Hub — wavespestcontrol.com',       group: 'Hub' },
  // Lawn
  { key: 'bradenton-lawn',          label: 'Bradenton Lawn',                   group: 'Lawn' },
  { key: 'parrish-lawn',            label: 'Parrish Lawn',                     group: 'Lawn' },
  { key: 'sarasotafllawncare',      label: 'Sarasota Lawn',                    group: 'Lawn' },
  { key: 'venicelawncare',          label: 'Venice Lawn',                      group: 'Lawn' },
  // Pest
  { key: 'bradentonflpestcontrol',  label: 'Bradenton Pest',                   group: 'Pest' },
  { key: 'palmettoflpestcontrol',   label: 'Palmetto Pest',                    group: 'Pest' },
  { key: 'parrishpestcontrol',      label: 'Parrish Pest',                     group: 'Pest' },
  { key: 'sarasotaflpestcontrol',   label: 'Sarasota Pest',                    group: 'Pest' },
  { key: 'veniceflpestcontrol',     label: 'Venice Pest',                      group: 'Pest' },
  // Exterminator variants
  { key: 'bradentonflexterminator', label: 'Bradenton Exterminator',           group: 'Exterminator' },
  { key: 'palmettoexterminator',    label: 'Palmetto Exterminator',            group: 'Exterminator' },
  { key: 'parrishexterminator',     label: 'Parrish Exterminator',             group: 'Exterminator' },
  { key: 'sarasotaflexterminator',  label: 'Sarasota Exterminator',            group: 'Exterminator' },
  { key: 'veniceexterminator',      label: 'Venice Exterminator',              group: 'Exterminator' },
];

const SPOKE_SITE_KEYS = SPOKE_SITES.map((s) => s.key);

module.exports = { SPOKE_SITES, SPOKE_SITE_KEYS };
