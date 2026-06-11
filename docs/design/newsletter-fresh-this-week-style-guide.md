# "Fresh This Week" Style Guide — the Beehiiv-Era Formula

Distilled from exhaustive teardowns of the shipped Beehiiv archive
(waves-pest-newsletter.beehiiv.com), 2026-06-11. The owner's direction:
**the most recent issues (May–Jul 2025) are the canonical template.**
The generator (`server/services/newsletter-draft.js`) encodes this
formula; this doc is the human-readable source of truth for anyone
editing drafts in Compose or tuning the prompt.

## Evolution (why these rules and not others)

| Era | Images | Structure | Sell |
|---|---|---|---|
| Jan 2025 | designed promo PNGs | black H3s, cramped one-line facts, bare-domain links | heavy ("bug-busting inbox buddy") |
| Mar–Apr 2025 | AI scene photos → first reaction GIFs | brick-red H2s, TOC, mascot divider, clock-emoji device | one wink max |
| **May–Jul 2025 (canonical)** | **reaction GIFs + punchline captions, custom cartoon thumbnails** | scoop bullets, inline event-name links, kickers, two-branch P.S. | **~0/10 — brand is wallpaper** |

Everything kept through July is load-bearing. Everything dropped
(promo graphics, hard sell, descriptive captions) is a known dead end.

## Issue anatomy (canonical order)

