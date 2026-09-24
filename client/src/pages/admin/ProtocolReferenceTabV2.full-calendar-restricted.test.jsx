// @vitest-environment jsdom
//
// codex round-4 P1 on PR #4673: GET /admin/protocols/programs?track=… is
// projected server-side for a technician (no material_cost / labor_cost /
// conditional_cost, no "($x)" tags) and tagged viewerRole:'technician'. The
// "View full calendar" table used to render Mat$/Lab$ columns from those
// fields regardless; a restricted viewer now gets no cost columns at all
// (not a column of "—"), and a service program's current-visit card drops
// its Materials/Labor/Expected strip. An admin response is unchanged.
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ProtocolReferenceTabV2 from "./ProtocolReferenceTabV2";

const MONTH = new Date().toLocaleString("en-US", { month: "short" });
const catalog = {
  lawn: { tracks: [{ key: "st_augustine", name: "Synthetic Lawn", visits: 0 }] },
  programs: [{ key: "qa_pest", name: "Synthetic Pest", visits: 0 }],
};
const ok = (data) => ({ ok: true, json: async () => data });
let viewerRole;
function visit(extra) {
  return { month: MONTH, visit: 1, notes: "Scout", primary: "K-Flow 0-0-25", secondary: "", tiers: [], ...extra };
}
function trackFor(role) {
  const priced = role === "admin";
  return {
    name: "Synthetic protocol",
    visits: [visit(priced ? { material_cost: 14.17, labor_cost: 35, conditional_cost: 26.13 } : {})],
  };
}
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    if (url === "/api/admin/protocols/programs") return ok(catalog);
    if (url.includes("/programs?")) return ok({ track: trackFor(viewerRole), viewerRole });
    return ok({ calibrations: [] });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("technician: the full calendar has no Mat$/Lab$ columns and the service-program card has no cost strip", async () => {
  viewerRole = "technician";
  render(<ProtocolReferenceTabV2 />);
  await screen.findByText("Tier Legend");
  fireEvent.click(screen.getByRole("button", { name: "View full calendar" }));
  await screen.findByText("Primary Applications");
  expect(screen.queryByText("Mat$")).not.toBeInTheDocument();
  expect(screen.queryByText("Lab$")).not.toBeInTheDocument();
  expect(screen.getByText("Tiers")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Protocol"), { target: { value: "qa_pest" } });
  await screen.findByText("Synthetic protocol");
  expect(screen.queryByText(/Materials:/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Labor:/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Expected:/)).not.toBeInTheDocument();
});

it("control: an admin still sees the Mat$/Lab$ columns with their figures and the cost strip", async () => {
  viewerRole = "admin";
  render(<ProtocolReferenceTabV2 />);
  await screen.findByText("Tier Legend");
  fireEvent.click(screen.getByRole("button", { name: "View full calendar" }));
  await screen.findByText("Primary Applications");
  expect(screen.getByText("Mat$")).toBeInTheDocument();
  expect(screen.getByText("Lab$")).toBeInTheDocument();
  expect(screen.getByText("$14.17")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Protocol"), { target: { value: "qa_pest" } });
  await screen.findByText("Synthetic protocol");
  expect(screen.getByText(/Materials:/)).toBeInTheDocument();
  expect(screen.getByText(/Expected:/)).toBeInTheDocument();
});
