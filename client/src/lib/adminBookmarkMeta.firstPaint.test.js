import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const html = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../index.html"),
  "utf8",
);

describe("Safari admin bookmark first paint", () => {
  it("declares apple-mobile-web-app-capable so home-screen launch is standalone", () => {
    expect(html).toMatch(
      /<meta name="apple-mobile-web-app-capable" content="yes"/,
    );
  });

  it("carries no inline admin first-paint script — renderHTML owns prod first paint", () => {
    // Production SPA HTML is served through renderHTML in server/index.js,
    // whose SECTIONS table already swaps manifest/title/apple-title/
    // theme-color and injects html.admin-app for /admin (applyHtmlMetadata,
    // server/services/report-page-metadata.js) before the response goes
    // out. A second inline mechanism here can silently diverge from it —
    // this test keeps the duplicate from coming back. (Vite dev serves the
    // raw file; there AdminSafariShell's effect applies admin identity
    // after mount, which is fine — dev is not a home-screen install
    // surface.)
    expect(html).not.toMatch(/admin-manifest\.json/);
    expect(html).not.toMatch(/classList\.add/);
  });
});
