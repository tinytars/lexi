// Replicates what `npm ci` validates: build the tree purely from package-lock.json
// (loadVirtual) and report any dependency edge that is missing or version-invalid.
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = '/home/runner/work/plover-factory/plover-factory/caller';

const candidates = [
  '/usr/lib/node_modules/npm/node_modules/@npmcli/arborist',
  '/usr/local/lib/node_modules/npm/node_modules/@npmcli/arborist',
  '/opt/hostedtoolcache/node/22.23.2/x64/lib/node_modules/npm/node_modules/@npmcli/arborist',
];

let Arborist = null;
for (const c of candidates) {
  if (existsSync(c)) {
    const req = createRequire(path.join(c, 'index.js'));
    Arborist = req(c);
    console.log('using arborist at', c);
    break;
  }
}
if (!Arborist) {
  console.log('ARBORIST_NOT_FOUND');
  process.exit(2);
}

const arb = new Arborist({ path: ROOT });
const tree = await arb.loadVirtual();

const problems = [];
for (const node of tree.inventory.values()) {
  for (const edge of node.edgesOut.values()) {
    if (edge.missing || edge.invalid) {
      problems.push(
        `${edge.type} ${edge.name}@${edge.spec} from ${node.location || '<root>'} -> ${
          edge.missing ? 'MISSING' : 'INVALID (resolved ' + (edge.to && edge.to.version) + ')'
        }`,
      );
    }
  }
}

console.log('nodes in virtual tree:', tree.inventory.size);
if (problems.length === 0) {
  console.log('LOCK_OK: every dependency edge resolves from the lockfile alone');
} else {
  console.log('LOCK_PROBLEMS:', problems.length);
  for (const p of problems) console.log('  -', p);
}
