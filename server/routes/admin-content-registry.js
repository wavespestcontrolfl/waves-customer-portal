const express = require('express');

const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const registry = require('../services/content/content-registry');
const registryAdmin = require('../services/content/content-registry-admin');

const router = express.Router();

router.use(adminAuthenticate, requireAdmin);

router.get('/', async (req, res, next) => {
  try {
    const result = await registryAdmin.listContentRegistry({ query: req.query });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/sync', async (req, res, next) => {
  try {
    const options = normalizeSyncBody(req.body || {});
    const result = await registry.runContentRegistrySync(options);
    const status = result.ok ? 200 : 400;
    res.status(status).json(syncResponse(result));
  } catch (err) {
    next(err);
  }
});

function normalizeSyncBody(body = {}) {
  return {
    commit: boolFlag(body.commit),
    contentType: body.content_type || body.contentType || null,
    astroSource: body.source || body.astro_source || body.astroSource || 'auto',
    astroRoot: body.astro_dir || body.astroRoot || process.env.ASTRO_REPO_DIR || null,
    githubRef: body.github_ref || body.githubRef || process.env.CONTENT_REGISTRY_GITHUB_REF || null,
  };
}

function boolFlag(value) {
  if (value === true) return true;
  return /^(1|true|yes|on)$/i.test(String(value || ''));
}

function syncResponse(result) {
  return {
    ok: result.ok,
    mode: result.mode,
    source: result.source,
    astro_root: result.astro_root,
    github_ref: result.github_ref,
    sync_run_id: result.sync_run_id,
    summary: result.summary,
    error: result.error,
    code: result.code,
  };
}

module.exports = router;
module.exports.normalizeSyncBody = normalizeSyncBody;
module.exports.boolFlag = boolFlag;
module.exports.syncResponse = syncResponse;
