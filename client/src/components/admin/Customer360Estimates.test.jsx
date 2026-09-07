// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import Customer360Estimates from "./Customer360Estimates";
afterEach(cleanup);
it("shows stored quote amounts and distinguishes missing totals from zero", () => {
  render(<Customer360Estimates estimates={[
    { id: "estimate-a", estimate_slug: "QA-1042", annual_total: "1234.56", onetime_total: "0.00", service_interest: "Quarterly pest", status: "accepted" },
    { id: "estimate-b", estimate_slug: "QA-1043", annual_total: null, onetime_total: "", service_interest: "Lawn care", status: "draft" },
  ]} />);
  expect(screen.getByText("$1,234.56")).toBeInTheDocument();
  expect(screen.getByText("$0.00")).toBeInTheDocument();
  expect(screen.getAllByText("Not recorded")).toHaveLength(2);
  expect(screen.getByRole("link", { name: "#QA-1042" })).toHaveAttribute("href", "/admin/estimates?estimateId=estimate-a");
  fireEvent.change(screen.getByRole("searchbox", { name: "Search estimates" }), { target: { value: "QA-1043" } });
  expect(screen.queryByText("$1,234.56")).not.toBeInTheDocument();
  expect(screen.getByText("Lawn care")).toBeInTheDocument();
  fireEvent.change(screen.getByRole("searchbox", { name: "Search estimates" }), { target: { value: "missing" } });
  expect(screen.getByText("No matching estimates.")).toBeInTheDocument();
});
