// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PricingLogicPanel from "./PricingLogicPanel";

const pricingConfig = {
  config_key: "global_adjustments",
  name: "Global adjustments",
  category: "global",
  data: { slopes: [{ label: "Flat", multiplier: 1 }] },
};

function response(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", {
    getItem: (key) => key === "waves_admin_token"
      ? "synthetic-token"
      : key === "waves_admin_user"
        ? JSON.stringify({ role: "admin" })
        : null,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PricingLogicPanel foundation", () => {
  it("keeps seconds in Recent changes audit timestamps", async () => {
    const changedAt = "2026-09-12T19:08:09Z";
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      if (url === "/api/admin/pricing-config") return response({ configs: [] });
      if (url === "/api/admin/pricing-config/audit-log?limit=30") {
        return response({ logs: [{
          config_key: "pest_base", changed_by: "Fixture admin", changed_at: changedAt,
        }] });
      }
      throw new Error(`Unexpected request: GET ${url}`);
    }));

    render(<PricingLogicPanel />);

    const expectedTimestamp = new Date(changedAt).toLocaleString(undefined, {
      year: "numeric", month: "short", day: "numeric", hour: "2-digit",
      minute: "2-digit", second: "2-digit",
    });
    expect(await screen.findByText(expectedTimestamp)).toBeInTheDocument();
  });

  it("keeps an unsaved raw JSON draft open when its request fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
      if (url === "/api/admin/pricing-config") return response({ configs: [pricingConfig] });
      if (url === "/api/admin/pricing-config/audit-log?limit=30") return response({ logs: [] });
      if (url === "/api/admin/pricing-config/global_adjustments" && options.method === "PUT") {
        return response({ error: "Synthetic save failure" }, 500);
      }
      throw new Error(`Unexpected request: ${options.method || "GET"} ${url}`);
    }));

    render(<PricingLogicPanel />);
    fireEvent.click(await screen.findByText("Global adjustments"));
    fireEvent.click(screen.getByRole("button", { name: "Raw JSON" }));
    const editor = screen.getByLabelText("Configuration JSON");
    fireEvent.change(editor, { target: { value: '{"value":41,"enabled":true}' } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Save failed: Synthetic save failure")).toBeInTheDocument();
    expect(screen.getByLabelText("Configuration JSON")).toHaveValue('{"value":41,"enabled":true}');
  });

  it("preserves a second cell draft when an earlier array save finishes", async () => {
    let finishSave;
    vi.stubGlobal("fetch", vi.fn((url, options = {}) => {
      if (url === "/api/admin/pricing-config") return Promise.resolve(response({ configs: [pricingConfig] }));
      if (url === "/api/admin/pricing-config/audit-log?limit=30") return Promise.resolve(response({ logs: [] }));
      if (url === "/api/admin/pricing-config/global_adjustments" && options.method === "PUT") {
        return new Promise((resolve) => { finishSave = () => resolve(response({ success: true })); });
      }
      throw new Error(`Unexpected request: ${options.method || "GET"} ${url}`);
    }));

    render(<PricingLogicPanel />);
    fireEvent.click(await screen.findByText("Global adjustments"));
    const cells = screen.getAllByTitle("Click to edit");
    fireEvent.click(cells[0]);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Level" } });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });

    fireEvent.click(screen.getAllByTitle("Click to edit")[1]);
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "2" } });
    finishSave();

    await waitFor(() => expect(screen.getByRole("spinbutton")).toHaveValue(2));
  });
});
