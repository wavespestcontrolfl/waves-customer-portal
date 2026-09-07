// @vitest-environment jsdom
import React, { useState } from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import Customer360Activity from "./Customer360Activity";

afterEach(cleanup);

function History({ timeline }) {
  const [filter, onFilter] = useState("all");
  const [search, onSearch] = useState("");
  return <Customer360Activity search={search} onSearch={onSearch} timeline={timeline} filter={filter} onFilter={onFilter} error={false} retrying={false} onRetry={() => {}} />;
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

  it("combines full-description search with activity category and can clear both", () => {
    render(<History timeline={[
      { type: "sms", title: "Customer message", description: "Please close the side gate", date: "2024-07-02" },
      { type: "interaction", title: "Internal note", description: "Side gate latch repaired", date: "2024-07-02" },
      { type: "service", title: "Application completed", description: "Front lawn", date: "2024-07-02" },
    ]} />);
    const history = within(screen.getByRole("region", { name: "Customer activity history" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search activity" }), { target: { value: "GATE side" } });
    expect(history.getAllByRole("group")).toHaveLength(2);
    fireEvent.change(screen.getByRole("combobox", { name: "Filter activity" }), { target: { value: "sms" } });
    expect(history.getByText("Customer message")).toBeInTheDocument();
    expect(history.queryByText("Internal note")).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search activity" }), { target: { value: "missing" } });
    expect(screen.getByText("No matching activity.")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search activity" }), { target: { value: "" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Filter activity" }), { target: { value: "all" } });
    expect(history.getByText("Application completed")).toBeInTheDocument();
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
