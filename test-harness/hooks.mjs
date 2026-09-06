import { readFileSync } from "node:fs";

export async function resolve(specifier, context, next) {
  if (specifier === "playroomkit") {
    return {
      url: new URL("./pk-stub.mjs", import.meta.url).href,
      shortCircuit: true,
    };
  }
  if (specifier.endsWith(".css")) {
    return {
      url: new URL("./empty-style.mjs", import.meta.url).href,
      shortCircuit: true,
    };
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (url.endsWith("/snark.json")) {
    const src = readFileSync(new URL(url), "utf8");
    return { format: "module", source: `export default ${src};`, shortCircuit: true };
  }
  return next(url, context);
}
