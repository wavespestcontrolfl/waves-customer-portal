# Privacy text for the Bug Identifier extension

Each store (Chrome Web Store, Edge Add-ons, Firefox Add-ons) needs a privacy
policy URL. Add the section below to the
website's privacy policy (`wavespestcontrol-astro`,
`src/content/pages/privacy-policy.md`, bumping its `modified:` date), then
use `https://www.wavespestcontrol.com/privacy-policy/` in every store listing.
The extension's footer already links there. If the AI providers behind the
`pest_id_app` lane in the model switchboard change, update the provider
sentence.

---

## Bug Identifier browser extension

The Waves Pest Control "Bug Identifier" extension for Google Chrome,
Microsoft Edge and Mozilla Firefox identifies a bug, spider or other pest
from a photo.

**What it sends.** When you ask it to identify something, the extension
sends that photo to Waves Pest Control's server at
portal.wavespestcontrol.com: a photo you chose, pasted or dropped in, an
image you right-clicked, or the area of the page you selected. Nothing else
from the page is sent, and the extension collects no name, email address,
location or account information.

**How it is used.** Our server passes the photo to our AI providers
(currently Google's Gemini, and OpenAI when Gemini can't answer) only to
identify it, and returns the answer to your browser. Waves does not store the
photo or the answer, does not use them for advertising, and does not sell
them. To prevent abuse, our server keeps a daily count of identifications and
short-lived, IP-based rate limits; neither holds a photo.

**What stays in your browser.** The extension holds the photo you selected
in the browser's temporary session storage for the moment it takes to pass
it to the side panel (the sidebar in Firefox), then deletes it. It does not read your browsing history. It
only sees a page when you right-click an image or choose to select a bug on
that page.

**Links.** Links from the extension to wavespestcontrol.com carry
`utm_source=chrome-extension` (in every browser) so we can tell those visits
apart; the rest of this policy applies on the website.

**Questions:** contact@wavespestcontrol.com
