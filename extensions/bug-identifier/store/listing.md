# Chrome Web Store listing — Bug Identifier

Everything to paste into the Chrome Web Store developer dashboard. Claims
follow the waves-content truth rules: company facts from the brand record,
species count from the catalog (239 approved entries in 29 groups as of
2026-10-31), no accuracy numbers.

## Store listing tab

**Name** (from `manifest.json`, 44 of 75 characters)

    Bug Identifier – Insect & Spider ID by Waves

**Summary** (the manifest `description`, 124 of 132 characters)

    Identify bugs, spiders and insects from a photo or any image on the web. Free, from a licensed Florida pest control company.

**Category:** Lifestyle › Household (Productivity › Education also fits).

**Language:** English (United States)

**Description**

    Found a bug and want to know what it is? Bug Identifier tells you from a photo, and whether to leave it alone, keep an eye on it, or have a pro take a look.

    HOW IT WORKS
    • Right-click any image on the web and choose "Identify this bug".
    • Or drop in, paste, or choose your own photo.
    • Or drag a box around a bug on any page.

    WHAT YOU GET
    • The likely species and its scientific name, when the photo shows enough to tell.
    • A plain verdict: helpful, harmless, keep an eye on it, or worth a pro look.
    • Safety notes for anything that bites, stings or can make you sick.
    • What in the photo matches, and what we would still need to see.
    • Look-alikes it is often confused with, and the extra photo that would help confirm it.

    Answers come from the same species catalog as the Waves Pest Control app and the pest identifier on wavespestcontrol.com: more than 230 bugs, spiders, ticks, snakes, lizards and other critters found in Florida homes and yards. When a photo can't settle it, Bug Identifier says so instead of guessing.

    Built by Waves Pest Control, an FDACS-licensed pest control company (license JB351547) serving Manatee, Sarasota and Charlotte counties in Southwest Florida.

    Free, no account needed. The answer is an AI suggestion from your photos, not a professional inspection.

    PRIVACY
    Photos go to Waves and its AI providers only to identify the bug, and Waves doesn't keep them. The extension doesn't read your browsing history: it only sees a page when you right-click an image or choose to select a bug on it.

**Graphic assets** (all in `store/`)

| Field | File |
|---|---|
| Store icon (128x128) | `../icons/icon-128.png` |
| Screenshots (1280x800) | `screenshots/1-identify.png`, `screenshots/2-select-on-page.png`, `screenshots/3-start.png` |
| Small promo tile (440x280) | `screenshots/promo-small-440x280.png` |

The store images use one photo, `sample-photos/golden-silk-orbweaver.jpg`,
which is public domain (CC0), so the listing needs no photo credit. Sources
and licenses for both sample photos are in `sample-photos/CREDITS.md`. To use
another photo, replace that file and re-run `scripts/screenshots.mjs`.

## Privacy practices tab

**Single purpose**

    Identifies a bug, spider or other pest from a photo the user provides or an image they select on a web page.

**Permission justifications**

| Permission | Justification |
|---|---|
| `activeTab` | When the user right-clicks an image or picks "Select a bug on this page to identify", the extension captures the visible tab once to crop the image or box they chose. It has no access to pages it was not invoked on. |
| `contextMenus` | Adds the "Identify this bug" and "Select a bug on this page to identify" right-click items. |
| `scripting` | Only after the user invokes it on a page: injects the drag-a-box selector, or measures where the right-clicked image sits so it can be cropped from the capture. |
| `sidePanel` | Shows the identifier and its answer in Chrome's side panel next to the page. |
| `storage` | `chrome.storage.session` (memory only) holds the photo the user just selected while it passes from the right-click menu to the side panel; it is deleted as soon as the panel picks it up. |
| Host `https://portal.wavespestcontrol.com/*` | Sends the user's photo to the Waves Pest Control identification API and reads the answer. |

**Remote code:** No, I am not using remote code.

**Data usage:** tick **Website content** (the photo or image the user
chooses to identify). Tick nothing else. Certify all three: not sold to
third parties, not used for purposes unrelated to the single purpose, not
used for creditworthiness or lending.

**Privacy policy URL:** `https://www.wavespestcontrol.com/privacy-policy/`,
once it carries the section in `../PRIVACY.md`.

## Edge Add-ons (Partner Center)

The same zip as Chrome. Text and answers are the Chrome ones above, with
these Edge-only fields:

- **Category:** Photos (Edge has no Lifestyle category).
- **Website:** `https://www.wavespestcontrol.com/pest-identifier/`;
  **support contact:** contact@wavespestcontrol.com.
- **Extension logo:** 300x300, rendered from `icons/icon.svg` at that size
  (`scripts/render-icons.mjs` renders only the manifest sizes).
- **Search terms:** bug identifier, insect identifier, spider identifier,
  pest identifier, identify bugs.
- **Notes for certification:** the reviewer steps, including the 6 an hour
  and 15 a day per-IP limits.

## Firefox Add-ons (AMO)

Upload `dist/bug-identifier-firefox-<version>.zip` (`package.mjs --firefox`).
That build declares `browser_specific_settings.gecko`: the add-on ID
`bug-identifier@wavespestcontrol.com`, Firefox 140 or later, and
`data_collection_permissions.required: ["websiteContent"]` (the photo the
user picks goes to the Waves API). Summary, description, privacy policy URL
and screenshots are the Chrome ones above. Category: Photos, Music & Videos
(it works on photos, as the Edge category does).

## Getting found in store search

Store search weighs the name most, then the summary and description, then
installs, ratings and weekly users. The name leads with the
highest-demand term ("Bug Identifier") and names insects and spiders; the
description uses the natural variants once each. Don't add a keyword list:
the store's spam policy rejects them. The first installs and reviews move
ranking the most, so link the listing from the website's `/pest-identifier/`
page and mention it in the newsletter after approval.
