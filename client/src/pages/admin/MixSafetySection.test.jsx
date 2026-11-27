// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MixSafetySection from "./MixSafetySection";

const CELSIUS = { id: "11111111-1111-4111-8111-111111111111", name: "Celsius WG", category: "herbicide" };
const CERTAINTY = { id: "22222222-2222-4222-8222-222222222222", name: "Certainty Turf Herbicide", category: "herbicide" };
const LIST = {
  rules: [
    { id: "r1", productAId: CELSIUS.id, productAName: "Celsius WG", productBId: null, productBName: null, groupB: "fertilizer", groupLabel: "Fertilizer", verdict: "never", reason: "Do not tank mix Celsius with fertilizer.", source: "Catalog row Celsius WG", jarTestRequired: false },
    { id: "r2", productAId: CELSIUS.id, productAName: "Celsius WG", productBId: CERTAINTY.id, productBName: "Certainty Turf Herbicide", groupB: null, verdict: "caution", reason: "Approved weed mix.", source: "card", jarTestRequired: true },
  ],
  products: [CELSIUS, CERTAINTY],
  groups: [{ key: "fertilizer", label: "Fertilizer" }],
};
const CHECK = {
  pairs: [{
    productAId: CELSIUS.id, productAName: "Celsius WG", productBId: CERTAINTY.id, productBName: "Certainty Turf Herbicide",
    verdict: "caution", reason: "Approved weed mix.", jarTestRequired: false,
    entries: [{ kind: "pair", verdict: "caution", reason: "Approved weed mix." }, { kind: "catalog", verdict: "caution", reason: "Label note: Requires NIS surfactant." }],
  }],
};

function respond(body, ok = true) {
  return { ok, json: async () => body };
}

describe("MixSafetySection", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async (url, opts = {}) => {
      if (String(url).includes("/check?")) return respond(CHECK);
      if (opts.method === "POST") return respond({ error: "Admin access required" }, false);
      return respond(LIST);
    }));
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("lists the rules in plain words: product, mixed with, can mix, reason, source", async () => {
    render(<MixSafetySection />);
    const table = await screen.findByRole("table", { name: "Mix safety rules" });
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(within(rows[1]).getByText("Group: Fertilizer")).toBeInTheDocument();
    expect(within(rows[1]).getByText("Never")).toBeInTheDocument();
    expect(within(rows[2]).getByText("Certainty Turf Herbicide")).toBeInTheDocument();
    expect(within(rows[2]).getByText("Caution")).toBeInTheDocument();
    expect(within(rows[2]).getByText("Jar test first")).toBeInTheDocument();
    expect(screen.getByText(/It never blocks a product/)).toBeInTheDocument();
  });

  it("checks a tank of the picked products and shows each pair's answer", async () => {
    render(<MixSafetySection />);
    await screen.findByRole("table", { name: "Mix safety rules" });
    const check = screen.getByRole("button", { name: "Check" });
    expect(check).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Tank product 1"), { target: { value: CELSIUS.id } });
    fireEvent.change(screen.getByLabelText("Tank product 2"), { target: { value: CERTAINTY.id } });
    fireEvent.click(check);
    const result = await screen.findByRole("list", { name: "Tank check result" });
    expect(within(result).getByText("Celsius WG + Certainty Turf Herbicide")).toBeInTheDocument();
    expect(within(result).getByText("Caution: Label note: Requires NIS surfactant.")).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith(
      `/api/admin/product-mix-rules/check?productIds=${encodeURIComponent(`${CELSIUS.id},${CERTAINTY.id}`)}`,
      expect.anything(),
    );
  });

  it("allows up to 5 tank products", async () => {
    render(<MixSafetySection />);
    await screen.findByRole("table", { name: "Mix safety rules" });
    const add = screen.getByRole("button", { name: "Add product" });
    for (let i = 0; i < 3; i += 1) fireEvent.click(add);
    expect(screen.getByLabelText("Tank product 5")).toBeInTheDocument();
    expect(add).toBeDisabled();
  });

  it("shows the server's refusal when a save is not allowed", async () => {
    render(<MixSafetySection />);
    await screen.findByRole("table", { name: "Mix safety rules" });
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    fireEvent.change(screen.getByLabelText("Product"), { target: { value: CELSIUS.id } });
    fireEvent.change(screen.getByLabelText("Second product"), { target: { value: CERTAINTY.id } });
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: "Short reason." } });
    fireEvent.click(screen.getByRole("button", { name: "Save rule" }));
    await waitFor(() => expect(screen.getByText("Admin access required")).toBeInTheDocument());
    const post = fetch.mock.calls.find(([, opts]) => opts?.method === "POST");
    expect(JSON.parse(post[1].body)).toMatchObject({ productAId: CELSIUS.id, productBId: CERTAINTY.id, groupB: null, verdict: "caution", reason: "Short reason." });
  });
});
