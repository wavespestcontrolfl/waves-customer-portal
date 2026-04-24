// Client mirror of server/services/content-astro/spoke-sites.js.
// Keep in sync — when a spoke is added/removed, update both files AND the
// Astro repo's site list so the blog content collection filter can honor it.

export const SPOKE_SITES = [
  { key: 'wavespestcontrol-astro',  label: 'Hub — wavespestcontrol.com',       group: 'Hub' },
  { key: 'bradenton-lawn',          label: 'Bradenton Lawn',                   group: 'Lawn' },
  { key: 'parrish-lawn',            label: 'Parrish Lawn',                     group: 'Lawn' },
  { key: 'sarasotafllawncare',      label: 'Sarasota Lawn',                    group: 'Lawn' },
  { key: 'venicelawncare',          label: 'Venice Lawn',                      group: 'Lawn' },
  { key: 'bradentonflpestcontrol',  label: 'Bradenton Pest',                   group: 'Pest' },
  { key: 'palmettoflpestcontrol',   label: 'Palmetto Pest',                    group: 'Pest' },
  { key: 'parrishpestcontrol',      label: 'Parrish Pest',                     group: 'Pest' },
  { key: 'sarasotaflpestcontrol',   label: 'Sarasota Pest',                    group: 'Pest' },
  { key: 'veniceflpestcontrol',     label: 'Venice Pest',                      group: 'Pest' },
  { key: 'bradentonflexterminator', label: 'Bradenton Exterminator',           group: 'Exterminator' },
  { key: 'palmettoexterminator',    label: 'Palmetto Exterminator',            group: 'Exterminator' },
  { key: 'parrishexterminator',     label: 'Parrish Exterminator',             group: 'Exterminator' },
  { key: 'sarasotaflexterminator',  label: 'Sarasota Exterminator',            group: 'Exterminator' },
  { key: 'veniceexterminator',      label: 'Venice Exterminator',              group: 'Exterminator' },
];
