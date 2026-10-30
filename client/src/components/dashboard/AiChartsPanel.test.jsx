// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AiChartsPanel from "./AiChartsPanel";

vi.mock("../tech/DictationButton", () => ({ default: () => <button type="button">Dictate</button> }));
vi.mock("../../hooks/dictationPending", () => ({ default: () => false }));

const WIDGET = {
  id: "fixture-widget",
  title: "Pinned synthetic revenue",
  chartSpec: { chartType: "kpi", y: ["value"], yFormat: "currency" },
  rows: [{ value: 12500 }],
  fields: ["value"],
};

// Each request takes the next queued answer for its "METHOD path".
let answers;
function answer(key, status, body) {
  (answers[key] ||= []).push({ status, body });
}

beforeEach(() => {
  answers = {};
  vi.stubGlobal("localStorage", { getItem: () => "synthetic-token", setItem() {}, removeItem() {} });
  vi.stubGlobal("fetch", vi.fn(async (url, opts = {}) => {
    const key = `${opts.method || "GET"} ${url}`;
    const next = answers[key]?.shift();
    if (!next) throw new Error(`unexpected request ${key}`);
    return { ok: next.status < 400, status: next.status, json: async () => next.body };
  }));
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AiChartsPanel while hidden", () => {
  it("unmounts the mic while inactive, so a recording cannot run unseen", async () => {
    answer("GET /api/admin/dashboard/widgets", 200, { widgets: [] });
    const { rerender } = render(<AiChartsPanel active={false} />);
    await screen.findByText("No pinned charts yet — describe one above.");
    expect(screen.queryByRole("button", { name: "Dictate" })).not.toBeInTheDocument();

    rerender(<AiChartsPanel active />);
    expect(screen.getByRole("button", { name: "Dictate" })).toBeInTheDocument();
  });
});

describe("AiChartsPanel pinned-chart failures", () => {
  it("says the list could not load, with a retry, instead of claiming there are none", async () => {
    answer("GET /api/admin/dashboard/widgets", 503, { error: "Synthetic temporary failure" });
    render(<AiChartsPanel />);

    await screen.findByText("Pinned charts could not be loaded.");
    expect(screen.queryByText(/No pinned charts yet/)).not.toBeInTheDocument();

    answer("GET /api/admin/dashboard/widgets", 200, { widgets: [] });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText("No pinned charts yet — describe one above.");
    expect(screen.queryByText("Pinned charts could not be loaded.")).not.toBeInTheDocument();
  });

  it("keeps the charts on screen when the refresh after a pin fails", async () => {
    answer("GET /api/admin/dashboard/widgets", 200, { widgets: [WIDGET] });
    answer("POST /api/admin/dashboard/ai-chart/preview", 200, {
      spec: { title: "Synthetic revenue", chartType: "kpi", y: ["value"], yFormat: "currency", sql: "select 1 as value" },
      rows: [{ value: 497 }],
      fields: ["value"],
    });
    answer("POST /api/admin/dashboard/widgets", 201, { widget: { id: "second-widget" } });
    answer("GET /api/admin/dashboard/widgets", 503, { error: "Synthetic temporary failure" });
    render(<AiChartsPanel />);
    await screen.findByText(WIDGET.title);

    fireEvent.change(screen.getByLabelText("Describe a metric"), { target: { value: "revenue this month" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    await screen.findByText("Synthetic revenue");
    fireEvent.click(screen.getByRole("button", { name: "Pin" }));

    await screen.findByText("Pinned charts could not be refreshed. Showing the last loaded charts.");
    expect(screen.getByText(WIDGET.title)).toBeInTheDocument();
  });

  it("keeps a chart whose unpin failed and offers a retry", async () => {
    answer("GET /api/admin/dashboard/widgets", 200, { widgets: [WIDGET] });
    answer(`DELETE /api/admin/dashboard/widgets/${WIDGET.id}`, 503, { error: "Synthetic temporary failure" });
    render(<AiChartsPanel />);
    await screen.findByText(WIDGET.title);

    fireEvent.click(screen.getByRole("button", { name: "Unpin" }));
    await screen.findByText("Could not unpin this chart — Synthetic temporary failure");
    expect(screen.getByText(WIDGET.title)).toBeInTheDocument();

    answer(`DELETE /api/admin/dashboard/widgets/${WIDGET.id}`, 200, { ok: true });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText("No pinned charts yet — describe one above.");
    expect(screen.queryByText(WIDGET.title)).not.toBeInTheDocument();
  });
});
