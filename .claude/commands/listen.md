---
description: Mine today's Claude Code + Codex session transcripts for blog-post ideas, brainstorm them with the owner, and park the keepers in the content review queue
argument-hint: optional --hours=N (default 24)
---

Your work sessions are full of content ideas. This command listens to them.

Runs locally on this Mac (the transcripts live in `~/.claude/projects` and
`~/.codex/sessions`) and hands ideas to the EXISTING content engine as
category-seed briefs parked at `pending_review` — the runner can never claim
one until the owner approves it in the content review queue. Strictly
outbound blog content: never customer communications, never a draft SMS or
email.

Arguments: $ARGUMENTS

## 1. Extract (no DB, one FAST-tier LLM pass over redacted prose)

```sh
node ops/agents/listen-transcripts.js extract --hours=24 --out=/tmp/listen-<date>.json --execute
```

The script keeps only user/assistant prose (tool results, tool inputs and
thinking blocks are dropped whole), runs `pii-redactor` on every chunk before
dispatch, then writes the manifest to `--out` (`--execute` authorizes the
write; without it nothing is written — the manifest is only printed) and prints each kept idea with its slug, thesis, why-now, and the ideas it dropped (with the
targeting rule that dropped them). Pass `--hours=48` after a day off.
Turns the redactor cannot clear with confidence (lowercase-heavy prose
where a name could hide, digit runs, pasted credentials) are withheld whole
— the "withheld" count tells you how much of the day never left the Mac.

## 2. Brainstorm (the evening sit-down)

Show the owner the kept list, one line per idea: id, title, why-now. Then:

- Ask which to keep, which to reshape, which to drop. Reshaping means editing
  the manifest JSON in place (title, slug, thesis, outline, sources) — keep
  the `id`, keep slugs under `/pest-control/`, `/lawn-care/`, `/tree-shrub/`
  or `/mosquito/`, and keep sources on the allowed hosts (UF/IFAS EDIS,
  gardeningsolutions.ifas, entnemdept.ufl, epa.gov, fdacs.gov, cdc.gov).
- Apply the waves-content rulings while you talk: informational lane only,
  footprint cities only, no statewide framing, no "safe" product claims, no
  re-entry minutes, one entity per post (if a live post already owns the
  entity, propose a refresh instead of a seed).
- Offer angles the transcript suggests but the model missed — the point of
  the sit-down is the owner's judgement, not the model's list.

Seed mode re-runs every targeting ruling on the edited manifest and refuses
the whole selection if any brief fails — fix the brief, do not bypass.

## 3. Seed the keepers (dry run, then execute)

```sh
railway run --service Postgres node ops/agents/listen-transcripts.js seed --file=/tmp/listen-<date>.json --only=<id,id>
railway run --service Postgres node ops/agents/listen-transcripts.js seed --file=/tmp/listen-<date>.json --only=<id,id> --execute
```

The dry run flags rows already in `opportunity_queue`, titles already queued,
and titles that are already live posts. Execute seeds the rest at
`pending_review`; the owner releases each one from the admin content review
queue (requeue → pending), after which the normal chain runs: brief → writer →
gates → hero → Astro PR → Codex → poller.

## Never

- Never seed with `--execute` before the owner has said which ids to keep.
- Never paste raw transcript text into the manifest, a PR, or a brief — the
  evidence line is the ≤200-char redacted snippet the script wrote.
- Never route an idea to customer comms, SMS drafts, or review requests.
