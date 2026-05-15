const db = require('../models/db');
const logger = require('./logger');

const PROVIDER = 'bouncie';

async function loadTokens() {
  try {
    const exists = await db.schema.hasTable('bouncie_oauth_tokens');
    if (!exists) return null;
    const row = await db('bouncie_oauth_tokens').where({ provider: PROVIDER }).first();
    if (!row) return null;
    return {
      accessToken: row.access_token || null,
      refreshToken: row.refresh_token || null,
      expiresAt: row.expires_at || null,
    };
  } catch (err) {
    logger.warn(`[bouncie-token-store] token load skipped: ${err.message}`);
    return null;
  }
}

async function saveTokens({ accessToken, refreshToken, expiresIn } = {}) {
  if (!accessToken && !refreshToken) return;
  const now = new Date();
  const expiresAt = expiresIn ? new Date(Date.now() + Number(expiresIn) * 1000) : null;

  try {
    const exists = await db.schema.hasTable('bouncie_oauth_tokens');
    if (!exists) {
      logger.warn('[bouncie-token-store] bouncie_oauth_tokens table missing; tokens kept in memory only');
      return;
    }

    await db('bouncie_oauth_tokens')
      .insert({
        provider: PROVIDER,
        access_token: accessToken || null,
        refresh_token: refreshToken || null,
        expires_at: expiresAt,
        updated_at: now,
      })
      .onConflict('provider')
      .merge({
        access_token: accessToken || db.raw('bouncie_oauth_tokens.access_token'),
        refresh_token: refreshToken || db.raw('bouncie_oauth_tokens.refresh_token'),
        expires_at: expiresAt,
        updated_at: now,
      });

    await db('token_credentials')
      .insert({
        platform: PROVIDER,
        token_type: 'oauth',
        credential_type: 'oauth',
        status: 'healthy',
        last_verified_at: now,
        last_error: null,
        expires_at: expiresAt,
        env_var_name: 'BOUNCIE_REFRESH_TOKEN',
        metadata: JSON.stringify({
          source: 'bouncie_oauth_tokens',
          access_token_present: !!accessToken,
          refresh_token_present: !!refreshToken,
        }),
        updated_at: now,
      })
      .onConflict('platform')
      .merge({
        token_type: 'oauth',
        credential_type: 'oauth',
        status: 'healthy',
        last_verified_at: now,
        last_error: null,
        expires_at: expiresAt,
        env_var_name: 'BOUNCIE_REFRESH_TOKEN',
        metadata: JSON.stringify({
          source: 'bouncie_oauth_tokens',
          access_token_present: !!accessToken,
          refresh_token_present: !!refreshToken,
        }),
        updated_at: now,
      })
      .catch((err) => logger.warn(`[bouncie-token-store] token health update skipped: ${err.message}`));
  } catch (err) {
    logger.error(`[bouncie-token-store] token save failed: ${err.message}`);
  }
}

module.exports = {
  loadTokens,
  saveTokens,
};
