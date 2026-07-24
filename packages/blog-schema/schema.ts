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
  // Object form per content-ops/blog-linking-strategy.md, matching
  // src/content.config.ts `spokeLinkSchema` (the render-side contract).
  // Max 1: SpokeLinkCallout only consumes spoke_links[0]. The corpus is
  // 100% object-form; the old z.array(z.string()) here was drift that
  // made publish:post block every post with a populated spoke link.
  spoke_links: z
    .array(
      z.object({
        domain: z.string().min(1),
        anchor: z.string().min(1),
        placement: z.enum(['in_body', 'cta', 'both']).optional(),
        vertical: z.string().optional(),
      }),
    )
    .max(1),

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
//
// INVARIANT: every name below MUST be registered in the `mdxComponents`
// map in src/layouts/BlogPostLayout.astro AND have a real implementation
// in src/components/blog/. A cataloged-but-unregistered component passes
// the publish gate here and then crashes the Astro build at merge time
// ("Expected component X to be defined"), so this list is deliberately
// the SUBSET of what the renderer can actually mount.
//
// Removed 2026-07-04 (accepted by the gate but never implemented or
// registered — any .mdx post using them would have failed the fleet
// build): WhyTrustUs, TLDR, DataCallout, ProTip, AnnotatedDiagnosticPhoto,
// CaseStudy, SeasonalCalendar, PestDiagnosticTree, WaveGuardLadder,
// RecommendationQuiz, ContentUpgrade, DisclosureBlock, GrassTypeSection,
// FAQBlock. Re-add a name only after its component ships AND is
// registered in BlogPostLayout's mdxComponents.
// ─────────────────────────────────────────────────────────────