1. **Subject** — one leading thematic emoji + either a noun-triple with
   kicker ("🌪️ Twisters, Tail Wags & Pirates? Unleash The Weekend") or a
   full declarative sentence with a curiosity gap ("🥧 Someone's Going to
   Win $500 for Baking a Pie").
2. **Preview text** — the second punchline, never a summary. Roast or
   three-fragment cadence: "Could be you. Could be Grandma. Will be
   chaos." / "If you're bored this weekend, that's a *you* problem!"
3. **Hero/thumbnail** — custom flat retro-cartoon collage restating the
   subject (the ONLY designed visual; everything inside is meme-grade).
4. **TOC** ("In this email:") → **cold-open meme GIF + caption** before
   any words → **👋 greeting** with dense bold/italic interleave, a
   "Whether you're X, Y, or Z" triad, FOMO close + 👇.
5. **Events (7–10)**, each:
   - Curiosity-gap H2 (emoji + bold-italic) that never names the event:
     "🐶 PSA: You Might Meet Your New Best Friend This Weekend".
     Formulas: "…? Yes, Please" / "…? Say Less" / "…? Count Us In" /
     PSA framing / direct address / equation titles.
   - Reaction GIF (pop-culture meme, NOT an event photo) + caption.
   - Hype paragraph where **the event's official name is the inline
     ticket link**.
   - Emoji fact lines: 📅 bold day/date | clock emoji matching the
     actual start hour (🕢 = 7:30, 🕗 = 8:00) bold time, 📍 italic
     venue, 🎟️ **FREE** celebrated loudly (paid: link only — never
     invent prices).
   - Rotating lead-in ("Here's the scoop:" / "Here's the deal:" /
     "Why it's a vibe:" …) + 3–5 bullets, each opening with its own
     thematic emoji.
   - Optional 👉 pro-tip line(s).
   - **Bold one-line kicker**: "This is **Bradenton's Fourth of July
     mic drop.**"
6. **Outro** — "That's the scoop, crew" + callback triad referencing the
   actual lineup + ✔️ checklist (practical + absurd: "Hydrate like it's
   your job" / "Don't underestimate the power of a funnel cake").
7. **Sign-off** — "Catch you out there!" / "— The Waves Pest Control
   Team 🌊" (owner decision 2026-06-11: Team form, not "Waves crew").
8. **P.S. two-branch forward joke** — "If you loved this, forward it to
   a friend who [hyper-specific persona]. If you didn't… [reverse-blame
   punchline] 🎪" — referencing this issue's events.

## Caption genre (GIF captions are their own comedic form)

3–8 words (12 max), **never descriptive**. Five proven shapes:

- **Equation**: "Planetarium + 'Laaaasers' + legendary tracks = yes"
- **Three-fragment cadence**: "Tiny anglers. Big catches. Major
  bragging rights." / "Same boom. Better backdrop."
- **GIF-source riff**: "Came for the rum. Stayed for the scandal."
- **Meme grammar**: "When the funnel cake slaps harder than the
  fireworks." / "How it feels to defend your playlist from one more
  Luke Bryan request."
- **"X, but make it Y" / "Mood:"**: "Photosynthesis but make it fun." /
  "Mood: Baroque and unhinged."

## Humor device kit

Parentheticals as a second comic voice ("no judgment", "yes, really",
"you *will*"); affectionate reader/dad/local roasts ("New Balance stock
on the rise"); hyper-specific personas; bathos ("$500 gift card and the
world's most charming weapon: a wooden spoon"); mock warnings ("Don't
say we didn't warn you"); internet idioms in moderation (rent-free,
full send, serotonin); incredulity tics ("…and 8th place?! 👀");
Florida in-jokes (foldable chair in the trunk, sunscreen,
afternoon-thunderstorm dodging).

## Brand rules

- **Pest sell ≈ 0.** The mascot GIF divider is the only ad. At most ONE
  sly bug wink per issue ("a garden so lush, even the bugs pay rent!").
- Homeowner Minute stays (portal addition, non-salesy, facts-bank
  sourced) — it must stand alone as a useful tip.
- No buttons, ever — inline text links only.
- The discontinued customer-appreciation segment ($100 winner / review
  card / Google-review CTA) must NOT come back.

## Themed lanes (documented for future newsletter types — NOT the weekly guide)

The Beehiiv archive has two non-event lanes, each its own content tag:

**🦟 Pest Watch** (e.g. the Feb 2025 mosquito PSA — the most sales-forward
issue that exists, and it's still only ~3.5/10):
- Structure: edutainment facts (~60% of words: "So yeah, that mosquito
  keeping you up at night? Probably a mom-to-be.") → ONE earnest
  feature-benefit pitch section (~25%) → voice-y close (~15%).
- The **humor sandwich**: irreverence lives in headers/captions/kickers;
  the pitch bullets themselves are sincere. No product name, no price,
  no discount, phone CTA only. Urgency is biological/seasonal ("By March
  they're out in full force"), never commercial.

**🌞 Landscaping That Gets SWFL** (e.g. "9 SWFL Plants That Don't Need
You"): anthropomorphized-personality listicle, per item: emoji H2 with
a personality epithet ("Firebush: The 'Set It and Forget It' Superstar")
→ image + punchline caption → personality prose → labeled utility
blocks (`Why it's awesome:` 4 emoji bullets / `Where to plant it:` /
`Hot tip:`). Real horticulture embedded, never dumbed down: **bold =
facts**, *italic = jokes* — the info layer and voice layer stay visually
separable. Zero sell; sign-off links a city SEO page.

**Seasonal listicle specials** (holiday/NYE, Dec 2024): numbered H2s in
chronological order, `🗓 When / 📍 Where / 🎉 Why Go / 💡 Pro Tip` fact
blocks, per-entry vibe-framers ("For the fam:", "For the *fancy
folks*:"). Shipped in pre-formula voice — if revived, render in the
mature voice.

The weekly guide's **Homeowner Minute** is where this themed energy
lives today: same bold-facts/italic-jokes separation, biological
urgency, optional "Hot tip:" closer, zero pitch.

## What the generator enforces that the human era couldn't

Wrong day-names shipped in 4 of 8 issues; one issue pasted a
Ticketmaster cart-session URL as a ticket link; another promised
"cannonballs" in the intro/og:image for an event that wasn't in the
lineup. The pipeline's factual lock (eventId anchoring, DB-locked
dates/venues/URLs, hallucinated-claim hard-block) makes that whole bug
class impossible — model prose can never override the database.
