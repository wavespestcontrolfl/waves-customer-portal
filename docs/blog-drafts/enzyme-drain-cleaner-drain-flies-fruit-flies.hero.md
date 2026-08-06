# Hero image spec — enzyme-drain-cleaner-drain-flies-fruit-flies

The autonomous publisher (`server/services/content-astro/astro-publisher.js`)
generates the hero at PR-open via `content/image-generator.js` when a post has
no curated `featured_image_url`, commits it to
`public/images/blog/<slug>/hero.webp` in the Astro repo, and stamps the alt.
That step needs `OPENAI_API_KEY` / `GEMINI_API_KEY`, which live on Railway —
not in this authoring environment — so the bytes are produced at publish time,
not here. This file records the exact generation inputs so the hero is
reproducible and matches the frontmatter already in the `.mdx`.

- **Committed path:** `/images/blog/enzyme-drain-cleaner-drain-flies-fruit-flies/hero.webp`
- **Mode:** `blog-hero` (1536×1024, 3:2, compressed to WebP by the publisher)
- **Provider chain (default):** `gpt-image-2,gpt-image-1.5,gpt-image-1,gemini`

**Generation prompt** (from `image-generator.buildPrompt`, city = Bradenton):

> A high-quality, photorealistic blog hero image for a Southwest Florida pest control & lawn care business named "Waves Pest Control." Subject: enzyme drain cleaner for drain flies around a kitchen sink. Setting: a Bradenton-area home or yard with characteristic SWFL landscaping (palm trees, sandy soil, bright sun). Composition: landscape 3:2 aspect ratio, 1536x1024. Style: bright, clean, professional. Sunny coastal light with a deep-blue sky and warm golden accents (brand palette: blue #009CDE, gold #FFD700 — no teal color cast). No text, words, watermarks, or logos in the image.

**Alt text** (frontmatter uses a sink-focused variant that matches the subject;
the publisher may overwrite with the vision-derived alt after generation):

> Bright Southwest Florida kitchen sink and drain, illustrating enzyme drain cleaner treatment for fruit flies and drain flies.
