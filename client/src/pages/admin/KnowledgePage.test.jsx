// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../components/admin/AdminCommandHeader", () => ({
  default: ({ sections = [], activeKey, onSectionChange, action, headingLevel, sticky }) => (
    <div data-heading-level={headingLevel} data-sticky={String(sticky)}>
      {sections.map(({ key, label }) => (
        <button
          key={key}
          type="button"
          aria-current={activeKey === key ? "page" : undefined}
          onClick={() => onSectionChange(key)}
        >
          {label}
        </button>
      ))}
      {action && <button type="button" onClick={action.onClick}>{action.label}</button>}
    </div>
  ),
}));

import KnowledgePage from "./KnowledgePage";

function response(data, { ok = true, status = 200 } = {}) {
  const json = vi.fn(async () => data);
  return {
    ok,
    status,
    statusText: "",
    headers: { get: vi.fn(() => null) },
    json,
    clone: vi.fn(() => ({ json })),
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location-search">{location.search}</output>;
}

function renderWiki(entry) {
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route
          path="/admin/knowledge"
          element={(
            <>
              <KnowledgePage embedded />
              <LocationProbe />
            </>
          )}
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe("KnowledgePage embedded navigation", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("waves_admin_token", "admin-token");
    vi.stubGlobal("fetch", vi.fn(async () => response({})));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("uses wikiTab without overwriting the Knowledge area", () => {
    localStorage.setItem("waves_admin_user", JSON.stringify({ role: "admin" }));
    renderWiki("/admin/knowledge?source=bookmark&wikiTab=sources");

    expect(screen.getByRole("button", { name: "Sources" }))
      .toHaveAttribute("aria-current", "page");
    fireEvent.click(screen.getByRole("button", { name: "Recent Queries" }));

    expect(screen.getByTestId("location-search")).toHaveTextContent(
      "?source=bookmark&wikiTab=queries",
    );
  });

  it("does not expose the admin-only Health area to non-admin staff", () => {
    localStorage.setItem("waves_admin_user", JSON.stringify({ role: "technician" }));
    renderWiki("/admin/knowledge?wikiTab=health");

    expect(screen.queryByRole("button", { name: "Health" }))
      .not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Articles" }))
      .toHaveAttribute("aria-current", "page");
  });

  it("retains a failed question and restores opener focus on close", async () => {
    localStorage.setItem("waves_admin_user", JSON.stringify({ role: "admin" }));
    fetch.mockImplementation(async (url, options) => options?.method === "POST"
      ? response({ error: "Knowledge service unavailable" }, { ok: false, status: 503 })
      : response({ articles: [] }));
    renderWiki("/admin/knowledge");

    const opener = screen.getByRole("button", { name: /ask a question/i });
    fireEvent.click(opener);
    expect(screen.getByRole("dialog")).toHaveAttribute("data-ui-density", "comfortable");
    const question = screen.getByRole("textbox", { name: "Question" });
    fireEvent.change(question, { target: { value: "What is the annual rate?" } });
    fireEvent.submit(question.closest("form"));

    expect(await screen.findByRole("alert")).toHaveTextContent("Knowledge service unavailable");
    expect(question).toHaveValue("What is the annual rate?");
    expect(fetch).toHaveBeenCalledWith(
      "/api/admin/knowledge/query",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ question: "What is the annual rate?" }),
      }),
    );

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
    fireEvent.click(opener);
    expect(screen.getByRole("textbox", { name: "Question" })).toHaveValue("");
  });

  it("guards duplicate question and file-back requests and retains the answer on failure", async () => {
    localStorage.setItem("waves_admin_user", JSON.stringify({ role: "admin" }));
    const questionPending = deferred();
    const fileBackPending = deferred();
    fetch.mockImplementation((url, options) => {
      if (url.endsWith("/query") && options?.method === "POST") return questionPending.promise;
      if (url.endsWith("/file-back") && options?.method === "POST") return fileBackPending.promise;
      return Promise.resolve(response({ articles: [] }));
    });
    renderWiki("/admin/knowledge");

    fireEvent.click(screen.getByRole("button", { name: /ask a question/i }));
    const question = screen.getByRole("textbox", { name: "Question" });
    fireEvent.change(question, { target: { value: "Question one" } });
    fireEvent.submit(question.closest("form"));
    fireEvent.submit(question.closest("form"));
    expect(fetch.mock.calls.filter(([url]) => url.endsWith("/query"))).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Ask" })).toBeDisabled();

    questionPending.resolve(response({
      answer: "Answer one",
      queryId: "query-1",
      articleTitles: [{ title: "Rate guide" }],
    }));
    expect(await screen.findByText("Answer one")).toBeInTheDocument();
    expect(screen.getByText("Sources: Rate guide")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Good" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Incomplete" })).toBeDisabled();

    const fileBack = screen.getByRole("button", { name: "File into wiki" });
    fireEvent.click(fileBack);
    fireEvent.click(fileBack);
    expect(fetch.mock.calls.filter(([url]) => url.endsWith("/file-back"))).toHaveLength(1);
    expect(fetch).toHaveBeenCalledWith(
      "/api/admin/knowledge/file-back",
      expect.objectContaining({ body: JSON.stringify({ queryId: "query-1" }) }),
    );
    fileBackPending.resolve(response({ error: "Could not write article" }, { ok: false, status: 500 }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not write article");
    expect(screen.getByText("Answer one")).toBeInTheDocument();
  });

  it.each(["article", "health"])("retries a rejected %s read without changing its request", async (kind) => {
    localStorage.setItem("waves_admin_user", JSON.stringify({ role: "admin" }));
    const target = kind === "article" ? "/api/admin/knowledge/article/fixture" : "/api/admin/knowledge/health";
    let reads = 0;
    fetch.mockImplementation(async (url) => {
      if (url === target) {
        reads += 1;
        if (reads === 1) return response({ error: "Synthetic read failure" }, { ok: false, status: 503 });
        return response(kind === "article"
          ? { article: { title: "Fixture article", content: "Fixture article body", tags: "malformed" } }
          : { healthScore: 75, totalArticles: 1, issues: [{ title: "Fixture health finding", detail: "Review required", severity: "high" }] });
      }
      return response({ articles: [{ id: "fixture", title: "Fixture article", tags: [] }] });
    });
    renderWiki(`/admin/knowledge?source=fixture&wikiTab=${kind === "article" ? "articles" : "health"}`);
    if (kind === "article") fireEvent.click(await screen.findByText("Fixture article"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Synthetic read failure");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText(kind === "article" ? "Fixture article body" : "Fixture health finding")).toBeInTheDocument();
    expect(reads).toBe(2);
    expect(fetch).toHaveBeenCalledWith(target, expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer admin-token" }),
    }));
    expect(screen.getByTestId("location-search")).toHaveTextContent("source=fixture");
  });

  it("marks each linter severity distinctly and skips non-string tags", async () => {
    localStorage.setItem("waves_admin_user", JSON.stringify({ role: "admin" }));
    fetch.mockImplementation(async (url) => {
      if (url.endsWith("/knowledge/health")) {
        return response({
          healthScore: 75,
          totalArticles: 1,
          issues: [
            { title: "Broken link", detail: "Target missing", severity: "medium" },
            { title: "Orphan page", detail: "No inbound links", severity: "low" },
          ],
        });
      }
      if (url.endsWith("/knowledge/article/fixture")) {
        return response({ article: { title: "Fixture article", content: "Fixture article body", tags: ["kept", { name: "object" }, ["nested"], 7] } });
      }
      return response({ articles: [{ id: "fixture", title: "Fixture article", tags: [] }] });
    });
    renderWiki("/admin/knowledge?wikiTab=health");

    const medium = await screen.findByText("medium");
    const low = screen.getByText("low");
    expect(medium.querySelector("span")).toHaveClass("bg-zinc-900");
    expect(low.querySelector("span")).toHaveClass("bg-zinc-500");
    expect(medium.querySelector("span")).not.toHaveClass("bg-alert-fg");
    expect(screen.getByLabelText("Wiki health score: 75")).toHaveClass("border-zinc-900");
  });

  it("renders the Health panel blank off a 403 instead of offering a retry", async () => {
    localStorage.setItem("waves_admin_user", JSON.stringify({ role: "admin" }));
    let healthReads = 0;
    fetch.mockImplementation(async (url) => {
      if (url.endsWith("/knowledge/health")) {
        healthReads += 1;
        return response({ error: "Admin access required" }, { ok: false, status: 403 });
      }
      return response({ articles: [] });
    });
    renderWiki("/admin/knowledge?wikiTab=health");

    await waitFor(() => expect(healthReads).toBe(1));
    await waitFor(() => expect(screen.queryByText("Running health check…")).not.toBeInTheDocument());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
    expect(screen.queryByText("Admin access required")).not.toBeInTheDocument();
  });

  it("builds an in-page table of contents from article headings", async () => {
    localStorage.setItem("waves_admin_user", JSON.stringify({ role: "admin" }));
    const content = "Intro line\n# Termite basics\nBody one\n## Bait stations\nBody two\n# Not a heading? #\nTail";
    fetch.mockImplementation(async (url) => (
      url.endsWith("/knowledge/article/fixture")
        ? response({ article: { title: "Fixture article", content, tags: [] } })
        : response({ articles: [{ id: "fixture", title: "Fixture article", tags: [] }] })
    ));
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
    renderWiki("/admin/knowledge?wikiTab=articles");
    fireEvent.click(await screen.findByText("Fixture article"));

    const toc = await screen.findByRole("navigation", { name: "Article contents" });
    const entries = within(toc).getAllByRole("button").map((button) => button.textContent);
    expect(entries).toEqual(["Termite basics", "Bait stations", "Not a heading?"]);
    expect(screen.getByRole("heading", { level: 2, name: "Termite basics" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "Bait stations" })).toBeInTheDocument();
    expect(screen.getByText("Body two")).toBeInTheDocument();

    fireEvent.click(within(toc).getByRole("button", { name: "Bait stations" }));
    expect(screen.getByRole("heading", { level: 3, name: "Bait stations" })).toHaveFocus();
  });

  it("renders only string tags so malformed tag elements cannot crash the reader", async () => {
    localStorage.setItem("waves_admin_user", JSON.stringify({ role: "admin" }));
    fetch.mockImplementation(async (url) => (
      url.endsWith("/knowledge/article/fixture")
        ? response({ article: { title: "Fixture article", content: "Fixture article body", tags: ["kept", { name: "object" }, ["nested"], 7] } })
        : response({ articles: [{ id: "fixture", title: "Fixture article", tags: [] }] })
    ));
    renderWiki("/admin/knowledge?wikiTab=articles");
    fireEvent.click(await screen.findByText("Fixture article"));
    expect(await screen.findByText("Fixture article body")).toBeInTheDocument();
    expect(screen.getByLabelText("Article tags").textContent).toBe("kept");
  });

  it("explains why an answer without a query ID cannot be filed", async () => {
    localStorage.setItem("waves_admin_user", JSON.stringify({ role: "admin" }));
    fetch.mockImplementation(async (url, options) => (
      url.endsWith("/query") && options?.method === "POST"
        ? response({ answer: "Answer without an ID", articleTitles: [] })
        : response({ articles: [] })
    ));
    renderWiki("/admin/knowledge");

    fireEvent.click(screen.getByRole("button", { name: /ask a question/i }));
    const question = screen.getByRole("textbox", { name: "Question" });
    fireEvent.change(question, { target: { value: "Question without an ID" } });
    fireEvent.submit(question.closest("form"));

    expect(await screen.findByText("Answer without an ID")).toBeInTheDocument();
    const fileBack = screen.getByRole("button", { name: "File into wiki" });
    expect(fileBack).toBeDisabled();
    expect(fileBack).toHaveAccessibleDescription(
      "Filing into the wiki is unavailable for this answer.",
    );
    expect(fetch.mock.calls.filter(([url]) => url.endsWith("/file-back"))).toHaveLength(0);
  });
});
