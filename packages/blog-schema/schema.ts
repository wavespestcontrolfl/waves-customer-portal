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
  'BlogPosting',
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
  // Schema version marker. Optional for backward compat with posts
  // authored before the version field landed; when present must be 2.
  // The migration script sets this to 2 once a post conforms to v2.
  schemaVersion: z.literal(2).optional(),
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
  // fact_checked_by is no longer a required trust-chain field (owner decision —
  // no fabricated fact-check attribution). Kept optional for backward-compat
  // with legacy frontmatter that may still carry it.
  fact_checked_by: z.string().min(1).optional(),

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
// v1 (legacy) frontmatter — permissive shape matching the WP export
// that backs the 198 pre-migration posts. Used only so the publish
// gatekeeper can parse legacy posts without throwing 20 blockers per
// file. v1 posts skip component + props validation entirely.
// ─────────────────────────────────────────────────────────────

export const blogPostFrontmatterV1 = z.looseObject({
  title: z.string().min(1),
  slug: z.string().min(1),
  metaTitle: z.string().optional(),
  metaDescription: z.string().optional(),
  canonical: z.string().optional(),
  date: z.string().optional(),
  modified: z.string().optional(),
  ogImage: z.string().optional().nullable(),
});

export type BlogPostFrontmatterV1 = z.infer<typeof blogPostFrontmatterV1>;

// ─────────────────────────────────────────────────────────────
// Detects which schema applies. Explicit schemaVersion wins; otherwise
// presence of a v2-only field (primary_keyword) triggers v2 handling.
// Everything else is treated as v1. Keeps the gatekeeper usable on
// the 198 legacy posts without forcing a one-shot migration.
// ─────────────────────────────────────────────────────────────

export function detectSchemaVersion(fm: unknown): 1 | 2 {
  if (!fm || typeof fm !== 'object') return 1;
  const obj = fm as Record<string, unknown>;
  if (obj.schemaVersion === 2) return 2;
  if (obj.schemaVersion === 1) return 1;
  if (typeof obj.primary_keyword === 'string') return 2;
  return 1;
}

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
  'PestEvidenceGrid',
] as const;

export type ComponentName = (typeof COMPONENT_NAMES)[number];

// ─────────────────────────────────────────────────────────────
// §10b — Component prop schemas
//
// Each entry in COMPONENT_NAMES has a Zod schema here defining its
// prop surface. This is the contract authors hit when invoking the
// component in MDX, and what the v5b2 validator will check against.
//
// Prop schemas are intentionally lean — required fields are the minimum
// signal the component needs to render meaningfully. Optional fields are
// for affordances (captions, credits, etc.). If a component truly has no
// props (reads everything from frontmatter), its schema is `z.object({})`.
// ─────────────────────────────────────────────────────────────

const waveGuardTierEnum = z.enum(['Bronze', 'Silver', 'Gold', 'Platinum']);
const grassTypeEnum = z.enum(['st-augustine', 'bahia', 'zoysia', 'bermuda']);
const confidenceEnum = z.enum(['high', 'medium', 'low']);
const severityEnum = z.enum(['low', 'medium', 'high']);
const monthEnum = z.enum([
  'jan', 'feb', 'mar', 'apr', 'may', 'jun',
  'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
]);

