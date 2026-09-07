// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import Customer360Estimates from "./Customer360Estimates";
afterEach(cleanup);
it("shows stored quote amounts and distinguishes missing totals from zero", () => {
  render(<Customer360Estimates estimates={[
    { id: "estimate-a", estimate_slug: "QA-1042", annual_total: "1234.56", monthly_total: "102.88", priceReferences: [{ name: "Quarterly pest", perApplicationPrice: 308.64 }], onetime_total: "0.00", service_interest: "Quarterly pest", status: "accepted" },
    { id: "estimate-b", estimate_slug: "QA-1043", annual_total: null, onetime_total: "", service_interest: "Lawn care", status: "draft" },
  ]} />);
  expect(screen.getByText("$1,234.56")).toBeInTheDocument();
  expect(screen.getByText("$0.00")).toBeInTheDocument();
  expect(screen.getAllByText("Not recorded")).toHaveLength(3);
  expect(screen.getByText("$102.88")).toBeInTheDocument();
  expect(screen.getByText("$308.64")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "#QA-1042" })).toHaveAttribute("href", "/admin/estimates?estimateId=estimate-a");
  fireEvent.change(screen.getByRole("searchbox", { name: "Search estimates" }), { target: { value: "QA-1043" } });
  expect(screen.queryByText("$1,234.56")).not.toBeInTheDocument();
  expect(screen.getByText("Lawn care")).toBeInTheDocument();
  fireEvent.change(screen.getByRole("searchbox", { name: "Search estimates" }), { target: { value: "missing" } });
  expect(screen.getByText("No matching estimates.")).toBeInTheDocument();
});

it("keeps mixed service units separate and preserves a fully discounted application", () => {
  render(<Customer360Estimates estimates={[{ id: "quote-mixed", monthly_total: "39.00", annual_total: "468.00", priceReferences: [
    { name: "Pest Control", perApplicationPrice: 0, monthlyPrice: null },
    { name: "Rodent Bait", perApplicationPrice: null, monthlyPrice: 39 },
    { name: "Lawn Care", perApplicationPrice: null, monthlyPrice: null },
  ] }]} />);
  const pest = screen.getByText("Pest Control").closest("div");
  expect(pest).toHaveTextContent("$0.00");
  expect(screen.getByText("Rodent Bait").closest("div")).toHaveTextContent("$39.00 · billed monthly");
  expect(screen.getByText("Lawn Care").closest("div")).toHaveTextContent("Not recorded");
});
