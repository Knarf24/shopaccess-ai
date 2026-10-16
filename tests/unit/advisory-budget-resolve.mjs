import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const src = pathToFileURL(`${path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src")}${path.sep}`);
const EXTENSIONS = [".ts", ".tsx", ".mts", ".js", ".mjs"];

async function withExtension(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (!error || error.code !== "ERR_MODULE_NOT_FOUND") throw error;
    for (const extension of EXTENSIONS) {
      try {
        return await nextResolve(specifier + extension, context);
      } catch (next) {
        if (!next || next.code !== "ERR_MODULE_NOT_FOUND") throw next;
      }
    }
    throw error;
  }
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    return withExtension(new URL(specifier.slice(2), src).href, context, nextResolve);
  }
  if (specifier.startsWith(".")) return withExtension(specifier, context, nextResolve);
  return nextResolve(specifier, context);
}