export const componentPropSchemas = {
  BottomLineBox: z.object({
    verdict: z.string().min(1),
    recommendation: z.string().min(1),
    confidence: confidenceEnum.optional(),
  }),
  WhyTrustUs: z.object({
    // Reads author + reviewer from frontmatter; override props optional.
    hideReviewer: z.boolean().optional(),
  }),
  TLDR: z.object({
    summary: z.string().min(1),
    bullets: z.array(z.string().min(1)).max(7).optional(),
  }),
  DataCallout: z.object({
    stat: z.string().min(1),
    source: z.string().min(1),
    sourceUrl: z.string().url().optional(),
    context: z.string().optional(),
  }),
  ProTip: z.object({
    title: z.string().optional(),
    tip: z.string().min(1),
  }),
  HonestRejection: z.object({
    audience: z.string().min(1),
    reason: z.string().min(1),
  }),
  ComparisonTable: z
    .object({
      columns: z.array(z.string().min(1)).min(2),
      rows: z
        .array(
          z.object({
            label: z.string().min(1),
            values: z.array(z.string()).min(2),
          }),
        )
        .min(1),
      caption: z.string().optional(),
      // 0-based index into the OPTION columns (those after the row-label column)
      // to visually emphasize — e.g. highlight={0} bolds the first option column.
      highlight: z.number().int().min(0).optional(),
    })
    // highlight must reference an existing option column (columns minus the
    // leading row-label column), so the renderer actually emphasizes something.
    // Guarded on columns being a known array — a missing/invalid `columns`
    // already errors in the base object, so the refine just passes through
    // rather than dereferencing undefined.
    .refine((d) => d.highlight === undefined || !Array.isArray(d.columns) || d.highlight < d.columns.length - 1, {
      message: 'highlight must be a 0-based index within the option columns (0..columns.length-2)',
      path: ['highlight'],
    }),
  PestEvidenceGrid: z.object({
    title: z.string().optional(),
    items: z
      .array(
        z.object({
          label: z.string().min(1),
          note: z.string().min(1),
        }),
      )
      .optional(),
    caption: z.string().optional(),
  }),
  AnnotatedDiagnosticPhoto: z.object({
    src: imagePath,
    alt: z.string().min(1),
    caption: z.string().optional(),
    annotations: z
      .array(
        z.object({
          x: z.number().min(0).max(100),
          y: z.number().min(0).max(100),
          label: z.string().min(1),
        }),
      )
      .optional(),
  }),
  CaseStudy: z.object({
    neighborhood: z.string().min(1),
    pest: z.string().min(1),
    before: imagePath,
    after: imagePath,
    outcome: z.string().min(1),
    duration: z.string().optional(),
  }),
  SeasonalCalendar: z.object({
    activities: z
      .array(
        z.object({
          month: monthEnum,
          activity: z.string().min(1),
          severity: severityEnum.optional(),
        }),
      )
      .min(1),
  }),
  PestDiagnosticTree: z.object({
    rootQuestion: z.string().min(1),
    branches: z
      .array(
        z.object({
          condition: z.string().min(1),
          outcome: z.string().min(1),
        }),
      )
      .min(2),
  }),
  WaveGuardLadder: z.object({
    tiers: z.array(waveGuardTierEnum).min(1).max(4).optional(),
    highlight: waveGuardTierEnum.optional(),
  }),
  RecommendationQuiz: z.object({
    id: z.string().min(1),
    questions: z
      .array(
        z.object({
          q: z.string().min(1),
          options: z.array(z.string().min(1)).min(2),
        }),
      )
      .min(1),
  }),
  ContentUpgrade: z.object({
    title: z.string().min(1),
    description: z.string().min(1),
    downloadUrl: z.string().min(1),
    leadMagnet: z.boolean().optional(),
  }),
  DisclosureBlock: z.object({
    type: disclosureType,
    text: z.string().optional(),
  }),
  GrassTypeSection: z.object({
    grass: grassTypeEnum,
    advice: z.string().optional(),
  }),
  FAQBlock: z.object({
    faqs: z
      .array(
        z.object({
          q: z.string().min(1),
          a: z.string().min(1),
        }),
      )
      .min(1),
  }),
} satisfies Record<ComponentName, z.ZodObject>;

