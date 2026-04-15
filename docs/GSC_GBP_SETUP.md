# Google Search Console + GBP Setup

The SEO Grade shows **N/A** when the `gsc_*` and `gbp_performance_daily` tables are empty. Sync runs only when `GOOGLE_SERVICE_ACCOUNT_JSON` is set. Follow these steps to enable it.

## Required Railway environment variables

| Variable | Value | Notes |
|---|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Full JSON of service account key | Paste the entire JSON blob (single line or multi-line, both work). Used by `server/services/seo/search-console.js:66`. |
| `GSC_SITE_URL` | `https://wavespestcontrol.com/` **or** `sc-domain:wavespestcontrol.com` | Must match the property format exactly as registered in GSC. Domain properties use the `sc-domain:` prefix. |

`GOOGLE_API_KEY` is **not** sufficient — Search Console API requires OAuth or service account auth.

## Step 1 — Create the Google Cloud service account

1. Go to https://console.cloud.google.com → pick (or create) a project.
2. **APIs & Services → Library** → enable:
   - Google Search Console API
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

## Step 3 — Grant access to Google Business Profile (optional, for GBP data)

1. https://business.google.com → open your account.
2. **Users → Add users** → paste the same `client_email` → role **Manager** → invite. Accept the invite if needed.

## Step 4 — Set Railway variables

```
railway variables set GOOGLE_SERVICE_ACCOUNT_JSON="$(cat path/to/key.json)"
railway variables set GSC_SITE_URL="https://wavespestcontrol.com/"
```

Or via the Railway dashboard → Variables tab → **Raw Editor** (safer for multi-line JSON).

## Step 5 — Trigger a sync

After Railway redeploys with the new vars:

```
curl -X POST https://<railway-app>/api/admin/seo/sync-gsc \
  -H "Authorization: Bearer <admin-token>"
```

Or wait for the scheduled cron (Monday 7 AM) to run. Then reload the SEO page — grade should switch from `N/A` to a live letter grade.

## Troubleshooting

- **Still N/A after sync** — check logs for `GSC sync disabled` or `googleapis not installed`. Run `npm install googleapis` in `server/` if missing.
- **403 from GSC API** — service account not added to the property, or property URL format mismatch (`https://` vs `sc-domain:`).
- **GBP empty but GSC works** — GBP requires a separate invite acceptance in https://business.google.com.
