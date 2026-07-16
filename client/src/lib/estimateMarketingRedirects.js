const WEBSITE_ORIGIN = 'https://www.wavespestcontrol.com';

// Client fallback for SPA navigations. Production document requests are
// redirected by the server before the portal bundle loads.
export const ESTIMATE_MARKETING_REDIRECTS = Object.freeze({
  mosquito: `${WEBSITE_ORIGIN}/estimate/mosquito-control/`,
  termite: `${WEBSITE_ORIGIN}/estimate/termite-treatment/`,
  lawn: `${WEBSITE_ORIGIN}/estimate/lawn-care/`,
  flea: `${WEBSITE_ORIGIN}/estimate/flea-treatment/`,
  cockroach: `${WEBSITE_ORIGIN}/estimate/cockroach-control/`,
  'bed-bug': `${WEBSITE_ORIGIN}/estimate/bed-bug-treatment/`,
  dethatching: `${WEBSITE_ORIGIN}/estimate/lawn-dethatching/`,
  dehatching: `${WEBSITE_ORIGIN}/estimate/lawn-dethatching/`,
  'top-dressing': `${WEBSITE_ORIGIN}/estimate/lawn-top-dressing/`,
  overseeding: `${WEBSITE_ORIGIN}/estimate/lawn-care/`,
});

export const ESTIMATE_QUOTE_URL = `${WEBSITE_ORIGIN}/quote/`;
export const SERVICE_ESTIMATE_SLUGS = new Set(Object.keys(ESTIMATE_MARKETING_REDIRECTS));
