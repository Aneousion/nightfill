import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Hex } from "./codec.js";

export const MEASURED_FILES = [
  "src/core/match.ts",
  "src/core/engine.ts",
  "src/core/merkle.ts",
  "src/core/sodium.ts",
  "src/core/canonical.ts",
] as const;

export function repoRoot(): string {
  return fileURLToPath(new URL("../../", import.meta.url));
}

export function codeMeasurement(root = repoRoot()): {
  hex: string;
  files: string[];
} {
  const chunks: Buffer[] = [];
  for (const relative of MEASURED_FILES) {
    chunks.push(Buffer.from(relative));
    chunks.push(Buffer.from([0]));
    chunks.push(readFileSync(join(root, relative)));
    chunks.push(Buffer.from([0]));
  }
  return {
    hex: sha256Hex(Buffer.concat(chunks)),
    files: [...MEASURED_FILES],
  };
}
