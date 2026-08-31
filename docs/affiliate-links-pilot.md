# Affiliate Links in Blog Posts — Pilot Playbook

Owner-approved scoping (2026-08-31). Affiliate links are a supplemental
revenue stream on the hub blog's informational lane — never a reason a post
exists, and never allowed to cannibalize a service lead.

## Placement rules (the deal we made with readers)

- **Blog bodies only.** Never on service/city pages, never in meta fields,
  never on spoke surfaces. Enforced: the guardrails only accept registered
  affiliate URLs on blog targets (`content-guardrails.js`).
- **DIY-intent posts only.** A post whose job is converting a service lead
  (termite, WDO, recurring pest plans, anything an inspection sells) carries
  no affiliate links. Candidates are prevention/product-education posts where
  the honest answer is already "you can do this yourself."
- **Disclosure before the first link.** Every post carrying an affiliate link
  discloses the commission relationship (editorial policy §5.9). Enforced:
  P0 `AFFILIATE_LINK_WITHOUT_DISCLOSURE`.
- **The pesticide idiom is unchanged.** Product recommendations follow the
  same truth rules as all content: never "safe"/"pet-safe",
  "EPA-registered"/"EPA-exempt" only, no re-entry minutes, licensed technical
  review on any pesticide recommendation.
- **Manual placement only during the pilot.** The autonomous writer gets no
  affiliate instructions; refresh lanes may preserve existing affiliate links
  but a refresh that adds one is parked (P0 `AFFILIATE_LINK_ADDED_ON_REFRESH`).

## How a link gets registered (portal side — SHIPPED)

`CONTENT_AFFILIATE_LINKS` (Railway env, portal server) — comma-separated
**exact URLs**, tracking tag included, e.g.:

```
CONTENT_AFFILIATE_LINKS=https://www.domyown.com/<product>.html?aff=<id>,https://www.amazon.com/dp/<ASIN>?tag=<tag>
```

- Exact-URL discipline, never host-wide: a registered product page does not
  authorize anything else that retailer serves, and the same path without
  its tracking tag stays blocked.
- Empty (the default) = the lane is OFF. This env var is the kill switch;
  clearing it re-blocks every affiliate URL fleet-wide on next deploy.

## Owner checklist (accounts — only Adam can do these)

1. **DoMyOwn** — apply via Awin (domyown.com/pages/affiliates). Best brand
   fit: professional-grade products, "what the pros use" framing.
2. **Amazon Associates** — easiest approval; Lawn & Garden pays ~3% with a
   24-hour cookie. Needs the site listed + a purchase within 180 days to
   stay active.
3. Optional later: Solutions Pest & Lawn, ARBICO Organics (7.5%, fits the
   EPA-exempt/low-tox content angle).
4. W-9 / payout details per program; commissions are ordinary business
   income.

Decided and parked (not in the pilot): pest-control *lead* affiliates
(e.g. Terminix ~$40/sale) for out-of-footprint traffic — competitor-adjacent,
revisit only with explicit owner sign-off.

## Astro-repo follow-ups (required before the first link ships)

The portal gates are live, but the rendering side lives in the astro repo:

1. **Schema**: add `affiliate` to `disclosureType` in
   `packages/blog-schema` (edit in astro, then `npm run sync:blog-schema`
   here — the portal copy is vendored, never hand-edited).
2. **Renderer**: implement the disclosure block in `BlogPostLayout.astro`
   (the `DisclosureBlock` component was de-cataloged precisely because it
   was never implemented) — disclosure copy renders above the article body.
3. **`rel="sponsored nofollow"`** on affiliate anchors (Google requirement;
   plain followed affiliate links risk link-scheme classification). Simplest
   robust form: a rehype/remark step that stamps rel on any anchor whose
   href is in the affiliate set, so authors can't forget it.
4. Hand-place the pilot links + disclosures in 5–10 live DIY-intent posts,
   bump `modified:` frontmatter, ship via the normal astro flow.

## Pilot measurement (60–90 days)

- Clicks/conversions from the partner dashboards (Awin, Associates Central).
- Watch for lead cannibalization: organic conversions on the edited posts
  before/after (GSC + portal lead attribution).
- Go/no-go: revenue that justifies Phase 2 (portal admin UI for link
  management, a DB-backed link registry replacing the env var, autonomous
  writer integration behind the review queue). Otherwise the env var stays
  small and manual — or gets cleared.
