// The Quick Links how-to guides: each inserts its steps once, with a deep
// link LoginPage will honor, and guides that share a deep link still insert
// side by side.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HOW_TO_GUIDE_LINKS, howToGuideText } from "./howToGuides";
import { STATIC_COMPOSER_LINKS, appendStaticLinkClause, libraryLinkClause, staticLinkPresent } from "./composerLinks";
import emailSeed from "../../../server/models/migrations/20261120200000_seed_how_to_guide_email_templates";

const guide = (key) => HOW_TO_GUIDE_LINKS.find((link) => link.key === `howto:${key}`);
const insert = (body, link) => appendStaticLinkClause(body, { url: link.url, clause: libraryLinkClause(link), guide: link });

describe("how-to guide rows", () => {
  it("ships the eleven guides in the How-to group, each with plain-ASCII steps", () => {
    expect(HOW_TO_GUIDE_LINKS.map((link) => link.key)).toEqual([
      "howto:add_contact", "howto:autopay", "howto:notifications", "howto:get_app",
      "howto:alerts_iphone", "howto:alerts_android", "howto:documents",
      "howto:reschedule", "howto:access_notes", "howto:add_property", "howto:refer",
    ]);
    for (const link of HOW_TO_GUIDE_LINKS) {
      expect(link.category).toBe("howto");
      // Texts go out as GSM-7; a curly quote or dash would switch the segment encoding.
      expect(howToGuideText(link)).toMatch(/^[\x20-\x7E\n]+$/);
    }
  });

  // The emailed guide and the pasted one must tell the customer the same
  // thing. When a step changes here, publish the new wording in Email
  // Templates and point this test at the migration that carries it.
  it("carries the same steps as the emailed guide", () => {
    for (const link of HOW_TO_GUIDE_LINKS) {
      const emailed = emailSeed.GUIDES.find((g) => `howto:${g.key}` === link.key);
      expect(emailed.title).toBe(link.title);
      expect(emailed.after).toBe(link.after);
      // The pasted "get the app" step holds the store links; the email has a button.
      const from = link.key === "howto:get_app" ? 1 : 0;
      expect(emailed.steps.slice(from)).toEqual(link.steps.slice(from));
      expect(link.url).toBe(`portal.wavespestcontrol.com/login?next=${encodeURIComponent(emailed.path)}`);
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

  it("ends every guide with the reply-for-help line and marks every row active-plan only", () => {
    for (const link of HOW_TO_GUIDE_LINKS) {
      const lines = howToGuideText(link).split("\n");
      expect(lines.at(-2)).toBe("Don't see one of these buttons? Reply here and we will help.");
      expect(link.description).toMatch(/^Active plans only/);
    }
  });

  it("links the iPhone alert guide to its picture page, which repeats the guide's steps", () => {
    const iphone = guide("alerts_iphone");
    expect(howToGuideText(iphone).split("\n")[1]).toBe("See these steps with a picture: https://portal.wavespestcontrol.com/help/iphone-alerts.html");
    expect(HOW_TO_GUIDE_LINKS.filter((link) => link.pictures).map((link) => link.key)).toEqual(["howto:alerts_iphone"]);

    // Served as a plain file from client/public at the same path.
    const pageUrl = new URL(`../../public${new URL(iphone.pictures).pathname}`, import.meta.url);
    const page = readFileSync(pageUrl, "utf8");
    // Every step but the Focus one appears word for word; the page splits
    // the Focus step into a list, so its key phrases are checked instead.
    const [open, alerts, immediate, focus, appStep] = iphone.steps;
    for (const text of [open, alerts, immediate, appStep, iphone.after]) expect(page).toContain(text);
    expect(focus).toContain("Silence Notifications From");
    for (const phrase of ["tap Focus, then Sleep", "Tap Apps under Allow Notifications", "If it says Allow Notifications From, tap Add, choose Waves and tap Done.", "If it says Silence Notifications From, take Waves off that list.", "Do Not Disturb"]) {
      expect(page).toContain(phrase);
    }
    // No script, and every picture it shows ships beside it.
    expect(page).not.toMatch(/<script/i);
    const images = [...page.matchAll(/<img[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]);
    expect(images.length).toBeGreaterThan(0);
    for (const src of images) {
      expect(src.startsWith("/help/")).toBe(true);
      expect(existsSync(new URL(`../../public${src}`, import.meta.url))).toBe(true);
    }
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
