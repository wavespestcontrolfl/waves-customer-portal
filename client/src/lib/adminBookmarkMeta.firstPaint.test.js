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

  it("swaps admin identity before React so /admin/login installs Waves Admin", () => {
    expect(html).toMatch(/admin-manifest\.json/);
    expect(html).toMatch(/Waves Admin/);
    expect(html).toMatch(/classList\.add\('admin-app'\)/);
  });
});
