// W13d — every R2 key is namespaced by a per-deployment store prefix so multiple app
// versions (the health-dashboard dev deploy, a future main prod deploy, any branch
// preview) can share one bucket without colliding. The prefix comes from the
// `STORE_PREFIX` Pages env var (committed per-branch in wrangler.jsonc `vars`).
//
// HARD RULE: throw on an unset/empty prefix rather than default to "" — an empty prefix
// would silently merge two deployments' keys (cross-deploy PHI collision). See 13-w13-data-store.md.

export interface StoreEnv {
  STORE_PREFIX?: string;
}

export function storeKey(env: StoreEnv, ...parts: string[]): string {
  const prefix = (env.STORE_PREFIX ?? "").trim();
  if (!prefix) {
    throw new Error("STORE_PREFIX is unset — refusing to build an unprefixed R2 key (cross-deploy collision risk)");
  }
  return [prefix, ...parts].join("/");
}
