'use strict';

const crypto = require('crypto');
const { decodeHTML } = require('entities');
const { fetchPage } = require('../seo/contact-finder');
const { LIMITS } = require('./editorial-review-contracts');

function htmlText(html) {
  const withoutNoise = String(html || '')
    .replace(/<!--[^]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg)\b[^>]*>[^]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p\s*>|<\/li\s*>|<\/h[1-6]\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decodeHTML(withoutNoise).replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

function publisherOf(html, url) {
  const meta = String(html || '').match(/<meta\b[^>]*(?:property|name)=["']og:site_name["'][^>]*content=["']([^"']+)["'][^>]*>/i)
    || String(html || '').match(/<meta\b[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["']og:site_name["'][^>]*>/i);
  if (meta?.[1]) return decodeHTML(meta[1]).replace(/\s+/g, ' ').trim().slice(0, 200);
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'unknown'; }
}

function normalizeRequestedSources(sourceUrls) {
  const urls = [];
  const errors = [];
  const seen = new Set();
  if (sourceUrls != null && !Array.isArray(sourceUrls)) errors.push('sourceUrls must be an array.');
  for (const raw of Array.isArray(sourceUrls) ? sourceUrls : []) {
    let normalized;
    try {
      const parsed = new URL(String(raw));
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('unsupported protocol');
      normalized = parsed.toString();
    } catch {
      errors.push(`Invalid source URL: ${String(raw).slice(0, 200)}`);
      continue;
    }
    if (!seen.has(normalized)) { seen.add(normalized); urls.push(normalized); }
  }
  if (urls.length > LIMITS.sourceUrls) errors.push(`Source URL count exceeds ${LIMITS.sourceUrls}; excess sources were not fetched.`);
  return { urls: urls.slice(0, LIMITS.sourceUrls), errors };
}

async function fetchSources(sourceUrls) {
  const normalized = normalizeRequestedSources(sourceUrls);
  let remaining = LIMITS.totalSourceChars;
  const records = [];
  const errors = [...normalized.errors];
  for (const url of normalized.urls) {
    const page = await fetchPage(url, { timeoutMs: 10000, maxRedirects: 3 });
    if (!page || page.blocked || !page.html || page.status < 200 || page.status >= 300) {
      errors.push(`Source could not be safely retrieved: ${url}`);
      continue;
    }
    const type = String(page.contentType || '').toLowerCase();
    if (type && !type.includes('html') && !type.includes('text')) {
      errors.push(`Source content type is not reviewable text: ${url}`);
      continue;
    }
    const text = htmlText(page.html);
    if (!text) { errors.push(`Source contained no reviewable text: ${url}`); continue; }
    const excerptLength = Math.max(0, Math.min(LIMITS.sourceChars, remaining));
    if (!excerptLength) { errors.push(`Total source evidence exceeds ${LIMITS.totalSourceChars} characters.`); break; }
    const finalUrl = page.finalUrl || url;
    const excerpt = text.slice(0, excerptLength);
    records.push({
      url: finalUrl,
      publisher: publisherOf(page.html, finalUrl),
      retrievedAt: new Date().toISOString(),
      excerpt,
      contentHash: crypto.createHash('sha256').update(excerpt).digest('hex'),
    });
    remaining -= excerpt.length;
  }
  return { records, errors };
}

module.exports = {
  fetchSources,
  htmlText,
  normalizeRequestedSources,
  publisherOf,
};
