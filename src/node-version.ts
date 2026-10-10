/**
 * Which Node can run wazap, decided before anything else loads. It imports
 * nothing and uses no syntax newer than Node 14, so the oldest Node a person
 * may still have parses it and prints the one line below instead of a stack
 * trace about `node:sqlite` from deep inside the import graph.
 */

/** package.json `engines`, in words. */
export const NODE_REQUIRED = "Node 22.16 or newer (22.16+, or 24+)";

/** The one line that installs wazap with a Node of its own. */
export const INSTALL_LINE = "curl -fsSL https://raw.githubusercontent.com/razvangirgiz/wazap/main/scripts/install.sh | sh";

/** `^22.16.0 || >=24.0.0`, as package.json says; 23 is out, it was never an LTS. */
export function nodeSupported(version: string): boolean {
  const parts = version.replace(/^v/, "").split(".");
  const major = Number(parts[0]);
  const minor = Number(parts[1]);
  if (!Number.isInteger(major) || !Number.isInteger(minor)) return false;
  return (major === 22 && minor >= 16) || major >= 24;
}

/** One line for stderr when this Node cannot run wazap, or null when it can. */
export function nodeProblem(version: string, execPath: string): string | null {
  if (nodeSupported(version)) return null;
  return (
    "✗ wazap needs " + NODE_REQUIRED + "; this is Node " + version.replace(/^v/, "") + " (" + execPath + "). " +
    "Fix: run `" + INSTALL_LINE + "`, which installs wazap with its own Node and needs no sudo, then use the `wazap` it puts on your PATH."
  );
}
