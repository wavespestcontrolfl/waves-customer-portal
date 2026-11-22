// Dependency-free Google Ads configuration check. Kept apart from google-ads.js
// so a read that only needs to know whether the integration is configured
// (e.g. GET /api/admin/ads/sync-status) never loads the ~87MB Google Ads SDK.
// The OAuth credentials alone. The Local Services sync (google-lsa.js) reads its
// own account with them, so it does not need GOOGLE_ADS_CUSTOMER_ID.
function hasCredentials() {
  return !!(
    process.env.GOOGLE_ADS_DEVELOPER_TOKEN &&
    process.env.GOOGLE_ADS_CLIENT_ID &&
    process.env.GOOGLE_ADS_CLIENT_SECRET &&
    process.env.GOOGLE_ADS_REFRESH_TOKEN
  );
}

function isConfigured() {
  return hasCredentials() && !!process.env.GOOGLE_ADS_CUSTOMER_ID;
}

// The Google Ads SDK rejects with a GoogleAdsFailure object, not an Error: it
// has no `.message`, and the reason is in errors[0].message. One short line for
// a log or a job_health row.
const errorText = (err) => String(err?.errors?.[0]?.message || err?.message || 'unknown error').slice(0, 200);

module.exports = { isConfigured, hasCredentials, errorText };
