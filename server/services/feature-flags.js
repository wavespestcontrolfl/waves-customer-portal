const db = require('../models/db');

const FEATURE_FLAG_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function isValidFeatureFlagKey(key) {
  return FEATURE_FLAG_KEY_RE.test(String(key || ''));
}

async function isUserFeatureEnabled(userId, flagKey, defaultValue = false, knex = db) {
  if (!userId || !isValidFeatureFlagKey(flagKey)) return !!defaultValue;
  const row = await knex('user_feature_flags')
    .where({ user_id: userId, flag_key: flagKey })
    .first('enabled')
    .catch(() => null);
  return row ? !!row.enabled : !!defaultValue;
}

module.exports = {
  FEATURE_FLAG_KEY_RE,
  isValidFeatureFlagKey,
  isUserFeatureEnabled,
};
