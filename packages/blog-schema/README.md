# @waves/blog-schema (vendored)

Vendored copy of the blog post frontmatter schema. **Source of truth is the Astro spoke repo** at `wavespestcontrol-astro/packages/blog-schema/`.

## Do not edit files here directly

`schema.ts`, `service-areas.ts`, `schema.json`, and `upstream-checksum.txt` are all copied from upstream. A build-time drift check (`scripts/verify-vendor.js`) computes sha256 over `schema.ts + service-areas.ts` (both hashed, sorted for determinism) and compares it to `upstream-checksum.txt` — any mismatch fails the build.

## Update workflow

1. In the Astro repo, edit `packages/blog-schema/schema.ts` (structural changes) and/or `service-areas.ts` (city list).
2. In the Astro repo, run `npm run generate:blog-schema`. This regenerates `schema.json` and `checksum.txt`.
3. Commit the upstream changes.
4. In this repo, run `npm run sync:blog-schema`. This copies `schema.ts`, `service-areas.ts`, `schema.json`, and the upstream `checksum.txt` (renamed to `upstream-checksum.txt`) into this directory.
5. Commit the vendor update here.

The sync script assumes the Astro repo is cloned as a sibling of this repo (i.e. at `../wavespestcontrol-astro`). Override with `BLOG_SCHEMA_ASTRO_REPO=/abs/path npm run sync:blog-schema` if it lives elsewhere.

## What's in this directory

| File | Purpose |
|---|---|
| `schema.ts` | Human-readable source reference (mirrors upstream; read-only here) |
| `service-areas.ts` | Valid values for `service_areas_tag` — mirrors upstream; read-only here |
| `schema.json` | JSON Schema bundle — admin code validates drafts against this via `ajv` (wiring lands in PR 1) |
| `upstream-checksum.txt` | Expected sha256 over `schema.ts + service-areas.ts` — drift check compares against this |
| `scripts/verify-vendor.js` | Drift check; runs on `prestart` and `prebuild` |
| `scripts/sync-from-astro.js` | Pulls updated files from the Astro repo |

## What it's used for

PR 0 ships the schema contract only. PR 1 wires the admin Blog Content Engine to:

- Validate draft frontmatter against `schema.json` before publish
- Run `validateRenderedComponents(html, frontmatter)` from `schema.ts` against the rendered HTML to enforce §10 post-type component requirements
- Publish posts to the Astro spoke fleet via a new admin endpoint + Cloudflare Pages deploy hook (replacing the legacy WordPress REST publish path)
