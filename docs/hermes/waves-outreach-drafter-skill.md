# Hermes Skill — Waves Outreach Drafter (Backlink Manager M3c)

**Paste this into the Hostinger Hermes dashboard → Skills tab → category WAVES.**
It is the *outreach* counterpart to the existing `waves-backlink-worker` (signup)
skill. This skill NEVER signs up for anything and NEVER sends email — it only
**drafts** one-to-one editorial/partnership outreach and reports the draft back to
the Waves portal, where it lands in the operator approval queue
(`/admin/seo → Backlinks → Link Building → Needs approval`). A human approves and
the portal sends from `contact@wavespestcontrol.com`. (M3a built the claim/report
contract; M3b built the send valve + approval UI; this skill is M3c.)

---

## When to run

On request ("run an outreach drafting cycle") or on a schedule. Each cycle claims a
small batch of outreach prospects, drafts a personalized email for each, and reports
the drafts. It is safe to re-run — the portal de-dupes and the human gate stands
between every draft and any send.

## Prerequisites (operator/Adam sets these; not the agent)

- `GATE_HERMES_WORKER=true` and `HERMES_SERVICE_TOKEN` set on the portal (Railway).
- `GATE_LINK_OUTREACH=true` — the outreach lane master switch. **If it is off, the
  claim returns an empty list with a note and you must stop and tell the operator.**
- The portal service token at `/data/workspace/.waves-portal-token` (same file the
  signup skill uses).

`PORTAL_URL` below = the same portal base URL the `waves-backlink-worker` signup
skill already uses.

---

## The contract (exact)

### 1. Claim a batch — `GET /api/integrations/backlink-worker/claim?type=outreach&n=5`

Returns:
```json
{
  "prospects": [
    {
      "id": "uuid",
      "target_domain": "bradentonherald.com",
      "target_url": "https://www.bradentonherald.com/...",   // the page/site to pitch (may be null)
      "target_page": "https://wavespestcontrol.com/...",      // OUR money page to earn the link to
      "anchor_planned": "pest control bradenton",             // suggested anchor (may be null)
      "link_type": "editorial",                               // editorial | resource | guest_post | haro
      "priority": "high",
      "notes": "WDO wedge — realtor resources page",          // strategist context (may be null)
      "domain_rating": 52,
      "lease_token": "2026-06-15T07:12:33.123Z"               // ECHO THIS BACK in /report
    }
  ],
  "business_profile": {
    "brand": "Waves Pest Control",
    "website": "https://wavespestcontrol.com",
    "contact_email": "contact@wavespestcontrol.com",
    "default_location_id": "bradenton",
    "locations": [ { "id": "bradenton", "name": "...", "address": "...", "phone": "(941) ...", "google_place_id": "..." } ],
    "instructions": "Use the default location for brand-wide outreach; copy NAP exactly."
  }
}
```
- `{"prospects": [], "note": "outreach is approval-gated (linkProspectOutreach off)"}`
  → the gate is OFF. **Stop. Report to the operator.** Do not loop.
- `{"prospects": []}` (no note) → nothing to draft right now. Done.

### 2. Report each draft — `POST /api/integrations/backlink-worker/report`

```json
{
  "prospect_id": "uuid",
  "outcome": "drafted",
  "lease_token": "2026-06-15T07:12:33.123Z",
  "outreach_to_email": "editor@bradentonherald.com",
  "outreach_subject": "Local pest-pressure data for your SWFL readers",
  "outreach_body": "Hi <name>,\n\n...\n\n— The Waves Pest Control Team\n(941) ...",
  "notes": "Found editorial contact on /about/contact; angle = seasonal termite-swarm data"
}
```
Responses:
- `{"ok": true, "status": "prospect", "attempts": N}` → drafted + queued for the human. ✅
- `400 {"code":"draft_incomplete"}` → a VALID `outreach_to_email` + non-empty subject + body are all required. Fix and re-report.
- `400 {"code":"not_outreach"}` → this prospect isn't an outreach link type; skip it (don't draft).
- `400 {"code":"outreach_locked"}` → already sent / in flight / awaiting reconciliation; skip it.
- `409 {"code":"stale_lease"}` → your lease expired or was reclaimed. Re-claim before reporting again.
- `404 {"code":"not_found"}` → skip.

**Report EXACTLY ONCE per claimed prospect.** If you cannot produce a usable draft
(no findable recipient, etc.), report `outcome: "failed"` with a `notes` explaining
why — do NOT report `drafted` without all three of recipient/subject/body, and do
NOT fabricate a recipient address.

---

## Per-prospect workflow

For each claimed prospect:

1. **Research the target** (Oxylabs web-search + HTTP `requests` — there is NO browser
   runtime on this instance, so do not bootstrap chromium):
   - Find the right **recipient**: the editorial/resources/partnerships contact for
     `target_domain` (e.g. an editor, a "resources/preferred-vendors" page owner, a
     property manager). Prefer a real human/role address found on the site
     (`/about`, `/contact`, masthead, resources page). If only a generic
     `info@`/`editor@` exists, that is acceptable. If you cannot find ANY plausible
     address, report `failed` (do not invent one).
   - Find the **angle**: the specific reason THIS site/page would link to OUR
     `target_page`. Read the page in `notes`/`target_url` for context.
