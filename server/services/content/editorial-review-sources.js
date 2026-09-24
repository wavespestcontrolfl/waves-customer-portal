'use strict';

const crypto = require('crypto');
const { decodeHTML } = require('entities');
const { fetchPage } = require('../seo/contact-finder');
const { classifyPageBody } = require('../seo/page-body-classifier');
const { LIMITS } = require('./editorial-review-contracts');

function htmlText(html) {
  const withoutNoise = String(html || '')
    .replace(/<!--[^]*?-->/g, ' ')
    .replace(/<!--[^]*$/g, ' ')
    .replace(/<(?:script|style|noscript|svg)\b[^>]*\/\s*>/gi, ' ')
    .replace(/<(script|style|noscript|svg)\b[^>]*>[^]*?<\/\1>/gi, ' ')
    .replace(/<(script|style|noscript|svg)\b[^>]*>[^]*$/gi, ' ')
    .replace(/\s+/g, ' ')
    .replace(/<br\b[^>]*>/gi, '\n')
    .replace(/<\/p\s*>|<\/li\s*>|<\/h[1-6]\s*>/gi, '\n')
    .replace(/<\/?(?:address|article|aside|blockquote|div|dl|dt|dd|fieldset|figcaption|figure|footer|form|header|hr|main|nav|ol|pre|section|table|tbody|thead|tfoot|tr|td|th|ul)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return decodeHTML(withoutNoise).replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

function publisherOf(html, url) {
  const meta = String(html || '').match(/<meta\b[^>]*(?:property|name)=["']og:site_name["'][^>]*content=["']([^"']+)["'][^>]*>/i)
    || String(html || '').match(/<meta\b[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["']og:site_name["'][^>]*>/i);
  const metadataPublisher = decodeHTML(meta?.[1] || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (metadataPublisher) return metadataPublisher;
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
      parsed.hash = '';
      normalized = parsed.toString();
    } catch {
      errors.push(`Invalid source URL: ${String(raw).slice(0, 200)}`);
      continue;
    }
    if (seen.has(normalized)) continue;
    if (urls.length === LIMITS.sourceUrls) {
      errors.push(`Source URL count exceeds ${LIMITS.sourceUrls}; excess sources were not fetched.`);
      break;
    }
    seen.add(normalized);
    urls.push(normalized);
  }
  return { urls, errors };
}

async function fetchSources(sourceUrls) {
  const normalized = normalizeRequestedSources(sourceUrls);
  let remaining = LIMITS.totalSourceChars;
  const records = [];
  const errors = [...normalized.errors];
  const seenFinalUrls = new Set();
  for (const url of normalized.urls) {
    if (!remaining) { errors.push(`Total source evidence exceeds ${LIMITS.totalSourceChars} characters.`); break; }
    const page = await fetchPage(url, { timeoutMs: 10000, maxRedirects: 3 });
    if (!page || page.blocked || !page.html || page.status < 200 || page.status >= 300) {
      errors.push(`Source could not be safely retrieved: ${url}`);
      continue;
    }
    const mediaType = String(page.contentType || '').split(';', 1)[0].trim().toLowerCase();
    if (mediaType && !['text/html', 'application/xhtml+xml', 'text/plain'].includes(mediaType)) {
      errors.push(`Source content type is not reviewable text: ${url}`);
      continue;
    }
    const bodyType = classifyPageBody(page.html, mediaType, { strictChallenge: true });
    if (bodyType === 'challenge') {
      errors.push(`Source returned a challenge page: ${url}`);
      continue;
    }
    if (mediaType !== 'text/plain' && bodyType !== 'html') {
      errors.push(`Source body is not reviewable HTML: ${url}`);
      continue;
    }
    const finalUrl = page.finalUrl || url;
    const parsedFinalUrl = new URL(finalUrl);
    parsedFinalUrl.hash = '';
    const normalizedFinalUrl = parsedFinalUrl.toString();
    if (seenFinalUrls.has(normalizedFinalUrl)) continue;
    const text = mediaType === 'text/plain'
      ? String(page.html || '').replace(/\u00a0/g, ' ').trim()
      : htmlText(page.html);
    if (!text) { errors.push(`Source contained no reviewable text: ${url}`); continue; }
    seenFinalUrls.add(normalizedFinalUrl);
    const excerptLength = Math.max(0, Math.min(LIMITS.sourceChars, remaining));
    const excerpt = text.slice(0, excerptLength);
    records.push({
      url: normalizedFinalUrl,
      publisher: publisherOf(mediaType === 'text/plain' ? '' : page.html, normalizedFinalUrl),
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
