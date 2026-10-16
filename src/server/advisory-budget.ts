import * as fs from "node:fs";
import path from "node:path";
import { AdvisoryFailure, type AdvisoryTransport } from "@/lib/providers/qwen-advisory";

/** The demonstration allows two advisory reservations. A different count is rejected. */
export const ADVISORY_BUDGET_SLOTS = 2;

const SLOTS_VARIABLE = "SHOPACCESS_ADVISORY_BUDGET_SLOTS";
const DIRECTORY_VARIABLE = "SHOPACCESS_ADVISORY_BUDGET_DIR";

export type AdvisoryBudget =
  | { readonly mode: "off" }
  | { readonly mode: "on"; readonly slots: 2; readonly directory: string };

export type AdvisoryBudgetError = "ADVISORY_BUDGET_PARTIAL" | "ADVISORY_BUDGET_INVALID";

export interface BudgetDirectoryStat {
  readonly uid: number;
  readonly mode: number;
  isSymbolicLink(): boolean;
  isDirectory(): boolean;
}

/** Real filesystem calls. Tests can supply a substitute for a single failing operation. */
export interface BudgetFiles {
  openSync(file: string, flags: string, mode?: number): number;
  writeSync(fd: number, data: string): number;
  closeSync(fd: number): void;
  lstatSync(file: string): BudgetDirectoryStat;
}

const realFiles: BudgetFiles = {
  openSync: (file, flags, mode) => fs.openSync(file, flags, mode),
  writeSync: (fd, data) => fs.writeSync(fd, data),
  closeSync: (fd) => {
    fs.closeSync(fd);
  },
  lstatSync: (file) => fs.lstatSync(file),
};

/**
 * Both variables absent leaves the budget off. One of them, including an empty string,
 * is partial. Any other unacceptable pair is invalid. Errors never include the values.
 */
export function parseAdvisoryBudget(
  env: Readonly<Record<string, string | undefined>>,
  options: { readonly advisory: "local" | "external" | "invalid"; readonly repoRoot: string },
  files: BudgetFiles = realFiles,
): { ok: true; value: AdvisoryBudget } | { ok: false; error: AdvisoryBudgetError } {
  const slots = env[SLOTS_VARIABLE];
  const directory = env[DIRECTORY_VARIABLE];
  if (slots === undefined && directory === undefined) return { ok: true, value: { mode: "off" } };
  if (slots === undefined || directory === undefined) return { ok: false, error: "ADVISORY_BUDGET_PARTIAL" };
  if (options.advisory !== "external" || slots !== String(ADVISORY_BUDGET_SLOTS) || !validBudgetDirectory(directory, options.repoRoot, files)) {
    return { ok: false, error: "ADVISORY_BUDGET_INVALID" };
  }
  return { ok: true, value: { mode: "on", slots: ADVISORY_BUDGET_SLOTS, directory } };
}

/** Present when either budget variable is set, including an empty string. */
export function advisoryBudgetPresence(env: Readonly<Record<string, string | undefined>>): "absent" | "present" {
  return env[SLOTS_VARIABLE] === undefined && env[DIRECTORY_VARIABLE] === undefined ? "absent" : "present";
}

/**
 * Reserves one slot, then forwards the same request once.
 * A failed reservation, open, write, or close does not forward.
 * The slot file is left in place after success and after failure.
 */
export function createBudgetedAdvisoryTransport(
  directory: string,
  inner: AdvisoryTransport,
  repoRoot = process.cwd(),
  files: BudgetFiles = realFiles,
): AdvisoryTransport {
  return async (request) => {
    if (!validBudgetDirectory(directory, repoRoot, files) || reserveSlot(directory, files) === null) throw new AdvisoryFailure("TRANSPORT");
    return inner(request);
  };
}

function reserveSlot(directory: string, files: BudgetFiles): number | null {
  for (let slot = 1; slot <= ADVISORY_BUDGET_SLOTS; slot += 1) {
    let fd: number;
    try {
      fd = files.openSync(path.join(directory, `slot-${slot}`), "wx", 0o600);
    } catch (error) {
      if (errorCode(error) === "EEXIST") continue;
      return null;
    }
    let written = false;
    try {
      files.writeSync(fd, JSON.stringify({ reservedAt: Date.now() }));
      written = true;
    } catch {
      written = false;
    }
    try {
      files.closeSync(fd);
    } catch {
      return null;
    }
    if (!written) return null;
    return slot;
  }
  return null;
}

function validBudgetDirectory(directory: string, repoRoot: string, files: BudgetFiles): boolean {
  if (directory.length < 1 || directory.length > 4096 || directory.includes("\0")) return false;
  if (!path.isAbsolute(directory) || directory !== path.resolve(directory)) return false;
  const root = path.resolve(repoRoot);
  if (directory === root || directory.startsWith(`${root}${path.sep}`)) return false;
  let stat: BudgetDirectoryStat;
  try {
    stat = files.lstatSync(directory);
  } catch {
    return false;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid === undefined || stat.uid !== uid) return false;
  return (stat.mode & 0o777) === 0o700;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") return error.code;
  return undefined;
}
