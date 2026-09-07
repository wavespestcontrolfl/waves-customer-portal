// @vitest-environment jsdom
import React, { useState } from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import Customer360Sections, { CUSTOMER_WORKSPACE_SECTIONS } from "./Customer360Sections";

afterEach(cleanup);

function Sections({ sections = CUSTOMER_WORKSPACE_SECTIONS }) {
  const [active, onChange] = useState("overview");
  return <><Customer360Sections active={active} onChange={onChange} contentId="test-profile-content" sections={sections} /><div id="test-profile-content" role="tabpanel" aria-label={active}>{active}</div></>;
}

it("makes every section reachable by keyboard with one selected tab in the tab order", () => {
  render(<Sections />);
  const overview = screen.getByRole("tab", { name: "Summary" });
  overview.focus();
  fireEvent.keyDown(overview, { key: "End" });
  const compliance = screen.getByRole("tab", { name: "Details" });
  expect(compliance).toHaveFocus();
  expect(compliance).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("tabpanel")).toHaveTextContent("property");
  expect(screen.getAllByRole("tab").filter((tab) => tab.tabIndex === 0)).toEqual([compliance]);
  fireEvent.keyDown(compliance, { key: "ArrowRight" });
  expect(overview).toHaveFocus();
  expect(overview).toHaveAttribute("aria-selected", "true");
  fireEvent.keyDown(overview, { key: "ArrowRight" });
  expect(screen.getByRole("tabpanel")).toHaveTextContent("comms");
});

it("keeps keyboard navigation inside the sections available to the role", () => {
  render(<Sections sections={CUSTOMER_WORKSPACE_SECTIONS.filter((section) => section.key !== "billing")} />);
  expect(screen.queryByRole("tab", { name: "Billing" })).not.toBeInTheDocument();
  fireEvent.keyDown(screen.getByRole("tab", { name: "Summary" }), { key: "ArrowRight" });
  const activity = screen.getByRole("tab", { name: "Activity" });
  expect(activity).toHaveFocus();
  fireEvent.keyDown(activity, { key: "ArrowRight" });
  expect(screen.getByRole("tab", { name: "Details" })).toHaveFocus();
  expect(screen.getByRole("tabpanel")).toHaveTextContent("property");
});
