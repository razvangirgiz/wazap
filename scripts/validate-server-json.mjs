#!/usr/bin/env node
/**
 * Validates server.json against the registry schema it names in its own
 * `$schema`, so the file is checked by the contract it claims rather than by
 * one hardcoded here. A JSON Schema library would be a dependency for one
 * file, so this walks the draft-07 keywords the registry schema actually uses.
 *
 * Network-bound, so it is a release step rather than part of `npm test`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const file = process.argv[2] ?? fileURLToPath(new URL("../server.json", import.meta.url));
const doc = JSON.parse(readFileSync(file, "utf8"));

function resolve(ref, root) {
  return ref
    .replace(/^#\//, "")
    .split("/")
    .reduce((node, key) => node[key], root);
}

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

function matchesType(want, value) {
  const actual = typeOf(value);
  if (want === "number") return actual === "number" || actual === "integer";
  return actual === want;
}

function validate(schema, value, root, path) {
  if (schema === true || schema === undefined) return [];
  if (schema === false) return [`${path}: not allowed here`];
  if (schema.$ref) return validate(resolve(schema.$ref, root), value, root, path);

  const errors = [];
  for (const sub of schema.allOf ?? []) errors.push(...validate(sub, value, root, path));
  if (schema.anyOf && !schema.anyOf.some((sub) => validate(sub, value, root, path).length === 0)) {
    errors.push(`${path}: matches none of the ${schema.anyOf.length} allowed shapes`);
  }
  if (schema.oneOf && schema.oneOf.filter((sub) => validate(sub, value, root, path).length === 0).length !== 1) {
    errors.push(`${path}: must match exactly one of the ${schema.oneOf.length} allowed shapes`);
  }

  const types = schema.type === undefined ? [] : [schema.type].flat();
  if (types.length > 0 && !types.some((want) => matchesType(want, value))) {
    errors.push(`${path}: expected ${types.join(" or ")}, got ${typeOf(value)}`);
    return errors;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} is not one of ${schema.enum.join(", ")}`);
  }

  if (typeof value === "string") {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${path}: ${JSON.stringify(value)} does not match ${schema.pattern}`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${path}: ${value.length} characters, the limit is ${schema.maxLength}`);
    }
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path}: shorter than ${schema.minLength} characters`);
    }
  }

  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) => errors.push(...validate(schema.items, item, root, `${path}[${index}]`)));
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${path}: missing required property "${key}"`);
    }
    for (const [key, child] of Object.entries(value)) {
      const property = schema.properties?.[key];
      if (property !== undefined) errors.push(...validate(property, child, root, `${path}.${key}`));
      else if (schema.additionalProperties !== undefined) {
        errors.push(...validate(schema.additionalProperties, child, root, `${path}.${key}`));
      }
    }
  }

  return errors;
}

const schemaUrl = doc.$schema;
if (typeof schemaUrl !== "string") {
  console.error(`${file} names no $schema, so there is nothing to validate it against.`);
  process.exit(1);
}

const response = await fetch(schemaUrl);
if (!response.ok) {
  console.error(`${schemaUrl} answered ${response.status}.`);
  process.exit(1);
}
const schema = await response.json();

const errors = validate(schema, doc, schema, "server.json");
if (errors.length > 0) {
  for (const error of errors) console.error(`  ${error}`);
  console.error(`${errors.length} problem(s) against ${schemaUrl}`);
  process.exit(1);
}
console.log(`server.json validates against ${schemaUrl}`);
