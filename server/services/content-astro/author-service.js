/**
 * author-service.js — reads the Astro `authors` collection via GitHub
 * Contents API so the admin blog editor shows a live author dropdown.
 *
 * Why GitHub (not a local mirror or a DB table): the authors collection
 * lives in wavespestcontrol-astro alongside the bios and photos it
 * describes. Mirroring into the portal would mean two places to edit one
 * fact. The content engine publishes 5+ posts/week — a 5-minute cache
 * at the portal edge keeps us off the GitHub rate limit without forcing
 * a deploy every time we add a new byline.
 *
 * Consumers: admin BlogPage dropdown, astro-publisher (reviewer lookup),
 * any route that needs to resolve an author_slug → display metadata.
 */

const gh = require('./github-client');
const fm = require('./frontmatter');
const logger = require('../logger');

const TTL_MS = 5 * 60 * 1000;
const cache = { at: 0, authors: null };

async function listAuthors({ force = false } = {}) {
  if (!force && cache.authors && Date.now() - cache.at < TTL_MS) {
    return cache.authors;
  }

  try {
    const dir = await gh.listDir('src/content/authors');
    const mdFiles = dir.filter((f) => f.type === 'file' && f.name.endsWith('.md'));

    const authors = [];
    for (const f of mdFiles) {
      try {
        const file = await gh.getFile(`src/content/authors/${f.name}`);
        if (!file) continue;
        const { data } = fm.parse(file.content);
        if (!data?.slug || !data?.name) continue;
        authors.push({
          slug: data.slug,
          name: data.name,
          role: data.role || '',
          fdacs_license: data.fdacs_license || null,
          years_swfl: data.years_swfl || null,
          photo: data.photo || null,
          bio_short: data.bio_short || '',
          credentials: Array.isArray(data.credentials) ? data.credentials : [],
          specialties: Array.isArray(data.specialties) ? data.specialties : [],
          bio_url: `/about/authors/${data.slug}`,
        });
      } catch (err) {
        logger.warn(`[authors] failed to parse ${f.name}: ${err.message}`);
      }
    }

    authors.sort((a, b) => a.name.localeCompare(b.name));
    cache.authors = authors;
    cache.at = Date.now();
    return authors;
  } catch (err) {
    logger.error(`[authors] listAuthors failed: ${err.message}`);
    // Fall back to the last good snapshot rather than breaking the editor.
    if (cache.authors) return cache.authors;
    throw err;
  }
}

async function getAuthor(slug, opts) {
  const all = await listAuthors(opts);
  return all.find((a) => a.slug === slug) || null;
}

function clearCache() {
  cache.at = 0;
  cache.authors = null;
}

module.exports = { listAuthors, getAuthor, clearCache };
