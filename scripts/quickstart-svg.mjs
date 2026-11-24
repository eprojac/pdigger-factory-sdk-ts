// Regenerates docs/img/quickstart-output.svg: runs examples/quickstart.ts (Node 22.18+ strips the types) against
// FakeFactory serving the dry1 excerpt of the fixtures (a real 20.20 recording) and draws the first lines it prints.
//
//   npm run build && node scripts/quickstart-svg.mjs
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const RECORDING = "joined-mid-move";
const LINES = 15;

const child = spawn(process.execPath, ["--import", "./scripts/fake-preload.mjs", "examples/quickstart.ts"], {
  cwd: root,
  env: { ...process.env, FAKE_RECORDING: RECORDING, PDIGGER_FACTORY_URL: "http://fake.factory" },
  stdio: ["ignore", "pipe", "inherit"],
});
const lines = await new Promise((resolve, reject) => {
  let text = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    text += chunk;
    const got = text.split("\n");
    if (got.length > LINES) {
      child.kill();
      resolve(got.slice(0, LINES));
    }
  });
  child.on("exit", (code) => reject(new Error(`the quickstart ended (${code}) before printing ${LINES} lines`)));
});

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const W = 760;
const LH = 20;
const top = 44;
const H = top + (lines.length + 1) * LH + 16;
const rows = [
  `<text x="20" y="${top}" fill="#8b97a3">$ node quickstart.mjs</text>`,
  ...lines.map((l, i) => {
    const y = top + (i + 1) * LH;
    if (i === 0) return `<text x="20" y="${y}" fill="#8b97a3">${esc(l)}</text>`;
    const m = /^(\S+) (.*)$/.exec(l);
    return `<text x="20" y="${y}"><tspan fill="#7fb4ff">${esc(m[1])}</tspan> <tspan fill="#e6edf3">${esc(m[2])}</tspan></text>`;
  }),
];
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Output of the quickstart on the dry1 recording excerpt">
  <title>Quickstart output: the first events of ${RECORDING} (dry1, frames 399-420), a 20.20 recording served by FakeFactory</title>
  <rect width="${W}" height="${H}" rx="8" fill="#0f1317"/>
  <circle cx="20" cy="16" r="5" fill="#3a434d"/><circle cx="38" cy="16" r="5" fill="#3a434d"/><circle cx="56" cy="16" r="5" fill="#3a434d"/>
  <g font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="13">
    ${rows.join("\n    ")}
  </g>
</svg>
`;
writeFileSync(`${root}docs/img/quickstart-output.svg`, svg);
console.log(lines.join("\n"));
