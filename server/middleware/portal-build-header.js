// Stamps a signed-in staff answer with the client build this server serves
// and the time this server started, so an open staff tab can tell when its
// code is out of date (client/src/lib/portalVersion.js). adminAuthenticate
// calls it once a staff session checks out, so public routes and refused
// requests never carry the stamp. The start time lets the tab ignore a late
// answer from the old server while a deploy drains, so it never flips back.
// The build comes from the <meta name="portal-build"> tag that vite.config.js
// writes into index.html. Without that tag (a dev checkout with no build) the
// answer carries no stamp and no tab counts itself out of date.
const fs = require('fs');
const path = require('path');

const BUILD_TAG = /<meta\s+name="portal-build"\s+content="([a-f0-9]{8,64})"/i;
const INDEX_HTML = path.join(__dirname, '..', '..', 'client', 'dist', 'index.html');
const BOOT = String(Date.now());

let cachedBuild; // undefined until the first staff answer reads index.html

function readPortalBuild(indexPath = INDEX_HTML) {
  try {
    const match = BUILD_TAG.exec(fs.readFileSync(indexPath, 'utf8'));
    return match ? match[1].toLowerCase() : null;
  } catch {
    return null;
  }
}

// Never throws: the stamp must not change what the request gets.
function stampPortalBuild(res) {
  try {
    if (cachedBuild === undefined) cachedBuild = readPortalBuild();
    if (!cachedBuild || typeof res?.setHeader !== 'function') return;
    res.setHeader('X-Portal-Build', cachedBuild);
    res.setHeader('X-Portal-Boot', BOOT);
  } catch {
    // The answer goes out without the stamp.
  }
}

function setPortalBuildForTests(build) {
  cachedBuild = build;
}

module.exports = { readPortalBuild, stampPortalBuild, setPortalBuildForTests, BOOT };
