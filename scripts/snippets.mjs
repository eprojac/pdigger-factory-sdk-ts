// Fills the code samples of README.md, docs/*.md and docs/tutorials/*.md from the examples they name, so every sample
// is code that the tests run (test/examples.test.ts) and checks (test/docs.test.ts). In the Markdown a sample is a
// marker line
//   <!-- snippet: examples/quickstart.ts#quickstart -->
// followed by a fenced block; the block becomes the lines between `// #region quickstart` and `// #endregion quickstart`
// of that file, dedented.
//
//   node scripts/snippets.mjs           rewrite the samples
//   node scripts/snippets.mjs --check   exit 1 when a sample differs from its example
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

/** The lines of a `// #region name` of a file, dedented. */
export function region(file, name) {
  const text = readFileSync(`${root}${file}`, "utf8");
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim() === `// #region ${name}`);
  const end = lines.findIndex((l, i) => i > start && l.trim() === `// #endregion ${name}`);
  if (start < 0 || end < 0) throw new Error(`${file} has no region ${name}`);
  const body = lines.slice(start + 1, end);
  const indent = Math.min(...body.filter((l) => l.trim() !== "").map((l) => l.length - l.trimStart().length));
  return body
    .map((l) => l.slice(indent))
    .join("\n")
    .trimEnd();
}

const MARKER = /<!-- snippet: (\S+?)#([\w-]+) -->\n(?:```\w*\n[\s\S]*?\n?```\n)?/g;

/** The Markdown with every sample filled from its example. */
export function fill(markdown) {
  return markdown.replace(MARKER, (_m, file, name) => {
    const lang = file.endsWith(".js") || file.endsWith(".mjs") ? "js" : "ts";
    return `<!-- snippet: ${file}#${name} -->\n\`\`\`${lang}\n${region(file, name)}\n\`\`\`\n`;
  });
}

export const PAGES = [
  "README.md",
  ...readdirSync(`${root}docs`)
    .filter((f) => f.endsWith(".md"))
    .map((f) => `docs/${f}`),
  ...readdirSync(`${root}docs/tutorials`)
    .filter((f) => f.endsWith(".md"))
    .map((f) => `docs/tutorials/${f}`),
];

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const check = process.argv.includes("--check");
  let stale = 0;
  for (const page of PAGES) {
    const before = readFileSync(`${root}${page}`, "utf8");
    const after = fill(before);
    if (after === before) continue;
    stale++;
    if (check) console.error(`${page}: samples differ from the examples (node scripts/snippets.mjs)`);
    else writeFileSync(`${root}${page}`, after);
  }
  process.exitCode = check && stale > 0 ? 1 : 0;
}
