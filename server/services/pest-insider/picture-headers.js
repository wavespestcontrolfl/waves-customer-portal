/**
 * The header Waves Pest Insider pictures need when the portal serves them.
 * The fact cards and top pictures (cards.js, heroes.js) are pictures inside
 * emails. A mail app that loads pictures straight into its own view, with no
 * image proxy, is another origin, and helmet's same-origin
 * Cross-Origin-Resource-Policy would block them there (same reason as
 * routes/public-map-image.js). server/index.js calls this from the setHeaders
 * of both static mounts that serve the folders, so the pictures need no route
 * or middleware of their own.
 */
'use strict';

const PICTURE = /[\\/]pest-insider[\\/](?:cards|heroes)[\\/][^\\/]+\.(?:png|jpg)$/;

function pictureHeaders(res, filePath) {
  if (PICTURE.test(String(filePath))) res.set('Cross-Origin-Resource-Policy', 'cross-origin');
}

module.exports = { pictureHeaders };
