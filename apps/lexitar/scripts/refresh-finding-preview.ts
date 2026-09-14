// Read-only preview for `ingest.ts --refresh-finding`: pulls the client's slice from R2 and prints
// planFindingRefresh's verdict, without calling Anthropic or writing anything back.
//
// W77 gave `--refresh-finding --dry-run` the same guarantee, so this is no longer the ONLY safe way
// to see "full core regen" coming before paying for it — but it is still the preferred one, and
// ops.yml routes the preview here. It pulls fresh from R2 first, so it plans against the vault the
// real run will actually read rather than whatever this checkout happens to hold.
//
//   npx tsx scripts/refresh-finding-preview.ts <client-id>

import "./load-creds";
import { pull as pullVault } from "./vault-sync";
import { loadClientVault } from "./vault-io";
import { planFindingRefresh } from "./factors";

const id = process.argv[2];
if (!id) throw new Error("usage: refresh-finding-preview.ts <client-id>");

await pullVault(id);
const client = (await loadClientVault(id)).clients[id];
if (!client?.finding) throw new Error(`${id}: no Finding yet — run --refresh-finding first.`);

const plan = planFindingRefresh(client, false);
process.stdout.write(`${id}: ${JSON.stringify(plan, null, 2)}\n`);
