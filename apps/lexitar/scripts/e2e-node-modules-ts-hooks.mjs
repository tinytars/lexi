// Node refuses to strip types from a .ts file resolved into node_modules
// (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING) — a hard rule with no override flag, hit here
// because @tinytars/frame, @tinytars/vault and @pablotech/akesi all ship raw .ts with no compiled
// dist. `tsx --import` lifts the restriction but does so process-wide with `keepNames: true`,
// which injects an `__name(fn, "name")` helper call into every function it transforms —
// including first-party tests/e2e/*.ts closures that Playwright's `page.evaluate` serializes into
// the browser, where that helper doesn't exist (`ReferenceError: __name is not defined`). Scoping
// the transform to only these packages' node_modules trees avoids touching anything Playwright
// already handles correctly on its own.
import { transform } from "esbuild";

const SCOPED = ["/node_modules/@tinytars/frame/", "/node_modules/@tinytars/vault/", "/node_modules/@pablotech/akesi/"];

const inScoped = (url) => SCOPED.some((prefix) => url.includes(prefix));

// These packages' own internal relative imports (e.g. treatment-bucket.ts's `from "./dates"`) omit
// the .ts extension, relying on a bundler's automatic resolution — Node's own resolver has no such
// fallback for a relative specifier. Only tried within a SCOPED parent, and only as a fallback,
// since most specifiers here resolve fine on their own (a package's cross-import from outside a
// SCOPED tree, or one that already carries an extension).
export async function resolve(specifier, context, nextResolve) {
  if (context.parentURL && inScoped(context.parentURL) && specifier.startsWith(".") && !specifier.match(/\.[a-z]+$/i)) {
    try {
      return await nextResolve(`${specifier}.ts`, context);
    } catch {
      // Fall through — some scoped specifier really does resolve without an extension.
    }
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, next) {
  if (url.endsWith(".ts") && inScoped(url)) {
    const { source } = await next(url, { ...context, format: "module" });
    const code = typeof source === "string" ? source : Buffer.from(source).toString("utf8");
    const { code: transformed } = await transform(code, { loader: "ts", format: "esm", sourcefile: url });
    return { format: "module", source: transformed, shortCircuit: true };
  }
  return next(url, context);
}
