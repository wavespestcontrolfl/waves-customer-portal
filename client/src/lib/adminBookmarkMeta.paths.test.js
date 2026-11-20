import { describe, expect, it } from "vitest";
import { isAdminPath, isFieldPath } from "./adminBookmarkMeta";

// React Router matches /ADMIN/TODAY too: both predicates follow it (Codex #5573 r9).
describe("admin/field path predicates", () => {
  it("are case-insensitive", () => {
    expect(isAdminPath("/ADMIN/TODAY")).toBe(true);
    expect(isFieldPath("/ADMIN/TODAY")).toBe(true);
    expect(isAdminPath("/Admin")).toBe(true);
    expect(isAdminPath("/administrator")).toBe(false);
    expect(isFieldPath("/admin/todays")).toBe(false);
  });

  // React Router decodes each segment before it matches (decodePath in
  // @remix-run/router): these URLs open Today, so the predicates say so too.
  it("decode each segment, as React Router does", () => {
    expect(isAdminPath("/%61dmin/today")).toBe(true);
    expect(isFieldPath("/%61dmin/today")).toBe(true);
    expect(isFieldPath("/admin/%74oday")).toBe(true);
    expect(isFieldPath("/admin/%54ODAY/visit")).toBe(true);
    // An encoded slash stays inside its segment: no route matches it.
    expect(isAdminPath("/admin%2Ftoday")).toBe(false);
    expect(isFieldPath("/admin/today%2Fvisit")).toBe(false);
    // A path that does not decode is matched as it is.
    expect(isAdminPath("/admin/%E0%A4%A")).toBe(true);
    expect(isFieldPath("/admin/%E0%A4%A")).toBe(false);
  });
});
