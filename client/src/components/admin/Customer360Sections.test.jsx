// @vitest-environment jsdom
import React, { useState } from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import Customer360Sections from "./Customer360Sections";

afterEach(cleanup);

function Sections() {
  const [active, onChange] = useState("overview");
  return <><Customer360Sections active={active} onChange={onChange} contentId="test-profile-content" /><div id="test-profile-content" role="tabpanel" aria-label={active}>{active}</div></>;
}

it("makes every section reachable by keyboard with one selected tab in the tab order", () => {
  render(<Sections />);
  const overview = screen.getByRole("tab", { name: "Overview" });
  overview.focus();
  fireEvent.keyDown(overview, { key: "End" });
  const compliance = screen.getByRole("tab", { name: "Compliance" });
  expect(compliance).toHaveFocus();
  expect(compliance).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("tabpanel")).toHaveTextContent("compliance");
  expect(screen.getAllByRole("tab").filter((tab) => tab.tabIndex === 0)).toEqual([compliance]);
  fireEvent.keyDown(compliance, { key: "ArrowRight" });
  expect(overview).toHaveFocus();
  expect(overview).toHaveAttribute("aria-selected", "true");
  fireEvent.keyDown(overview, { key: "ArrowRight" });
  expect(screen.getByRole("tabpanel")).toHaveTextContent("services");
});
