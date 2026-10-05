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

describe("non-JSON error bodies", () => {
  const response = (status, body, type) => ({
    ok: false, status, statusText: "",
    headers: { get: (name) => (name.toLowerCase() === "content-type" ? type : null) },
    clone() { return this; },
    json: async () => { throw new Error("not json"); },
    text: async () => body,
  });

  it("reads a Cloudflare 524 HTML page as the status, not its markup", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(524, "<!DOCTYPE html><html><title>524: A timeout occurred</title></html>", "text/html; charset=UTF-8")));
    await expect(adminFetch("/admin/lawn-assessment/assess", { method: "POST" }))
      .rejects.toMatchObject({ status: 524, message: "Request failed (524)" });
  });

  it("still surfaces a plain-text server message (Express labels res.send strings text/html)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(400, "Missing ?location= parameter", "text/html; charset=utf-8")));
    await expect(adminFetch("/admin/settings/x")).rejects.toMatchObject({ status: 400, message: "Missing ?location= parameter" });
  });
});