export type ComponentPropSchemas = typeof componentPropSchemas;

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
// Per-invocation prop validation (§10b — step 5b2)
//
// Walks every JSX invocation of a known component in the MDX body,
// extracts its attributes, and checks them against the component's
// prop schema from `componentPropSchemas`.
//
// Limitations (intentional, first-pass):
//   - Only string literals and simple literal-expression props are
//     validated ({true}, {false}, {null}, {42}). Complex expressions
//     ({[…]}, {{…}}, {someVariable}) are marked as `unvalidated`
//     and assumed correct at runtime — the validator does not parse
//     arbitrary JS/TS expressions.
//   - Upgrade to a full MDX AST walk (remark-mdx) if false positives
//     from the regex extractor become real.
// ─────────────────────────────────────────────────────────────

export interface ComponentPropIssue {
  component: ComponentName;
  index: number; // 0-based invocation index within the body
  issue: 'missing-required' | 'invalid-value' | 'unknown-prop';
  prop: string;
  message: string;
}

export interface ComponentPropValidationResult {
  ok: boolean;
  issues: ComponentPropIssue[];
  unvalidated_props: Array<{ component: ComponentName; index: number; prop: string }>;
}

export function validateMarkdownComponentProps(
  body_mdx: string,
): ComponentPropValidationResult {
  const cleaned = body_mdx.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
  const invocations = extractComponentInvocations(cleaned);

  const issues: ComponentPropIssue[] = [];
  const unvalidated: ComponentPropValidationResult['unvalidated_props'] = [];
  const perComponentCount: Record<string, number> = {};

  for (const inv of invocations) {
    if (!(inv.name in componentPropSchemas)) continue; // unknown — handled by name validator
    const name = inv.name as ComponentName;
    const idx = (perComponentCount[name] = (perComponentCount[name] ?? 0));
    perComponentCount[name] = idx + 1;

    const schema = componentPropSchemas[name];
    const knownPropNames = new Set(Object.keys(schema.shape));
    const { simple, expressions } = parseJsxProps(inv.attrs);

    // Unknown-prop detection — any prop name not in the schema shape.
    for (const propName of Object.keys(simple)) {
      if (!knownPropNames.has(propName)) {
        issues.push({
          component: name,
          index: idx,
          issue: 'unknown-prop',
          prop: propName,
          message: `<${name}> has unknown prop "${propName}"`,
        });
      }
    }
    for (const propName of expressions) {
      if (!knownPropNames.has(propName)) {
        issues.push({
          component: name,
          index: idx,
          issue: 'unknown-prop',
          prop: propName,
          message: `<${name}> has unknown prop "${propName}"`,
        });
      } else if (!(propName in simple)) {
        unvalidated.push({ component: name, index: idx, prop: propName });
      }
    }

    // Missing-required detection — check before Zod so we can classify.
    // A required prop must have a value in either `simple` or `expressions`.
    for (const propName of knownPropNames) {
      if (propName in simple || expressions.has(propName)) continue;
      if (isOptionalField(schema.shape[propName])) continue;
      issues.push({
        component: name,
        index: idx,
        issue: 'missing-required',
        prop: propName,
        message: `<${name}> is missing required prop "${propName}"`,
      });
    }

    // Invalid-value detection — only validates simple (parseable) props.
    // Expression props are substituted with a placeholder so Zod doesn't
    // reject them; remaining failures are genuine value-shape mismatches.
    const toParse: Record<string, unknown> = {};
    for (const propName of knownPropNames) {
      if (propName in simple) {
        toParse[propName] = simple[propName];
      } else if (expressions.has(propName)) {
        toParse[propName] = placeholderForField(schema.shape[propName]);
      }
    }

    const result = schema.safeParse(toParse);
    if (result.success) continue;

    for (const err of result.error.issues) {
      const propPath = err.path[0];
      const propName = typeof propPath === 'string' ? propPath : '(unknown)';

      // Already reported as missing-required above — skip.
      if (!(propName in toParse)) continue;
      // Expression placeholder — we can't validate the real runtime value.
      if (expressions.has(propName) && !(propName in simple)) continue;

      issues.push({
        component: name,
        index: idx,
        issue: 'invalid-value',
        prop: propName,
        message: `<${name}> prop "${propName}": ${err.message}`,
      });
    }
  }

  return { ok: issues.length === 0, issues, unvalidated_props: unvalidated };
}

