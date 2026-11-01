// @vitest-environment jsdom
// GATE_AWAY_WATCH: the tech job card shows the server's Away Watch / Welcome Home lines, and nothing when the key is absent.
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { JobCardAwayWatch } from "./SchedulePage";

afterEach(cleanup);

const D = { text: "#000", muted: "#666" };
const AWAY = "Away Watch: member away until 2026-09-30. Take 3 photos of the outside of the home from the ground and note standing water.";
const WELCOME = "Welcome Home: last visit before the member is back. Do a lanai cobweb sweep (no product).";

describe("JobCardAwayWatch", () => {
  it("shows each line the server sent, at 14px", () => {
    render(<JobCardAwayWatch D={D} lines={[AWAY, WELCOME]} />);
    expect(screen.getByText(AWAY)).toHaveStyle({ fontSize: "14px" });
    expect(screen.getByText(WELCOME)).toBeInTheDocument();
  });

  it("renders nothing when the card has no awayWatch key (gate off, or a visit outside the window)", () => {
    expect(render(<JobCardAwayWatch D={D} lines={undefined} />).container).toBeEmptyDOMElement();
    expect(render(<JobCardAwayWatch D={D} lines={[]} />).container).toBeEmptyDOMElement();
  });
});
