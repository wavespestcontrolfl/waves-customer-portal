// Dependency-free Google Ads configuration check. Kept apart from google-ads.js
// so a read that only needs to know whether the integration is configured
// (e.g. GET /api/admin/ads/sync-status) never loads the ~87MB Google Ads SDK.
function isConfigured() {
  return !!(
    process.env.GOOGLE_ADS_DEVELOPER_TOKEN &&
    process.env.GOOGLE_ADS_CLIENT_ID &&
    process.env.GOOGLE_ADS_CLIENT_SECRET &&
    process.env.GOOGLE_ADS_REFRESH_TOKEN &&
    process.env.GOOGLE_ADS_CUSTOMER_ID
  );
}

module.exports = { isConfigured };
