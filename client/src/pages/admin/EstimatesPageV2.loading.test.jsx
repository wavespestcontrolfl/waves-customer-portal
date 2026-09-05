// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { MemoryRouter } from "react-router-dom";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import EstimatesPageV2 from "./EstimatesPageV2";

vi.mock("../../hooks/useFeatureFlag", () => ({ useFeatureFlag: () => false }));
const active = { id: "qa-active", customerId: "qa-customer", customerName: "Synthetic Active", status: "sent", createdAt: new Date().toISOString(), monthlyTotal: 50, serviceLines: [] };
const archived = { ...active, id: "qa-archived", customerName: "Synthetic Archived", status: "declined", archivedAt: new Date().toISOString() };
let loadArchive;
let loadActive;
let mutate;
function response(body, status = 200) {
  return { ok: status === 200, status, json: async () => body, clone() { return this; } };
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function mount(width) {
  window.innerWidth = width;
  return render(<MemoryRouter initialEntries={["/admin/pipeline?tab=estimates"]}><EstimatesPageV2 /></MemoryRouter>);
}
function filterMobile(name) {
  fireEvent.click(screen.getByRole("button", { name: /^Filter:/ }));
  fireEvent.click(within(screen.getByRole("dialog", { name: "Filter estimates" })).getByRole("button", { name }));
}

beforeEach(() => {
  mutate = vi.fn(async () => response({}));
  loadArchive = vi.fn(async () => response({ estimates: [archived] }));
  loadActive = vi.fn(async () => response({ estimates: [active] }));
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    const u = new URL(String(url), "http://localhost");
    if (u.pathname.endsWith("/unarchive")) return mutate();
    if (u.pathname === "/api/admin/estimates") {
      if (u.searchParams.get("archived") === "only" && !u.searchParams.has("status")) return loadArchive();
      if (u.searchParams.get("sentOnly") === "1") return loadActive();
      return response({ estimates: [] });
    }
    return response({ resolved: 0, drafted: 0, sources: [] });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("estimate filter request recovery", () => {
  it.each(["success", "failure"])("ignores a superseded desktop load's %s", async (outcome) => {
    const old = deferred();
    loadActive.mockReturnValueOnce(old.promise);
    window.innerWidth = 1440;
    render(<React.StrictMode><MemoryRouter initialEntries={["/admin/pipeline?tab=estimates"]}><EstimatesPageV2 /></MemoryRouter></React.StrictMode>);
    await screen.findByText("Synthetic Active");
    await act(async () => {
      old.resolve(outcome === "success"
        ? response({ estimates: [{ ...active, customerName: "Obsolete result" }] })
        : response({ error: "Obsolete failure" }, 503));
    });
    expect(screen.getByText("Synthetic Active")).toBeInTheDocument();
    expect(screen.queryByText(/Obsolete/)).not.toBeInTheDocument();
    expect(screen.queryByText("Failed to load estimates")).not.toBeInTheDocument();
  });

  it.each([768, 1440])("shows a failed archive request after populated results and retries at %ipx", async (width) => {
    loadArchive.mockResolvedValueOnce(response({ error: "Synthetic archive unavailable" }, 503));
    const { container } = mount(width);
    await screen.findByText("Synthetic Active");
    fireEvent.click(screen.getByRole("button", { name: "Archived", exact: true }));
    await screen.findByText("Failed to load estimates");
    expect(screen.queryByText(/^No estimates in "Archived"/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("Synthetic Archived");
    expect(container.querySelector('[data-estimate-id="qa-archived"]')).toHaveTextContent("Synthetic Archived");
    expect(screen.queryByText("Failed to load estimates")).not.toBeInTheDocument();
  });

  it("can leave a persistently failed Archived filter without reloading", async () => {
    loadArchive.mockResolvedValue(response({ error: "Archive unavailable" }, 503));
    mount(1440);
    await screen.findByText("Synthetic Active");
    fireEvent.click(screen.getByRole("button", { name: "Archived", exact: true }));
    await screen.findByText("Failed to load estimates");
    fireEvent.click(screen.getByRole("button", { name: "Show all estimates" }));
    await screen.findByText("Synthetic Active");
    expect(screen.queryByText("Failed to load estimates")).not.toBeInTheDocument();
  });

  it.each([1440, 390])("refreshes the current filter after a delayed row action at %ipx", async (width) => {
    const action = deferred();
    mutate.mockReturnValueOnce(action.promise);
    mount(width);
    await screen.findByText("Synthetic Active");
    if (width === 390) filterMobile(/^Archived/);
    else fireEvent.click(screen.getByRole("button", { name: "Archived", exact: true }));
    await screen.findByText("Synthetic Archived");
    if (width === 390) fireEvent.click(screen.getByRole("button", { name: "Actions for Synthetic Archived" }));
    fireEvent.click(screen.getByText("Unarchive", { exact: true }));
    expect(mutate).toHaveBeenCalledTimes(1);
    if (width === 390) filterMobile(/^All /);
    else fireEvent.click(screen.getByRole("button", { name: "Archived", exact: true }));
    await screen.findByText("Synthetic Active");
    loadActive.mockClear();
    loadArchive.mockClear();
    await act(async () => { action.resolve(response({})); });
    await screen.findByText("Synthetic Active");
    expect(loadActive).toHaveBeenCalled();
    expect(loadArchive).not.toHaveBeenCalled();
  });

  it("keeps a successful empty archive distinct from a failure", async () => {
    loadArchive.mockResolvedValue(response({ estimates: [] }));
    mount(1440);
    await screen.findByText("Synthetic Active");
    fireEvent.click(screen.getByRole("button", { name: "Archived", exact: true }));
    await screen.findByText(/^No estimates in "Archived"/);
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it.each([375, 390])("ignores an older archive success after All finishes at %ipx", async (width) => {
    const old = deferred();
    loadArchive.mockReturnValueOnce(old.promise);
    const { container } = mount(width);
    await screen.findByText("Synthetic Active");
    filterMobile(/^Archived/);
    filterMobile(/^All /);
    await screen.findByText("Synthetic Active");
    await act(async () => { old.resolve(response({ estimates: [archived] })); });
    expect(screen.queryByText("Synthetic Archived")).not.toBeInTheDocument();
    expect(container.querySelector('[data-estimate-id="qa-active"]')).toHaveTextContent("Synthetic Active");
    expect(screen.getByRole("button", { name: /^Filter:/ })).toHaveTextContent("All (1)");
  });

  it("ignores an older failure and its loading completion while the current request is pending", async () => {
    const old = deferred();
    const current = deferred();
    loadArchive.mockReturnValueOnce(old.promise);
    mount(390);
    await screen.findByText("Synthetic Active");
    filterMobile(/^Archived/);
    loadActive.mockReturnValueOnce(current.promise);
    filterMobile(/^All /);
    await act(async () => { old.resolve(response({ error: "Obsolete archive failure" }, 503)); });
    expect(screen.getByText("Loading estimates…")).toBeInTheDocument();
    expect(screen.queryByText(/Obsolete archive failure/)).not.toBeInTheDocument();
    await act(async () => { current.resolve(response({ estimates: [active] })); });
    await screen.findByText("Synthetic Active");
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("still surfaces current mobile failures and permits retry", async () => {
    loadArchive.mockResolvedValueOnce(response({ error: "Synthetic archive unavailable" }, 503));
    mount(390);
    await screen.findByText("Synthetic Active");
    filterMobile(/^Archived/);
    await screen.findByText(/Failed to load estimates: Synthetic archive unavailable/);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("Synthetic Archived");
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });
});
