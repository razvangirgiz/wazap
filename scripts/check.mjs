/**
 * The local gate: what a contributor runs before pushing. Fastest first, so a
 * lint slip fails in seconds instead of after the suite. `test` includes the
 * build, so a green run also proves the tree compiles.
 */
import { spawnSync } from "node:child_process";

const steps = [
  ["lint", ["run", "lint"]],
  ["typecheck", ["run", "typecheck"]],
  ["test", ["test"]],
];

for (const [name, [cmd, ...args]] of steps) {
  console.log(`\n=== ${name} ===`);
  const ran = spawnSync("npm", [cmd, ...args], { stdio: "inherit", shell: process.platform === "win32" });
  if (ran.status !== 0) {
    console.error(`\ncheck failed at: ${name}`);
    process.exit(ran.status ?? 1);
  }
}
console.log("\ncheck: all steps passed");
