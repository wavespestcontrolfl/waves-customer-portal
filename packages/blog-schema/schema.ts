// Waves blog post frontmatter — source of truth.
// Edit this file, then run `npm run generate:blog-schema` from the repo root
// to regenerate schema.json and checksum.txt.
//
// Admin portal vendors a copy of this file + schema.json + checksum.txt.
// The admin drift check fails the build if its local schema.ts sha256
// does not match the recorded upstream-checksum.txt.

import { z } from 'zod';
import { SERVICE_AREAS } from './service-areas.ts';

// ─────────────────────────────────────────────────────────────
// Enums
// ─────────────────────────────────────────────────────────────

// `category` is taxonomy (URL structure + hub-and-spoke routing).
// `post_type` is structural contract (drives §10 component requirements).
// They are orthogonal — a "DIY vs pro chinch bug" post is
// category: lawn-care + post_type: decision.
export const postCategory = z.enum([
  'pest-control',
  'lawn-care',
  'termite',
  'mosquito',
  'tree-shrub',
  'seasonal',
]);

export const postType = z.enum([
  'diagnostic',
  'seasonal',
  'by-grass-type',
  'protocol',
  'cost',
  'comparison',
  'case-study',
  'location',
  'decision',
]);

export const serviceArea = z.enum(SERVICE_AREAS);

export const waveGuardTier = z.enum(['Bronze', 'Silver', 'Gold', 'Platinum']);

export const schemaType = z.enum([
  'Article',
  'FAQPage',
  'BreadcrumbList',
  'HowTo',
  'Service',
  'Review',
]);

export const reviewCadence = z.enum(['monthly', 'quarterly', 'annually']);

export const disclosureType = z.enum([
  'pricing-transparency',
  'service-area-limits',
  'regulatory',
  'none',
]);

// ─────────────────────────────────────────────────────────────
// Primitives
// ─────────────────────────────────────────────────────────────

const fdacsLicense = z
  .string()
  .regex(/^JB\d{4,}$/, 'FDACS license must be "JB" followed by 4+ digits');

const ymdDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');

const bioUrl = z
  .string()
  .regex(
    /^\/about\/authors\/[a-z0-9-]+$/,
    'bio_url must be /about/authors/{kebab-slug}',
  );

const slugPath = z
  .string()
  .regex(
    /^\/[a-z0-9-]+(\/[a-z0-9-]+)*\/$/,
    'slug must be a URL path like /category/primary-keyword/',
  );

const imagePath = z
  .string()
  .regex(/^\/.+\.(webp|jpg|jpeg|png|avif)$/i, 'image must be a site-absolute path to a webp/jpg/png/avif');

// ─────────────────────────────────────────────────────────────
// Object blocks
// ─────────────────────────────────────────────────────────────

export const authorSchema = z.object({
  name: z.string().min(1),
  role: z.string().min(1),
  fdacs_license: fdacsLicense.optional(),
  years_swfl: z.number().int().min(0).optional(),
  bio_url: bioUrl,
});

export const reviewerSchema = z.object({
  name: z.string().min(1),
  credential: z.string().min(1), // "BCE", "Certified Arborist", "Lead Tech", "Owner", …
  fdacs_license: fdacsLicense.optional(),
  bio_url: bioUrl,
});

export const heroImageSchema = z.object({
  src: imagePath,
  alt: z.string().min(1),
  caption: z.string().optional(),
  credit: z.string().optional(),
});

export const disclosureSchema = z.object({
  type: disclosureType,
  text: z.string().optional(),
});

export const trackingSchema = z.object({
  number_key: z.string().optional(),
  domains: z.array(z.string()).optional(),
  robots: z.string().optional(),
});

// ─────────────────────────────────────────────────────────────
// Full frontmatter
// ─────────────────────────────────────────────────────────────

export const blogPostFrontmatter = z.object({
  // Identity
  title: z.string().min(1),
  slug: slugPath,
  // Hard bounds 115–160. Ideal range is 120–155; `lintFrontmatter` emits
  // warnings for 115–119 and 156–160 (too short / too long but not broken).
  meta_description: z.string().min(115).max(160),
  primary_keyword: z.string().min(1),
  secondary_keywords: z.array(z.string()).max(20),

  // Taxonomy
  category: postCategory,
  post_type: postType,
  service_areas_tag: z.array(serviceArea).min(1),
  related_waveguard_tier: waveGuardTier.optional(),
  related_services: z.array(z.string()),

  // Internal linking
  hub_link: z.string().optional(),
  spoke_links: z.array(z.string()).max(20),

  // Byline + review chain (PR 1 trust layer backing)
  author: authorSchema,
  technically_reviewed_by: reviewerSchema,
  fact_checked_by: z.string().min(1),

  // Four surfaced dates
  published: ymdDate,
  updated: ymdDate,
  technically_reviewed: ymdDate,
  fact_checked: ymdDate,
  review_cadence: reviewCadence,

  reading_time_min: z.number().int().min(1),

  // Imagery
  hero_image: heroImageSchema,
  og_image: imagePath,

  // SEO
  canonical: z.url(),
  schema_types: z.array(schemaType).min(1),

  // Disclosures + tracking
  disclosure: disclosureSchema,
  tracking: trackingSchema.optional(),
});

