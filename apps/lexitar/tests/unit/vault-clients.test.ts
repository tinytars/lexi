import { describe, it, expect } from "vitest";
import type { Client, Vault } from "../../src/lib/types";
import { withClient } from "../../src/lib/vault-clients";

const client = (displayName: string): Client => ({ displayName, dob: "1980-01-01", gender: "female", watchlist: [], results: [] });

describe("withClient", () => {
  it("replaces the named client and keeps every other one", () => {
    const alex = client("Alex");
    const vault: Vault = { clients: { alex, sam: client("Sam") } };
    const renamed = client("Sam R.");
    const next = withClient(vault, "sam", renamed);
    expect(next.clients).toEqual({ alex, sam: renamed });
    expect(next.clients.alex).toBe(alex);
  });

  it("adds the client when the id is new", () => {
    const next = withClient({ clients: {} }, "alex", client("Alex"));
    expect(Object.keys(next.clients)).toEqual(["alex"]);
  });

  it("returns a new vault without mutating the input", () => {
    const sam = client("Sam");
    const vault: Vault = { clients: { sam } };
    const next = withClient(vault, "sam", client("Other"));
    expect(next).not.toBe(vault);
    expect(next.clients).not.toBe(vault.clients);
    expect(vault.clients.sam).toBe(sam);
  });
});
