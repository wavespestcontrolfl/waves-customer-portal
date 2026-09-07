// @vitest-environment jsdom
import React from "react";
import { readFileSync } from "node:fs";
import { parseExpression } from "@babel/parser";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import AdminTabRedirect from "./AdminTabRedirect";
import { isPathAdminOnly } from "../../config/adminNavigation";

const app = readFileSync("src/App.jsx", "utf8");
const cases = [
  ["content-engine", "blog", "autopilot"],
  ["content-registry", "blog", "registry"],
  ["data-hygiene", "agents", "hygiene"],
  ["agent-decisions", "agents", "decisions"],
  ["drafts", "agents", "drafts"],
  ["health", "customers", "health", "view"],
  ["documents", "contracts", "templates"],
  ["document-requests", "contracts", "requests"],
  ["discounts", "service-library", "discounts"],
];

function Probe() {
  const location = useLocation();
  const navigate = useNavigate();
  return <><output data-testid="location">{location.pathname}{location.search}{location.hash}</output>
    <button onClick={() => navigate(-1)}>Back</button>
    <button onClick={() => navigate(1)}>Forward</button></>;
}

afterEach(cleanup);

describe("App's existing admin aliases", () => {
  it.each(cases)("preserves context and history for %s", (source, target, leaf, queryKey = "tab") => {
    // Read the real JSX declaration, so a query-dropping Navigate in App fails
    // even if the redirect helper's independent unit tests remain green.
    const declaration = app.match(new RegExp(`<Route path="${source}" element=\\{([^\\n]+?)\\} />`));
    expect(declaration).not.toBeNull();
    const opening = parseExpression(declaration[1], { plugins: ["jsx"] }).openingElement;
    expect(opening.name.name).toBe("AdminTabRedirect");
    const props = Object.fromEntries(opening.attributes.map((a) => [a.name.name, a.value.value]));
    expect(props.to).toBe(`/admin/${target}`);
    expect(props.tab).toBe(leaf);
    expect(props.queryKey || "tab").toBe(queryKey);
    expect(isPathAdminOnly(`/admin/${source}`)).toBe(true);
    const initial = `/admin/${source}?${queryKey}=obsolete&status=auto_applied&id=fixture-123&filter=a&filter=b#evidence`;
    render(<MemoryRouter initialEntries={["/before", initial]} initialIndex={1}>
      <Routes>
        <Route path={`/admin/${source}`} element={<AdminTabRedirect {...props} />} />
        <Route path="*" element={<Probe />} />
      </Routes>
    </MemoryRouter>);
    const actual = new URL(screen.getByTestId("location").textContent, "https://fixture.invalid");
    expect(actual.pathname).toBe(`/admin/${target}`);
    expect(actual.searchParams.get(queryKey)).toBe(leaf);
    expect(actual.searchParams.get("status")).toBe("auto_applied");
    expect(actual.searchParams.get("id")).toBe("fixture-123");
    expect(actual.searchParams.getAll("filter")).toEqual(["a", "b"]);
    expect(actual.hash).toBe("#evidence");
    fireEvent.click(screen.getByText("Back"));
    expect(screen.getByTestId("location").textContent).toBe("/before");
    fireEvent.click(screen.getByText("Forward"));
    expect(screen.getByTestId("location").textContent).toBe(`${actual.pathname}${actual.search}${actual.hash}`);
  });
});
