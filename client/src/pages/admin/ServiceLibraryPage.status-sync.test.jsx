// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../hooks/useIsMobile", () => ({ default: () => false }));
vi.mock("../../components/admin/MobileServiceLibrary", () => ({
  default: () => <div>Mobile services workspace</div>,
}));
vi.mock("./LawnProtocolCommandCenterPage", () => ({ default: () => <div /> }));

import ServiceLibraryPage from "./ServiceLibraryPage";

let rows;
let puts;

// Fake catalog: GET lists rows; PUT merges only the fields it carries.
function stubCatalog(initial) {
  rows = [initial];
  puts = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, options) => {
      if (options?.method === "PUT") {
        const body = JSON.parse(options.body);
        puts.push(body);
        rows[0] = { ...rows[0], ...body };
        return { ok: true, json: async () => ({}) };
      }
      return { ok: true, json: async () => ({ services: rows, total: rows.length }) };
    }),
  );
}

const base = {
  id: "fixture-service",
  name: "Fixture Pest Service",
  category: "pest_control",
  billing_type: "recurring",
  is_active: true,
  is_archived: false,
};

async function openService() {
  render(
    <MemoryRouter initialEntries={["/admin/service-library"]}>
      <ServiceLibraryPage />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByText(base.name));
}

async function renameAndSave() {
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
    target: { value: "Renamed Service" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
  await waitFor(() => expect(puts.some((p) => p.name === "Renamed Service")).toBe(true));
  return puts.find((p) => p.name === "Renamed Service");
}

describe("ServiceLibraryPage status sync", () => {
  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1400 });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("keeps a header deactivation when the form is saved afterwards", async () => {
    stubCatalog(base);
    await openService();
    fireEvent.click(screen.getByRole("button", { name: /Active/ }));
    await waitFor(() => expect(rows[0].is_active).toBe(false));
    await waitFor(() =>
      expect(screen.getByRole("checkbox", { name: "Active" })).not.toBeChecked(),
    );

    const payload = await renameAndSave();
    expect(payload).not.toHaveProperty("is_active");
    expect(payload).not.toHaveProperty("is_archived");
    expect(rows[0].is_active).toBe(false);
  });

  it("does not re-archive a restored service on the next save", async () => {
    stubCatalog({ ...base, is_active: false, is_archived: true });
    render(
      <MemoryRouter initialEntries={["/admin/service-library"]}>
        <ServiceLibraryPage />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole("button", { name: /^Archived/ }));
    fireEvent.click(await screen.findByText(base.name));
    fireEvent.click(await screen.findByRole("button", { name: "Restore service" }));
    await waitFor(() => expect(rows[0].is_archived).toBe(false));
    await waitFor(() =>
      expect(screen.getByRole("checkbox", { name: "Active" })).toBeChecked(),
    );

    const payload = await renameAndSave();
    expect(payload).not.toHaveProperty("is_archived");
    expect(payload).not.toHaveProperty("is_active");
    expect(rows[0].is_archived).toBe(false);
  });

  it("still sends is_active when the form checkbox is changed", async () => {
    stubCatalog(base);
    await openService();
    fireEvent.click(screen.getByRole("checkbox", { name: "Active" }));

    const payload = await renameAndSave();
    expect(payload.is_active).toBe(false);
    expect(payload).not.toHaveProperty("is_archived");
  });

  it("keeps a checkbox edit when the header status changes underneath", async () => {
    stubCatalog(base);
    await openService();
    fireEvent.click(screen.getByRole("checkbox", { name: "Active" }));
    fireEvent.click(screen.getByRole("button", { name: /Active/ }));
    await waitFor(() => expect(rows[0].is_active).toBe(false));
    fireEvent.click(screen.getByRole("checkbox", { name: "Active" }));
    expect(screen.getByRole("checkbox", { name: "Active" })).toBeChecked();

    const payload = await renameAndSave();
    expect(payload.is_active).toBe(true);
  });

  it("keeps a checkbox change made while an earlier save is still running", async () => {
    stubCatalog(base);
    const catalogFetch = fetch;
    let releaseFirstPut;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, options) => {
        if (options?.method === "PUT" && !releaseFirstPut) {
          await new Promise((resolve) => {
            releaseFirstPut = resolve;
          });
        }
        return catalogFetch(url, options);
      }),
    );
    await openService();
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Renamed Service" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(releaseFirstPut).toBeTypeOf("function"));
    fireEvent.click(screen.getByRole("checkbox", { name: "Active" }));
    releaseFirstPut();
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).not.toHaveProperty("is_active");

    fireEvent.click(await screen.findByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(puts).toHaveLength(2));
    expect(puts[1].is_active).toBe(false);
    expect(rows[0].is_active).toBe(false);
  });
});
