// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { adminFetch } from "./admin-fetch";

afterEach(() => vi.unstubAllGlobals());
describe("admin session return target", () => {
  it("preserves the actual document URL on an expired-token hard redirect", async () => {
    const location = { pathname: "/admin/data-hygiene", search: "?status=auto_applied&tag=a&tag=b", hash: "#evidence", href: "" };
    vi.stubGlobal("window", { location });
    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 401 })));
    await expect(adminFetch("/admin/auth/me")).rejects.toMatchObject({ status: 401, code: "UNAUTHENTICATED" });
    expect(new URL(location.href, "https://fixture.invalid").searchParams.get("next"))
      .toBe("/admin/data-hygiene?status=auto_applied&tag=a&tag=b#evidence");
  });

  it("does not replace an existing login return target with a login loop", async () => {
    const location = { pathname: "/admin/login", search: "?next=%2Fadmin%2Fagents", hash: "", href: "" };
    vi.stubGlobal("window", { location });
    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 401 })));
    await expect(adminFetch("/admin/auth/me")).rejects.toMatchObject({ status: 401 });
    expect(location.href).toBe("/admin/login?next=%2Fadmin%2Fagents");
  });
});