// Zod 4 `_def.type` values are lowercase tokens: 'string', 'number',
// 'boolean', 'array', 'object', 'enum', 'optional', 'default', 'nullable'.
// We read them as-is (no case-insensitive matching).

function zodTypeName(field: z.ZodTypeAny): string {
  const def = (field as { _def?: { type?: string; typeName?: string } })._def;
  return (def?.type ?? def?.typeName ?? '').toString();
}

function unwrap(field: z.ZodTypeAny): z.ZodTypeAny | null {
  const inner = (field as unknown as { _def?: { innerType?: z.ZodTypeAny } })._def?.innerType;
  return inner ?? null;
}

function isOptionalField(field: z.ZodTypeAny): boolean {
  const t = zodTypeName(field);
  return t === 'optional' || t === 'default' || t === 'nullable';
}

// For expression-only known props, we pass a placeholder of the right
// type so Zod doesn't mis-report "invalid" on something we've already
// decided to skip validating. Returns a shape-compatible value for the
// common Zod node types in our prop schemas.
function placeholderForField(field: z.ZodTypeAny): unknown {
  const t = zodTypeName(field);
  if (t === 'string') return '__expr__';
  if (t === 'number') return 0;
  if (t === 'boolean') return true;
  if (t === 'array') return [];
  if (t === 'object') return {};
  if (t === 'enum') {
    const values = (field as unknown as { options?: string[] }).options;
    return Array.isArray(values) && values.length ? values[0] : '';
  }
  if (t === 'url') return 'https://example.com';
  const inner = unwrap(field);
  if (inner) return placeholderForField(inner);
  return '__expr__';
}

interface ParsedInvocation {
  name: string;
  attrs: string;
}

function extractComponentInvocations(cleaned: string): ParsedInvocation[] {
  const invocations: ParsedInvocation[] = [];
  // Matches opening tag up to closing `>`, capturing name + raw attr string.
  // Handles self-closing (<Foo ... />) and paired (<Foo ...>…</Foo>).
  const pattern = /<([A-Z][A-Za-z0-9]*)((?:\s+[^>]*?)?)\s*(\/?)>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(cleaned)) !== null) {
    invocations.push({ name: match[1], attrs: match[2] ?? '' });
  }
  return invocations;
}

function parseJsxProps(attrs: string): {
  simple: Record<string, string | boolean | number | null>;
  expressions: Set<string>;
} {
  const simple: Record<string, string | boolean | number | null> = {};
  const expressions = new Set<string>();

  // prop="value"
  const dq = /\b([a-zA-Z_$][\w$]*)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = dq.exec(attrs)) !== null) simple[m[1]] = m[2];

  // prop='value'
  const sq = /\b([a-zA-Z_$][\w$]*)\s*=\s*'([^']*)'/g;
  while ((m = sq.exec(attrs)) !== null) simple[m[1]] = m[2];

  // prop={true|false|null|number}
  const lit = /\b([a-zA-Z_$][\w$]*)\s*=\s*\{\s*(true|false|null|-?\d+(?:\.\d+)?)\s*\}/g;
  while ((m = lit.exec(attrs)) !== null) {
    const raw = m[2];
    simple[m[1]] =
      raw === 'true' ? true : raw === 'false' ? false : raw === 'null' ? null : Number(raw);
  }

  // prop={…anything else…} — record as expression, don't try to parse
  const expr = /\b([a-zA-Z_$][\w$]*)\s*=\s*\{/g;
  while ((m = expr.exec(attrs)) !== null) {
    if (!(m[1] in simple)) expressions.add(m[1]);
  }

  return { simple, expressions };
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
