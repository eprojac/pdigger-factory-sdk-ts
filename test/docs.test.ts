/**
 * The docs stay true: every code sample of README.md and docs/*.md is a region of an example that examples.test.ts
 * runs, relative links resolve, the quickstart picture shows what the quickstart prints, and the version is one.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { USER_AGENT, VERSION } from "pdigger-factory-sdk";
import { PAGES, fill } from "../scripts/snippets.mjs";
import { readText } from "./helpers/fixtures.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => readFileSync(join(root, rel), "utf8");
const pages: string[] = PAGES;

describe("docs", () => {
  it("covers the README and every page of docs/", () => {
    expect(pages).toEqual(expect.arrayContaining(["README.md", "docs/concepts.md", "docs/viz.md"]));
  });

  it.each(pages)("%s: every code sample is a region of a tested example", (page) => {
    const text = read(page);
    const fences = [...text.matchAll(/^```(ts|typescript|js|javascript|mjs)$/gm)].length;
    const markers = [...text.matchAll(/^<!-- snippet: \S+#[\w-]+ -->$/gm)].length;
    expect(markers, "a TypeScript or JavaScript block without a snippet marker").toBe(fences);
    expect(fill(text), "run node scripts/snippets.mjs").toBe(text);
  });

  it.each(pages)("%s: relative links and pictures exist", (page) => {
    for (const m of read(page).matchAll(/\]\(((?!https?:|#|mailto:)[^)\s]+)\)/g)) {
      const target = (m[1] as string).split("#")[0] as string;
      expect(existsSync(resolve(dirname(join(root, page)), target)), `${page} links ${m[1]}`).toBe(true);
    }
  });

  it("the quickstart picture shows what the quickstart prints on joined-mid-move", () => {
    const svg = read("docs/img/quickstart-output.svg");
    const lines = [...svg.matchAll(/<text [^>]*>(.*?)<\/text>/g)].map((m) =>
      (m[1] as string)
        .replace(/<[^>]+>/g, "")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&"),
    );
    const events = readText("golden/joined-mid-move.events.txt").split("\n");
    expect(lines[0]).toBe("$ node quickstart.mjs");
    expect(lines[1]).toBe("following dry1, session 1795314878");
    expect(lines.slice(2)).toEqual(events.slice(0, lines.length - 2));
    expect(lines.length).toBeGreaterThan(10);
  });

  const prose = [...pages, "TESTING.md", "CHANGELOG.md", "CONTRIBUTING.md"];
  it.each(prose)("%s: no unfilled placeholder (an ALL_CAPS_NAME outside code)", (page) => {
    const text = read(page)
      .replace(/^```[^\n]*\n[\s\S]*?^```$/gm, "") // fenced code
      .replace(/`[^`\n]*`/g, ""); // inline code
    const found = [...text.matchAll(/\b[A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+\b/g)].map((m) => m[0]);
    expect(found, `${page} has template placeholders`).toEqual([]);
  });

  it("has one version: package.json, the user agent, the changelog", () => {
    const pkg = JSON.parse(read("package.json")) as { version: string };
    expect(VERSION).toBe(pkg.version);
    expect(USER_AGENT).toBe(`pdigger-factory-sdk-ts/${pkg.version}`);
    expect(read("CHANGELOG.md")).toContain(`## [${pkg.version}]`);
  });
});