export const COMPONENT_NAMES = [
  'BottomLineBox',
  'HonestRejection',
  'ComparisonTable',
  'SeasonalPressureChart',
  'HomeZoneMap',
  'PestEvidenceGrid',
  'AppPhone',
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

const confidenceEnum = z.enum(['high', 'medium', 'low']);

export const componentPropSchemas = {
  BottomLineBox: z.object({
    verdict: z.string().min(1),
    recommendation: z.string().min(1),
    confidence: confidenceEnum.optional(),
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
    // highlight must reference a column the renderer can actually emphasize.
    // Semantics + bounds:
    //   - The renderer (ComparisonTable.astro) reads highlight as a 0-based
    //     index into the OPTION columns (columns[1..]), so the only renderable
    //     range is 0..columns.length-2. This bound used to be widened to
    //     columns.length-1 to tolerate content written under the
    //     full-column-index convention (highlight={2} meaning the third column
    //     of three). That failed open in the worst way: the out-of-range value
    //     is a SILENT no-op — the table renders with no emphasis at all, so the
    //     "recommended option" the author intended simply never appears, and
    //     nothing anywhere errors. The generator kept emitting {2} on 2-option
    //     tables precisely because nothing rejected it. The bound is now the
    //     true renderable range so the mistake fails loudly at publish time.
    //   - Guarded on `columns` being a plausibly-real parsed array
    //     (length >= 2). When `columns` arrives as an unparseable JSX
    //     expression, the validator substitutes an EMPTY placeholder array
    //     (see placeholderForField); validating highlight against that
    //     fabricated length rejected every literal highlight, so the refine
    //     deliberately fails open (skips) when columns.length < 2. A real
    //     columns array shorter than 2 already errors in the base object.
    .refine(
      (d) =>
        d.highlight === undefined ||
        !Array.isArray(d.columns) ||
        d.columns.length < 2 ||
        d.highlight < d.columns.length - 1,
      {
        message:
          'highlight is a 0-based index into the OPTION columns (those after the row-label column), so the valid range is 0..columns.length-2. For a 2-option table like ["What you get","DIY","Waves"], the Waves column is highlight={1}, NOT {2}.',
        path: ['highlight'],
      },
    ),
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
  AppPhone: z.object({
    src: imagePath,
    alt: z.string().min(1),
    tilt: z.enum(['left', 'right', 'none']).optional(),
    caption: z.string().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
  }),
  // Seasonal pressure band chart — ships with the standard SWFL year baked
  // in, so it renders standalone with zero props (all props are overrides).
  SeasonalPressureChart: z.object({
    title: z.string().min(1).optional(),
    seasons: z
      .array(
        z.object({
          name: z.string().min(1),
          months: z.string().min(1),
          level: z.string().min(1),
          note: z.string().min(1),
        }),
      )
      .min(1)
      .optional(),
    caption: z.string().optional(),
  }),
  // "Where we inspect & treat" schematic — default zone list baked in;
  // renders standalone with zero props (all props are overrides).
  HomeZoneMap: z.object({
    title: z.string().min(1).optional(),
    zones: z
      .array(
        z.object({
          label: z.string().min(1),
          note: z.string().optional(),
        }),
      )
      .min(1)
      .optional(),
    caption: z.string().optional(),
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
// template level, not from MDX body invocations.
//
// 2026-07-04: requirements referencing removed (never-implemented)
// components were pruned — a post type cannot REQUIRE a component the
// renderer can't mount (that made those post types unpublishable:
// omitting the component blocked on missing-required, including it
// blocked on unknown-component and would have crashed the .mdx build).
// Previous contracts, restorable once the components actually ship:
//   diagnostic  required AnnotatedDiagnosticPhoto + PestDiagnosticTree
//               (recommended CaseStudy)
//   seasonal    required SeasonalCalendar + ContentUpgrade
//   protocol    required DataCallout
//   cost        required WaveGuardLadder + DisclosureBlock
//   case-study  required CaseStudy
//   by-grass-type required GrassTypeSection
export const postTypeRequirements: Record<string, PostTypeRequirement> = {
  decision: {
    required: ['BottomLineBox', 'ComparisonTable', 'HonestRejection'],
  },
  diagnostic: {
    required: [],
  },
  seasonal: {
    required: [],
  },
  protocol: {
    required: [],
    recommended: ['HonestRejection'],
  },
  cost: {
    required: ['ComparisonTable'],
  },
  comparison: {
    required: ['ComparisonTable', 'HonestRejection'],
  },
  'case-study': {
    required: [],
  },
  location: {
    required: [],
  },
  'by-grass-type': {
    required: [],
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
//   - String literals, simple literal expressions ({true}, {false},
//     {null}, {42}) and JSON-shaped container expressions
//     ({["a", "b"]}, {{"k": "v"}}) are validated against their real
//     values. Anything else ({someVariable}, JS-flavored object
//     literals with unquoted keys, trailing commas, …) is marked as
//     `unvalidated` and assumed correct at runtime — the validator
//     does not evaluate arbitrary JS/TS expressions.
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
  simple: Record<string, unknown>;
  expressions: Set<string>;
} {
  const simple: Record<string, unknown> = {};
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

  // prop={…expression…} — extract the balanced expression body and try to
  // statically parse it as JSON (covers the common authored shape
  // columns={["a", "b", "c"]}). A successful parse yields the REAL value,
  // so downstream checks (e.g. ComparisonTable's highlight range refine)
  // validate against actual element counts instead of a fabricated
  // placeholder. Anything that isn't statically parseable stays an
  // opaque expression and is skipped (fail-open), exactly as before.
  const expr = /\b([a-zA-Z_$][\w$]*)\s*=\s*\{/g;
  while ((m = expr.exec(attrs)) !== null) {
    const propName = m[1];
    if (propName in simple) continue;
    const body = extractBalancedExpression(attrs, expr.lastIndex - 1);
    const parsed = body === null ? undefined : tryParseStaticJson(body);
    if (parsed !== undefined) {
      simple[propName] = parsed.value;
    } else {
      expressions.add(propName);
    }
  }

  return { simple, expressions };
}

// Given the index of an opening `{`, returns the expression text between it
// and its balancing `}` (exclusive), honoring nested braces/brackets and
// quoted strings. Returns null when the braces never balance (e.g. the attr
// string was truncated by the invocation-extraction regex).
function extractBalancedExpression(text: string, openBraceIdx: number): string | null {
  let depth = 0;
  let quote: '"' | "'" | null = null;
  for (let i = openBraceIdx; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i++; // skip escaped char inside a string
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return text.slice(openBraceIdx + 1, i);
    }
  }
  return null;
}

// Strict JSON.parse wrapper. Wrapped result distinguishes "parsed to a
// value" (including null) from "not statically parseable" (undefined).
function tryParseStaticJson(body: string): { value: unknown } | undefined {
  const trimmed = body.trim();
  // Only attempt containers here — scalar literals are handled by the
  // dedicated regexes above, and bare identifiers must stay expressions.
  if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return undefined;
  try {
    return { value: JSON.parse(trimmed) };
  } catch {
    // JSX authoring style is JS, not strict JSON — tolerate trailing
    // commas, single-quoted strings, and multi-line layout so a real
    // columns array still yields its true length for the highlight refine.
    // JSX authoring is JS, not JSON — walk the text converting
    // single-quoted strings to double-quoted while leaving double-quoted
    // spans (which may contain apostrophes) untouched, then drop trailing
    // commas outside strings.
    try {
      let out = '';
      for (let i = 0; i < trimmed.length; i += 1) {
        const ch = trimmed[i];
        if (ch === '"') {
          let j = i + 1;
          while (j < trimmed.length && trimmed[j] !== '"') { if (trimmed[j] === '\\') j += 1; j += 1; }
          out += trimmed.slice(i, j + 1);
          i = j;
        } else if (ch === "'") {
          let j = i + 1; let inner = '';
          while (j < trimmed.length && trimmed[j] !== "'") {
            if (trimmed[j] === '\\') { inner += trimmed[j + 1]; j += 2; continue; }
            inner += trimmed[j]; j += 1;
          }
          out += JSON.stringify(inner);
          i = j;
        } else {
          out += ch;
        }
      }
      return { value: JSON.parse(out.replace(/,\s*([\]}])/g, '$1')) };
    } catch {
      return undefined;
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Service-area claims — blocks copy that says Waves works somewhere it doesn't.
// ─────────────────────────────────────────────────────────────

// Large/nearby Florida markets that are NOT in the service area (SERVICE_AREAS
// in ./service-areas.ts is the allowlist). These are the names that actually
// leak: the content engine is told to write for "Southwest Florida", and the
// region's most recognizable cities — Naples, Fort Myers, Cape Coral — are all
// in Collier/Lee, outside the Manatee/Sarasota/Charlotte footprint.
const NON_SERVICE_AREA_CITY_CANDIDATES = [
  'Naples',
  'Fort Myers',
  'Cape Coral',
  'Bonita Springs',
  'Estero',
  'Marco Island',
  'Lehigh Acres',
  'Tampa',
  'St. Petersburg',
  'Clearwater',
  'Orlando',
  'Miami',
  'Jacksonville',
  'Fort Lauderdale',
  // Major FL metros the portal-side gate also blocks (parity).
  'Tallahassee',
  'Gainesville',
  'Lakeland',
  'Kissimmee',
  'Ocala',
  'Port St. Lucie',
  'West Palm Beach',
  'Hialeah',
  'Boca Raton',
  'Winter Haven',
  'Plant City',
  // Broader FL metros (curated — full-state coverage stays a curated list
  // by design; the SERVICE_AREAS filter guards legitimate expansions).
  'Daytona Beach',
  'Melbourne',
  'Palm Bay',
  'Vero Beach',
  'Fort Pierce',
  'Pensacola',
  'Panama City',
  'Spring Hill',
  'Brooksville',
  // Nearby SWFL towns/islands a regional writer plausibly names.
  'Sanibel',
  'Captiva',
  'Arcadia',
  'Sebring',
  'Immokalee',
  'LaBelle',
  // County-level phrasings of the same out-of-area markets. Footprint
  // counties (Manatee/Sarasota/Charlotte, plus served south Hillsborough)
  // are deliberately absent.
  'Lee County',
  'Collier County',
  'Pinellas County',
  'Hendry County',
  'DeSoto County',
  'Polk County',
  'Miami-Dade County',
  'Broward County',
] as const;

// Filtered against the SERVICE_AREAS allowlist at module load so a legitimate
// expansion (a service-areas.ts bump, per the package README) automatically
// drops the city from the blocklist — the two sources can never disagree.
const NON_SERVICE_AREA_CITIES: readonly string[] =
  NON_SERVICE_AREA_CITY_CANDIDATES.filter(
    (city) => !(SERVICE_AREAS as readonly string[]).includes(city),
  );

// First-person service language. Deliberately narrow: this must match a claim
// that WAVES OPERATES somewhere, not a CTA or a factual mention. `we serve` is
// guarded against "we serve up ..." (a weather/humidity idiom in existing copy).
//
// Two families, both corpus-validated to zero false positives across the 223
// posts in this repo:
//   - direct operation ("our techs treat", "we service")
//   - demand signal, which implies operation just as strongly ("the call is one
//     of the most common we get" alongside an out-of-area city)
// Bare CTA verbs (book / schedule / call us) are deliberately EXCLUDED: a CTA
// next to a factual city mention is not a service claim, and including them
// flagged legitimate pest-range copy.
// First- AND third-person: brand-name phrasing ("Waves Pest Control serves
// Naples") and spoke-shared token copy ("{{brandName}} treats Cape Coral
// homes") assert operation exactly like "we serve".
// "our techs/team" needs an OPERATION VERB nearby — a bare team mention
// ("our team reviewed Miami termite research") is not a service claim.
// Brand tokens match any {{brand*}} form (brandName, brandShort, spaced) —
// the gate scans RAW frontmatter/body before Astro token substitution, and
// every brand token renders as a Waves identity. The verb group covers the
// participial "serving" launch phrasing ("now serving customers in …") that
// existing copy already uses.
// "serve up" stays idiom on the brand branch too ("Waves serves up a
// Naples-vs-Sarasota comparison" is blog copy, not an operating claim).
const CLAIM_VERB_SOURCE =
  '(?:is |are |can |could |will |do |does |has |have |had )?(?:been )?(?:now |proudly |also |currently |still )?(?:serv(?:e|es|ed)\\b(?!\\s+up\\b(?!\\s+(?:[\\w-]+\\s+){0,2}?(?:pest|mosquito|termite|rodent|lawn|tree|shrub)\\s+(?:control|care|treatment|service)s?\\b(?!\\s+(?:tips?|advice|research|info\\w*|guides?|facts?|insights?|news|myths?)\\b)))|serving\\b(?!\\s+up\\b(?!\\s+(?:[\\w-]+\\s+){0,2}?(?:pest|mosquito|termite|rodent|lawn|tree|shrub)\\s+(?:control|care|treatment|service)s?\\b(?!\\s+(?:tips?|advice|research|info\\w*|guides?|facts?|insights?|news|myths?)\\b)))|servic\\w+\\b|treat(?:s|ed|ing)?\\b|cover(?:s|ed|ing)?\\b|exterminat\\w+\\b|remov(?:e|es|ed|ing)\\b|eliminat\\w+\\b|visit(?:s|ed|ing)?\\b|spray(?:s|ed|ing)?\\b|inspect\\w*\\b|handl\\w+\\b|protect\\w*\\b|get(?:s|ting)? rid of\\b|control(?:s|led|ling)?\\b(?!\\s+(?:panels?|groups?|measures?)\\b)|bring(?:s|ing)?\\b|brought\\b|send(?:s|ing)?\\b|sent\\b|dispatch(?:es|ed|ing)?\\b|fertiliz(?:e|es|ed|ing)\\b|maintain(?:s|ed|ing)?\\b|mow(?:s|ed|ing)?\\b|aerat\\w+\\b|help(?:s|ing|ed)?\\b(?!\\s+(?:[\\w.-]+\\s+){0,2}?(?:you|readers?|homeowners?|residents?)\\s+(?:understand|identify|learn|compare|decide|research|choose|spot)\\b)|manag(?:e|es|ed|ing)\\b(?!\\s+to\\b)|control(?:s|led|ling)?\\b(?!\\s+(?:panels?|groups?|measures?)\\b)|includ(?:e|es|ed|ing)\\b(?![^.!?]{0,30}\\b(?:data|research|weather|statistics|figures|information|charts?|tables?|topics?|sources?|studies)\\b)|proud to (?:serve|service|treat|cover|protect)\\b|work(?:s|ed|ing)? (?:in|throughout|across|around)\\b|operat(?:es|ed|ing)? (?:in|throughout|across|around)\\b)';

// Service-family keyword phrase. On its own this is NOT a claim — it needs
// commercial context (need/get/book …, "<kw> in/near/for", your/our) so
// factual research copy ("University of Florida termite treatment research
// in Miami") passes while packaging copy ("Need mosquito control in Cape
// Coral?", "Naples pest control guide") flags via the city loop.
// Lead nouns chain through conjunctions — "tree and shrub care", "lawn &
// pest control" are single service phrases, not two failed half-matches.
const SERVICE_NOUN_SOURCE =
  '(?:pest|mosquito|termite|rodent|lawn|tree|shrub|bed.?bugs?|wdo|ants?|fire.?ants?|cockroach(?:es)?|roach(?:es)?|fleas?|ticks?|spiders?|wasps?|hornets?|bees?|rats?|mice|mouse|scorpions?|silverfish|earwigs?|crickets?|wildlife|weeds?|grubs?|chinch.?bugs?)';
// The optional trailing "services/plans/programs" keeps compound phrasings
// like "pest control services in Naples" inside one keyword match — the
// in/near/for context arm anchors right after the keyword.
// Standalone agent/process nouns ("an exterminator in Naples",
// "extermination in Tampa") are packaging keywords on their own — no
// leading service noun required. \b closes both alternatives so the
// keyword can never end mid-word.
const SERVICE_KEYWORD_SOURCE =
  `(?:${SERVICE_NOUN_SOURCE}(?:\\s*(?:,|and|&|\\/|\\+)\\s*${SERVICE_NOUN_SOURCE})*\\s+(?:control|care|removal|treatment|exterminat\\w+|inspection|service|fertiliz\\w+|maintenance|mowing|aeration|seeding)s?(?:\\s+(?:service|plan|program)s?\\b(?!\\s+guides?\\b))?|exterminat(?:ors?|ions?)\\b|waveguard(?:\\s+(?:membership|plan|program|tier)s?)?\\b)`;
// First-person verbs allow an auxiliary/adverb between subject and verb —
// "we are treating homes in Naples", "we currently serve Tampa" claim
// operation exactly like the bare forms. "we serve up …" (idiom) stays
// excluded.
// Customer-demand arms bind to their own city (see the city loop): kept as
// a named source so the loop can match demand spans with the same pattern
// the claim regex embeds.
const DEMAND_CONTEXT_SOURCE =
  `(?:calls?|questions?|requests?)\\b[^.!?]{0,40}\\bwe (?:get|see|receive)\\b(?:\\s+(?:from|in|across|throughout)\\s+(?:(?!about\\b|regarding\\b|concerning\\b|whether\\b|if\\b|ask\\w*\\b|compar\\w*\\b|call\\w*\\b|text\\w*\\b|contact\\w*\\b|wonder\\w*\\b|says?\\b|tells?\\b|report\\w*\\b|complain\\w*\\b|mention\\w*\\b|discuss\\w*\\b|debat\\w*\\b|research\\b|records?\\b|data\\b|studies\\b|forums?\\b|threads?\\b)[\\w.']+\\s*){1,3}(?!\\s*(?:research|records?|data|studies|forums?|threads?|reports?)\\b))?|we (?:get|see|receive)\\b[^.!?]{0,40}\\b(?:calls?|questions?|requests?|customers?)\\b(?:\\s+about\\s+(?:[\\w-]+\\s+){0,4}?(?=(?:from|in|across|throughout)\\s))?(?:\\s*(?:from|in|across|throughout)\\s+(?:(?!about\\b|regarding\\b|concerning\\b|whether\\b|if\\b|ask\\w*\\b|compar\\w*\\b|call\\w*\\b|text\\w*\\b|contact\\w*\\b|wonder\\w*\\b|says?\\b|tells?\\b|report\\w*\\b|complain\\w*\\b|mention\\w*\\b|discuss\\w*\\b|debat\\w*\\b|research\\b|records?\\b|data\\b|studies\\b|forums?\\b|threads?\\b)[\\w.']+\\s*){1,3}(?!\\s*(?:research|records?|data|studies|forums?|threads?|reports?)\\b))?|our calls?\\b(?:\\s+(?:from|in|across|throughout)\\s+(?:(?!about\\b|regarding\\b|concerning\\b|whether\\b|if\\b|ask\\w*\\b|compar\\w*\\b|call\\w*\\b|text\\w*\\b|contact\\w*\\b|wonder\\w*\\b|says?\\b|tells?\\b|report\\w*\\b|complain\\w*\\b|mention\\w*\\b|discuss\\w*\\b|debat\\w*\\b|research\\b|records?\\b|data\\b|studies\\b|forums?\\b|threads?\\b)[\\w.']+\\s*){1,3}(?!\\s*(?:research|records?|data|studies|forums?|threads?|reports?)\\b))?|(?:[\\w.'-]+\\s+){0,3}?(?:customers?|homeowners?|residents?|neighbors?)\\s+(?:\\w+\\s+){0,3}?(?:call|text|contact|ask)s?\\s+(?:us\\b|waves\\w*\\b|our\\s+(?:team|office|techs?|technicians?)\\b)(?:\\s+(?:from|in|across|throughout)\\s+(?:(?!about\\b|regarding\\b|concerning\\b|whether\\b|if\\b|ask\\w*\\b|compar\\w*\\b|call\\w*\\b|text\\w*\\b|contact\\w*\\b|wonder\\w*\\b|says?\\b|tells?\\b|report\\w*\\b|complain\\w*\\b|mention\\w*\\b|discuss\\w*\\b|debat\\w*\\b|research\\b|records?\\b|data\\b|studies\\b|forums?\\b|threads?\\b)[\\w.']+\\s*){1,3}(?!\\s*(?:research|records?|data|studies|forums?|threads?|reports?)\\b))?|(?:waves(?: pest control)?(?:'s|')?)\\s+(?:\\w+\\s+){0,2}?customers\\b(?:\\s+(?:in|from|across|throughout)\\s+(?:(?!about\\b)[\\w.']+\\s*){1,3}(?!\\s*(?:research|records?|data|studies|forums?|threads?|reports?)\\b))?|our\\s+(?:[\\w.']+\\s+){0,3}?customers\\b(?:\\s+(?:in|from|across|throughout)\\s+(?:(?!about\\b|regarding\\b|concerning\\b|whether\\b|if\\b|ask\\w*\\b|compar\\w*\\b|call\\w*\\b|text\\w*\\b|contact\\w*\\b|wonder\\w*\\b|says?\\b|tells?\\b|report\\w*\\b|complain\\w*\\b|mention\\w*\\b|discuss\\w*\\b|debat\\w*\\b|research\\b|records?\\b|data\\b|studies\\b|forums?\\b|threads?\\b)[\\w.']+\\s*){1,3}(?!\\s*(?:research|records?|data|studies|forums?|threads?|reports?)\\b))?`;

const SERVICE_CLAIM_PATTERN = new RegExp(
  `((?:our|waves(?: pest control)?(?:'s|')?|\\{\\{\\s*brand\\w*\\s*\\}\\}) (?:[\\w-]+ ){0,3}?(?:technicians?|techs?|team|routes?|trucks?|vans?|crews?|offices?|branch(?:es)?|plans?|programs?|memberships?|pros?|specialists?|experts?|applicators?|staff|inspectors?)(?: \\w+){0,4} (?:offer(?:s|ed|ing)?\\b|provid(?:e|es|ed|ing)\\b|deliver(?:s|ed|ing)?\\b|control(?:s|led|ling)?\\b(?!\\s+(?:panels?|groups?|measures?)\\b)|treat(?:s|ing|ed)?\\b|serv(?:e|es|ed)\\b(?!\\s+up\\b(?!\\s+(?:[\\w-]+\\s+){0,2}?(?:pest|mosquito|termite|rodent|lawn|tree|shrub)\\s+(?:control|care|treatment|service)s?\\b(?!\\s+(?:tips?|advice|research|info\\w*|guides?|facts?|insights?|news|myths?)\\b)))|serving\\b(?!\\s+up\\b(?!\\s+(?:[\\w-]+\\s+){0,2}?(?:pest|mosquito|termite|rodent|lawn|tree|shrub)\\s+(?:control|care|treatment|service)s?\\b(?!\\s+(?:tips?|advice|research|info\\w*|guides?|facts?|insights?|news|myths?)\\b)))|servic\\w+\\b|cover(?:s|ing|ed)?\\b|visit(?:s|ing|ed)?\\b|inspect(?:s|ing|ed)?\\b|handl(?:e|es|ing|ed)\\b|spray(?:s|ing|ed)?\\b|run(?:s|ning)?\\b|work(?:s|ing|ed)? in\\b|operat(?:e|es|ing|ed)? in\\b|roll(?:s|ing)? out\\b|available (?:in|throughout|across|to|for|near)\\b|includ(?:e|es|ed|ing)\\b|help(?:s|ing|ed)?\\b(?!\\s+(?:[\\w.-]+\\s+){0,2}?(?:you|readers?|homeowners?|residents?)\\s+(?:understand|identify|learn|compare|decide|research|choose|spot)\\b)|get(?:s|ting)? rid of\\b|extend(?:s|ed|ing)? (?:to|into)\\b|reach(?:es|ed|ing)?\\b|protect(?:s|ing|ed)?\\b|exterminat\\w+\\b|remov(?:e|es|ed|ing)\\b|eliminat\\w+\\b|proud to (?:serve|service|treat|cover|protect)\\b)`
  + `|we(?:'re| are|'ll| will| can| could| do| does|'ve| have| has| had)?(?: been)?(?: currently| now| proudly| also| still| \\w+ly)? (?:treat(?:s|ing|ed)?\\b|servic\\w+\\b|serv(?:e|es|ing|ed)\\b:?(?!\\s+up\\b(?!\\s+(?:[\\w-]+\\s+){0,2}?(?:pest|mosquito|termite|rodent|lawn|tree|shrub)\\s+(?:control|care|treatment|service)s?\\b(?!\\s+(?:tips?|advice|research|info\\w*|guides?|facts?|insights?|news|myths?)\\b)))|cover(?:s|ing|ed)?\\b|inspect(?:s|ing|ed)?\\b|handl(?:e|es|ing|ed)\\b|protect(?:s|ing|ed)?\\b|visit(?:s|ing|ed)?\\b|spray(?:s|ing|ed)?\\b|exterminat\\w+\\b|remov(?:e|es|ed|ing)\\b|eliminat\\w+\\b|get(?:s|ting)? rid of\\b|control(?:s|led|ling)?\\b(?!\\s+(?:panels?|groups?|measures?)\\b)|bring(?:s|ing)?\\b|brought\\b|send(?:s|ing)?\\b|sent\\b|dispatch(?:es|ed|ing)?\\b|fertiliz(?:e|es|ed|ing)\\b|maintain(?:s|ed|ing)?\\b|mow(?:s|ed|ing)?\\b|aerat\\w+\\b|help(?:s|ing|ed)?\\b(?!\\s+(?:[\\w.-]+\\s+){0,2}?(?:you|readers?|homeowners?|residents?)\\s+(?:understand|identify|learn|compare|decide|research|choose|spot)\\b)|manag(?:e|es|ed|ing)\\b(?!\\s+to\\b))`
  + `|we(?:'re| are)? proud to (?:serve|service|treat|cover|protect)\\b`
  + `|${SERVICE_KEYWORD_SOURCE}\\s+(?:is\\s+|are\\s+)?now\\s+available\\s+(?:in|to|for|near|throughout|across)\\b(?![^.!?]{0,40}\\b(?:by|from)\\s+(?:the\\s+county|the\\s+city|the\\s+state|counties|municipalit\\w+|other\\s+(?:compan|provider|firm)\\w*|competitors?|national\\s+chains?|local\\s+(?:compan|provider|firm)\\w*)\\b)|now offering\\b[^.!?]{0,30}?\\b${SERVICE_KEYWORD_SOURCE}\\b`
  + `|(?:services?|plans?|programs?|treatments?)\\s*:\\s*available\\s+(?:in|to|for|near|throughout|across)\\b(?![^.!?]{0,40}\\b(?:by|from)\\s+(?:the\\s+county|the\\s+city|the\\s+state|counties|municipalit\\w+|other\\s+(?:compan|provider|firm)\\w*|competitors?|national\\s+chains?|local\\s+(?:compan|provider|firm)\\w*)\\b)|^\\s*available\\s+(?:in|to|for|near|throughout|across)\\b(?![^.!?]{0,40}\\b(?:by|from)\\s+(?:the\\s+county|the\\s+city|the\\s+state|counties|municipalit\\w+|other\\s+(?:compan|provider|firm)\\w*|competitors?|national\\s+chains?|local\\s+(?:compan|provider|firm)\\w*)\\b)`
  + `|(?:we(?:'ve| have)?|waves(?: pest control)?(?:'s|')?(?: has| have)?)\\s+got\\s+(?:you|your\\s+\\w+)\\s+covered\\b|(?:waves(?: pest control)?(?:'s|')?|we)\\s+(?:has|have)\\s+you\\s+covered\\b`
  + `|(?:we(?:'re| are)?|waves(?: pest control)?(?:'s|')?(?: is| are)?|our (?:team|techs?|technicians?|crews?)(?: is| are)?)\\s*here to help\\b(?!\\s+(?:[\\w.-]+\\s+){0,2}?(?:you|readers?|homeowners?|residents?)\\s+(?:understand|identify|learn|compare|decide|research|choose|spot)\\b)`
  + `|(?:we|waves(?: pest control)?(?:'s|')?|\\{\\{\\s*brand\\w*\\s*\\}\\})\\s+(?:(?:have|has|had)\\s+)?(?:expand(?:ed|s|ing)?|grew|grown|growing|moved?|moving)\\s+(?:into|to|toward)\\b|(?:we|waves(?: pest control)?(?:'s|')?)\\s+(?:have|has|had)\\s+(?:\\w+\\s+){0,2}?customers\\s+(?:in|across|throughout)\\b`
  + `|(?:we|waves(?: pest control)?(?:'s|')?|\\{\\{\\s*brand\\w*\\s*\\}\\})\\s+(?:run|runs|running|have|has|had|operate|operates)\\s+(?:\\w+\\s+){0,4}?(?:routes?|offices?|branch(?:es)?|locations?|storefronts?)\\b`
  + `|(?:is|are|has been|have been)\\s+(?:proudly\\s+|now\\s+|regularly\\s+)?(?:covered|served|serviced|treated|protected|inspected|sprayed|visited|handled|controlled|maintained)\\s+by\\s+(?:waves(?: pest control)?(?:'s|')?|waveguard|\\{\\{\\s*brand\\w*\\s*\\}\\}|our\\s+(?:team|techs?|technicians?|crews?))\\b`
  + `|we(?:'re| are)\\s+(?:now\\s+|also\\s+|still\\s+|currently\\s+)?available\\s+(?:in|throughout|across|to|for|near)\\b`
  + `|(?<!\\bno\\s+(?:[\\w']+\\s+){0,2})(?<!\\bnot\\s+(?:[\\w']+\\s+){0,2})${SERVICE_KEYWORD_SOURCE}\\s+(?:is|are|can be|may be)\\s+(?:now\\s+)?(?:available|offered|provided|booked|bookable|scheduled|requested|reserved)\\s*(?:to|for|in|near|throughout|across)\\b(?![^.!?]{0,40}\\b(?:by|from)\\s+(?:the\\s+county|the\\s+city|the\\s+state|counties|municipalit\\w+|other\\s+(?:compan|provider|firm)\\w*|competitors?|national\\s+chains?|local\\s+(?:compan|provider|firm)\\w*)\\b)`
  + `|our (?:[\\w-]+\\s+){0,3}?(?:(?:service|coverage)\\s+)?(?:areas?|footprints?)(?:\\s*(?=:)|\\s+(?:now\\s+)?(?:includes?|covers?|extends?|reaches?|adds?|added|gained|grew|grows|growing)\\b)|(?:part of|one of|includ(?:ed|ing) in|joins?|joined|joining|added to|adding to|expands? (?:to|into)|expanding (?:to|into)|within|inside)\\s+our (?:(?:service|coverage)\\s+)?(?:areas?|footprints?)\\b|our (?:[\\w-]+\\s+){0,3}?coverage\\s+(?:now\\s+)?(?:includes?|covers?|extends?|reaches?|adds?|added|grew|grows|growing)\\b|(?:is|are|lies?|sits?|falls?)\\s+(?:now\\s+|currently\\s+|proudly\\s+)?in\\s+our (?:(?:service|coverage)\\s+)?(?:areas?|footprints?)\\b|(?:is|are)\\s+(?:now\\s+|also\\s+|officially\\s+)?(?:(?:a|our|one of our|among our)\\s+)?(?:newest\\s+)?(?:service|coverage)\\s+(?:areas?|footprints?)\\b|(?:add(?:s|ed|ing)?|welcom(?:e|es|ed|ing))\\b[^.!?]{0,30}?\\bto our (?:(?:service|coverage)\\s+)?(?:areas?|footprints?)\\b|(?:expand(?:s|ed|ing)?|extend(?:s|ed|ing)?|grew|grow(?:s|ing)?)\\s+our (?:(?:service|coverage)\\s+)?(?:areas?|footprints?)\\s+(?:to|into)\\b|our customers in\\b|^\\s*(?:and |but |yet )?(?:also |now |still |currently )?(?:includes?|covers?|extends? (?:to|into)|reaches?|serves?|services?|treats?|visits?|sprays?|inspects?|protects?|handles?|helps?)\\b(?!\\s*:)(?!\\s+up\\b(?!\\s+(?:[\\w-]+\\s+){0,2}?(?:pest|mosquito|termite|rodent|lawn|tree|shrub)\\s+(?:control|care|treatment|service)s?\\b(?!\\s+(?:tips?|advice|research|info\\w*|guides?|facts?|insights?|news|myths?)\\b)))(?![^.!?]{0,30}\\b(?:data|research|weather|statistics|figures|information|charts?|tables?|topics?|sources?|studies)\\b)|we(?:'re| are|'ll| will|'ve| have)?(?: been)?(?: also| now| currently| proudly| still)? (?:work(?:s|ed|ing)?|operat(?:e|es|ed|ing)) (?:in|throughout|across|around)\\b(?!\\s+(?:\\w+\\s+){0,2}?(?:records?|data|datasets?|research|studies|regulations?|rules|ordinances?|history|archives?|reports?|statistics|literature|documents?)\\b)|\\b(?:and|or)\\s+(?:now\\s+|currently\\s+|\\w+ly\\s+)?(?:work(?:s|ing)?|operat(?:e|es|ing)) (?:in|throughout|across|around)\\b|\\b(?:and|or|but)\\s+(?:now\\s+|currently\\s+|also\\s+|still\\s+|\\w+ly\\s+)?(?:visit|visits|spray|sprays|treat|treats|cover|covers|protect|protects|inspect|inspects|handle|handles|serve|serves|service|services|include|includes|extend|extends|reach|reaches)\\b(?!\\s+up\\b(?!\\s+(?:[\\w-]+\\s+){0,2}?(?:pest|mosquito|termite|rodent|lawn|tree|shrub)\\s+(?:control|care|treatment|service)s?\\b(?!\\s+(?:tips?|advice|research|info\\w*|guides?|facts?|insights?|news|myths?)\\b)))(?!\\s+(?:\\w+\\s+){0,2}?(?:records?|data|datasets?|research|studies|regulations?|rules|ordinances?|history|archives?|reports?|statistics|literature|documents?)\\b)`
  + `|${DEMAND_CONTEXT_SOURCE}|(?<!\\bnot\\s)(?<!\\bnever\\s)(?<!\\bstopped\\s)(?:now|currently|still|proudly|also) serving\\b(?!\\s+up\\b(?!\\s+(?:[\\w-]+\\s+){0,2}?(?:pest|mosquito|termite|rodent|lawn|tree|shrub)\\s+(?:control|care|treatment|service)s?\\b(?!\\s+(?:tips?|advice|research|info\\w*|guides?|facts?|insights?|news|myths?)\\b)))|proudly serv\\w*\\b(?!\\s+up\\b(?!\\s+(?:[\\w-]+\\s+){0,2}?(?:pest|mosquito|termite|rodent|lawn|tree|shrub)\\s+(?:control|care|treatment|service)s?\\b(?!\\s+(?:tips?|advice|research|info\\w*|guides?|facts?|insights?|news|myths?)\\b)))|(?:^|,)\\s*serving\\b(?!\\s+up\\b(?!\\s+(?:[\\w-]+\\s+){0,2}?(?:pest|mosquito|termite|rodent|lawn|tree|shrub)\\s+(?:control|care|treatment|service)s?\\b(?!\\s+(?:tips?|advice|research|info\\w*|guides?|facts?|insights?|news|myths?)\\b)))`
  // offer/provide/deliver assert operation like serve/treat, but ONLY when
  // a service-shaped noun is the verb's OBJECT (≤2 modifier words between)
  // — "we offer a Naples-vs-Sarasota comparison" and "we deliver pest
  // research" are editorial, "we offer pest control services in Naples" is
  // an operating claim.
  + `|(?:we|waves(?: pest control)?|waveguard|\\{\\{\\s*brand\\w*\\s*\\}\\})(?:'re| are|'ll| will| can| could| do| does|'ve| have| has| had)?(?: been)?(?: currently| now| proudly| also| still)? (?:offer|provid|deliver)\\w*\\s+(?:(?!(?:research|information|info|advice|guidance|tips|insights?|education|educational|resources?|articles?|guides?|content|news|about|on|regarding|of|for|to)\\b)[a-z-]+\\s+){0,2}?(?:(?:pest|mosquito|termite|rodent|lawn|tree|shrub|bed.?bugs?|wdo)\\s+)?(?:control|care|treatment|service|plan|program|inspection|removal|exterminat|waveguard)\\w*\\b(?!\\s+(?:(?!(?:and|or|nor|plus|as)\\b)[a-z-]+\\s+){0,2}?(?:research|information|info|advice|guidance|tips|insights?|education|educational|resources?|articles?|guides?|content|news|facts?|myths?|history|overviews?|checklists?|comparisons?|roundups?|director(?:y|ies)|summar(?:y|ies)|glossar(?:y|ies)|calendars?|faqs?)\\b)`
  // Editorial-FIRST mixed objects ("we provide pest control advice and
  // services in Naples") — an in/near-anchored "…services in <place>" after
  // a first-person/brand offer verb is an operating claim no matter what
  // editorial noun sits between.
  + `|(?:we|waves(?: pest control)?|waveguard|\\{\\{\\s*brand\\w*\\s*\\}\\})(?:'re| are|'ll| will| can| could| do| does|'ve| have| has| had)?(?: been)?(?: currently| now| proudly| also| still)? (?:offer|provid|deliver)\\w*\\b(?:(?!\\b(?:about|regarding|concerning|on|for|director(?:y|ies)|lists?|overview|roundup|comparison|index|map)\\b)[^.!?;]){0,40}?\\bservices?\\s+(?:in|near|throughout|across)\\b`
  + `|(?<!\\b(?:can't|cannot|can not|won't|will not|don't|do not|doesn't|does not|couldn't|could not|shouldn't|should not|never|unable to|no way to|no)\\s+)(?:need|get|find|book|schedule|looking for|searching for)\\b[^.!?]{0,30}?\\b${SERVICE_KEYWORD_SOURCE}\\b(?![^.!?]{0,40}\\bwith\\s+(?:another|other|a different|any|that|your current)\\s+(?:compan|provider|firm|exterminator)\\w*)(?![^.!?]{0,60}\\b(?:contact|call|hire|choose|find|use)\\s+(?:a\\s+|an\\s+|your\\s+)?(?:local|nearby|area|another|different|licensed)\\s+(?:provider|compan(?:y|ies)|firm|exterminator|pro(?:fessional)?)s?\\b)(?![^.!?]{0,60}\\b(?:we|waves\\w*)\\b[^.!?]{0,20}?\\b(?:do not|don'?t|does not|doesn'?t|cannot|can'?t|won'?t)\\b)`
  // A short punctuation-free segment built around the keyword is a bare
  // packaging TITLE/META ("Cape Coral pest control services") — prose
  // sentences carry terminal punctuation and never match the anchored form.
  + `|^(?:(?!\\b(?:not|no|never|unavailable|unserved|isn|aren|without)\\b)[^.!?]){0,25}${SERVICE_KEYWORD_SOURCE}(?!(?:\\s+(?:service|plan|program)s?)?\\s+(?:guides?|research|information|info|advice|tips|insights?|education|resources?|articles?|content|news|myths?|history|faqs?)\\b)(?:(?!\\b(?:not|no|never|unavailable|unserved|isn|aren)\\b)[^.!?]){0,25}$`
  + `|\\b(?<!\\b(?:about|regarding|concerning|on)\\b[^.!?]{0,20})(?<!\\bcompar\\w+\\b[^.!?]{0,25})(?<!\\b(?:director(?:y|ies)|lists?|overview|roundup|comparison|index|map)\\s+of\\b[^.!?]{0,20})(?<!\\b(?:provid|offer|deliver)\\w*\\b[^.!?]{0,30}\\bfor\\b[^.!?]{0,20})(?<!\\b(?:competitors?|other\\s+(?:compan|provider|firm)\\w*|national\\s+chains?|local\\s+(?:compan|provider|firm)\\w*|the\\s+county|the\\s+city|the\\s+state|counties|municipalit\\w+)\\b[^.!?]{0,25})(?<!\\bno\\s)(?<!\\bnot\\s)(?<!\\bnever\\s)(?<!\\bwithout\\s)${SERVICE_KEYWORD_SOURCE}\\s+(?:in|near|for|quotes?|plans?|company|companies|available)\\b(?![^.!?]{0,40}\\bwith\\s+(?:another|other|a different|any|that|your current)\\s+(?:compan|provider|firm|exterminator)\\w*)(?![^.!?]{0,60}\\b(?:contact|call|hire|choose|find|use)\\s+(?:a\\s+|an\\s+|your\\s+)?(?:local|nearby|area|another|different|licensed)\\s+(?:provider|compan(?:y|ies)|firm|exterminator|pro(?:fessional)?)s?\\b)(?![^.!?]{0,60}\\b(?:we|waves\\w*)\\b[^.!?]{0,20}?\\b(?:do not|don'?t|does not|doesn'?t|cannot|can'?t|won'?t)\\b)(?![^.!?]{0,30}\\b(?:is|are|was|were|has|have|be|may|might|can|could|will|would|should|must|costs?|varies|vary|differs?|depends?|remains?|tends?|requires?|use[sd]?|using|rel(?:y|ies|ied)|charge[sd]?|charging|follow(?:s|ed)?|recommend(?:s|ed)?|report(?:s|ed)?|typically|often|usually|commonly|generally)\\b(?!(?:\\s+(?!(?:not|no|never|rarely|hardly)\\b)[a-z]+){0,2}?\\s+(?:(?:available|offered|provided|book(?:ed|able)?|scheduled|requested|reserved)\\b(?!\\s+(?:around|during|before|after|when|while)\\b)(?![^.!?]{0,40}\\b(?:by|from)\\s+(?:the\\s+county|the\\s+city|the\\s+state|counties|municipalit\\w+|other\\s+(?:compan|provider|firm)\\w*|competitors?|national\\s+chains?|local\\s+(?:compan|provider|firm)\\w*)\\b)|(?:handled|performed|managed|covered|treated|serviced|delivered|done)\\s+by\\s+(?:waves|us|our)\\b)))`
  // "Our pest control services guide explains…" is editorial packaging of
  // CONTENT, not of service — the guide-compound lookahead mirrors the
  // keyword suffix's own guard.
  + `|(?:your|our)\\s+(?:\\w+\\s+){0,2}?${SERVICE_KEYWORD_SOURCE}\\b(?!(?:\\s+(?:service|plan|program)s?)?\\s+(?:guides?|advice|research|information|info|tips|insights?|education|resources?|articles?|content|news|facts?|myths?|history|overviews?|checklists?|comparisons?|faqs?)\\b)(?![^.!?]{0,30}\\b(?:depends?|varies|vary|differs?|costs?|requires?|tends?|remains?)\\b)`
  + `|(?<!\\bno\\s)(?<!\\bnot\\s)(?:\\b(?:waves\\w*|waveguard|(?:our|this|the)\\s+(?:\\w+\\s+){0,2}?(?:service|plan|program|membership|treatment)s?)\\b|\\{\\{\\s*brand\\w*\\s*\\}\\})[^.!?]{0,20}?\\b(?:is|are)\\s+(?:now\\s+)?available\\s+(?:in|throughout|across|to|for|near)\\b`
  + `|(?:waves(?: pest control)?|waveguard|\\{\\{\\s*brand\\w*\\s*\\}\\}) ${CLAIM_VERB_SOURCE})`,
  'i',
);

// Disclaimer exemptions come in two scopes. FOOTPRINT-scoped phrases name
// the service area itself and safely exempt the whole clause ("Naples is
// outside our service area"). Bare negated verbs ("don't include") are NOT
// clause-level exemptions — "plans that don't include termite coverage"
// negates a service line, not the footprint — so negation exempts a city
// only when the city itself is the OBJECT of the negated verb (see
// cityNegationPattern). Tested on apostrophe-normalized text.
const SERVICE_AREA_DISCLAIMER_PATTERN =
  /\b(outside (?:of )?(?:our|the) (?:(?:service|coverage) )?(?:areas?|footprints?)|(?:not|isn'?t|aren'?t) (?:currently )?(?:in|within|inside|(?:a )?part of|included in|covered by) our (?:(?:service|coverage) )?(?:areas?|footprints?)|(?:not|isn'?t|aren'?t) (?:currently )?(?:a (?:waves(?: pest control)?(?:'s|')? )?(?:service|coverage) area|one of (?:our|waves(?:'s|')?) (?:service|coverage) areas)\b|beyond our (?:(?:service|coverage) )?(?:areas?|footprints?)|our (?:(?:service|coverage)\\s+)?(?:areas?|footprints?) (?:excludes?|does not (?:include|extend|reach)|doesn'?t (?:include|extend|reach)|do not (?:include|extend|reach)|don'?t (?:include|extend|reach))\b)\b/i;

// "…does not include Tampa", "we no longer serve Naples", "won't reach
// St. Petersburg" — the negated verb's object (within a few words) is the
// blocked city, so the sentence honestly denies service there.
// The gap after the negated verb tolerates list separators so every city in
// "we don't serve Naples, Tampa, or Miami" is exempt, not just the first.
// "excludes Naples" and "stops short of Naples" deny service in POSITIVE
// verb form — same honest boundary copy as the do-not forms.
// The gap after the negated verb tolerates comma-separated city lists
// ("we don't serve Naples, Tampa, or Miami") but must NOT cross into a new
// affirmative clause — "We do not serve Naples, we serve Tampa" restates
// service, so the gap refuses a comma followed by a claim subject and
// refuses dashes entirely (a dash splice is a new clause, not a list).
function cityNegationPattern(citySource: string): RegExp {
  return new RegExp(
    `(?:(?:do not|don'?t|does not|doesn'?t|no longer|won'?t|will not|cannot|can'?t|is not|isn'?t|are not|aren'?t|was not|wasn'?t|were not|weren'?t) (?:currently |yet |now |just )?(?:includ(?:e|ing)|cover(?:ing)?|serv(?:e|ing)|servic(?:e|ing)|extend(?:ing)?(?: to| into)?|reach(?:ing)?|treat(?:ing)?|visit(?:ing)?|book(?:ing)?|schedul(?:e|ing)|offer(?:ing)?|provid(?:e|ing)|deliver(?:ing)?)|excludes?|stops? (?:short of|before|at)|(?:is|are|was|were)?\\s*(?:not|never|no longer)\\s+(?:currently\\s+)?(?:available|offered|provided)\\s+(?:in|to|for|near|throughout|across)|unavailable\\s+(?:in|to|for|near|throughout|across)|,\\s*(?:but\\s+)?(?:not|excluding|except)\\b[^.!?;]{0,25}?(?=[^.!?;]{0,5}${citySource})|no (?:need|reason) (?:for\\b(?!(?:\\s+[\\w.-]+){0,4}\\s+to\\s+(?:wait|delay|hesitate)\\b)|to (?!(?:wait|delay|hesitate|put off|hold off|postpone|rush)\\b)\\w+)(?![^.!?]{0,60}[;,]\\s*(?:just\\s+)?(?:book|schedule|call|order|text)\\b))(?:(?!,\\s*(?:we|our|waves|waveguard|you)\\b|\\s(?:and|but)\\s+(?:you\\s+)?(?:also\\s+)?(?:can\\s+|could\\s+|will\\s+|would\\s+|may\\s+|might\\s+|do\\s+|does\\s+|now\\s+|still\\s+|also\\s+|\\w+ly\\s+){0,2}(?:offer|provid|deliver|serv|treat|cover|exterminat|remov|eliminat|manag|work|operat|book|schedul|visit|spray|inspect|handl|protect|includ|extend|reach|help)|\\s(?:and|but|yet)\\s+(?:is|are|was|were)\\b|\\bto\\s+(?:book|schedul|call|order|get|claim|redeem)\\w*\\b|,\\s*(?:book|schedul|call|order|get)\\w*\\b|,\\s*(?:now\\s+|currently\\s+|also\\s+|still\\s+)?(?:serving|offering|covering|treating)\\b|,\\s*(?=[^.!?]{0,40}\\b(?:is|are)\\s+(?:now\\s+|currently\\s+)?(?:in|part of|one of|available)\\b)|\\b(?:before|when|while|after|if|whenever)\\s+(?:book|schedul|call|order)\\w*\\b|\\sand\\s+[^.!?;]{0,30}?\\b(?:is|are)\\s+(?:now\\s+)?(?:available|offered|provided)\\b|\\b(?:we|our|waves|waveguard)\\s+(?:\\w+\\s+){0,2}?(?:provid|offer|deliver|serv|treat|cover|exterminat|remov|eliminat|manag|work|operat|book|schedul|visit|spray|inspect|handl|protect|get)\\w*\\b)[^.!?;–—]){0,60}?\\b${citySource}|(?<!\\b(?:serv(?:e|es|ing|ice|ices|icing)|treat(?:s|ing)?|cover(?:s|ing)?|visit(?:s|ing)?|spray(?:s|ing)?|inspect(?:s|ing)?|protect(?:s|ing)?|handl(?:e|es|ing)|exterminat\\w+|in|throughout|across)\\s+)${citySource}(?:(?!\\b(?:we|our|waves|waveguard)\\b\\s+(?:\\w+\\s+){0,2}?(?:serv|treat|cover|visit|spray|inspect|protect|handl|exterminat|book|schedul|offer|provid|deliver|get)\\w*)[^.!?]){0,40}\\b(?:is|sits|falls|lies) (?:just )?(?:outside|beyond|out of|past|(?:south|north|east|west) of\\b(?=[^.!?]{0,30}\\b(?:our|the)\\s+(?:service\\s+)?(?:area|footprint)\\b))\\b`,
    'i',
  );
}

// Blog copy uses typographic apostrophes; the disclaimer pattern is written
// with ASCII ones. Normalize before testing so "doesn’t include Tampa" is
// recognized as the disclaimer it is.
function normalizeApostrophes(text: string): string {
  return text.replace(/[‘’]/g, "'");
}

// Replace disclaimer spans with spaces so claim-context tests on a prefix
// never match the disclaimer's own wording (offsets are preserved).
function blankDisclaimers(text: string, ranges: number[][]): string {
  let out = text;
  for (const [s, e] of ranges) out = out.slice(0, s) + ' '.repeat(e - s) + out.slice(e);
  return out;
}

// Clause boundaries WITHIN a sentence. The disclaimer exemption is scoped to
// the clause, not the whole sentence — "Naples is outside our service area,
// but we cover Tampa" must still flag the Tampa claim in the second clause.
// Bare adversatives (no comma) and "and we/our …" split too — those are
// exactly the joints where a disclaimer half hides an affirmative half.
// A bare "and" between noun phrases ("lawns and shrubs") does NOT split, so
// a claim verb still governs its full object list.
// "and" splits ONLY before a new claim subject (we/our) — a bare ", and"
// boundary would sever the tail of an Oxford-comma object list ("We serve
// Sarasota, Venice, and Naples") from its claim verb.
// "while" splits ONLY before a third-party subject (adversative "…while
// Tampa faces different rules"); temporal "while we treat the lawn" keeps
// the city and the service verb in one clause — splitting there severed
// the exact context the gate evaluates.
// "whether" opens a subordinate question clause — "our customers ask
// whether Naples termites behave differently" carries the demand signal in
// one clause and a factual comparison in the other; splitting keeps the
// blocked city bound to its own (claim-free) clause. A subordinate that
// itself contains a claim ("ask whether we serve Naples") still flags on
// its own half.
const CLAUSE_SPLIT_PATTERN =
  /;(?!\s*(?:just\s+)?(?:book|schedul|call|order|text)\w*\b)\s*|\s*[–—]\s*(?=(?:we|our|waves|waveguard)\b|[^.!?]{0,80}\b(?:is|are|was|were|has|have|lies?|sits?|falls?|remains?)\b)|,\s*(?:but(?!\s+also\b(?!\s+(?:we|our|waves|waveguard)\b))|yet|however|though|although|whereas|so(?=\s+(?:we|our|waves|waveguard)\b)|while(?!\s+(?:we|our|waves|waveguard)\b))\s+|\s+(?:but(?!\s+also\b(?!\s+(?:we|our|waves|waveguard)\b))|however|yet|though|although|whereas|while(?!\s+(?:we|our|waves|waveguard)\b)|whether(?<=\b(?:ask|asks|asked|asking|wonder|wonders|wondered|wondering|question|questions|questioned|questioning|debate|debates|debated|debating|unsure|know|knows|knew|check|checks|checked|checking|confirm|confirms|confirmed|confirming|decide|decides|decided|deciding|sure)\s+whether))\s+|\s+(?:how|when|where|why)\s+(?=(?:we|our|waves|waveguard)\b)|\s+(?:using|based on|citing|according to)\s+|(?<=^\s*(?:because|since|due to|given that)\b[^,;]{1,80}),\s*(?=(?:we|our|waves|waveguard)\b)|,?\s+and\s+(?=(?:we|our|waves|waveguard)\b)/i;

// "We serve Sarasota; Venice; and Naples." renders as ONE claim list — a
// semicolon whose following fragment is NOTHING BUT list glue (optionally
// "and"/"or" plus capitalized place words and separators) is a list
// separator, not a clause boundary, so the claim verb must carry across it.
// A fragment with any lowercase prose is a real clause and stays split —
// "We serve Sarasota; Tampa mosquito season starts earlier" must NOT glue
// Tampa onto the claim. Case-sensitive on purpose.
const LIST_FRAGMENT_RE =
  /^\s*(?!(?:We|Our|Waves|WaveGuard)\b)(?:(?:and|or|nor)\s+|[&/+]\s*|(?!(?:We|Our|Waves|WaveGuard)\b)[A-Z][A-Za-z'’.&-]*[\s,–—-]*(?:(?:homeowners?|homes?|property owners?|properties|lawns?|yards?|businesses?|neighborhoods?|residents?|customers?|families|areas?|communit(?:y|ies)|markets?|suburbs?|districts?|corridors?|condos?|condominiums?|apartments?|restaurants?|hotels?|offices?|schools?|storefronts?|warehouses?|facilities|clinics?|shops?|stores?|marinas?|resorts?)[\s,]*)*)+(?:(?:year[- ]round|weekly|monthly|quarterly|seasonally|daily|annually|too|as well|and more|every(?:\s+\w+){1,2}|each(?:\s+\w+){1,2}|during(?:\s+\w+){1,2}|in(?:\s+\w+){1,2}|from(?:\s+\w+){1,3}|for(?:\s+\w+){1,3})[\s,]*){0,2}\.?\s*$/;

function rejoinListSemicolons(sentence: string): string[] {
  const out: string[] = [];
  for (const part of sentence.split(/;(?!\s*(?:just\s+)?(?:book|schedul|call|order|text)\w*\b)\s*/)) {
    if (out.length && LIST_FRAGMENT_RE.test(part)) out[out.length - 1] += `, ${part}`;
    else out.push(part);
  }
  return out;
}

// Glue allowed between a footprint disclaimer and a city it exempts when the
// disclaimer comes FIRST ("Outside our service area: Naples, Fort Myers, and
// Cape Coral."): separators, list connectors, and capitalized place words
// only. Any lowercase verb ("…: Naples, our techs treat Tampa") breaks the
// glue and the trailing city flags. Case-sensitive on purpose.
const DISCLAIMER_LIST_GLUE_RE =
  /^[\s:;,–—-]*(?:(?:and|or|nor|plus|including|includes?|such as|as well as|as well|too|of|the|is|are|count(?:y|ies)|for now|for the moment|today|currently|at this time|right now|yet|so far|at present)[\s,;:]*|[A-Z][A-Za-z'.&-]*[\s,;:–—-]*)*\.?\s*$/;

// City list BEFORE the disclaimer: "Naples, Fort Myers, Cape Coral, Bonita
// Springs, Estero, and Marco Island are outside our service area." — the
// first city sits far past any fixed window, so the pre-disclaimer
// exemption also accepts an arbitrarily long run of pure list glue plus the
// linking verb between the city and the disclaimer phrase.
const PRE_DISCLAIMER_GLUE_RE =
  /^[\s,;:]*(?:(?:and|or|nor|all|both|are|is|sit|sits|fall|falls|lie|lies|remain|remains|of|the)\s+|[A-Z][A-Za-z'.&-]*[\s,;:]*)*$/;

// A markdown list item ("- Naples", "2) Venice") — used to re-attach a
// colon-terminated claim intro ("We serve these cities:") to each item.
const LIST_ITEM_MARKER_RE = /^\s*(?:[-*+]|\d+[.)])\s+/;

// Common alias spellings of the blocked cities — matching is case-insensitive
// and covers the abbreviated forms the sentence splitter deliberately
// preserves ("we service Ft. Myers", "st petersburg humidity").
function cityAliasSource(city: string): string {
  // "St. Pete" is the common local abbreviation for St. Petersburg —
  // "we service St. Pete" is the same out-of-area claim.
  if (city === 'St. Petersburg') return '(?:St\\.?|Saint) Pete(?:rsburg)?';
  // "<Name> County" entries also match the plural-list shorthand "Lee and
  // Collier counties": the bare name counts when a "counties" head follows
  // the (possibly multi-name) list it sits in.
  const countyBase = city.match(/^(.+) County$/);
  if (countyBase) {
    const base = countyBase[1].replace(/\./g, '\\.');
    return `${base}(?:\\s+Count(?:y|ies)\\b|(?=(?:(?:\\s*(?:,|and|&|or))+\\s*[A-Z][\\w.-]+)*\\s+count(?:y|ies)\\b))`;
  }
  return city
    .replace(/\./g, '\\.')
    .replace(/^Fort /, '(?:Fort|Ft\\.?) ');
}

// No "Bay" exemption in the city matcher: "we service Tampa Bay" targets a
// region outside the footprint and must flag. Factual water-body mentions
// ("runoff drains to Tampa Bay") pass because they carry no service-claim
// context — the claim gate, not the city matcher, does that discrimination.
// (The matcher itself is built inline in validateServiceAreaClaims with the
// 'gi' flags so EVERY occurrence is examined.)

// Markdown-aware segmentation: blank lines separate blocks; within a block,
// SELF-CLOSING marker lines (headings, JSX tags) are their own segments;
// CONTINUABLE markers (list items, blockquote lines, table rows) start a
// segment that ABSORBS following soft-wrapped lines — markdown renders
// "- From Sarasota to Naples,\n  our techs treat…" as one list item, so it
// must scan as one sentence. Consecutive PROSE lines likewise re-join with
// a space (a soft-wrapped paragraph is one rendered sentence).
const MARKDOWN_SELF_CLOSING_LINE_RE = /^\s*(?:#{1,6}\s|<\/?[A-Za-z])/;
const MARKDOWN_CONTINUABLE_MARKER_RE = /^\s*(?:[-*+]\s|\d+[.)]\s|>\s?|\|)/;

function markdownSegments(body: string): string[] {
  const segments: string[] = [];
  for (const block of body.split(/\n{2,}/)) {
    let current = '';
    for (const line of block.split('\n')) {
      if (MARKDOWN_SELF_CLOSING_LINE_RE.test(line) || line.includes('|')) {
        if (current) { segments.push(current); current = ''; }
        segments.push(line);
      } else if (MARKDOWN_CONTINUABLE_MARKER_RE.test(line)) {
        // Consecutive `>` lines are ONE rendered blockquote paragraph — a
        // hard-wrapped quote must scan as one sentence. List items and
        // table rows stay separate segments.
        if (/^\s*>/.test(line) && /^\s*>/.test(current)) {
          current = `${current} ${line.replace(/^\s*>\s?/, '').trim()}`;
        } else {
          if (current) segments.push(current);
          current = line;
        }
      } else {
        current = current ? `${current} ${line.trim()}` : line;
      }
    }
    if (current) segments.push(current);
  }
  return segments;
}

export interface ServiceAreaClaimResult {
  ok: boolean;
  violations: Array<{ city: string; sentence: string }>;
}

/**
 * Flags sentences that name an out-of-service-area city AND assert Waves does
 * work there — e.g. "From Sarasota to Cape Coral, our techs treat the same
 * trouble spots." That is a false service claim, not a style nit.
 *
 * Scoped to the SENTENCE, not the line or the post, on purpose. Blog copy
 * legitimately references these cities as geography or pest range ("Asian
 * subterranean termites were originally confined to Miami", "runoff drains to
 * Tampa Bay", "reads differently in Naples than in Jacksonville"). Across the
 * 223 posts in this repo, sentence scoping flags exactly the real false claim
 * and none of the ~19 legitimate factual mentions; line scoping produced false
 * positives on both counts.
 */
export function validateServiceAreaClaims(
  body_mdx: string,
): ServiceAreaClaimResult {
  const violations: ServiceAreaClaimResult['violations'] = [];
  // Link DESTINATIONS are invisible to readers — a blocked city inside a
  // URL ("[UF guidance](https://example.com/miami-termite-treatment)") is
  // not a rendered claim. Blank them (keeping anchor text) before scanning.
  const body = body_mdx
    .replace(/^---[\s\S]*?\n---\n/, '')
    // MDX/HTML comments never render — commented-out copy is not a claim.
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // Wrapper chars trailing sentence punctuation ("?*" / ".**") hide the
    // sentence end from the splitter — drop them; rendering is unchanged.
    .replace(/([.!?])[*_`]+(\s|$)/g, '$1$2')
    // Same-line HTML FAQ pairs ("…?</h3><p>Yes.") — closing block tags
    // end their segment so question and answer split.
    .replace(/<\/(?:h\d|p|li|blockquote|td|th|tr|div)>/gi, '$&\n')
    // A quoted phrase attributed to a third party (or discussed AS a
    // phrase) is not Waves' own claim — blank the quote content.
    .replace(/((?<!\bour )(?<!\bwe )(?:competitor|company|provider|firm|phrase|wording|term|example)s?\b[^.!?"\u201c]{0,25}["\u201c])([^"\u201d]{0,120})(["\u201d])/gi, '$1…$3')
    .replace(/\s(?:href|src)\s*=\s*\"[^\"]*\"/gi, ' ')
    .replace(/\s(?:href|src)\s*=\s*'[^']*'/gi, ' ')
    .replace(/\]\(\s*[^)]*\)/g, '](#)')
    .replace(/https?:\/\/[^\s)\]>"'`]+/g, '');

  // Markdown segmentation first (blocks/marker lines split, soft-wrapped
  // prose re-joins — see markdownSegments). Within a segment, the
  // lookbehinds keep dotted place abbreviations (St. Petersburg, Ft. Myers,
  // Mt. Dora) inside one sentence — a bare period split turned "We service
  // St. Petersburg…" into a claim-free "We service St." fragment and an
  // out-of-area "Petersburg…" fragment, missing the violation. A rare
  // genuine sentence ending in "St." merges two sentences, which only
  // widens the claim window — fails closed.
  // "We serve these cities:" followed by "- Naples" bullets is ONE rendered
  // claim — the intro carries the service verb, each item carries a city, and
  // neither alone would flag. Re-attach a colon-terminated intro to every
  // following list item; the intro persists across the whole list (blank
  // lines included) and clears at the next non-list prose segment.
  const scanUnits: string[] = [];
  let listIntro = '';
  // A table header row carries claim context for every row beneath it
  // ("| Areas we serve |" / "| Naples |") — attach the header to each data
  // row so the claim text and the city are scanned together.
  let tableIntro = '';
  let lastTableRow = '';
  const allSegments = markdownSegments(body);
  for (let segIndex = 0; segIndex < allSegments.length; segIndex += 1) {
    const segment = allSegments[segIndex];
    const trimmed = segment.trim();
    const nextTrimmed = (allSegments[segIndex + 1] || '').trim();
    const sepLike = (t: string) => /^[\s:|-]+$/.test(t) && t.includes('-');
    if (/^\|.+/.test(trimmed) || (trimmed.includes('|') && (sepLike(nextTrimmed) || sepLike(trimmed) || tableIntro))) {
      listIntro = '';
      // A row directly above a separator row is the NEXT table's header —
      // never carry a previous table's claim context onto it.
      if (sepLike(nextTrimmed)) {
        tableIntro = '';
      }
      // A separator row marks the row above it as THIS table's header —
      // that also resets a stale header carried over from a previous
      // table separated only by a blank line.
      if (sepLike(trimmed)) {
        tableIntro = lastTableRow;
        continue;
      }
      lastTableRow = trimmed;
      if (!tableIntro) {
        scanUnits.push(segment);
      } else if (/\|\s*(?:\*\*)?(?:no\s*[,.!;:—–][^|]{0,60}|no|not (?:served|available|covered|yet|included|offered)\b[^|]{0,40}|not (?:in|within|currently|part of)\b[^|]{0,40}|not a (?:service|coverage) area[^|]{0,20}|unavailable[^|]{0,60}|outside\s+(?:our|the)\b[^|]{0,40}|outside\s+(?:service\s+|coverage\s+)?(?:areas?|footprints?)\b[^|]{0,20}|✗|✕)(?:\*\*)?\s*(?:\||$)/i.test(trimmed)
        || SERVICE_AREA_DISCLAIMER_PATTERN.test(trimmed)) {
        // A denial cell ("| Naples | No |") marks the row as boundary
        // status, not a claim — scan the row without the header's claim
        // context.
        scanUnits.push(trimmed);
      } else {
        scanUnits.push(`${tableIntro} ${trimmed}`);
      }
      continue;
    }
    tableIntro = '';
    if (LIST_ITEM_MARKER_RE.test(segment)) {
      const item = segment.replace(LIST_ITEM_MARKER_RE, '');
      // A bullet that is itself a boundary disclaimer must not inherit the
      // claim intro ("Our service areas:" / "- Naples — outside our
      // service area").
      if (SERVICE_AREA_DISCLAIMER_PATTERN.test(item)) {
        scanUnits.push(item);
      } else scanUnits.push(listIntro ? `${listIntro} ${item}` : segment);
    } else {
      listIntro = /:\s*$/.test(segment.trim()) ? segment.trim() : '';
      scanUnits.push(segment);
    }
  }
  const sentences = scanUnits.flatMap((segment) =>
    segment.split(/(?<=[.!?])(?<!\bSt\.)(?<!\bFt\.)(?<!\bMt\.)(?<!\b[eE]\.[gG]\.)(?<!\b[iI]\.[eE]\.)(?<!\bvs\.)\s+/),
  );
  for (let sentenceIndex = 0; sentenceIndex < sentences.length; sentenceIndex += 1) {
    let sentence = sentences[sentenceIndex];
    // Inline wrappers (bold/italic/code/links) render as plain text — strip
    // them up front so the FAQ question checks see the rendered words.
    const faqProbe = sentence
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]+>/g, ' ')
      .replace(/[*_`]+/g, '');
    // A second-person service question answered "Yes" is a rendered claim
    // ("### Do you serve Naples?" / "Yes.") — rewrite the subject to
    // first person so the claim arms see it. DIY questions ("Can you treat
    // your lawn yourself?") stay reader-directed.
    if (/^\s*(?:#{1,6}\s+|[-*+]\s+|>\s+|\d+\.\s+|\*\*)?(?:do|does|can|could|will|would|is|are)\s+(?:you|your\s+\w+|waves\w*)\b(?:\b(?:St|Ft|Mt)\.|[^.!?])*\b(?:serv|treat|cover|visit|spray|inspect|protect|handl|exterminat|work|operat|available|run|have|has|carry|offer|provid)\w*(?:\b(?:St|Ft|Mt)\.|[^.!?])*\?\**\s*$/i.test(faqProbe)
      && !/\b(?:yourself|your own|diy)\b/i.test(faqProbe)
      && /^\s*(?:yes\b|absolutely\b|of course\b|yep\b|we (?:do|are|can|sure do|sure can)\b|no (?:problem|worries|sweat)\b|no (?:appointment|contract|subscription)s?\s+(?:needed|required|necessary)\b|they (?:do|are)\b)/i.test(normalizeApostrophes(sentences[sentenceIndex + 1] ?? '').replace(/<[^>]+>/g, ' ').replace(/^[\s*_~`>#-]+/, ''))) {
      sentence = faqProbe
        .replace(/\b(?:do|does|can|could|will|would)\s+(?:you|your\s+\w+|waves\w*)\s+(?:have|carry)\s+/i, 'we offer ')
        .replace(/\b(?:do|does|can|could|will|would|is|are)\s+(?:you|your\s+\w+|waves\w*)\s+/i, 'our team ');
    }
    // A boundary FAQ asks about service and then denies it ("Do we serve
    // Naples? No.") — the interrogative sentence is a question, not a
    // claim, when the next sentence opens with a denial.
    if (/^\s*(?:#{1,6}\s+|[-*+]\s+|>\s+|\d+\.\s+|\*\*)?(?:do|does|did|can|could|will|would|should|is|are|was|were|need|want|looking)\b(?:\b(?:St|Ft|Mt)\.|[^.!?])*\?\**\s*$/i.test(faqProbe)
      && /^\s*(?:no\s*[.,!;:—–-]|no\s+(?:we|unfortunately|sorry|not)\b|not\b|nope\b|unfortunately\b|sadly\b|we (?:do not|don'?t|cannot|can'?t)|(?:contact|call|try|choose|find|use)\s+(?:a|an|your)?\s*(?:local|nearby|another|different|licensed))/i.test(normalizeApostrophes(sentences[sentenceIndex + 1] ?? '').replace(/<[^>]+>/g, ' ').replace(/^[\s*_~`>#-]+/, ''))) {
      continue;
    }
    // Claim/disclaimer logic runs per CLAUSE so a disclaimer in one clause
    // cannot exempt an affirmative claim in the next. Semicolon list
    // fragments are rejoined first so "We serve Sarasota; Venice; and
    // Naples" scans as one claim clause, while a semicolon followed by real
    // prose stays a clause boundary (see rejoinListSemicolons).
    for (const semiUnit of rejoinListSemicolons(sentence)) {
    for (const clause of semiUnit.split(CLAUSE_SPLIT_PATTERN)) {
      const normalized = normalizeApostrophes(clause)
        .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|>\s+|\d+\.\s+)+/, '')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/__([^_]+)__/g, '$1')
        .replace(/\*([^*\n]+)\*/g, '$1')
        .replace(/\b_([^_\n]+)_\b/g, '$1')
        .replace(/`([^`\n]+)`/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
      if (!SERVICE_CLAIM_PATTERN.test(normalized)) continue;
      // Footprint disclaimers exempt PER CITY, not per clause: in "Naples is
      // outside our service area, Waves serves Tampa" only Naples (the
      // disclaimer's subject, sitting just before the phrase) is exempt —
      // Tampa still flags. Intro commas ("In Naples, we treat…") never
      // sever a claim from its city.
      // ALL disclaimer occurrences, not just the first — "Naples is outside
      // our service area, and Naples remains outside our service area."
      // repeats the honest disclaimer, and each city occurrence must be
      // evaluated against the disclaimer it belongs to.
      const disclaimerRanges = [...normalized.matchAll(new RegExp(SERVICE_AREA_DISCLAIMER_PATTERN.source, 'gi'))]
        .map((m) => [m.index ?? 0, (m.index ?? 0) + m[0].length]);
      // Demand arms bind to their own city. When the clause's ONLY claim
      // context is a demand arm (no core claim once demand spans are
      // blanked), a blocked city must sit INSIDE a demand span — "Our
      // Tampa customers ask…" flags, "Our customers ask about Naples
      // termite research" is a topic mention and does not.
      const demandRanges = [...normalized.matchAll(new RegExp(DEMAND_CONTEXT_SOURCE, 'gi'))]
        .map((m) => [m.index ?? 0, (m.index ?? 0) + m[0].length]);
      const demandOnly = demandRanges.length > 0
        && !SERVICE_CLAIM_PATTERN.test(blankDisclaimers(normalized, demandRanges));
      // A leading geographic range ("From Sarasota down through Naples, the
      // call is one of the most common we get") attaches to the demand
      // phrase — cities inside that leading range count as demand-bound.
      const leadingRange = demandOnly ? normalized.match(/^\s*(?:from\b[^,;.!?]{0,40}?\b(?:to|through|down to|up to|down through|across to)\b[^,;.!?]{0,20}|between\b[^,;.!?]{0,60}|(?:across|throughout)\b[^,;.!?]{0,60}),/i) : null;
      const leadingRangeEnd = leadingRange ? leadingRange[0].length : 0;
      for (const city of NON_SERVICE_AREA_CITIES) {
        const source = cityAliasSource(city);
        // EVERY occurrence of the city is examined, not just the first —
        // "Naples is outside our service area — our techs service Naples
        // homes" repeats the city in an affirmative claim after the honest
        // disclaimer, and a first-match-only scan never saw the second.
        // Negation exemptions are occurrence-scoped the same way: only a
        // city INSIDE the negation match's span is the denial's object; a
        // repeat of the city elsewhere in the clause is its own claim.
        const negationRanges = [...normalized.matchAll(new RegExp(cityNegationPattern(source).source, 'gi'))]
          .map((m) => [m.index ?? 0, (m.index ?? 0) + m[0].length]);
        let flagged = false;
        for (const cityMatch of normalized.matchAll(new RegExp(`\\b${source}\\b`, 'gi'))) {
          const cityStart = cityMatch.index ?? 0;
          const cityEnd = cityStart + cityMatch[0].length;
          if (negationRanges.some(([s, e]) => cityStart >= s && cityEnd <= e)) continue;
          if (demandOnly && cityEnd > leadingRangeEnd
            && !demandRanges.some(([ds, de]) => cityStart >= ds && cityEnd <= de)) continue;
          if (demandOnly && /\b(?:about|regarding)\s+(?:[\w.-]+\s+){0,2}$/i.test(normalized.slice(0, cityStart))) continue;
          // "drains toward Tampa Bay" names the water body, not the city —
          // exempt only "toward(s)" or a motion/orientation verb governing
          // the preposition. Coverage phrasings keep flagging: "treat homes
          // around Tampa Bay" and "From Tampa Bay to Sarasota, our techs
          // treat…" are operating claims on the Tampa Bay area, and so is
          // bare "We treat Tampa Bay".
          if (/^\s+bay\s+(?:humidity|weather|water|winds?|climate|watershed|estuar\w+|tides?|temperatures?|rainfall|storms?)\b/i.test(normalized.slice(cityEnd))) {
            continue;
          }
          if (/^\s+bay\b/i.test(normalized.slice(cityEnd))
            && /(?:\b(?:toward|towards)\s*$|\b(?:drains?|draining|flows?|flowing|runs?|running|slopes?|sloping|leads?|leading|empties|emptying|points?|pointing|looks?|looking|faces?|facing|overlooks?|overlooking)\s+(?:toward|towards|into|to|at|over|across|near|along|around|off|on|from|of)\s*$)/i.test(normalized.slice(0, cityStart))) {
            continue;
          }
          // City BEFORE a disclaimer: exempt within the close window, or
          // across an arbitrarily long pure-list run ("Naples, Fort Myers,
          // …, and Marco Island are outside our service area."). The
          // long-list glue path additionally requires NO claim context
          // BEFORE the city — in "We serve Naples, and Fort Myers, …, are
          // outside our service area." Naples is the claim verb's object,
          // not part of the disclaimer's subject list.
          // City AFTER a disclaimer (disclaimer-FIRST list form): exempt
          // only while the ENTIRE clause tail after that disclaimer is pure
          // list glue — a lowercase claim continuation re-arms the gate.
          const disclaimed = disclaimerRanges.some(([dStart, dEnd]) => {
            if (cityStart < dStart) {
              // Both pre-disclaimer paths require NO claim context before
              // the city — "We serve Naples, even though Naples is outside
              // our service area" contradicts itself, and the nearby
              // disclaimer must not erase the affirmative claim. The prefix
              // is tested with disclaimer spans blanked so an EARLIER
              // disclaimer's own wording ("…service area…") never reads as
              // claim context ("Naples is outside our service area, and
              // Naples remains outside our service area." stays honest).
              if (SERVICE_CLAIM_PATTERN.test(blankDisclaimers(normalized, disclaimerRanges).slice(0, cityStart))) return false;
              // The stretch BETWEEN the city and the disclaimer must also
              // be claim-free — "Naples customers use our quarterly pest
              // control, an area outside our service area" carries the
              // claim in that gap and the distance alone must not exempt.
              if (SERVICE_CLAIM_PATTERN.test(normalized.slice(cityEnd, dStart))) return false;
              return dStart - cityEnd <= 60
                || PRE_DISCLAIMER_GLUE_RE.test(normalized.slice(cityEnd, dStart));
            }
            return cityStart >= dEnd && DISCLAIMER_LIST_GLUE_RE.test(normalized.slice(dEnd));
          });
          if (disclaimed) continue;
          flagged = true;
          break;
        }
        if (!flagged) continue;
        violations.push({ city, sentence: sentence.trim().slice(0, 200) });
      }
    }
    }
  }

  return { ok: violations.length === 0, violations };
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
