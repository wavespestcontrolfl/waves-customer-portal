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
// §10 — Component catalog + post-type requirements
//
// COMPONENT_NAMES is the contract between:
//   - the validator (what we look for in authored MDX)
//   - the renderer (what Astro registers and compiles)
//   - the template (what authors may invoke in MDX bodies)
//
// Names are PascalCase JSX identifiers — they appear verbatim in MDX
// bodies as <BottomLineBox ... />. Adding a component means adding its
// name here AND registering it Astro-side; both paths must stay in sync
// or the validator will miss invocations or flag false positives.
// ─────────────────────────────────────────────────────────────

export const COMPONENT_NAMES = [
  'BottomLineBox',
  'WhyTrustUs',
  'TLDR',
  'DataCallout',
  'ProTip',
  'HonestRejection',
  'ComparisonTable',
  'AnnotatedDiagnosticPhoto',
  'CaseStudy',
  'SeasonalCalendar',
  'PestDiagnosticTree',
  'WaveGuardLadder',
  'RecommendationQuiz',
  'ContentUpgrade',
  'DisclosureBlock',
  'GrassTypeSection',
  'FAQBlock',
] as const;

export type ComponentName = (typeof COMPONENT_NAMES)[number];

export interface PostTypeRequirement {
  required: ComponentName[];
  recommended?: ComponentName[];
}

// Post-type → required/recommended body components.
//
// Location posts have no body requirements — city-level assets (map
// ribbon, hero image, tracking number) render from frontmatter at the
// template level, not from MDX body invocations. Protocol posts require
// DataCallout for methodology; howto-step structure comes from regular
// markdown headings. Case-study posts require the single CaseStudy
// component — before/after pairs, named neighborhoods, and measurable
// outcomes are its props, not separate components.
export const postTypeRequirements: Record<string, PostTypeRequirement> = {
  decision: {
    required: ['BottomLineBox', 'ComparisonTable', 'HonestRejection'],
  },
  diagnostic: {
    required: ['AnnotatedDiagnosticPhoto', 'PestDiagnosticTree'],
    recommended: ['CaseStudy'],
  },
  seasonal: {
    required: ['SeasonalCalendar', 'ContentUpgrade'],
  },
  protocol: {
    required: ['DataCallout'],
    recommended: ['HonestRejection'],
  },
  cost: {
    required: ['WaveGuardLadder', 'DisclosureBlock', 'ComparisonTable'],
  },
  comparison: {
    required: ['ComparisonTable', 'HonestRejection'],
  },
  'case-study': {
    required: ['CaseStudy'],
  },
  location: {
    required: [],
  },
  'by-grass-type': {
    required: ['GrassTypeSection'],
  },
};

export interface ComponentValidationResult {
  ok: boolean;
  post_type: string;
  missing_required: ComponentName[];
  missing_recommended: ComponentName[];
  unknown_components: string[]; // JSX elements found in body that aren't in COMPONENT_NAMES
}

// Validates authored MDX body against the §10 post-type contract.
//
// Extracts JSX element invocations from the MDX source, intersects with
// the known component catalog, and reports which required/recommended
// components are missing plus any unknown component names used.
//
// Presence check only — does not validate props. Prop validation is a
// future pass once the prop-interface catalog lives alongside this file.
//
// Implementation: strips fenced + inline code so JSX in code samples
// doesn't produce false hits, then regex-matches <PascalCaseName as
// JSX element openings. Upgrade to a full MDX AST walk (remark-mdx) if
// false positives become real.
export function validateMarkdownComponents(
  body_mdx: string,
  frontmatter: { post_type: string },
): ComponentValidationResult {
  const pt = frontmatter.post_type;
  const req = postTypeRequirements[pt] ?? { required: [], recommended: [] };
  const found = extractMdxComponentNames(body_mdx);
  const known = new Set<string>(COMPONENT_NAMES);

  const missingRequired = req.required.filter((name) => !found.has(name));
  const missingRecommended = (req.recommended ?? []).filter(
    (name) => !found.has(name),
  );
  const unknownComponents = [...found].filter((name) => !known.has(name));

  return {
    ok: missingRequired.length === 0,
    post_type: pt,
    missing_required: missingRequired,
    missing_recommended: missingRecommended,
    unknown_components: unknownComponents,
  };
}

function extractMdxComponentNames(mdx: string): Set<string> {
  let cleaned = mdx.replace(/```[\s\S]*?```/g, '');
  cleaned = cleaned.replace(/`[^`\n]*`/g, '');

  const names = new Set<string>();
  const pattern = /<([A-Z][A-Za-z0-9]*)(?=[\s/>])/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(cleaned)) !== null) {
    names.add(match[1]);
  }
  return names;
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
