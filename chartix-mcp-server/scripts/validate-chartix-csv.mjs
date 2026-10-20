#!/usr/bin/env node
/**
 * Validate a Chartix pattern export before it is trusted (§10).
 *
 *   node scripts/validate-chartix-csv.mjs path/to/export.csv
 *
 * Exits 1 on an error, 0 on notes alone. The distinction matters: a missing
 * sample_size is a NOTE, not an error, because Chartix exposes no sample size
 * on any route and the person running this cannot fix it. An unfixable error
 * is one people learn to pass --force to.
 */
import { readFileSync } from "node:fs";
import { parseCsv, CSV_HEADER } from "../dist/chartix/fileSource.js";

const path = process.argv[2];
if (!path) {
  console.error("usage: validate-chartix-csv.mjs <file.csv>");
  console.error(`expected header: ${CSV_HEADER.join(",")}`);
  process.exit(2);
}

let text;
try {
  text = readFileSync(path, "utf8");
} catch (e) {
  console.error(`  cannot read ${path}: ${e.code ?? e.name}`);
  process.exit(2);
}

const { rows, problems, as_of } = parseCsv(text);
const errors = problems.filter((p) => p.level === "error");
const notes = problems.filter((p) => p.level === "note");

console.log(`  ${path}`);
console.log(`  rows accepted : ${rows.length}`);
console.log(`  as_of         : ${as_of ?? "(none)"}`);
console.log(`  errors        : ${errors.length}`);
console.log(`  notes         : ${notes.length}`);

for (const p of errors.slice(0, 20)) console.log(`    ERROR row ${p.row}: ${p.message}`);
if (errors.length > 20) console.log(`    … and ${errors.length - 20} more`);
for (const p of notes.slice(0, 5)) console.log(`    note  row ${p.row}: ${p.message}`);
if (notes.length > 5) console.log(`    … and ${notes.length - 5} more notes`);

process.exit(errors.length > 0 ? 1 : 0);
