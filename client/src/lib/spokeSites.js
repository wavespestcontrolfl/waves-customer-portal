// Client mirror of server/services/content-astro/spoke-sites.js.
// Keys match the Astro repo's src/data/domains.json — the same
// production-domain string each spoke's Cloudflare Pages project sets
// as SITE_DOMAIN at build time. Keep this list in sync across all
// three files when a spoke is added/removed.

export const SPOKE_SITES = [
  { key: 'wavespestcontrol.com',         label: 'Hub — wavespestcontrol.com',       group: 'Hub' },
  { key: 'bradentonfllawncare.com',      label: 'Bradenton Lawn Care',              group: 'Lawn' },
  { key: 'parrishfllawncare.com',        label: 'Parrish Lawn Care',                group: 'Lawn' },
  { key: 'sarasotafllawncare.com',       label: 'Sarasota Lawn Care',               group: 'Lawn' },
  { key: 'venicelawncare.com',           label: 'Venice Lawn Care',                 group: 'Lawn' },
  { key: 'bradentonflpestcontrol.com',   label: 'Bradenton Pest Control',           group: 'Pest' },
  { key: 'palmettoflpestcontrol.com',    label: 'Palmetto Pest Control',            group: 'Pest' },
  { key: 'parrishpestcontrol.com',       label: 'Parrish Pest Control',             group: 'Pest' },
  { key: 'sarasotaflpestcontrol.com',    label: 'Sarasota Pest Control',            group: 'Pest' },
  { key: 'veniceflpestcontrol.com',      label: 'Venice Pest Control',              group: 'Pest' },
  { key: 'bradentonflexterminator.com',  label: 'Bradenton Exterminator',           group: 'Exterminator' },
  { key: 'palmettoexterminator.com',     label: 'Palmetto Exterminator',            group: 'Exterminator' },
  { key: 'parrishexterminator.com',      label: 'Parrish Exterminator',             group: 'Exterminator' },
  { key: 'sarasotaflexterminator.com',   label: 'Sarasota Exterminator',            group: 'Exterminator' },
  { key: 'veniceexterminator.com',       label: 'Venice Exterminator',              group: 'Exterminator' },
];
