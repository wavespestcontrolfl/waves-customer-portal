// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { useCanAccessCalls } from "./useStaffCallAccess";
import AuthenticatedCallAudio from "../components/admin/AuthenticatedCallAudio";
import CallBridgeLink from "../components/admin/CallBridgeLink";

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

  it("is false for a technician under /admin/today, where the field shell hands down techRole and no user", () => {
    const renderToday = (techRole, child) => render(
      <MemoryRouter initialEntries={["/admin/today"]}>
        <Routes>
          <Route path="/admin/today" element={<Outlet context={{ techRole }} />}>
            <Route index element={child} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    renderToday("technician", <Probe />);
    expect(screen.getByTestId("probe")).toHaveTextContent("false");
    cleanup();
    renderToday("admin", <Probe />);
    expect(screen.getByTestId("probe")).toHaveTextContent("true");
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

describe("the call bridge is not offered to a technician", () => {
  it("shows the number as plain text for a technician, and the call button for an admin", () => {
    renderInShell({ role: "technician" }, <CallBridgeLink phone="+15555550123">(555) 555-0123</CallBridgeLink>);
    expect(screen.getByText("(555) 555-0123")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    // The plain phone link, as on the visit card.
    expect(screen.getByRole("link", { name: "(555) 555-0123" })).toHaveAttribute("href", "tel:+15555550123");
    cleanup();
    // A styled "Call" pill becomes the plain number, never a dead control
    // carrying the button classes (codex #5683 r1).
    renderInShell({ role: "technician" }, <CallBridgeLink phone="+15555550123" className="pill-button">Call</CallBridgeLink>);
    expect(screen.getByText("+15555550123")).toBeInTheDocument();
    expect(screen.queryByText("Call")).not.toBeInTheDocument();
    expect(document.querySelector(".pill-button")).toBeNull();
    cleanup();
    // Under /admin/today the technician's role arrives as techRole, with no user.
    render(
      <MemoryRouter initialEntries={["/admin/today"]}>
        <Routes>
          <Route path="/admin/today" element={<Outlet context={{ techRole: "technician" }} />}>
            <Route index element={<CallBridgeLink phone="+15555550123">(555) 555-0123</CallBridgeLink>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "(555) 555-0123" })).toHaveAttribute("href", "tel:+15555550123");
    cleanup();
    renderInShell({ role: "admin" }, <CallBridgeLink phone="+15555550123">(555) 555-0123</CallBridgeLink>);
    expect(screen.getByRole("button", { name: /call/i })).toBeInTheDocument();
  });
});
