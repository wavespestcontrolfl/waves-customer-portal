// @vitest-environment jsdom
// Operations audit OP-02/03/04/06/07 (Field assessment): late responses never
// land under another customer, failed reads are failures, unscored metrics are
// not 0%, and a DATE shows its own calendar day.
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import LawnAssessmentPanel from "./LawnAssessmentPanel";

const alice = { id: "customer-a", firstName: "Alice", lastName: "Example", address: "1 Synthetic St", phone: "941-555-0101" };
const blair = { id: "customer-b", firstName: "Blair", lastName: "Example", address: "2 Synthetic St", phone: "941-555-0102" };
const ok = (data) => ({ ok: true, json: async () => data });
const historyRow = (observations, extra = {}) => ({
  id: `${observations}-row`, service_date: "2026-10-30T00:00:00.000Z", season: "shoulder", confirmed_by_tech: true,
  turf_density: 80, weed_suppression: 70, color_health: 60, fungus_control: 50, thatch_level: 40, observations, ...extra,
});

// Reads the test holds open resolve in any order; the rest answer at once.
let pending;
let answers;
function installFetch() {
  pending = {};
  vi.stubGlobal("fetch", vi.fn((url) => {
    const path = String(url).replace(/^\/api/, "");
    if (answers[path]) return Promise.resolve(answers[path]());
    return new Promise((resolve) => { pending[path] = resolve; });
  }));
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("lawn_guide_seen", "1");
  localStorage.setItem("waves_admin_token", "fixture-token");
  vi.stubGlobal("alert", vi.fn());
  answers = { "/admin/lawn-assessment/customers": () => ok({ customers: [alice, blair] }) };
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const clickFor = async (customer, button) => {
  const name = await screen.findByText(`${customer.firstName} ${customer.lastName}`);
  const card = name.closest(".grid > *") || name.parentElement.parentElement;
  fireEvent.click(Array.from(card.querySelectorAll("button")).find((b) => b.textContent.trim() === button));
};

it("a late history read for Alice never shows under Blair's heading", async () => {
  render(<LawnAssessmentPanel embedded />);
  await clickFor(alice, "History");
  await clickFor(blair, "History");
  await act(async () => pending["/admin/lawn-assessment/history/customer-b"](ok({ history: [historyRow("Blair-only observation")] })));
  await act(async () => pending["/admin/lawn-assessment/history/customer-a"](ok({ history: [historyRow("Alice-only observation")] })));
  expect(screen.getByRole("heading", { name: /Blair Example\s+—\s+Assessment History/ })).toBeInTheDocument();
  expect(screen.getByText("Blair-only observation")).toBeInTheDocument();
  expect(screen.queryByText("Alice-only observation")).not.toBeInTheDocument();
});

it("a late turf profile read for Alice never fills Blair's form", async () => {
  render(<LawnAssessmentPanel embedded />);
  await clickFor(alice, "Profile");
  await clickFor(blair, "Profile");
  await act(async () => pending["/admin/customers/customer-b/turf-profile"](ok({ profile: { municipality: "Blair town" } })));
  await act(async () => pending["/admin/customers/customer-a/turf-profile"](ok({ profile: { municipality: "Alice town" } })));
  expect(screen.getByRole("heading", { name: /Blair Example\s+—\s+Turf/ })).toBeInTheDocument();
  expect(screen.getByDisplayValue("Blair town")).toBeInTheDocument();
  expect(screen.queryByDisplayValue("Alice town")).not.toBeInTheDocument();
});

it("all photos rejected: stays on capture with the server's retake message", async () => {
  class FixtureFileReader { readAsDataURL() { this.onload({ target: { result: "data:image/jpeg;base64,cGhvdG8=" } }); } }
  class FixtureImage { set src(_value) { this.width = 800; this.height = 600; this.onload(); } }
  vi.stubGlobal("FileReader", FixtureFileReader);
  vi.stubGlobal("Image", FixtureImage);
  answers["/admin/lawn-assessment/assess"] = () => ok({
    success: false,
    message: "All photos failed quality check. Please retake with better lighting, closer to the lawn, avoiding shadows.",
    qualityResults: [{ photoIndex: 0, passed: false, issues: ["blurry"] }],
    photoCount: 1,
  });
  const { container } = render(<LawnAssessmentPanel embedded />);
  fireEvent.click(await screen.findByText("Alice Example"));
  fireEvent.change(container.querySelector('input[type="file"]'), { target: { files: [new File(["x"], "lawn.jpg", { type: "image/jpeg" })] } });
  fireEvent.click(await screen.findByRole("button", { name: /Analyze 1 Photo/ }));
  await waitFor(() => expect(alert).toHaveBeenCalledWith(expect.stringContaining("All photos failed quality check. Please retake")));
  expect(screen.getByRole("button", { name: /Analyze 1 Photo/ })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Confirm Scores" })).not.toBeInTheDocument();
});

it("a failed customer read is a failure with Try again, not an empty schedule", async () => {
  let fail = true;
  answers["/admin/lawn-assessment/customers"] = () => (fail ? { ok: false, status: 503, json: async () => ({}) } : ok({ customers: [alice] }));
  render(<LawnAssessmentPanel embedded />);
  expect(await screen.findByText("Couldn't load today's lawn customers.")).toBeInTheDocument();
  expect(screen.queryByText(/No lawn services scheduled today/)).not.toBeInTheDocument();
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("Alice Example")).toBeInTheDocument();
  expect(screen.queryByText("Couldn't load today's lawn customers.")).not.toBeInTheDocument();
});

it("history shows the stored calendar day, unscored metrics as not scored, and measured zero as 0%", async () => {
  answers["/admin/lawn-assessment/history/customer-a"] = () => ok({ history: [historyRow("Synthetic pending read", {
    confirmed_by_tech: false, turf_density: 0, weed_suppression: null, color_health: null, fungus_control: null,
  })] });
  render(<LawnAssessmentPanel embedded />);
  await clickFor(alice, "History");
  expect(await screen.findByText("10/30/2026")).toBeInTheDocument();
  expect(screen.getAllByText("Not scored")).toHaveLength(3);
  expect(screen.getByText("0%")).toBeInTheDocument();
  expect(screen.getByText("40%")).toBeInTheDocument();
  expect(screen.getByText("Not confirmed")).toBeInTheDocument();
});

it("a late profile save for Alice never refills Blair's form", async () => {
  answers["/admin/customers/customer-a/turf-profile"] = () => ok({ profile: { municipality: "Alice town" } });
  answers["/admin/customers/customer-b/turf-profile"] = () => ok({ profile: { municipality: "Blair town" } });
  render(<LawnAssessmentPanel embedded />);
  await clickFor(alice, "Profile");
  expect(await screen.findByDisplayValue("Alice town")).toBeInTheDocument();
  // Hold Alice's save open: the PUT goes to the same path as the read.
  delete answers["/admin/customers/customer-a/turf-profile"];
  fireEvent.click(screen.getByRole("button", { name: /Save/ }));
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  await clickFor(blair, "Profile");
  expect(await screen.findByDisplayValue("Blair town")).toBeInTheDocument();
  await act(async () => pending["/admin/customers/customer-a/turf-profile"](ok({ profile: { municipality: "Alice saved" } })));
  expect(screen.getByDisplayValue("Blair town")).toBeInTheDocument();
  expect(screen.queryByDisplayValue("Alice saved")).not.toBeInTheDocument();
  expect(alert).toHaveBeenCalledWith("Turf profile saved");
});