2. **Compose** a short, personalized, one-to-one email (see Drafting rules). Use the
   `business_profile` NAP verbatim for the sign-off; never invent business details.
3. **Report** `outcome: "drafted"` with `outreach_to_email`, `outreach_subject`,
   `outreach_body`, the `lease_token`, and a one-line `notes` recording where you
   found the contact + the angle.

---

## Drafting rules (mandatory)

- **One-to-one, never templated.** Each email references the specific site, page, or
  audience by name. No mail-merge blasts — the portal sends from the PRIMARY Waves
  inbox, so a templated/spammy draft risks the real inbox's reputation.
- **Value-first and short** (~120–180 words). Lead with why it helps THEIR readers,
  not why it helps us. Propose `target_page` as a genuine resource.
- **Subject: specific, honest, non-spammy.** No "RE:" tricks, no ALL CAPS, no
  clickbait. e.g. "Local termite-swarm timing data for your spring home guide".
- **Identify clearly as Waves Pest Control** and sign off with the brand + the
  relevant office phone from `business_profile.locations` (default location unless the
  prospect targets a specific city). Sign-off line: `— The Waves Pest Control Team`.
- **No pricing, no incentives-for-links, no fabricated stats.** If you cite local
  pest data, attribute it to Waves' Pest Pressure tracking (a real, citable asset).
- The portal fills the actual `From:` (`contact@`) — do not put a different sender in
  the body.

### Tier / angle playbook (priority order — see notes/link_type)

- **Tier 1 — local partnerships (`resource`/`editorial`, highest dual-ROI):**
  realtors/brokerages "preferred vendor / resources" pages, property & HOA
  management, home inspectors (mutual referral, non-competing), complementary home
  services. **Wedge:** WDO (termite) inspections are transaction-critical for FL home
  sales — realtors *need* a reliable vendor and link from resource pages.
- **Tier 2 — local media / digital PR (`editorial`/`haro`):** SWFL outlets (Bradenton
  Herald, Sarasota Herald-Tribune, Sarasota/SRQ Magazine, Venice Gondolier, North
  Port/Charlotte Sun, LWR Life, WWSB ABC7). Seasonal hooks: termite swarm (spring),
  lovebugs, mosquito + hurricane/post-storm surge, no-see-ums, palmetto bugs, fall
  rodents. **Linkable asset:** Waves' Pest Pressure local-activity data.

### Worked example (illustrative — do not reuse verbatim)

> **To:** features@veniceflorida-magazine.com
> **Subject:** Spring termite-swarm timing for a Venice homeowner guide
>
> Hi Dana,
>
> I read your "Spring home prep" series — really useful for new Gulf Coast owners.
> One thing we get asked constantly this time of year: when do subterranean termites
> actually swarm here? We track local pest activity across Manatee/Sarasota and put
> together a plain-English homeowner guide on swarm timing + what to look for:
> https://wavespestcontrol.com/termite-control-venice-fl/
>
> If it's a fit for an upcoming piece, I'm happy to pull our latest Venice-area swarm
> data for your readers. Either way, love the series.
>
> — The Waves Pest Control Team
> Waves Pest Control · Venice, FL · (941) 297-3337

---

## Hard rules (do not violate)

1. **Never send email.** This skill only drafts. The portal + a human operator send.
2. **Never invent business details.** Copy brand/website/address/phone verbatim from
   `business_profile`. Never invent a recipient address — if none is findable, report
   `failed`.
3. **contact@ only.** Do not propose or use any other sending identity.
4. **Report every claimed prospect exactly once** (`drafted` or `failed`).
5. **Stop if the gate is off** (empty + note). Don't loop on an empty queue.

---

## Hermes ops traps (hard-won — apply the workarounds)

- **Token / secret-redactor:** the redactor mangles `$(cat /data/workspace/.waves-portal-token)`
  inside shell commands and `Bearer <real-token>` mid-flight, sending a blank token
  (→ `invalid worker token`). **Workaround:** read the token in Python and pass it as
  a literal header arg, e.g.:
  ```python
  import requests
  token = open('/data/workspace/.waves-portal-token').read().strip()
  base = PORTAL_URL + '/api/integrations/backlink-worker'
  claim = requests.get(base + '/claim', params={'type': 'outreach', 'n': 5},
                       headers={'Authorization': f'Bearer {token}'}).json()
  # ...compose draft...
  r = requests.post(base + '/report', headers={'Authorization': f'Bearer {token}'},
                    json={'prospect_id': p['id'], 'outcome': 'drafted',
                          'lease_token': p['lease_token'], 'outreach_to_email': to,
                          'outreach_subject': subject, 'outreach_body': body, 'notes': note})
  ```
  (If you must use the terminal/curl, write a script to disk with the token baked in,
  exec it, then delete it — never echo the token.)
- **Workspace file editor once saved 0 bytes** — after any file write, verify with
  `wc -c`.
- **No browser runtime** (no chromium/system libs). Research via web-search + HTTP
  only; never bootstrap a browser. Outreach drafting needs neither.
- **Per-turn tool-iteration cap:** if you hit it mid-batch, a follow-up message in the
  SAME conversation resets the budget — no fresh chat needed. Claim a small `n`
  (≤5) per cycle.
