---
description: Run a local SEO audit on a wavespestcontrol.com page
---

Read the SEO operator context from `docs/seo-playbook/waves-seo-operator-prompt.md` and the local SEO audit prompt from `docs/seo-playbook/waves-local-seo-prompt.md`.

Then run the audit with these parameters:

$ARGUMENTS

Instructions:
1. Use the Playwright MCP to fetch and render the target URL as an actual browser would — capture visible copy, CTAs, schema blocks, mobile layout, and Core Web Vitals if accessible.
2. Use Brave Search MCP to check the live SERP for the primary keywords with location targeting for the target city.
3. Use Playwright to check the associated Google Business Profile by searching Google Maps for "Waves Pest Control [city]".
4. Produce the full audit in the output format specified by the local SEO prompt.
5. Save the audit report to `docs/seo-playbook/audits/[YYYY-MM-DD]-[page-slug].md` for future reference.
