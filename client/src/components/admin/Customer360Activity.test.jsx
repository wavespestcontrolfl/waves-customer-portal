// @vitest-environment jsdom
import React, { useState } from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import Customer360Activity from "./Customer360Activity";

afterEach(cleanup);

function History({ timeline }) {
  const [filter, onFilter] = useState("all");
  return <Customer360Activity timeline={timeline} filter={filter} onFilter={onFilter} error={false} retrying={false} onRetry={() => {}} />;
}

describe("Customer 360 activity", () => {
  it("keeps history beyond the former 30-event cutoff reachable after filtering", () => {
    const timeline = Array.from({ length: 46 }, (_, index) => ({ type: index === 45 ? "activity" : "sms", title: index === 45 ? "Account created" : `Message ${index + 1}`, date: "2024-07-02T12:00:00Z" }));
    render(<History timeline={timeline} />);
    const history = within(screen.getByRole("region", { name: "Customer activity history" }));
    expect(history.getByText("Account created")).toBeInTheDocument();
    expect(history.getByText("Message 45")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Filter activity" }), { target: { value: "activity" } });
    expect(history.getByText("Account created")).toBeInTheDocument();
    expect(history.queryByText("Message 1")).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Filter activity" }), { target: { value: "all" } });
    expect(history.getByText("Message 45")).toBeInTheDocument();
  });

  it("uses Eastern dates for instants and preserves the calendar date of services", () => {
    render(<History timeline={[
      { type: "sms", title: "Evening text", date: "2024-07-02T01:00:00Z" },
      { type: "scheduled_service", title: "Scheduled application", date: "2024-07-02T00:00:00Z" },
    ]} />);
    expect(screen.getByText("Evening text").closest("summary")).toHaveTextContent("Jul 1, 2024");
    expect(screen.getByText("Scheduled application").closest("summary")).toHaveTextContent("Jul 2, 2024");
  });

  it("shows a retryable history failure without presenting it as an empty account", () => {
    const onRetry = vi.fn();
    render(<Customer360Activity timeline={[]} filter="all" onFilter={vi.fn()} error retrying={false} onRetry={onRetry} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load customer history");
    expect(screen.queryByText("No activity in this category.")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry customer history" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