export type BlogPostFrontmatter = z.infer<typeof blogPostFrontmatter>;

// ─────────────────────────────────────────────────────────────
// §10 — Post-type component requirements
//
// Each component renders an HTML root with data-wv-component="<id>".
// validateRenderedComponents(html, frontmatter) parses the HTML and
// returns which required IDs are missing.
// ─────────────────────────────────────────────────────────────

export type ComponentId = string;

export interface PostTypeRequirement {
  required: ComponentId[];
  recommended?: ComponentId[];
}

export const postTypeRequirements: Record<string, PostTypeRequirement> = {
  decision: {
    required: ['bottom-line-box', 'comparison-table', 'honest-rejection-callout'],
  },
  diagnostic: {
    required: ['annotated-diagnostic-photo', 'pest-symptom-decision-tree'],
    recommended: ['case-study-block'],
  },
  seasonal: {
    required: ['seasonal-calendar', 'content-upgrade-pdf'],
  },
  protocol: {
    required: ['howto-steps', 'methodology-callout', 'protocol-field-photos'],
    recommended: ['alternatives-considered-callout'],
  },
  cost: {
    required: ['waveguard-ladder', 'disclosure-block', 'comparison-table'],
  },
  comparison: {
    required: [
      'comparison-table',
      'honest-rejection-callout',
      'who-shouldnt-pick-this',
    ],
  },
  'case-study': {
    required: [
      'case-study-block',
      'before-after-photo-pair',
      'named-neighborhood',
      'measurable-outcome',
    ],
  },
  location: {
    required: ['city-map-ribbon', 'city-hero-image', 'city-tracking-number'],
  },
  // `by-grass-type` is a structural pattern (St. Augustine / Bermuda /
  // Zoysia / Bahia subsections). Require at least one grass-type-section
  // marker — either the 4-column comparison table or the 4 labeled
  // subsections form; both render with data-wv-component="grass-type-section".
  'by-grass-type': {
    required: ['grass-type-section'],
    recommended: ['grass-type-field-photos'],
  },
};

export interface ComponentValidationResult {
  ok: boolean;
  post_type: string;
  missing_required: ComponentId[];
  missing_recommended: ComponentId[];
}

export function validateRenderedComponents(
  html: string,
  frontmatter: { post_type: string },
): ComponentValidationResult {
  const pt = frontmatter.post_type;
  const req = postTypeRequirements[pt] ?? { required: [], recommended: [] };

  const missingRequired: ComponentId[] = [];
  for (const id of req.required) {
    if (!hasComponent(html, id)) missingRequired.push(id);
  }

  const missingRecommended: ComponentId[] = [];
  for (const id of req.recommended ?? []) {
    if (!hasComponent(html, id)) missingRecommended.push(id);
  }

  return {
    ok: missingRequired.length === 0,
    post_type: pt,
    missing_required: missingRequired,
    missing_recommended: missingRecommended,
  };
}

function hasComponent(html: string, id: ComponentId): boolean {
  // Escape regex metachars in the id (ids are kebab-case but belt+suspenders).
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`data-wv-component=["']${escaped}["']`, 'i');
  return pattern.test(html);
}

// ─────────────────────────────────────────────────────────────
// Soft lints — non-fatal advisories the publish gate can surface.
// ─────────────────────────────────────────────────────────────

export interface LintResult {
  warnings: Array<{ field: string; message: string }>;
}

export function lintFrontmatter(fm: Partial<BlogPostFrontmatter>): LintResult {
  const warnings: LintResult['warnings'] = [];

  const desc = fm.meta_description;
  if (typeof desc === 'string') {
    const len = desc.length;
    if (len >= 115 && len < 120) {
      warnings.push({
        field: 'meta_description',
        message: `length ${len} is below the ideal 120–155 range — consider expanding`,
      });
    } else if (len > 155 && len <= 160) {
      warnings.push({
        field: 'meta_description',
        message: `length ${len} may be truncated in Google's SERP — ideal is 120–155`,
      });
    }
  }

  return { warnings };
}

// ─────────────────────────────────────────────────────────────
// Migration map — legacy Astro collection field → v2 field
// Consumed by the PR 1 migration script; not used at runtime.
// Value of `null` means the field is dropped (no v2 equivalent).
// Nested paths use dot notation, e.g. 'tracking.number_key'.
// ─────────────────────────────────────────────────────────────

export const legacyFieldMap: Record<string, string | null> = {
  metaTitle: null, // use `title` for H1, derive <title> from `title` + brand suffix
  metaDescription: 'meta_description',
  date: 'published',
  modified: 'updated',
  ogImage: 'og_image',
  schema: 'schema_types',
  trackingNumberKey: 'tracking.number_key',
  domains: 'tracking.domains',
  robots: 'tracking.robots',
};
