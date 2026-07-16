---
name: waves-llm
description: Use when adding or modifying ANY LLM call site — choosing a model tier, calling Claude/OpenAI/Gemini, adding a cross-provider route, touching fallbacks, or changing model env vars. Covers the tier system, the DEEP helper contract, the ROUTES map, the fallback-to-Claude requirement, and the exceptions (call-recording, managed agents).
---

# Waves LLM call sites — tiers, routing, fallbacks

## 1. Never hardcode a model ID

Import a quality tier from `server/config/models.js`:

```js
const MODELS = require('../config/models'); // adjust path
// MODELS.DEEP / MODELS.FLAGSHIP / MODELS.WORKHORSE / MODELS.FAST / MODELS.VOICE / MODELS.VISION
```

These are **quality tiers, not cost tiers** (owner directive: best model
regardless of cost). Every tier is env-overridable (`MODEL_FLAGSHIP`, etc.)
so a model swap is a Railway var flip, never a code hunt. A per-feature pin
that can't use a tier still lives in `models.js` under the `MODEL_<NAME>`
registry convention (see `LAWN_CHALLENGE`) — never in the service file.

Enforced mechanically: `npm run check:domain-rules` fails the build on a
`claude-*` literal outside `models.js` / `llm/deep.js`.

## 2. Picking a tier

| Tier | Resolves to | Use for |
|---|---|---|
| `DEEP` | claude-fable-5 | Deepest reasoning, latency-tolerant, low-volume: agronomic wiki/KB stack, SMS draft verifier, shadow judge, blog fact-check gate |
| `FLAGSHIP` | claude-opus-4-8 | Best general reasoning: Intelligence Bar, advisors, analysis, agents |
| `WORKHORSE` | claude-opus-4-8 | Drafting + content generation |
| `FAST` | claude-opus-4-8 | High-volume classification, tagging, signals |
| `VOICE` | claude-sonnet-4-6 | Customer-facing copy where warm/natural beats raw reasoning: SMS replies, service recaps, social posts. High-stakes messages (cancellations, complaints) escalate to FLAGSHIP at the call site |
| `VISION` | claude-sonnet-4-6 | Image scoring — the Opus line removed `temperature` and scoring needs it (pinned 0.2 to match the Gemini scorer) |

## 3. DEEP call sites — the helper is mandatory

Every DEEP call goes through `server/services/llm/deep.js`:

```js
const { createDeepMessage } = require('../llm/deep');
const response = await createDeepMessage(anthropicClient, { ...params });
```

Why (both have caused real parsing bugs):
- **Thinking blocks.** fable-5 always thinks; `thinking` blocks precede the
  `text` block, so `content[0].text` reads the wrong block. The helper strips
  them.
- **Refusals.** fable-5's safety classifiers can refuse benign
  pesticide/termiticide-adjacent content (HTTP 200, `stop_reason: 'refusal'`).
  The helper retries the identical request once on FLAGSHIP — the lane
  degrades to Opus, it never gaps.

Also required at DEEP sites:
- `max_tokens` **≥ 4096** — thinking spends from the same budget.
- Pass your own Anthropic client (per-site timeout/retry config and test
  mocks keep working).
- Kill switch: `MODEL_DEEP=claude-opus-4-8` reverts every DEEP lane to Opus
  with no deploy.

Enforced mechanically: `check:domain-rules` fails on a file referencing
`MODELS.DEEP` without the helper.

## 4. Cross-provider routing (OpenAI / Gemini)

Owner directive 2026-06-17: the best model is the **LIVE** model — no
shadow/competing-model machinery. Some features route to OpenAI/Gemini via
the `ROUTES` map in `models.js`, dispatched through
`server/services/llm/call.js` (the one fail-closed place for OpenAI
Responses / Gemini generateContent / Anthropic SDK).

Currently live:
- **GPT-5.5** (`MODEL_OPENAI_BEST`): lead-triage classification
  (`lead-triage.js`), knowledge-base Q&A (`knowledge-bridge.js`), estimate
  assistant (`estimate-assistant.js`).
- **Gemini 3.5 Flash** (`MODEL_GEMINI_VISION`; per-service override
  `GEMINI_VISION_MODEL`): vision scoring in `lawn-assessment.js` +
  `satellite-analyzer.js`.

**Every cross-provider call site keeps an automatic fallback to Claude** so
a provider issue never causes a gap:
- OpenAI features → Claude (the estimate assistant then falls to a
  deterministic template).
- Gemini vision → retry `GEMINI_VISION_FALLBACK_MODEL` (default
  `gemini-2.5-flash`), and the parallel Claude-vision fan-out still runs.

Adding a new cross-provider feature: add a `ROUTES` entry (env-overridable),
dispatch through `llm/call.js`, implement the Claude fallback, and document
the route in `models.js`. Never call the OpenAI/Gemini SDK directly from a
service.

## 5. The exceptions

- **Call transcription + extraction** keep their own providers/models in
  `call-recording-processor.js` (transcription `gpt-4o-transcribe-diarize`,
  extraction `gemini-2.5-pro`). This is the one place competing/parallel
  models still make sense; it is intentionally NOT in `ROUTES`. Leave it.
- **Managed agents stay on Anthropic** — the Managed Agents API has no
  OpenAI equivalent.
- **Intelligence Bar** has its own model overrides:
  `INTELLIGENCE_BAR_MODEL` / `INTELLIGENCE_BAR_TECH_MODEL` (default
  FLAGSHIP).

## 6. Checklist for a new LLM call site

1. Pick the tier by job (table above); import from `models.js`.
2. DEEP → `createDeepMessage`, `max_tokens` ≥ 4096.
3. VOICE for customer-facing copy; escalate high-stakes to FLAGSHIP.
4. Cross-provider → `ROUTES` + `llm/call.js` + Claude fallback.
5. `npm run check:domain-rules` passes.
6. New env vars documented in CLAUDE.md's Environment Variables section.
