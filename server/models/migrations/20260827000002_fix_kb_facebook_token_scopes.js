/**
 * Data fix — publish the corrected FACEBOOK_ACCESS_TOKEN refresh procedure to
 * the LIVE knowledge_base row on deploy.
 *
 * Context: the first social engagement sweep (2026-08-27 05:15 ET) failed every
 * Facebook target with (#10) requires pages_read_engagement /
 * pages_read_user_content, and the Instagram shares insight with (#10) no
 * permission (instagram_manage_insights). The seed entry gained those scopes
 * + forceUpdate, but forceUpdate only re-seeds when someone MANUALLY re-runs
 * scripts/seed-knowledge-base.js — deploys run knex migrations, not the seed
 * (same failure mode as 20260528000031_fix_kb_blackout_charlotte_northport).
 * Without this migration the Intelligence Bar keeps telling the owner to mint
 * a token with the OLD scope list.
 *
 * Self-contained: content embedded as JSON, extracted verbatim from the seed
 * entry at authoring time. Update-only + idempotent; fresh environments get
 * the same text from the seed.
 */

const SLUG = 'social-media-token-facebook';
const ENTRY = {
  "title": "Social Media Token Refresh — Facebook",
  "category": "credentials",
  "tags": [
    "facebook",
    "meta",
    "oauth",
    "token",
    "social-media",
    "api"
  ],
  "content": "# Facebook Page Access Token — Refresh Procedure\n\n## Token Lifecycle\nFacebook long-lived page access tokens expire after ~60 days.\n\n## Refresh Steps\n1. Go to https://developers.facebook.com/tools/explorer/\n2. Select the Waves Pest Control app\n3. Generate a User Access Token with permissions: pages_manage_posts, pages_read_engagement, pages_read_user_content, pages_show_list, instagram_basic, instagram_manage_insights. The social engagement ingest needs pages_read_engagement + pages_read_user_content (Facebook post likes/comments — first live sweep 2026-08-27 got \"(#10) requires pages_read_engagement / pages_read_user_content\" on every Facebook post with a token missing pages_read_user_content) and instagram_manage_insights (Instagram share counts via Media Insights). If Meta still returns #10 with those granted, the app needs App Review approval for pages_read_engagement / pages_read_user_content (the Page Public Content Access feature is the alternative).\n4. Exchange for long-lived token: GET /oauth/access_token?grant_type=fb_exchange_token&client_id={APP_ID}&client_secret={APP_SECRET}&fb_exchange_token={SHORT_TOKEN}\n5. Get Page Access Token: GET /me/accounts?access_token={LONG_LIVED_USER_TOKEN}\n6. Copy the page access token for page ID 110336442031847\n7. Update FACEBOOK_ACCESS_TOKEN in Railway environment variables\n8. Redeploy\n\n## Instagram Note\nInstagram posting uses the SAME token (FACEBOOK_ACCESS_TOKEN). Refreshing Facebook also fixes Instagram. The engagement ingest (SOCIAL_ENGAGEMENT_SYNC_ENABLED) reads Instagram share counts via Media Insights, which needs instagram_manage_insights on this token — a token generated without it still syncs likes/comments but records shares as not measured and warns in the sweep log.\nThe Instagram Business Account ID is 17841465266249854.\n\n## Monitoring\nThe token health check runs daily and will SMS alert when this token fails or approaches expiry."
};

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('knowledge_base'))) return;
  const existing = await knex('knowledge_base').where({ slug: SLUG }).first();
  if (!existing) return;
  await knex('knowledge_base').where({ slug: SLUG }).update({
    title: ENTRY.title,
    tags: JSON.stringify(ENTRY.tags),
    content: ENTRY.content,
    confidence: 'high',
    last_verified_at: new Date(),
    verified_by: 'migration-fb-token-scopes-2026-08-27',
  });
};

exports.down = async function down() {
  // Data correction — intentionally NOT reverted (a down would restore the
  // incomplete scope list).
};
