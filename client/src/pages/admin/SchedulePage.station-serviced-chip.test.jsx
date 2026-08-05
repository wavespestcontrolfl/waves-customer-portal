// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { StationMarkingStep } from "./SchedulePage.jsx";

// Round 18 (codex P2): a declared trap SETUP cannot carry serviced pins —
// the server rejects the completion — so the editor must not offer the
// "Serviced" status while the setup is declared. A pin already serviced
// (restored, or marked before the visit-type selector changed) keeps its
// mark visible so the operator can find and clear it; the handleSubmit
// mirror still blocks the submit if they don't. This renders the real
// component, so the assertion covers the branch, not just a predicate.
describe("StationMarkingStep hides Serviced while a trap setup is declared", () => {
  afterEach(cleanup);

  const baseProps = {
    map: { available: true, image: { url: "data:image/gif;base64,R0lGODlhAQABAAAAACw=", width: 640, height: 340 } },
    stations: [{ key: "st-1", id: "st-1", number: 1, label: null, shape: { type: "circle", cx: 0.5, cy: 0.5, r: 0.02 }, stale: false }],
    statuses: {},
    onAddStation: () => {},
    onMoveStation: () => {},
    onSetStatus: () => {},
    onRemoveStation: () => {},
    program: "trapping",
  };

  it("legend offers Serviced by default", () => {
    render(<StationMarkingStep {...baseProps} />);
    expect(screen.getByText("Serviced")).toBeInTheDocument();
  });

  it("legend drops Serviced when the setup declaration disallows it", () => {
    render(<StationMarkingStep {...baseProps} disallowServiced />);
    expect(screen.queryByText("Serviced")).not.toBeInTheDocument();
  });

  it("an already-serviced pin keeps its mark visible so it can be cleared", () => {
    render(
      <StationMarkingStep
        {...baseProps}
        statuses={{ "st-1": "serviced" }}
        disallowServiced
      />,
    );
    expect(screen.getByText("Serviced")).toBeInTheDocument();
  });
});
