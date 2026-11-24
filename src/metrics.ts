/**
 * A parser of the Prometheus text exposition format (`GET /metrics`).
 *
 * @module
 */

/** One sample: `name{labels} value`. */
export interface MetricSample {
  name: string;
  labels: Record<string, string>;
  value: number;
  /** Milliseconds since the epoch, when the line has a timestamp. */
  timestamp?: number;
}

/** `getMetrics()`: the text and its parsed samples. */
export interface Metrics {
  text: string;
  samples: MetricSample[];
}

function parseValue(v: string): number {
  if (v === "+Inf" || v === "Inf") return Number.POSITIVE_INFINITY;
  if (v === "-Inf") return Number.NEGATIVE_INFINITY;
  if (v === "NaN") return Number.NaN;
  return Number(v);
}

function parseLabels(s: string): Record<string, string> {
  const labels: Record<string, string> = {};
  let i = 0;
  while (i < s.length) {
    while (i < s.length && (s[i] === " " || s[i] === ",")) i++;
    if (i >= s.length) break;
    const eq = s.indexOf("=", i);
    if (eq < 0) break;
    const name = s.slice(i, eq).trim();
    i = eq + 1;
    if (s[i] !== '"') break;
    i++;
    let value = "";
    while (i < s.length && s[i] !== '"') {
      if (s[i] === "\\" && i + 1 < s.length) {
        const n = s[i + 1];
        value += n === "n" ? "\n" : (n as string);
        i += 2;
      } else {
        value += s[i] as string;
        i++;
      }
    }
    i++;
    labels[name] = value;
  }
  return labels;
}

/** Parses Prometheus text: comments and blank lines are skipped, malformed lines ignored. */
export function parseMetrics(text: string): MetricSample[] {
  const out: MetricSample[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    let name: string;
    let labels: Record<string, string> = {};
    let rest: string;
    const brace = line.indexOf("{");
    const space = line.indexOf(" ");
    if (brace >= 0 && (space < 0 || brace < space)) {
      const close = line.lastIndexOf("}");
      if (close < brace) continue;
      name = line.slice(0, brace);
      labels = parseLabels(line.slice(brace + 1, close));
      rest = line.slice(close + 1).trim();
    } else {
      if (space < 0) continue;
      name = line.slice(0, space);
      rest = line.slice(space + 1).trim();
    }
    const parts = rest.split(/\s+/);
    const v = parts[0] as string;
    const ts = parts[1];
    const value = parseValue(v);
    if (Number.isNaN(value) && v !== "NaN") continue;
    const sample: MetricSample = { name, labels, value };
    if (ts !== undefined && /^-?\d+$/.test(ts)) sample.timestamp = Number(ts);
    out.push(sample);
  }
  return out;
}
