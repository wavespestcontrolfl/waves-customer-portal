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
});
