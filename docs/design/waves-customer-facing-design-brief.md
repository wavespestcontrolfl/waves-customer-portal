# Waves Customer-Facing Design Brief

A separate, high-level design direction for customer-facing surfaces. Explicitly **not** the monochrome admin spec. Intentionally warmer, more branded, mobile-first.

**This brief exists so Claude Code doesn't accidentally apply the admin monochrome rules to customer-facing surfaces.** A full detailed spec like the admin one will be written before any of these surfaces are redesigned. This document is a placeholder and a scope fence.

---

## Surfaces in scope

- **Estimate** — web view and PDF that customers receive (the $800–$5,000 sales document)
- **Invoice** — web view and PDF that customers receive (billing document)
- **Booking page** — lead capture funnel on marketing sites, "Get a quote" flow
- **Appointment page** — scheduled service confirmation view and customer self-service reschedule
- **Customer portal** (`/portal`) — account view for existing customers to see history, pay invoices, manage services
- **Post-service follow-up** — the page a customer lands on after a completed service, review request
- **Email templates** — the styled HTML that goes out for estimates, invoices, appointment reminders, review requests
- **SMS landing pages** — any short-link destination from SMS (estimate links, payment links, reschedule links)

## Why this is different from admin

Admin UI optimizes for Virginia's throughput. She opens it 100+ times a day; density beats warmth, color is a scarce resource used for alerts only, UPPERCASE CTAs signal institutional professionalism.

Customer UI is the opposite situation. A homeowner sees one estimate in their inbox. They decide in 30 seconds whether Waves feels like a company they trust with $261/month. Density hurts. Institutional coldness hurts. What matters is:

- **Warmth and trust.** Clean, confident, personable — not clinical.
- **Brand presence.** Waves has a name and a story. The surfaces customers see should reflect that.
- **Clarity for non-experts.** The customer is a homeowner, not a pest tech. No jargon, no abbreviations.
- **Mobile-first.** Most customers open these on their phones. Design from 390px up.
- **One decision per page.** Customer UI is a funnel. Each page should push toward one clear action.

## Design direction (not a spec)

### Color

Brand color is **Wave Teal** — a deep ocean teal around `#0F6E56` (the color reserved from the admin spec as "not used there, but appropriate here"). Plus a warmer supporting palette:

- Wave Teal (primary brand) — buttons, links, key accents
- Sand — warm off-white for backgrounds, `#F9F5EF` or similar
- Deep navy — for text on light backgrounds, warmer than pure black
- Coral or sunset — a warm accent for highlights and "hot" moments
- Still use restraint — 2 brand colors + 1 accent is enough, not a rainbow

Colors are allowed to *decorate*, not just signal, on customer surfaces. A hero section can have brand color. A testimonial can have a warm tint. A call-to-action can pop. This is a marketing context.

### Typography

- Still Inter (or switch to something with more character like **Instrument Serif** for headlines + Inter for body — decide during detailed spec)
- Larger sizes than admin. Body 16px, headlines 32–56px on hero moments.
- Can use weight 600 and 700 here — bolder weights read as confident on marketing surfaces.
- Title Case acceptable in headlines. Sentence case in body. Never UPPERCASE for CTAs here — feels institutional.

### Spacing

- Generous. 32–64px section padding, not 16–24px like admin.
- Touch targets 48px+ minimum on mobile. Customers have thumbs.

### Imagery

- Photography allowed and encouraged. Real photos of Waves trucks, of Southwest Florida properties, of the team. Not stock imagery.
- Illustrations allowed if used sparingly.
- Waves logo prominent on every surface.

### Copy tone

- Conversational, not corporate.
- Written in Waves' voice — the same casual, direct tone as the blog.
- First-person plural ("We'll be out Tuesday morning" not "Your technician has been dispatched").
- No jargon. "Lawn fertilizer" not "agronomic nitrogen amendment."

---

## What NOT to do

- Don't copy the admin spec's monochrome palette
- Don't use UPPERCASE CTAs on customer surfaces — reads cold, institutional
- Don't use 13px body text — customers' eyes are older and unfocused
- Don't use 0.5px hairline borders as the primary structural language — feels fragile and clinical on consumer surfaces
- Don't use `text-tertiary` for anything important — customers aren't scanning for muscle memory, they're reading
- Don't use `tabular-nums` on everything — feels like a spreadsheet
- Don't deploy a coldly professional estimate page at the exact moment a homeowner is deciding whether to trust Waves with $3,140/year

---

## Highest-leverage first

If time is constrained, redesign in this order:

1. **Estimate** (web + PDF). This is the revenue document. Every dollar of new customer revenue flows through it. A trustworthy estimate converts; a clinical one doesn't.
2. **Booking page / lead capture.** This is the top of the funnel. Every lead the PPC spend generates lands here.
3. **Invoice.** Seen by every paying customer every month. Billing moments are trust moments.
4. **Customer portal.** Existing customers' self-service hub. Lower urgency than the above because customers are already converted, but still high-value.
5. **Post-service follow-up / review request.** Review velocity feeds the flywheel. A warmer page drives more reviews than a bland one.
6. **Appointment page and SMS landing pages** last — they're confirmations, not decision points.

---

## Decisions pending

When writing the full spec, the following need answers:

- Exact brand color values (Wave Teal shade, warm accent choice)
- Font choice (stick with Inter or introduce a display serif)
- Logo direction — is there a refreshed mark, or stay current?
- Photography vs illustration as dominant imagery
- Whether the customer portal shares any components with admin or is fully separate (recommended: fully separate)
- How much the brand voice extends into PDFs (which are static and more formal by nature)

---

## Status

This is a direction, not a spec. A full detailed spec comparable to the admin document should be written before any of these surfaces are redesigned. The admin tier 1 migration (Dashboard, Dispatch, Customers, Estimates, Communications) takes priority in the build order — customer-facing work begins after admin is stable and Virginia has signed off.

**Strict scope boundary: if Claude Code is working on admin surfaces, it does not touch customer-facing surfaces. And vice versa.**
