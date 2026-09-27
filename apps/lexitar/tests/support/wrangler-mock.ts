// scripts/access-log.ts reaches D1 only through `execFileSync("bash", [wrangler.sh, …, "--command", sql])`
// — no exported runner, no injectable seam. So the suites that pin its audit rows mock
// node:child_process itself (as passkey-function.test.ts mocks @simplewebauthn/server) and read the SQL
// back out of the call. That mock and the reading of it are shared here; `vi.mock` is file-scoped, so
// each suite still declares its own.
import type { Mock } from "vitest";

type Call = unknown[];

/** The `--command` argument, which is always last. */
export function sqlArg(call: Call): string {
  const args = call[1] as string[];
  return args[args.length - 1];
}

export function insertSqlFrom(mock: Mock<(...args: unknown[]) => string>): string | undefined {
  const call = mock.mock.calls.find((c) => sqlArg(c).startsWith("INSERT"));
  return call && sqlArg(call);
}

/** Answers the vault lookup with `rows` and every other statement with nothing. */
export function mockD1Lookup(mock: Mock<(...args: unknown[]) => string>, rows: Record<string, string>[]): void {
  mock.mockImplementation((...call: Call) =>
    JSON.stringify([{ results: sqlArg(call).startsWith("SELECT") ? rows : [] }]),
  );
}
