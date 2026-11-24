// Removes build output, coverage data and the generated API reference.
import { rmSync } from "node:fs";

for (const dir of ["dist", "coverage", "docs/api"])
  rmSync(new URL(`../${dir}`, import.meta.url), { recursive: true, force: true });
