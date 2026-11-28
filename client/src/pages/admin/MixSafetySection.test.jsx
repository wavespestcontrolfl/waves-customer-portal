// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MixSafetySection, { sourceLabel } from "./MixSafetySection";

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

function respond(body, ok = true, status = ok ? 200 : 400) {
  return { ok, status, json: async () => body };
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
    expect(within(rows[1]).getByText("Catalog")).toHaveAttribute("title", "Catalog row Celsius WG");
    expect(within(rows[2]).getByText("Waves rule")).toHaveAttribute("title", "card");
  });

  it("shows a plain source word, never a file or migration name", () => {
    expect(sourceLabel('server/config/tree-shrub-field-guide.json TriTek 1% limits: "Do not mix with NPK foliar fertilizer"')).toBe("Field guide");
    expect(sourceLabel('server/config/lawn-protocol-v13.json card line: "Topchoice ... (the label says not to apply it in combination)"')).toBe("Label");
    expect(sourceLabel('server/config/lawn-protocol-v13.json safety_rules (Tetrino): "Sunny turf only"')).toBe("Waves rule");
    expect(sourceLabel('server/config/protocols.json tree_shrub card line (Sequestar 6% Fe EDDHA): "never tank-mix with oil"')).toBe("Waves rule");
    expect(sourceLabel('Catalog row Celsius WG, compatibility_notes (migration 20260401000026): "Do NOT tank-mix with fertilizer."')).toBe("Catalog");
    expect(sourceLabel('server/config/protocols.json card line (X): "rate not on the label, Waves limit"')).toBe("Waves rule");
    expect(sourceLabel('migration 20261127240000 note: "not on the label"')).toBe("Other (see note)");
    // The seeded TriTek and SuffOil-X rules (migration 20261127143000) cite the tree & shrub visit field guide.
    expect(sourceLabel('server/config/protocols.json tree_shrub visit field guide, don\'t: "No oil and pyrethroid together"; notes: "Do not make oil + copper, oil + broad-spectrum pyrethroid, or neonic systemics a default production tank."')).toBe("Field guide");
    expect(sourceLabel("owner")).toBe("Owner");
    expect(sourceLabel("Supplier call 11-27")).toBe("Supplier call 11-27");
    expect(sourceLabel("")).toBe("—");
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

  it("clears the answer when the picked products change, and a late answer for the old pick never shows", async () => {
    const THIRD = { id: "33333333-3333-4333-8333-333333333333", name: "Tetrino Insecticide" };
    let release;
    fetch.mockImplementation(async (url) => {
      if (!String(url).includes("/check?")) return respond({ ...LIST, products: [CELSIUS, CERTAINTY, THIRD] });
      if (String(url).includes(THIRD.id)) return respond(CHECK);
      return new Promise((resolve) => { release = () => resolve(respond(CHECK)); });
    });
    render(<MixSafetySection />);
    await screen.findByRole("table", { name: "Mix safety rules" });
    fireEvent.change(screen.getByLabelText("Tank product 1"), { target: { value: CELSIUS.id } });
    fireEvent.change(screen.getByLabelText("Tank product 2"), { target: { value: CERTAINTY.id } });
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    await waitFor(() => expect(release).toBeTypeOf("function"));
    fireEvent.change(screen.getByLabelText("Tank product 2"), { target: { value: THIRD.id } });
    release();
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(screen.queryByRole("list", { name: "Tank check result" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    expect(await screen.findByRole("list", { name: "Tank check result" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Tank product 1"), { target: { value: "" } });
    expect(screen.queryByRole("list", { name: "Tank check result" })).not.toBeInTheDocument();
  });

  it("an edit sends the version it loaded, and a stale save shows the server's reload message", async () => {
    const rules = LIST.rules.map((r) => ({ ...r, version: 3 }));
    fetch.mockImplementation(async (url, opts = {}) => {
      if (opts.method === "PUT") return respond({ error: "This rule changed. Reload it." }, false);
      return respond({ ...LIST, rules });
    });
    render(<MixSafetySection />);
    const table = await screen.findByRole("table", { name: "Mix safety rules" });
    fireEvent.click(within(within(table).getAllByRole("row")[1]).getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Save rule" }));
    await waitFor(() => expect(screen.getByText("This rule changed. Reload it.")).toBeInTheDocument());
    const put = fetch.mock.calls.find(([, opts]) => opts?.method === "PUT");
    expect(put[0]).toBe("/api/admin/product-mix-rules/r1");
    expect(JSON.parse(put[1].body)).toMatchObject({ version: 3, groupB: "fertilizer", verdict: "never" });
  });

  it("Remove sends the version the list showed, and a stale Remove shows the reload message", async () => {
    const rules = LIST.rules.map((r) => ({ ...r, version: 7 }));
    fetch.mockImplementation(async (url, opts = {}) => {
      if (opts.method === "DELETE") return respond({ error: "This rule changed. Reload it." }, false);
      return respond({ ...LIST, rules });
    });
    render(<MixSafetySection />);
    const table = await screen.findByRole("table", { name: "Mix safety rules" });
    fireEvent.click(within(within(table).getAllByRole("row")[2]).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.getByText("This rule changed. Reload it.")).toBeInTheDocument());
    expect(fetch.mock.calls.find(([, opts]) => opts?.method === "DELETE")[0]).toBe("/api/admin/product-mix-rules/r2?version=7");
  });

  it("an older catalog note under a pair rule shows without a verdict word", async () => {
    const check = { pairs: [{ ...CHECK.pairs[0], entries: [CHECK.pairs[0].entries[0], { kind: "catalog_note", verdict: null, reason: "Catalog note (older): Celsius WG label note: Requires NIS surfactant." }] }] };
    fetch.mockImplementation(async (url) => respond(String(url).includes("/check?") ? check : LIST));
    render(<MixSafetySection />);
    await screen.findByRole("table", { name: "Mix safety rules" });
    fireEvent.change(screen.getByLabelText("Tank product 1"), { target: { value: CELSIUS.id } });
    fireEvent.change(screen.getByLabelText("Tank product 2"), { target: { value: CERTAINTY.id } });
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    const result = await screen.findByRole("list", { name: "Tank check result" });
    expect(within(result).getByText("Catalog note (older): Celsius WG label note: Requires NIS surfactant.")).toBeInTheDocument();
  });

  it("a failed re-check clears the old answer and says the check failed", async () => {
    let fail = false;
    fetch.mockImplementation(async (url) => {
      if (!String(url).includes("/check?")) return respond(LIST);
      return fail ? respond({ error: "Server error" }, false, 500) : respond(CHECK);
    });
    render(<MixSafetySection />);
    await screen.findByRole("table", { name: "Mix safety rules" });
    fireEvent.change(screen.getByLabelText("Tank product 1"), { target: { value: CELSIUS.id } });
    fireEvent.change(screen.getByLabelText("Tank product 2"), { target: { value: CERTAINTY.id } });
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    await screen.findByRole("list", { name: "Tank check result" });
    fail = true;
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    await waitFor(() => expect(screen.getByText("Check failed. Try again.")).toBeInTheDocument());
    expect(screen.queryByRole("list", { name: "Tank check result" })).not.toBeInTheDocument();
  });

  it("Add rule on a pair with an active rule shows that rule and offers Edit, which saves with its version", async () => {
    const current = { ...LIST.rules[1], version: 4 };
    fetch.mockImplementation(async (url, opts = {}) => {
      if (opts.method === "POST") return respond({ error: "A rule for this pair already exists. Edit that one.", rule: current }, false, 409);
      if (opts.method === "PUT") return respond({ rule: current });
      return respond(LIST);
    });
    render(<MixSafetySection />);
    await screen.findByRole("table", { name: "Mix safety rules" });
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    fireEvent.change(screen.getByLabelText("Product"), { target: { value: CELSIUS.id } });
    fireEvent.change(screen.getByLabelText("Second product"), { target: { value: CERTAINTY.id } });
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: "Short reason." } });
    fireEvent.click(screen.getByRole("button", { name: "Save rule" }));
    await waitFor(() => expect(screen.getByText("A rule for this pair already exists. Edit that one.")).toBeInTheDocument());
    expect(screen.getByText("Current rule: Caution. Approved weed mix.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit that rule" }));
    fireEvent.click(screen.getByRole("button", { name: "Save rule" }));
    await waitFor(() => expect(fetch.mock.calls.some(([, opts]) => opts?.method === "PUT")).toBe(true));
    const put = fetch.mock.calls.find(([, opts]) => opts?.method === "PUT");
    expect(put[0]).toBe("/api/admin/product-mix-rules/r2");
    expect(JSON.parse(put[1].body)).toMatchObject({ version: 4, productBId: CERTAINTY.id, reason: "Approved weed mix." });
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
