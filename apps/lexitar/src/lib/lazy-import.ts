// A lazy chunk that fails to load (a tab open across a deploy gets the SPA's index.html for the old
// hash) is caught by its call site and never reaches the uncaught-error listener, so it reports here.
// A no-op until the browser's error reporter registers — the Node CLI shares these call sites.

let onFailure: (err: unknown) => void = () => {};

export function onLazyImportFailure(report: (err: unknown) => void): void {
  onFailure = report;
}

export async function lazyImport<T>(load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (e) {
    onFailure(e);
    throw e;
  }
}
