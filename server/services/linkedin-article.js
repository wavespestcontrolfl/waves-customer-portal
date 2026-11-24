/**
 * The article card LinkedIn shows under a company post. Only a post with a
 * link has one: its title (cut to 200 characters; the link when there is no
 * title) and its description (trimmed, cut to 300 characters).
 *
 * services/linkedin.js createPost sends exactly this card, and
 * services/social-media.js checks the same card for phone numbers. So the
 * check never judges text LinkedIn does not show, and never misses text it
 * does. Kept out of linkedin.js because several suites mock that module.
 */
function linkedinArticleCard({ link, title, description } = {}) {
  if (!link) return null;
  const card = { source: link, title: String(title || '').slice(0, 200) || link };
  const desc = String(description || '').trim();
  if (desc) card.description = desc.slice(0, 300);
  return card;
}

module.exports = { linkedinArticleCard };
