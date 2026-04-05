const db = require('../../models/db');
const logger = require('../logger');

const BEARER_TOKEN = process.env.TWITTER_BEARER_TOKEN;

async function resolveUrl(shortUrl) {
  try {
    const res = await fetch(shortUrl, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(10000) });
    return res.url || shortUrl;
  } catch {
    return shortUrl;
  }
}

function extractDomain(url) {
  try { return new URL(url).hostname.replace('www.', ''); } catch { return null; }
}

async function pollTarget(target) {
  if (!BEARER_TOKEN) throw new Error('TWITTER_BEARER_TOKEN not set');

  // Resolve user ID if not cached
  let userId = target.x_user_id;
  if (!userId) {
    const res = await fetch(`https://api.twitter.com/2/users/by/username/${target.x_username}`, {
      headers: { Authorization: `Bearer ${BEARER_TOKEN}` },
    });
    const data = await res.json();
    if (data.data?.id) {
      userId = data.data.id;
      await db('backlink_agent_targets').where({ id: target.id }).update({ x_user_id: userId });
    } else {
      throw new Error(`Could not resolve X user: ${target.x_username}`);
    }
  }

  // Fetch recent tweets
  let url = `https://api.twitter.com/2/users/${userId}/tweets?max_results=100&tweet.fields=entities`;
  if (target.last_tweet_id) url += `&since_id=${target.last_tweet_id}`;

  const res = await fetch(url, { headers: { Authorization: `Bearer ${BEARER_TOKEN}` } });
  const data = await res.json();
  const tweets = data.data || [];

  if (tweets.length === 0) {
    await db('backlink_agent_targets').where({ id: target.id }).update({ last_polled_at: new Date() });
    return { newUrls: 0 };
  }

  // Extract and resolve URLs
  let newCount = 0;
  for (const tweet of tweets) {
    const urls = (tweet.entities?.urls || []).map(u => u.expanded_url).filter(Boolean);
    for (const rawUrl of urls) {
      const finalUrl = await resolveUrl(rawUrl);
      const domain = extractDomain(finalUrl);
      if (!domain) continue;

      // Skip twitter/x links
      if (domain.includes('twitter.com') || domain.includes('x.com')) continue;

      // Deduplicate
      const exists = await db('backlink_agent_queue').where({ domain }).first();
      if (exists) continue;

      await db('backlink_agent_queue').insert({
        url: finalUrl, original_url: rawUrl,
        source: 'x_feed', source_detail: tweet.id, domain,
      });
      newCount++;
    }
  }

  // Update cursor
  const newestId = tweets[0]?.id;
  await db('backlink_agent_targets').where({ id: target.id }).update({
    last_polled_at: new Date(),
    last_tweet_id: newestId || target.last_tweet_id,
  });

  return { newUrls: newCount };
}

async function pollAllTargets() {
  const { isEnabled } = require('../../config/feature-gates');
  if (!isEnabled('backlinkAgent')) return { polled: 0 };

  const targets = await db('backlink_agent_targets').where({ is_active: true });
  let totalNew = 0;

  for (const target of targets) {
    // Rate limit: once per hour
    if (target.last_polled_at && Date.now() - new Date(target.last_polled_at).getTime() < 3600000) {
      continue;
    }
    try {
      const result = await pollTarget(target);
      totalNew += result.newUrls;
      logger.info(`[backlink-agent] Polled @${target.x_username}: ${result.newUrls} new URLs`);
    } catch (err) {
      logger.error(`[backlink-agent] Poll failed for @${target.x_username}: ${err.message}`);
    }
  }

  return { polled: targets.length, newUrls: totalNew };
}

module.exports = { pollAllTargets, pollTarget };
