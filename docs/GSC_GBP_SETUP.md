# Google Search Console + GA4 + GBP Setup

The SEO Grade shows **N/A** when the `gsc_*` and `gbp_performance_daily` tables are empty. The Analytics tab shows empty data or an access error when GA4 is not connected. Sync runs only when `GOOGLE_SERVICE_ACCOUNT_JSON` is set and the service account has access in the matching Google product.

## Required Railway environment variables

| Variable | Value | Notes |
|---|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Full JSON of service account key | Paste the entire JSON blob (single line or multi-line, both work). Used by `server/services/seo/search-console.js:66`. |
| `GSC_SITE_URL` | `https://www.wavespestcontrol.com/` **or** `sc-domain:wavespestcontrol.com` | Must match a property the service account can access. Domain properties use the `sc-domain:` prefix. URL-prefix properties must include the exact protocol, host, and trailing slash shown in GSC. |
| `GA4_PROPERTY_ID` | `487785917` | Used by `server/services/analytics/google-analytics.js`. This is the numeric GA4 property ID, not the `G-...` measurement ID or the Google Analytics account ID. |

`GOOGLE_API_KEY` is **not** sufficient for Search Console or GA4 Data API access — both require OAuth/service-account auth and product-level permissions.

## Step 1 — Create the Google Cloud service account

1. Go to https://console.cloud.google.com → pick (or create) a project.
2. **APIs & Services → Library** → enable:
   - Google Search Console API
   - Google Analytics Data API
   - My Business Business Information API
   - My Business Account Management API (for GBP)
3. **IAM & Admin → Service Accounts → Create service account**.
   - Name: `waves-seo-sync`
   - Skip optional role grants.
4. Open the new service account → **Keys → Add key → Create new key → JSON**. A `.json` file downloads — keep it secure, do not commit.

## Step 2 — Grant the service account access to Search Console

1. Open the downloaded JSON; copy the `client_email` value (looks like `waves-seo-sync@PROJECT.iam.gserviceaccount.com`).
2. https://search.google.com/search-console → pick your property.
3. **Settings → Users and permissions → Add user**.
4. Paste the `client_email`, set permission to **Full**, save.

If Railway uses `GSC_SITE_URL=sc-domain:wavespestcontrol.com`, the service account must be added to that Domain property. If the service account only has access to `https://www.wavespestcontrol.com/`, set `GSC_SITE_URL` to that exact URL-prefix property instead.

## Step 3 — Grant the service account access to GA4

1. Open https://analytics.google.com.
2. Pick the GA4 property whose numeric property ID is in `GA4_PROPERTY_ID`.
3. **Admin → Property access management → Add users**.
4. Paste the same `client_email`, set role to **Viewer**, save.

For Waves, the Google Analytics account ID is `353979644`, but the GA4 property/app ID used by the Data API is `487785917`. Railway should use `GA4_PROPERTY_ID=487785917`.

## Step 4 — Grant access to Google Business Profile (optional, for GBP data)

1. https://business.google.com → open your account.
2. **Users → Add users** → paste the same `client_email` → role **Manager** → invite. Accept the invite if needed.

## Step 5 — Set Railway variables

```
railway variables set GOOGLE_SERVICE_ACCOUNT_JSON="$(cat path/to/key.json)"
railway variables set GSC_SITE_URL="https://www.wavespestcontrol.com/"
railway variables set GA4_PROPERTY_ID="487785917"
```

Or via the Railway dashboard → Variables tab → **Raw Editor** (safer for multi-line JSON).

## Step 6 — Trigger syncs

After Railway redeploys with the new vars:

```
curl -X POST https://portal.wavespestcontrol.com/api/admin/seo/sync \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{"daysBack":28}'

curl -X POST https://portal.wavespestcontrol.com/api/admin/analytics/sync \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{"days":30}'
```

Or wait for the scheduled crons: GSC runs daily at 6:00 AM ET and GA4 runs daily at 6:30 AM ET. Then reload `/admin/seo`.

## Troubleshooting

- **Still N/A after sync** — check logs for `GSC sync disabled` or `googleapis not installed`. Run `npm install googleapis` in `server/` if missing.
- **403 from GSC API** — service account not added to the property, or property URL format mismatch (`https://www.../` vs `sc-domain:`).
- **GA4 says insufficient permissions** — service account is valid, but it has not been added as a Viewer on the GA4 property in `GA4_PROPERTY_ID`, or `GA4_PROPERTY_ID` points at the wrong property.
- **GBP empty but GSC works** — GBP requires a separate invite acceptance in https://business.google.com.
