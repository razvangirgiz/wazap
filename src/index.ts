#!/usr/bin/env node
// Every way into wazap starts here: the CLI, `wazap serve` under a supervisor,
// and the bare stdio server an MCP client launches. The Node check comes before
// the rest is even loaded, because loading it is what fails on an old Node
// (`node:sqlite` is a static import far down the graph, and an ESM import that
// cannot link fails before a line of ours runs). So this file imports nothing
// but the check, and stdout stays untouched: it is the MCP protocol.
import { nodeProblem } from "./node-version.js";

const problem = nodeProblem(process.versions.node, process.execPath);
if (problem !== null) {
  process.stderr.write(problem + "\n");
  process.exitCode = 1;
} else {
  import("./main.js").catch((err: unknown) => {
    process.stderr.write("✗ wazap could not start: " + (err instanceof Error ? err.message : String(err)) + "\n");
    process.exit(1);
  });
}
