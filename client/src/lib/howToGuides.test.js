// The Quick Links how-to guides: each inserts its steps once, with a deep
// link LoginPage will honor, and guides that share a deep link still insert
// side by side.
import { describe, expect, it } from "vitest";
import { HOW_TO_GUIDE_LINKS, howToGuideText } from "./howToGuides";
import { STATIC_COMPOSER_LINKS, appendStaticLinkClause, libraryLinkClause, staticLinkPresent } from "./composerLinks";

const guide = (key) => HOW_TO_GUIDE_LINKS.find((link) => link.key === `howto:${key}`);
const insert = (body, link) => appendStaticLinkClause(body, { url: link.url, clause: libraryLinkClause(link), guide: link });

describe("how-to guide rows", () => {
  it("ships the nine guides in the How-to group, each with plain-ASCII steps", () => {
    expect(HOW_TO_GUIDE_LINKS.map((link) => link.key)).toEqual([
      "howto:add_contact", "howto:autopay", "howto:notifications", "howto:get_app", "howto:documents",
      "howto:reschedule", "howto:access_notes", "howto:add_property", "howto:refer",
    ]);
    for (const link of HOW_TO_GUIDE_LINKS) {
      expect(link.category).toBe("howto");
      // Texts go out as GSM-7; a curly quote or dash would switch the segment encoding.
      expect(howToGuideText(link)).toMatch(/^[\x20-\x7E\n]+$/);
    }
  });

  it("deep-links each guide through login to a tab the portal routes", () => {
    const tabs = ["dashboard", "plan", "visits", "billing", "refer", "documents", "property", "learn"];
    for (const link of HOW_TO_GUIDE_LINKS) {
      const next = new URL(`https://${link.url}`).searchParams.get("next");
      expect(next.startsWith("/?")).toBe(true);
      expect(tabs).toContain(new URLSearchParams(next.slice(1)).get("tab"));
    }
    expect(guide("autopay").url).toBe("portal.wavespestcontrol.com/login?next=%2F%3Ftab%3Dbilling%26focus%3Dpayment-methods");
  });

  it("inserts numbered steps that end on the link", () => {
    const text = libraryLinkClause(guide("add_contact"));
    expect(text.split("\n")[0]).toBe("How to add another contact in the Waves app:");
    expect(text).toContain("4. Type their name, phone number and email. To add more people, tap + Add another contact (up to 3).");
    expect(text.endsWith(`Open it here: ${guide("add_contact").url}`)).toBe(true);
  });

  it("inserts two guides that share a deep link, but never the same guide twice", () => {
    const contact = guide("add_contact");
    const notifications = guide("notifications");
    expect(contact.url).toBe(notifications.url);
    const once = insert("Hi Sam,", contact);
    const both = insert(once, notifications);
    expect(both).toContain(notifications.title);
    expect(insert(both, contact)).toBe(both);
  });

  it("still finds a guide after the operator edits a step", () => {
    const body = insert("", guide("refer")).replace("Tap Refer.", "Open the Refer tab.");
    expect(staticLinkPresent(body, guide("refer"))).toBe(true);
  });
});

describe("static link duplicate check", () => {
  const login = STATIC_COMPOSER_LINKS.find((link) => link.key === "portal_login");

  it("does not mistake a deep link for the bare login link", () => {
    const body = insert("", guide("autopay"));
    expect(staticLinkPresent(body, login)).toBe(false);
    expect(appendStaticLinkClause(body, { url: login.url, clause: libraryLinkClause(login) })).toContain(`${login.clause}: ${login.url}`);
  });

  it("still refuses the same link twice, including at the end of a sentence", () => {
    expect(staticLinkPresent(`Sign in at ${login.url}`, login)).toBe(true);
    expect(staticLinkPresent(`Sign in at ${login.url}.`, login)).toBe(true);
    expect(staticLinkPresent(`Sign in at ${login.url} today`, login)).toBe(true);
  });
});
