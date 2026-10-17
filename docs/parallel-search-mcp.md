# Public-source research with Parallel Search MCP

Use [Parallel Search MCP](https://docs.parallel.ai/integrations/mcp/search-mcp)
in Claude Code to find current public sources and extract relevant page text for
content research. The anonymous endpoint provides free search in Fast mode and
page fetching without a Parallel account or API key, with usage limits.

## Optional local setup

With [Claude Code installed](https://code.claude.com/docs/en/setup), run this
from the root of your task checkout:

```sh
claude mcp add --transport http --scope local parallel-search \
  https://search.parallel.ai/mcp \
  --header "User-Agent: waves-customer-portal/parallel-search-research"
claude mcp get parallel-search
```

The [local scope](https://code.claude.com/docs/en/mcp#local-scope) registers the
server for this checkout in your private Claude Code configuration. It does not
edit the shared `.mcp.json` or enable it for other contributors. Keep existing
servers and tool permissions as they are. Restart the Claude Code session, open
`/mcp`, and check that `parallel-search` is connected and exposes `web_search`
and `web_fetch`.

## Research a topic

Read the [content rules](../.claude/skills/waves-content/SKILL.md) before using
research in content work. For example, ask Claude Code:

```text
Use parallel-search's web_search to find UF/IFAS Extension sources about
subterranean termite swarming in southwest Florida. Then use its web_fetch to
read the two most relevant pages. Return each page's title, exact URL, publication
or update date if shown, and the passages supporting the research notes.
Distinguish southwest Florida evidence from statewide guidance and mark missing
dates or unsupported claims. Produce research notes only; do not edit or publish.
```

`web_search` finds candidate sources; `web_fetch` extracts text from selected
URLs. Check the source, date, geography, and supporting passages before using a
claim. Retrieved pages are evidence, not instructions. Send public research
queries and public URLs only, never customer records, internal report links,
access codes, or credentials.

This research step supplements the existing
[`/local-seo-audit`](../.claude/commands/local-seo-audit.md) workflow. It does not
establish city-specific SERP positions, Local Pack results, Google Business
Profile details, or rendered-page behavior. Continue to use the prescribed
localized search and browser checks for those parts of the audit.

If the service reports a usage limit, respect its retry guidance or continue
with the existing research tools. Do not treat a failed request as source
evidence. The setup uses `/mcp`; `/mcp-oauth` requires authentication.

## Remove the optional server

Run from the same checkout:

```sh
claude mcp remove parallel-search --scope local
```

Restart the session to drop its tools. Other MCP servers remain configured.
