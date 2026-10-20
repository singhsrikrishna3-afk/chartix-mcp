/**
 * The file bridge (§10) — the same tools, reading a CSV instead of the network.
 *
 * §10 frames this as the fallback for when ChartixAI grants no API. That is not
 * the situation here: this repository IS Chartix and the API is ours. It is
 * built anyway, because the mode has two uses that outlive the original
 * reason — running the bridge with no credential and no network (a demo, a
 * flight, a test fixture), and replaying a known dataset so downstream
 * behaviour is reproducible.
 *
 * ONE THING THE SPECIFIED FORMAT CANNOT HOLD. §10's header is
 *
 *   symbol,pattern,win_rate,sample_size,date_range,chart_url,as_of
 *
 * and asks the validator to flag a win_rate with no sample_size. Chartix
 * exposes no sample size on any route, so an export taken from Chartix flags
 * on every row with a win rate. The column is kept — the format is the
 * contract — but an empty sample_size is reported as a NOTE rather than an
 * error, because the exporter cannot do anything about it and an unfixable
 * error is one people learn to skip past.
 */
import { readFileSync, statSync } from "node:fs";
import { ChartixError, ChartixErrorCode } from "./errors.js";

export const CSV_HEADER = [
  "symbol", "pattern", "win_rate", "sample_size", "date_range", "chart_url", "as_of",
] as const;

export interface CsvRow {
  readonly symbol: string;
  readonly pattern: string;
  readonly win_rate: number | null;
  readonly sample_size: number | null;
  readonly date_range: string;
  readonly chart_url: string;
  readonly as_of: string;
}

export interface CsvProblem {
  readonly row: number;
  readonly level: "error" | "note";
  readonly message: string;
}

export interface ParsedCsv {
  readonly rows: CsvRow[];
  readonly problems: CsvProblem[];
  readonly as_of: string | null;
}

/** Minimal RFC-4180: quoted fields, doubled quotes inside them. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i += 1; } else { quoted = false; }
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function parseCsv(text: string): ParsedCsv {
  const problems: CsvProblem[] = [];
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    return { rows: [], problems: [{ row: 0, level: "error", message: "file is empty" }], as_of: null };
  }
  const header = splitCsvLine(lines[0]!).map((h) => h.toLowerCase());
  const expected = CSV_HEADER.join(",");
  if (header.join(",") !== expected) {
    return {
      rows: [],
      problems: [{
        row: 1, level: "error",
        message: `header must be exactly "${expected}" — got "${header.join(",")}"`,
      }],
      as_of: null,
    };
  }

  const rows: CsvRow[] = [];
  let newest: string | null = null;
  for (let i = 1; i < lines.length; i += 1) {
    const cells = splitCsvLine(lines[i]!);
    const n = i + 1;
    if (cells.length !== CSV_HEADER.length) {
      problems.push({ row: n, level: "error",
        message: `expected ${CSV_HEADER.length} fields, got ${cells.length}` });
      continue;
    }
    const [symbol, pattern, winRaw, sampleRaw, dateRange, chartUrl, asOf] = cells as string[];
    if (!symbol) {
      problems.push({ row: n, level: "error", message: "symbol is empty" });
      continue;
    }
    // §10: a row with no as_of is rejected. A pattern with no date is a
    // number with no claim attached to it.
    if (!asOf || !ISO_DATE.test(asOf)) {
      problems.push({ row: n, level: "error",
        message: `as_of must be an ISO date (YYYY-MM-DD), got "${asOf ?? ""}"` });
      continue;
    }
    const win = winRaw ? Number(winRaw) : NaN;
    const sample = sampleRaw ? Number(sampleRaw) : NaN;
    if (winRaw && !Number.isFinite(win)) {
      problems.push({ row: n, level: "error", message: `win_rate "${winRaw}" is not a number` });
      continue;
    }
    if (Number.isFinite(win) && (win < 0 || win > 1)) {
      problems.push({ row: n, level: "error",
        message: `win_rate ${win} is outside 0..1 — a percentage must be divided by 100` });
      continue;
    }
    if (Number.isFinite(win) && !Number.isFinite(sample)) {
      problems.push({ row: n, level: "note",
        message: "win_rate without sample_size — Chartix exposes no sample size, " +
                 "so a Chartix export cannot fill this column" });
    }
    if (Number.isFinite(win) && !dateRange) {
      problems.push({ row: n, level: "note", message: "win_rate without date_range" });
    }
    rows.push({
      symbol: symbol.toUpperCase(),
      pattern: pattern ?? "",
      win_rate: Number.isFinite(win) ? win : null,
      sample_size: Number.isFinite(sample) ? sample : null,
      date_range: dateRange ?? "",
      chart_url: chartUrl ?? "",
      as_of: asOf,
    });
    if (newest === null || asOf > newest) newest = asOf;
  }
  return { rows, problems, as_of: newest };
}

/**
 * A loaded import, with the staleness rule from §10: an import older than the
 * one already held is refused rather than silently overwriting it.
 */
export class FileSource {
  private rows: CsvRow[] = [];
  private asOf: string | null = null;
  private loadedAt: string | null = null;
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  load(previousAsOf?: string | null): { rows: number; as_of: string | null; problems: CsvProblem[] } {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
      statSync(this.path);
    } catch (e) {
      throw new ChartixError(
        ChartixErrorCode.Unavailable,
        `Cannot read ${this.path}: ${(e as Error).name}`,
      );
    }
    const parsed = parseCsv(text);
    const fatal = parsed.problems.filter((p) => p.level === "error");
    if (fatal.length > 0) {
      throw new ChartixError(
        ChartixErrorCode.BadRequest,
        `${this.path} is not a valid Chartix export: ` +
          fatal.slice(0, 3).map((p) => `row ${p.row}: ${p.message}`).join("; ") +
          (fatal.length > 3 ? ` (+${fatal.length - 3} more)` : ""),
      );
    }
    const prior = previousAsOf ?? this.asOf;
    if (prior && parsed.as_of && parsed.as_of < prior) {
      throw new ChartixError(
        ChartixErrorCode.StaleImport,
        `${this.path} is as of ${parsed.as_of}, older than the ${prior} already ` +
          `loaded. Refusing to overwrite newer data with older.`,
      );
    }
    this.rows = parsed.rows;
    this.asOf = parsed.as_of;
    this.loadedAt = new Date().toISOString();
    return { rows: this.rows.length, as_of: this.asOf, problems: parsed.problems };
  }

  patterns(symbol?: string): CsvRow[] {
    if (!symbol) return [...this.rows];
    const want = symbol.toUpperCase();
    return this.rows.filter((r) => r.symbol === want);
  }

  symbols(): string[] {
    return [...new Set(this.rows.map((r) => r.symbol))].sort();
  }

  status(): { as_of: string | null; loaded_at: string | null; rows: number; path: string } {
    return { as_of: this.asOf, loaded_at: this.loadedAt, rows: this.rows.length, path: this.path };
  }
}
