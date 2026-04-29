# Admin Design Studies — Claude language

Visual studies exploring "what would the admin look like in Claude's design language" — for direction-setting only. None of these are production specs. Open the HTML files locally or view the PNGs in GitHub.

## The four directions

Open `waves-claude-options-1440.png` for all four side-by-side, or each individual PNG for full detail.

| Option | Surface | H1 | Accent | Density | Feels like |
|---|---|---|---|---|---|
| **A — Editorial** (`option-A-editorial.png`) | Cream `#F5F2ED` | Tiempos serif 44px | Coral `#D97757` | 32px / 12px radius | claude.ai magazine cover |
| **B — Workhorse** (`option-B-workhorse.png`) | Cream `#F5F2ED` | Inter 24px medium | Coral `#D97757` | 24px / 8px radius | Notion / Linear |
| **C — Monochrome** (`option-C-monochrome.png`) | Cream `#F5F2ED` | Tiempos serif 44px | None — alert-red only | 32px / 12px radius | NYT obituary |
| **D — Brand Bridge** (`option-D-brand-bridge.png`) | Sand `#FDF6EC` | Tiempos serif 44px (navy) | Waves Blue `#009CDE` | 32px / 12px radius | Marketing site shell |

## Tradeoffs

- **A — Editorial.** Most "Claude.ai." Beautiful in screenshot. Feels like a content site after 8 hours of use. Coral on a B2B operations dashboard is unusual for the older trade clientele.
- **B — Workhorse.** Closest to what Virginia actually needs daily. Inter H1 is honest about what the page is. **Pick if optimizing for daily-use rigor.**
- **C — Monochrome.** Kills the policy tension entirely — alert-red is the only color, matching the existing CLAUDE.md rule. Most defensible against scope creep / accessibility / "is that decorative?" questions. **Pick if optimizing for institutional restraint.**
- **D — Brand Bridge.** Lets you ship without modifying the "no brand colors in admin" rule, because navy + Waves Blue both already exist in customer surfaces. Most likely to land politically.

## Policy note

CLAUDE.md currently says: *"Never apply customer-facing brand styling inside `/admin/*` — admin stays monochrome."* Options A, B, and D all break that rule (coral isn't brand, but it's still decoration; D directly imports brand colors). Option C is the only one that respects the existing rule as written.

If A/B/D wins, the rule needs an explicit revision in CLAUDE.md plus a DECISIONS.md entry recording the policy flip. **Decide on color-policy before implementation begins.**

## Source

Single source file `waves-claude-options.html` renders all four variants stacked. Open in any browser; resize to test responsive behavior.
