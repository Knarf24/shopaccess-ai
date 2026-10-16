import { register } from "node:module";

const hookUrl = new URL("./mock-store-load-hook.mjs", import.meta.url);
hookUrl.searchParams.set("as", "hook");

if (new URL(import.meta.url).searchParams.get("as") !== "hook") {
  register(hookUrl.href, import.meta.url);
}

const EXTENSIONS = [".ts", ".mts", ".js", ".mjs"];

function hasExtension(specifier) {
  return /\.(?:[cm]?[jt]s|json)$/.test(specifier);
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const error = new Error(`Bare alias is not resolved: ${specifier}`);
    error.code = "ERR_INVALID_MODULE_SPECIFIER";
    throw error;
  }
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && !hasExtension(specifier)) {
    let lastNotFound = null;
    for (const extension of EXTENSIONS) {
      try {
        return await nextResolve(`${specifier}${extension}`, context);
      } catch (error) {
        if (!error || error.code !== "ERR_MODULE_NOT_FOUND") throw error;
        lastNotFound = error;
      }
    }
    if (lastNotFound) throw lastNotFound;
  }
  return nextResolve(specifier, context);
}
