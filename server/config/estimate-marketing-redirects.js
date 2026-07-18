const WEBSITE_ORIGIN = 'https://www.wavespestcontrol.com';

// Permanent homes for the public marketing quote pages that used to render
// inside the customer portal. Unknown /estimate/<segment> values are NEVER
// redirected: they remain private customer estimate tokens.
const ESTIMATE_MARKETING_REDIRECTS = Object.freeze({
  '/estimate': `${WEBSITE_ORIGIN}/quote/`,
  '/quote': `${WEBSITE_ORIGIN}/quote/`,
  '/estimate/mosquito': `${WEBSITE_ORIGIN}/estimate/mosquito-control/`,
  '/estimate/termite': `${WEBSITE_ORIGIN}/estimate/termite-treatment/`,
  '/estimate/lawn': `${WEBSITE_ORIGIN}/estimate/lawn-care/`,
  '/estimate/flea': `${WEBSITE_ORIGIN}/estimate/flea-treatment/`,
  '/estimate/cockroach': `${WEBSITE_ORIGIN}/estimate/cockroach-control/`,
  '/estimate/bed-bug': `${WEBSITE_ORIGIN}/estimate/bed-bug-treatment/`,
  '/estimate/dethatching': `${WEBSITE_ORIGIN}/estimate/lawn-dethatching/`,
  '/estimate/dehatching': `${WEBSITE_ORIGIN}/estimate/lawn-dethatching/`,
  '/estimate/top-dressing': `${WEBSITE_ORIGIN}/estimate/lawn-top-dressing/`,
  // The website's lawn-care estimator explicitly includes overseeding where
  // appropriate; there is no standalone overseeding estimator in its sitemap.
  '/estimate/overseeding': `${WEBSITE_ORIGIN}/estimate/lawn-care/`,
});

const SERVICE_ESTIMATE_SLUGS = new Set(
  Object.keys(ESTIMATE_MARKETING_REDIRECTS)
    .filter((path) => path.startsWith('/estimate/'))
    .map((path) => path.slice('/estimate/'.length)),
);

function normalizeMarketingPath(reqPath = '') {
  const path = String(reqPath || '').split('?')[0].replace(/\/+$/, '') || '/';
  return path.toLowerCase();
}

function estimateMarketingRedirectTarget(reqPath = '') {
  return ESTIMATE_MARKETING_REDIRECTS[normalizeMarketingPath(reqPath)] || null;
}

function preserveOriginalQuery(target, originalUrl = '') {
  const queryIndex = String(originalUrl || '').indexOf('?');
  return queryIndex === -1 ? target : `${target}${String(originalUrl).slice(queryIndex)}`;
}

module.exports = {
  ESTIMATE_MARKETING_REDIRECTS,
  SERVICE_ESTIMATE_SLUGS,
  estimateMarketingRedirectTarget,
  preserveOriginalQuery,
};
