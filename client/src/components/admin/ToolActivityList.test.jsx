// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import ToolActivityList, { formatDuration } from "./ToolActivityList";

afterEach(cleanup);

describe("ToolActivityList", () => {
  it("renders one line per tool with label, outcome and duration — never inputs or results", () => {
    render(
      <ToolActivityList
        variant="dark"
        items={[
          { tool: "search_customers", label: "Search customers", status: "done", durationMs: 412, round: 0 },
          { tool: "send_sms", label: "Send a text message", status: "proposed", durationMs: 1800, round: 1 },
          { tool: "get_invoice", label: "Get invoice", status: "error", durationMs: 12000, round: 1 },
          { tool: "junk" },
          null,
        ]}
      />,
    );
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent("Search customers · done");
    expect(items[0]).toHaveTextContent("412 ms");
    expect(items[1]).toHaveTextContent("Send a text message · awaiting your confirmation");
    expect(items[1]).toHaveAttribute("data-status", "proposed");
    expect(items[2]).toHaveTextContent("Get invoice · could not complete");
    expect(items[2]).toHaveTextContent("12 s");
    expect(screen.getByRole("list", { name: "What the bar checked" })).toBeInTheDocument();
  });

  it("renders nothing without items (gate off → no toolActivity in the payload)", () => {
    const { container } = render(<ToolActivityList items={undefined} />);
    expect(container).toBeEmptyDOMElement();
    const empty = render(<ToolActivityList items={[]} variant="light" />);
    expect(empty.container).toBeEmptyDOMElement();
  });

  it("formats durations", () => {
    expect(formatDuration(0)).toBe("0 ms");
    expect(formatDuration(999)).toBe("999 ms");
    expect(formatDuration(1500)).toBe("1.5 s");
    expect(formatDuration(45000)).toBe("45 s");
    expect(formatDuration(undefined)).toBe("");
    expect(formatDuration(-5)).toBe("");
  });
});
