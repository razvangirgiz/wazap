#!/usr/bin/env node
/**
 * Prints one version's section of CHANGELOG.md, without its `## X.Y.Z`
 * heading: the notes a GitHub Release carries. The publish workflow calls it
 * with the tag's version before anything is published, so a tag whose version
 * has no notes fails there instead of shipping a release with an empty body.
 *
 *   node scripts/changelog-notes.mjs 0.18.6 [CHANGELOG.md]
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** A version heading is `## X.Y.Z`, optionally followed by a space and more text. */
function isHeadingFor(line, version) {
  const heading = `## ${version}`;
  return line === heading || line.startsWith(`${heading} `);
}

export function notesFor(changelog, version) {
  const lines = changelog.split(/\r?\n/).map((line) => line.trimEnd());
  const start = lines.findIndex((line) => isHeadingFor(line, version));
  if (start === -1) throw new Error(`no "## ${version}" section`);
  const rest = lines.slice(start + 1);
  // `### Added` does not end the section: only the next `## ` heading does.
  const end = rest.findIndex((line) => line.startsWith("## "));
  const body = (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
  if (body === "") throw new Error(`the "## ${version}" section is empty`);
  return body;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [version, file = fileURLToPath(new URL("../CHANGELOG.md", import.meta.url))] = process.argv.slice(2);
  if (version === undefined) {
    console.error("usage: node scripts/changelog-notes.mjs <version> [CHANGELOG.md]");
    process.exit(1);
  }
  try {
    console.log(notesFor(readFileSync(file, "utf8"), version));
  } catch (error) {
    console.error(`${file}: ${error.message}`);
    process.exit(1);
  }
}
