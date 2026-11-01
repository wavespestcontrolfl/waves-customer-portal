// @vitest-environment jsdom
//
// Add missed shift on the Entries tab: the form takes an Eastern date and
// times, posts them as instants to POST /admin/timetracking/entries with the
// reason, reloads the list on success, and shows the server's own refusal text
// (overlap, approved week, ...) without closing the form.
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EntriesTab } from "./TimeTrackingPage";

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json" },
});

beforeEach(() => localStorage.setItem("waves_admin_token", "synthetic-token"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

function stub(postResponse) {
  const calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
    const u = String(url);
    calls.push([u, options]);
    if (options.method === "POST") return postResponse;
    if (u.includes("/admin/timetracking/entries?")) return json({ entries: [], total: 0 });
    return json({ allTechs: [{ id: "tech-1", name: "Field Tech" }] });
  }));
  return calls;
}

async function fillForm() {
  fireEvent.click(await screen.findByRole("button", { name: "Add missed shift" }));
  // One in the page's tech filter, one in the form.
  await waitFor(() => expect(screen.getAllByRole("option", { name: "Field Tech" })).toHaveLength(2));
  fireEvent.change(screen.getByLabelText("Tech"), { target: { value: "tech-1" } });
  fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-07-07" } });
  fireEvent.change(screen.getByLabelText("Start time"), { target: { value: "08:00" } });
  fireEvent.change(screen.getByLabelText("End time"), { target: { value: "16:30" } });
}

describe("add missed shift", () => {
  it("needs a reason, then posts the Eastern times as instants and reloads", async () => {
    const calls = stub(json({ id: "shift-new" }, 201));
    const showToast = vi.fn();
    render(<EntriesTab showToast={showToast} />);
    await fillForm();

    const save = screen.getByRole("button", { name: "Add shift" });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Notes"), { target: { value: "Never tapped" } });
    fireEvent.change(screen.getByLabelText("Reason (required)"), { target: { value: "Tech worked, no clock-in" } });
    expect(save).toBeEnabled();
    const loadsBefore = calls.filter(([u]) => u.includes("/entries?")).length;
    fireEvent.click(save);

    await waitFor(() => expect(showToast).toHaveBeenCalledWith("Shift added"));
    const [url, options] = calls.find(([, o]) => o.method === "POST");
    expect(url).toMatch(/\/admin\/timetracking\/entries$/);
    // 8:00 AM and 4:30 PM Eastern on Jul 7 (EDT) are 12:00Z and 20:30Z.
    expect(JSON.parse(options.body)).toEqual({
      technician_id: "tech-1",
      clock_in: "2026-07-07T12:00:00.000Z",
      clock_out: "2026-07-07T20:30:00.000Z",
      notes: "Never tapped",
      edit_reason: "Tech worked, no clock-in",
    });
    await waitFor(() => expect(calls.filter(([u]) => u.includes("/entries?")).length).toBeGreaterThan(loadsBefore));
    expect(screen.queryByRole("dialog", { name: "Add missed shift" })).not.toBeInTheDocument();
  });

  it("shows the server's refusal and keeps the form open", async () => {
    stub(json({ error: "That time overlaps a shift already on this technician. Edit that shift instead." }, 409));
    const showToast = vi.fn();
    render(<EntriesTab showToast={showToast} />);
    await fillForm();
    fireEvent.change(screen.getByLabelText("Reason (required)"), { target: { value: "Late entry" } });
    fireEvent.click(screen.getByRole("button", { name: "Add shift" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("overlaps a shift already on this technician");
    expect(screen.getByRole("dialog", { name: "Add missed shift" })).toBeInTheDocument();
    expect(showToast).not.toHaveBeenCalledWith("Shift added");
  });
});
