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
  default: ({ sections = [], activeKey, onSectionChange, action, headingLevel, sticky, variant }) => (
    <div data-heading-level={headingLevel} data-sticky={String(sticky)} data-variant={variant}>
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
    fireEvent.click(screen.getByRole("button", { name: "Recent queries" }));

    expect(screen.getByTestId("location-search")).toHaveTextContent(
      "?source=bookmark&wikiTab=queries",
    );
  });

  it("loads the workspace directory, preserves filters, and opens from a native button", async () => {
    const firstLoad = deferred();
    fetch.mockImplementation((url) => {
      if (url.endsWith("/article/a-1")) {
        return Promise.resolve(response({
          article: {
            id: "a-1",
            title: "Termite protocol",
            path: "protocols/termite.md",
            version: 2,
            word_count: 321,
            content: "Inspect first.",
          },
        }));
      }
      return firstLoad.promise;
    });
    localStorage.setItem("waves_admin_user", JSON.stringify({ role: "admin" }));
    renderWiki("/admin/knowledge");

    expect(screen.getByText("Loading articles\u2026")).toBeInTheDocument();
    expect(document.querySelector('[data-ui-density="comfortable"]')).toBeInTheDocument();
    expect(document.querySelector("[data-variant]")).toHaveAttribute(
      "data-variant",
      "workspace",
    );

    firstLoad.resolve(response({
      articles: [{
        id: "a-1",
        title: "Termite protocol",
        path: "protocols/termite.md",
        word_count: 321,
        tags: '["termite"]',
      }],
      categoryCounts: { protocols: 1 },
    }));
    const category = await screen.findByRole("button", {
      name: "Filter by protocols category, 1 articles",
    });
    fireEvent.click(category);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search articles" }), {
      target: { value: "annual rate" },
    });
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      "/api/admin/knowledge?search=annual%20rate&category=protocols&",
      expect.any(Object),
    ));

    const articleButton = screen.getByRole("button", {
      name: "Open article: Termite protocol",
    });
    // A native button, so the card is reachable and operable from the keyboard.
    expect(articleButton.tagName).toBe("BUTTON");
    articleButton.focus();
    expect(articleButton).toHaveFocus();
    articleButton.click();
    expect(await screen.findByText("Inspect first.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "All articles" })).toBeInTheDocument();
  });

  it("retries an article-directory read error", async () => {
    fetch
      .mockResolvedValueOnce(response(
        { error: "Directory unavailable" },
        { ok: false, status: 503 },
      ))
      .mockResolvedValueOnce(response({ articles: [], categoryCounts: {} }));
    renderWiki("/admin/knowledge?source=bookmark");

    // A swallowed read used to render as an empty wiki rather than a failure.
    expect(await screen.findByRole("alert")).toHaveTextContent("Directory unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No articles yet")).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("location-search")).toHaveTextContent("source=bookmark");
  });

  it("retries recent-query reads while preserving tab and query context", async () => {
    let queryReads = 0;
    fetch.mockImplementation(async (url) => {
      if (!url.endsWith("/admin/knowledge/queries")) return response({ articles: [] });
      queryReads += 1;
      if (queryReads === 1) {
        return response({ error: "Queries unavailable" }, { ok: false, status: 503 });
      }
      return response({
        queries: [{
          id: "query-1",
          query: "Fixture prior question",
          answer: "Prior synthetic answer.",
          asked_by: "Fixture operator",
          created_at: "2026-09-10T15:00:00Z",
          response_quality: 4,
          filed_back: true,
        }],
      });
    });
    localStorage.setItem("waves_admin_user", JSON.stringify({ role: "admin" }));
    renderWiki("/admin/knowledge?source=bookmark&wikiTab=queries");

    expect(document.querySelector('[data-ui-density="comfortable"]')).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent("Queries unavailable");
    expect(screen.getByTestId("location-search")).toHaveTextContent(
      "?source=bookmark&wikiTab=queries",
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Q: Fixture prior question")).toBeInTheDocument();
    expect(screen.getByText("Fixture operator")).toBeInTheDocument();
    expect(screen.getByText("4/5")).toBeInTheDocument();
    expect(screen.getByText("Filed back")).toBeInTheDocument();
    expect(queryReads).toBe(2);

    fireEvent.click(screen.getByRole("button", { name: "Articles" }));
    fireEvent.click(screen.getByRole("button", { name: "Recent queries" }));
    await waitFor(() => expect(queryReads).toBe(3));
    expect(await screen.findByText("Q: Fixture prior question")).toBeInTheDocument();
    expect(screen.getByTestId("location-search")).toHaveTextContent(
      "?source=bookmark&wikiTab=queries",
    );
  });

  it("keeps the loading state armed until each recent-query read starts", async () => {
    localStorage.setItem("waves_admin_user", JSON.stringify({ role: "admin" }));
    const pending = deferred();
    fetch.mockImplementation(async (url) => (
      url.endsWith("/admin/knowledge/queries") ? pending.promise : response({ articles: [] })
    ));
    renderWiki("/admin/knowledge?wikiTab=queries");

    // A deep link must not paint the empty state before the passive effect runs.
    expect(screen.getByText("Loading recent queries\u2026")).toBeInTheDocument();
    expect(screen.queryByText(/No queries yet/)).not.toBeInTheDocument();

    pending.resolve(response({ queries: [] }));
    expect(await screen.findByText(/No queries yet/)).toBeInTheDocument();
  });

  it("re-arms the loading state instead of showing the previous visit's queries", async () => {
    localStorage.setItem("waves_admin_user", JSON.stringify({ role: "admin" }));
    const second = deferred();
    let queryReads = 0;
    fetch.mockImplementation(async (url) => {
      if (!url.endsWith("/admin/knowledge/queries")) return response({ articles: [] });
      queryReads += 1;
      if (queryReads > 1) return second.promise;
      return response({
        queries: [{
          id: "query-1",
          query: "Fixture prior question",
          answer: "Prior synthetic answer.",
          asked_by: "Fixture operator",
          created_at: "2026-09-10T15:00:00Z",
        }],
      });
    });
    renderWiki("/admin/knowledge?wikiTab=queries");
    expect(await screen.findByText("Q: Fixture prior question")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Articles" }));
    fireEvent.click(screen.getByRole("button", { name: "Recent queries" }));
    expect(screen.getByText("Loading recent queries\u2026")).toBeInTheDocument();
    expect(screen.queryByText("Q: Fixture prior question")).not.toBeInTheDocument();

    second.resolve(response({ queries: [] }));
    expect(await screen.findByText(/No queries yet/)).toBeInTheDocument();
  });

  it("collapses a recent-query answer to three lines behind an expand control", async () => {
    localStorage.setItem("waves_admin_user", JSON.stringify({ role: "admin" }));
    fetch.mockImplementation(async (url) => (
      url.endsWith("/admin/knowledge/queries")
        ? response({
          queries: [{
            id: "query-1",
            query: "Fixture prior question",
            answer: "Prior synthetic answer.",
            asked_by: "Fixture operator",
            created_at: "2026-09-10T15:00:00Z",
          }],
        })
        : response({ articles: [] })
    ));
    renderWiki("/admin/knowledge?wikiTab=queries");

    const answer = await screen.findByText("Prior synthetic answer.");
    expect(answer).toHaveClass("line-clamp-3");
    const toggle = screen.getByRole("button", { name: "Show full answer" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveAttribute("aria-controls", answer.id);

    fireEvent.click(toggle);
    expect(answer).not.toHaveClass("line-clamp-3");
    expect(screen.getByRole("button", { name: "Show less" }))
      .toHaveAttribute("aria-expanded", "true");
  });

  it("does not expose the admin-only Health area to non-admin staff", () => {
    localStorage.setItem("waves_admin_user", JSON.stringify({ role: "technician" }));
    renderWiki("/admin/knowledge?wikiTab=health");

    expect(screen.queryByRole("button", { name: "Health" }))
      .not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Articles" }))
      .toHaveAttribute("aria-current", "page");
  });

  it.each(["compile", "add"])(
    "guards duplicate source %s requests and retries only a failed refresh",
    async (mutation) => {
      const pending = deferred();
      // Count only this mutation's POSTs. useRenderedTabBeacon also POSTs to
      // /admin/usage/track on first render of a page+tab, and it dedupes for
      // the module's lifetime -- so a bare "any POST" filter counts the beacon
      // when this test runs first and misses it when an earlier test already
      // armed the same tab, which made the assertion order-dependent.
      const mutationPath = mutation === "compile"
        ? "/admin/knowledge/compile"
        : "/admin/knowledge/sources";
      const mutationPosts = () => fetch.mock.calls.filter(
        ([url, options]) => options?.method === "POST" && url.endsWith(mutationPath),
      );
      let getCount = 0;
      fetch.mockImplementation((url, options) => {
        if (options?.method === "POST") return pending.promise;
        getCount += 1;
        if (getCount === 2) {
          return Promise.resolve(response(
            { error: "Refresh unavailable" },
            { ok: false, status: 503 },
          ));
        }
        const sources = mutation === "compile" && getCount === 1
          ? [{ id: "source-1", filename: "rates.csv", file_type: "csv", processed: false }]
          : [];
        return Promise.resolve(response({ sources }));
      });
      localStorage.setItem("waves_admin_user", JSON.stringify({ role: "admin" }));
      renderWiki("/admin/knowledge?wikiTab=sources");
      expect(document.querySelector('[data-ui-density="comfortable"]')).toBeInTheDocument();

      if (mutation === "compile") {
        const compile = await screen.findByRole("button", { name: "Compile" });
        // Spec §5.7: Sources is table-first, one row per source document.
        const table = screen.getByRole("table", { name: "Source documents" });
        expect(table).toContainElement(compile);
        expect(table.querySelectorAll("tbody tr")).toHaveLength(1);
        fireEvent.click(compile);
        fireEvent.click(compile);
      } else {
        fireEvent.click(await screen.findByRole("button", { name: "Add source" }));
        const filename = screen.getByRole("textbox", { name: "Filename" });
        fireEvent.change(filename, { target: { value: "rates.csv" } });
        fireEvent.submit(filename.closest("form"));
        fireEvent.submit(filename.closest("form"));
      }

      expect(mutationPosts()).toHaveLength(1);
      pending.resolve(response({}));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Changes saved, but the source list could not be refreshed.",
      );
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      await waitFor(() => expect(getCount).toBe(3));
      expect(mutationPosts()).toHaveLength(1);
    },
  );

  it("lets a later successful refresh supersede an earlier one that failed", async () => {
    // The per-source guard permits two different sources to compile at once.
    // Each one refreshes the list, and loadError replaces the whole panel.
    const firstCompile = deferred();
    const secondCompile = deferred();
    let posts = 0;
    let getCount = 0;
    fetch.mockImplementation((url, options) => {
      if (options?.method === "POST") {
        posts += 1;
        return posts === 1 ? firstCompile.promise : secondCompile.promise;
      }
      getCount += 1;
      if (getCount === 2) {
        return Promise.resolve(response(
          { error: "Refresh unavailable" },
          { ok: false, status: 503 },
        ));
      }
      return Promise.resolve(response({
        sources: [
          { id: "source-1", filename: "rates.csv", file_type: "csv", processed: getCount > 2 },
          { id: "source-2", filename: "pricing.csv", file_type: "csv", processed: getCount > 2 },
        ],
      }));
    });
    localStorage.setItem("waves_admin_user", JSON.stringify({ role: "admin" }));
    renderWiki("/admin/knowledge?wikiTab=sources");

    const compiles = await screen.findAllByRole("button", { name: "Compile" });
    expect(compiles).toHaveLength(2);
    fireEvent.click(compiles[0]);
    fireEvent.click(compiles[1]);
    expect(fetch.mock.calls.filter(([, options]) => options?.method === "POST"))
      .toHaveLength(2);

    firstCompile.resolve(response({}));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Changes saved, but the source list could not be refreshed.",
    );

    secondCompile.resolve(response({}));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.getByRole("table", { name: "Source documents" })).toBeInTheDocument();
  });

  it("retains the source draft across cancel and a rejected add", async () => {
    fetch.mockImplementation(async (url, options) => options?.method === "POST"
      ? response({ error: "Invalid wiki path" }, { ok: false, status: 400 })
      : response({ sources: [] }));
    localStorage.setItem("waves_admin_user", JSON.stringify({ role: "admin" }));
    renderWiki("/admin/knowledge?wikiTab=sources");

    fireEvent.click(await screen.findByRole("button", { name: "Add source" }));
    const filename = screen.getByRole("textbox", { name: "Filename" });
    fireEvent.change(filename, { target: { value: "rates.csv" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Add source" }));
    expect(screen.getByRole("textbox", { name: "Filename" })).toHaveValue("rates.csv");
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid wiki path");
    expect(screen.getByRole("textbox", { name: "Filename" })).toHaveValue("rates.csv");
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
    const content = "Intro line\n# Termite basics\nBody one\n```sh\n# shell comment\n```\n## Bait stations\nBody two\n````md\n```\n# nested sample\n```\n~~~\n# tilde inside backticks\n~~~\n````\n# Not a heading? #\nTail";
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
    expect(screen.getByText(/Body two/)).toBeInTheDocument();
    expect(screen.getByText(/# shell comment/)).toBeInTheDocument();
    // A shorter or mismatched marker cannot close the four-backtick fence.
    expect(screen.getByText(/# nested sample/)).toBeInTheDocument();
    expect(screen.getByText(/# tilde inside backticks/)).toBeInTheDocument();

    fireEvent.click(within(toc).getByRole("button", { name: "Bait stations" }));
    expect(screen.getByRole("heading", { level: 3, name: "Bait stations" })).toHaveFocus();
  });

  it("keeps a literal trailing hash in a heading and clears the sticky hub header", async () => {
    localStorage.setItem("waves_admin_user", JSON.stringify({ role: "admin" }));
    // CommonMark needs whitespace before a closing hash run, so `# C#` keeps
    // its hash while `## Closing hashes stripped ##` drops the suffix.
    const content = ["# C#", "Body", "## Closing hashes stripped ##", "More"].join("\n");
    fetch.mockImplementation(async (url) => (
      url.endsWith("/knowledge/article/fixture")
        ? response({ article: { title: "Fixture article", content, tags: [] } })
        : response({ articles: [{ id: "fixture", title: "Fixture article", tags: [] }] })
    ));
    renderWiki("/admin/knowledge?wikiTab=articles");
    fireEvent.click(await screen.findByText("Fixture article"));

    const toc = await screen.findByRole("navigation", { name: "Article contents" });
    expect(within(toc).getAllByRole("button").map((button) => button.textContent))
      .toEqual(["C#", "Closing hashes stripped"]);

    // A TOC jump must land below the hub's sticky AdminCommandHeader.
    expect(screen.getByRole("heading", { level: 2, name: "C#" }))
      .toHaveClass("md:scroll-mt-32");
  });

  it("keeps info-string fences closed and nests third-level headings under their section", async () => {
    localStorage.setItem("waves_admin_user", JSON.stringify({ role: "admin" }));
    // ```json reuses the active delimiter and run length but carries an info
    // string, so it opens nothing and must not close the sample.
    const content = [
      "# Rodent Guarantee",
      "```",
      "```json",
      "# not a heading, still inside the sample",
      "```",
      "## Core Rules",
      "### 1. Retreatment is free",
      "Body",
    ].join("\n");
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
    expect(entries).toEqual(["Rodent Guarantee", "Core Rules", "1. Retreatment is free"]);
    // The `#` line inside the info-string fence stays in the code sample.
    expect(screen.getByText(/# not a heading, still inside the sample/)).toBeInTheDocument();
    // Three stored ATX levels map to three distinct elements.
    expect(screen.getByRole("heading", { level: 2, name: "Rodent Guarantee" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "Core Rules" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 4, name: "1. Retreatment is free" })).toBeInTheDocument();
    // ...and the TOC indents the child deeper than its parent.
    const child = within(toc).getByRole("button", { name: "1. Retreatment is free" }).closest("li");
    const parent = within(toc).getByRole("button", { name: "Core Rules" }).closest("li");
    expect(parent.className).toContain("pl-4");
    expect(child.className).toContain("pl-8");
  });

  it("honors Markdown's three-space indentation boundary for headings and fences", async () => {
    localStorage.setItem("waves_admin_user", JSON.stringify({ role: "admin" }));
    const content = [
      "# Top",
      "   ### Indented three spaces is still a heading",
      "    ```",
      "    # four-space indent is a code block, not a fence opener",
      "## Later heading must survive",
      "Body",
    ].join("\n");
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
    // Up to three spaces still opens a heading; a four-space-indented ``` is an
    // indented code block, so it must NOT open a fence and swallow what follows.
    expect(entries).toEqual([
      "Top",
      "Indented three spaces is still a heading",
      "Later heading must survive",
    ]);
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
