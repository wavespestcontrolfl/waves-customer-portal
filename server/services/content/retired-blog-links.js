'use strict';

/**
 * retired-blog-links.js — keep curated link lists off retired blog URLs.
 *
 * Seeded briefs (category, intercept, spoke) persist their `internal_links`
 * in opportunity_queue.signal_metadata when seeded, so editing the manifest
 * never reaches a row already queued. Their overlays resolve the persisted
 * list here at compose time instead: a redirected retired post becomes its
 * merge target, a post deleted with no redirect is dropped, and duplicates
 * collapse. Registry: server/data/retired-blog-topics-v1.json (owner prune
 * 2026-10-01; the topic-targeting gate reads the same file).
 */

// `live` rows are kept posts (topic protection only): their links stay as-is.
const RETIRED = new Map(require('../../data/retired-blog-topics-v1.json').posts.filter((p) => !p.live).map((p) => [p.url, p]));

function routeOf(link) {
  const raw = String(link || '').replace(/^https?:\/\/(?:www\.)?wavespestcontrol\.com/i, '').split(/[?#]/)[0].trim();
  if (!raw.startsWith('/')) return null;
  return `/${raw.replace(/^\/+|\/+$/g, '')}/`;
}

function resolveRetiredLinks(links = []) {
  const out = [];
  for (const link of Array.isArray(links) ? links : []) {
    const retired = RETIRED.get(routeOf(link));
    const next = retired ? (retired.redirected === false ? null : retired.merged_into) : link;
    if (next && !out.includes(next)) out.push(next);
  }
  return out;
}

// Writer-facing notes ("Verify /pest-control/get-rid-of-fire-ants/ resolves…")
// name a redirected retired URL → its merge target.
function resolveRetiredText(text) {
  if (typeof text !== 'string') return text;
  let out = text;
  for (const [url, post] of RETIRED) {
    if (post.redirected !== false && out.includes(url)) out = out.split(url).join(post.merged_into);
  }
  return out;
}

// A persisted seed payload with its links and writer notes resolved, so every
// consumer (structured requirements AND the binding-instruction text the
// writer follows) sees the same URLs.
function resolveRetiredPayload(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  return {
    ...payload,
    ...(payload.hub_link ? { hub_link: resolveRetiredLinks([payload.hub_link])[0] || null } : {}),
    ...(Array.isArray(payload.internal_links) ? { internal_links: resolveRetiredLinks(payload.internal_links) } : {}),
    ...(Array.isArray(payload.verify_notes) ? { verify_notes: payload.verify_notes.map(resolveRetiredText) } : {}),
  };
}

module.exports = { resolveRetiredLinks, resolveRetiredText, resolveRetiredPayload };
