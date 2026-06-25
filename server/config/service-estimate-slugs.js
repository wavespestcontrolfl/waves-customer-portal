// Public marketing service-quote slugs. /estimate/<slug> for one of these is a
// PUBLIC QuotePage (indexable marketing), NOT a tokenized customer estimate.
// Centralized so the /estimate/:token gateway (server/index.js) and the SPA
// privacy-header util (utils/sensitive-spa-headers.js) agree on which
// /estimate/* URLs are public marketing vs. customer quotes — the latter must
// be noindex'd, the former must not. Mirror the client copy in
// client/src/App.jsx if this list changes.
module.exports = new Set([
  'mosquito',
  'termite',
  'lawn',
  'flea',
  'cockroach',
  'bed-bug',
  'dethatching',
  'dehatching',
  'top-dressing',
  'overseeding',
]);
