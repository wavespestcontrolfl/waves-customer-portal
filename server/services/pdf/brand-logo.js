/**
 * Shared logo buffer for pdfkit-generated PDFs. Reads
 * client/public/waves-logo.png once per process, caches forever.
 * Returns null if the asset is missing so callers can fall back to
 * the wordmark without crashing production.
 */

const path = require('path');
const fs = require('fs');

let cached = null;

function getLogoBuffer() {
  if (cached !== null) return cached || null;
  try {
    cached = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'client', 'public', 'waves-logo.png'));
  } catch {
    cached = false;  // sentinel — "we tried, it's missing"
  }
  return cached || null;
}

module.exports = { getLogoBuffer };
