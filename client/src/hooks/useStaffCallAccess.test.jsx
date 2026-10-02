// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { useCanAccessCalls } from "./useStaffCallAccess";
import AuthenticatedCallAudio from "../components/admin/AuthenticatedCallAudio";

afterEach(cleanup);

function Probe() {
  return <span data-testid="probe">{String(useCanAccessCalls())}</span>;
}

// The admin shell hands the server-verified user down through its Outlet.
function renderInShell(user, child) {
  const Shell = () => <Outlet context={{ user }} />;
  return render(
    <MemoryRouter initialEntries={["/admin"]}>
      <Routes>
        <Route path="/admin" element={<Shell />}>
          <Route index element={child} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe("useCanAccessCalls", () => {
  it("is true for an admin and false for a technician in the admin shell", () => {
    renderInShell({ role: "admin" }, <Probe />);
    expect(screen.getByTestId("probe")).toHaveTextContent("true");
    cleanup();
    renderInShell({ role: "technician" }, <Probe />);
    expect(screen.getByTestId("probe")).toHaveTextContent("false");
  });

  it("is true when no shell supplies a role (callers outside it pass their own flag)", () => {
    render(<MemoryRouter><Probe /></MemoryRouter>);
    expect(screen.getByTestId("probe")).toHaveTextContent("true");
  });
});

describe("call audio is not shown to a technician", () => {
  it("renders no player for a technician, and the player for an admin", () => {
    const tech = renderInShell({ role: "technician" }, <AuthenticatedCallAudio recordingId="RE123" />);
    expect(tech.container).toBeEmptyDOMElement();
    cleanup();
    const admin = renderInShell({ role: "admin" }, <AuthenticatedCallAudio recordingId="RE123" />);
    expect(admin.container.querySelector("[data-audio-state]")).not.toBeNull();
  });
});
