// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import GBPManagement from "./GBPManagement";

const response = (body, status = 200) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );

const location = (id, name, gbp = {}) => ({
  id,
  name,
  hasCredentials: true,
  pendingUpdates: 0,
  gbp: { business_name: name, special_hours: [], ...gbp },
});
const PENDING = {
  id: "upd-1",
  location_id: "sarasota",
  field_name: "business_name",
  old_value: "Fixture Old Name",
  new_value: "Fixture New Name",
  source: "places",
  status: "pending",
  detected_at: "2026-05-29T23:36:25.000Z",
};
const APPROVED = { ...PENDING, id: "upd-2", status: "approved" };

let routes;
let calls;
beforeEach(() => {
  calls = [];
  routes = {
    "GET /admin/gbp/locations": () =>
      response({
        locations: [
          location("sarasota", "Fixture Sarasota"),
          location("bradenton", "Fixture Bradenton"),
        ],
      }),
    "GET /admin/gbp/updates": (url) =>
      response({ updates: url.includes("status=approved") ? [APPROVED] : [PENDING] }),
    "GET /admin/gbp/notifications": () =>
      response({ preferences: { frequency: "weekly", field_filters: [], enabled: true } }),
  };
  vi.stubGlobal(
    "fetch",
    vi.fn((url, opts = {}) => {
      const path = String(url).replace(/^\/api/, "");
      const method = (opts.method || "GET").toUpperCase();
      calls.push({ method, path, body: opts.body ? JSON.parse(opts.body) : null });
      const key = `${method} ${path.split("?")[0]}`;
      const exact = routes[key];
      const pattern = Object.entries(routes).find(
        ([k]) => k.includes(":id") && new RegExp(`^${k.replace(":id", "[^/]+")}$`).test(key),
      );
      const hit = exact || pattern?.[1];
      return hit ? hit(path, opts) : response({ error: `no mock for ${key}` }, 404);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const open = async () => {
  render(<GBPManagement />);
  await screen.findByRole("button", { name: /Fixture Bradenton/ });
};

describe("Google profile workspace", () => {
  it("saving a non-first location keeps it selected with its refreshed data", async () => {
    routes["PUT /admin/gbp/locations/:id"] = () => response({ location: {} });
    await open();
    fireEvent.click(screen.getByRole("button", { name: /Fixture Bradenton/ }));
    fireEvent.click(screen.getByRole("button", { name: "Profile" }));
    const name = await screen.findByLabelText("Business Name");
    expect(name).toHaveValue("Fixture Bradenton");

    routes["GET /admin/gbp/locations"] = () =>
      response({
        locations: [
          location("sarasota", "Fixture Sarasota"),
          location("bradenton", "Fixture Bradenton Saved"),
        ],
      });
    fireEvent.change(name, { target: { value: "Fixture Bradenton Saved" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Business Name")).toHaveValue("Fixture Bradenton Saved"),
    );
    expect(calls.find((c) => c.method === "PUT").path).toBe("/admin/gbp/locations/bradenton");
    expect(screen.getByRole("button", { name: /Fixture Bradenton Saved/ })).toHaveClass("bg-zinc-900");
  }, 15000);

  it("offers no push to Google; Overview and Profile say where to edit the live listing", async () => {
    await open();
    expect(screen.queryByRole("button", { name: /Push to Google/ })).toBeNull();
    expect(screen.getByText(/To change the live listing, edit it in Google Business Profile/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Profile" }));
    await screen.findByLabelText("Business Name");
    expect(screen.queryByRole("button", { name: /Push to Google/ })).toBeNull();
    expect(screen.getByText(/To change the live listing, edit it in Google Business Profile/)).toBeInTheDocument();
    expect(calls.some((c) => c.path.endsWith("/push"))).toBe(false);
  });

  it("removing the last special-hours date saves an empty list", async () => {
    routes["GET /admin/gbp/locations"] = () =>
      response({
        locations: [
          location("sarasota", "Fixture Sarasota", {
            special_hours: [{ date: "2026-12-25", closed: true }],
          }),
        ],
      });
    routes["PUT /admin/gbp/locations/:id/hours"] = () => response({ location: {} });
    routes["PUT /admin/gbp/locations/:id/special-hours"] = () => response({ location: {} });
    render(<GBPManagement />);
    await screen.findByRole("button", { name: /Fixture Sarasota/ });
    fireEvent.click(screen.getByRole("button", { name: "Profile" }));
    fireEvent.click(screen.getByRole("button", { name: "Hours" }));
    fireEvent.click(await screen.findByRole("button", { name: "×" }));
    fireEvent.click(screen.getByRole("button", { name: "Save Hours" }));
    await waitFor(() =>
      expect(calls.find((c) => c.path.endsWith("/special-hours"))?.body).toEqual({ specialHours: [] }),
    );
  }, 15000);

  it("a History filter never hides pending decisions from the Queue", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Updates" }));
    expect(await screen.findByText("Pending Updates (1)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    fireEvent.click(await screen.findByRole("button", { name: "approved" }));
    await waitFor(() =>
      expect(calls.some((c) => c.path.includes("status=approved"))).toBe(true),
    );
    fireEvent.click(screen.getByRole("button", { name: /^Queue/ }));
    expect(await screen.findByText("Pending Updates (1)")).toBeInTheDocument();
    expect(screen.queryByText("All changes have been reviewed")).toBeNull();
  });

  it("Sync All reports the locations that failed", async () => {
    routes["POST /admin/gbp/locations/:id/sync"] = () => response({ error: "down" }, 503);
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Sync All" }));
    expect(
      await screen.findByText("Sync failed for every location: Fixture Sarasota, Fixture Bradenton"),
    ).toBeInTheDocument();
  });

  it("failed reads show an error, never an empty or default state", async () => {
    routes["GET /admin/gbp/locations"] = () => response({ error: "down" }, 503);
    routes["GET /admin/reviews/gbp-locations"] = () => response({ error: "down" }, 503);
    render(<GBPManagement />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load locations: HTTP 503");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("a failed pending read is not shown as all reviewed", async () => {
    routes["GET /admin/gbp/updates"] = () => response({ error: "down" }, 503);
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Updates" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load pending updates: HTTP 503");
    expect(screen.queryByText("All changes have been reviewed")).toBeNull();
  });

  it("alert preferences cannot be saved until they were read", async () => {
    routes["GET /admin/gbp/notifications"] = () => response({ error: "down" }, 503);
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Alerts" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load the saved preferences: HTTP 503");
    expect(screen.getByRole("button", { name: "Save Preferences" })).toBeDisabled();
    expect(calls.some((c) => c.method === "PUT" && c.path === "/admin/gbp/notifications")).toBe(false);
  });
});
