import { defineConfig, type Plugin } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { writeFile, mkdir, readFile, rename } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
// This file is loaded by Node directly (Vite 8 no longer esbuild-bundles the config first), and
// Node refuses to type-strip a .ts file under node_modules — @tinytars/vault ships raw .ts source
// with no compiled dist, so the npm specifier throws ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING
// here specifically. Everywhere else in the app (Vite's own esbuild pipeline, tsx-run scripts,
// wrangler's Functions bundler) resolves the real @tinytars/vault package fine; only this one
// config-time import needs the monorepo source directly.
import { decryptVault } from '../../packages/security/crypto'

// W47 — write-to-temp-then-rename so a save-vault write is never observably partial. A plain
// writeFile(path, data) opens the destination in truncate mode ('w') and THEN streams the
// content; if the process dies between the truncate and the flush (killed dev server, a crash,
// two concurrent writes racing), the file is left at 0 bytes — exactly the corruption seen twice
// on records/private/liz/vault.json with no reproducing command. rename() on the same filesystem
// is atomic on macOS/Linux: readers only ever see the old complete content or the new complete
// content, never a truncated in-between.
async function atomicWriteFile(path: string, data: Buffer | string): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

// Dev-only write endpoint for the W5 data-entry UI (the localSink in
// @tinytars/vault/vault-sink). POST /__save-vault?id=<id> with the re-encrypted HD1
// blob as the body → writes records/public/data-<id>.enc. Not part of the
// production build: the deployed static bundle has no write endpoint.
function saveVaultMiddleware(): Plugin {
  const publicDir = fileURLToPath(new URL('./records/public', import.meta.url));
  const privateDir = fileURLToPath(new URL('./records/private', import.meta.url));
  return {
    name: 'save-vault-dev',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__save-vault', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end('method not allowed'); return; }
        const id = new URL(req.url ?? '', 'http://localhost').searchParams.get('id') ?? '';
        if (!/^[a-z0-9-]+$/.test(id)) { res.statusCode = 400; res.end('bad id'); return; }
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c as Buffer));
        req.on('end', async () => {
          const body = Buffer.concat(chunks);
          if (body.length < 4 || body[0] !== 0x48 || body[1] !== 0x44 || body[2] !== 0x31) {
            res.statusCode = 400; res.end('not an HD1 blob'); return;
          }
          try {
            await atomicWriteFile(`${publicDir}/data-${id}.enc`, body);
            // W13b: keep the plaintext source of truth in sync so a dev web-edit doesn't
            // drift from the served .enc (the id is the passphrase). Best-effort.
            try {
              const vault = await decryptVault(new Uint8Array(body), id);
              await mkdir(`${privateDir}/${id}`, { recursive: true });
              await atomicWriteFile(`${privateDir}/${id}/vault.json`, JSON.stringify(vault, null, 2) + '\n');
            } catch { /* decrypt failed → leave plaintext as-is; the .enc still wrote */ }
            res.statusCode = 204; res.end();
          } catch (e) {
            res.statusCode = 500; res.end(`write failed: ${(e as Error).message}`);
          }
        });
      });
    },
  };
}

// W13e dev-only: serve raw originals for the Export tab's "Original records" download.
// Mirrors GET /api/raw/{id}/{file} (the Pages Function in prod) by reading from
// records/private/{id}/raw/. No bearer in dev (local plaintext); the browser still sends
// one. Never part of the production build.
function rawFileMiddleware(): Plugin {
  const privateDir = fileURLToPath(new URL('./records/private', import.meta.url));
  const TYPES: Record<string, string> = {
    pdf: 'application/pdf',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    xls: 'application/vnd.ms-excel',
    json: 'application/json',
  };
  return {
    name: 'raw-file-dev',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/api/raw/', async (req, res) => {
        // originalUrl is the full path (connect strips the mount prefix from req.url).
        const full = ((req as { originalUrl?: string }).originalUrl ?? req.url ?? '').split('?')[0];
        const m = /^\/api\/raw\/(.+)$/.exec(full);
        const segs = (m ? m[1] : '').split('/').map(decodeURIComponent);
        const [id, file] = segs;
        if (!id || !file || segs.length !== 2 || segs.some((s) => s === '' || s === '.' || s === '..')) {
          res.statusCode = 400; res.end('expected /api/raw/{id}/{file}'); return;
        }
        try {
          const bytes = await readFile(`${privateDir}/${id.toLowerCase()}/raw/${file}`);
          res.setHeader('content-type', TYPES[file.slice(file.lastIndexOf('.') + 1).toLowerCase()] ?? 'application/octet-stream');
          res.statusCode = 200; res.end(bytes);
        } catch {
          res.statusCode = 404; res.end('raw source not found');
        }
      });
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  // W13: the served, encrypted layer moved under the records/ umbrella. publicDir
  // contents still map to the dist root, so served URLs (/data-{id}.enc) are unchanged.
  publicDir: 'records/public',
  plugins: [svelte(), saveVaultMiddleware(), rawFileMiddleware()],
  resolve: {
    alias: {
      // Cross-app packages resolved to source so Vite transpiles the shared TS/CSS directly
      // (avoids the "TS in node_modules isn't transpiled" workspace pitfall).
      '@tars/brand': fileURLToPath(new URL('../../packages/brand/index.ts', import.meta.url)),
      '@tars/styles': fileURLToPath(new URL('../../packages/styles', import.meta.url)),
      // The more specific subpath alias MUST come before the bare package alias below — Vite's alias
      // matching is prefix-based and first-match-wins, so '@pablotech/neuro-pil' alone would otherwise
      // match '@pablotech/neuro-pil/hash-web' too and mis-resolve it to '<index.ts>/hash-web'.
      '@pablotech/neuro-pil/hash-web': fileURLToPath(new URL('../../brain/neuro-pil/hash-web.ts', import.meta.url)),
      '@pablotech/neuro-pil': fileURLToPath(new URL('../../brain/neuro-pil/index.ts', import.meta.url)),
      '@pablotech/akesi-pil/types': fileURLToPath(new URL('../../brain/akesi-pil/types.ts', import.meta.url)),
      '@pablotech/akesi-pil/treatment-normalize': fileURLToPath(new URL('../../brain/akesi-pil/treatment-normalize.ts', import.meta.url)),
      '@pablotech/akesi-pil/treatment-bucket': fileURLToPath(new URL('../../brain/akesi-pil/treatment-bucket.ts', import.meta.url)),
      '@pablotech/akesi-pil/treatment-product': fileURLToPath(new URL('../../brain/akesi-pil/treatment-product.ts', import.meta.url)),
      '@pablotech/akesi-pil/treatment-timing-rules': fileURLToPath(new URL('../../brain/akesi-pil/treatment-timing-rules.ts', import.meta.url)),
      '@pablotech/akesi-pil/marker-deltas': fileURLToPath(new URL('../../brain/akesi-pil/marker-deltas.ts', import.meta.url)),
      '@pablotech/akesi-pil/unit-systems': fileURLToPath(new URL('../../brain/akesi-pil/unit-systems.ts', import.meta.url)),
      '@pablotech/akesi-pil/dates': fileURLToPath(new URL('../../brain/akesi-pil/dates.ts', import.meta.url)),
      '@pablotech/akesi-pil/ranges': fileURLToPath(new URL('../../brain/akesi-pil/ranges.ts', import.meta.url)),
      '@pablotech/akesi-pil/ranges-prompt': fileURLToPath(new URL('../../brain/akesi-pil/ranges-prompt.ts', import.meta.url)),
      '@pablotech/akesi-pil/item-registry': fileURLToPath(new URL('../../brain/akesi-pil/item-registry.ts', import.meta.url)),
      '@pablotech/akesi-pil/report-title': fileURLToPath(new URL('../../brain/akesi-pil/report-title.ts', import.meta.url)),
      '@pablotech/akesi-pil/imaging-catalog': fileURLToPath(new URL('../../brain/akesi-pil/imaging-catalog.ts', import.meta.url)),
      '@pablotech/akesi-pil/system-groups': fileURLToPath(new URL('../../brain/akesi-pil/system-groups.ts', import.meta.url)),
      '@pablotech/akesi-pil/factors-edit': fileURLToPath(new URL('../../brain/akesi-pil/factors-edit.ts', import.meta.url)),
      '@pablotech/akesi-pil/report-extract': fileURLToPath(new URL('../../brain/akesi-pil/report-extract.ts', import.meta.url)),
      '@pablotech/akesi-pil/report-merge': fileURLToPath(new URL('../../brain/akesi-pil/report-merge.ts', import.meta.url)),
      '@pablotech/akesi-pil/document-model': fileURLToPath(new URL('../../brain/akesi-pil/document-model.ts', import.meta.url)),
      '@pablotech/akesi-pil/document-read': fileURLToPath(new URL('../../brain/akesi-pil/document-read.ts', import.meta.url)),
      '@pablotech/akesi-pil/ingest-core': fileURLToPath(new URL('../../brain/akesi-pil/ingest-core.ts', import.meta.url)),
      '@pablotech/akesi-pil/pdf-node': fileURLToPath(new URL('../../brain/akesi-pil/parsers-report.ts', import.meta.url)),
      '@pablotech/akesi-pil/marker-groups-prompt': fileURLToPath(new URL('../../brain/akesi-pil/marker-groups-prompt.ts', import.meta.url)),
      '@pablotech/akesi-pil/treatment-infer': fileURLToPath(new URL('../../brain/akesi-pil/treatment-infer.ts', import.meta.url)),
      '@pablotech/akesi-pil/finding-generate': fileURLToPath(new URL('../../brain/akesi-pil/finding-generate.ts', import.meta.url)),
      '@pablotech/akesi-pil/finding-assemble': fileURLToPath(new URL('../../brain/akesi-pil/finding-assemble.ts', import.meta.url)),
      '@pablotech/akesi-pil/finding-regroup': fileURLToPath(new URL('../../brain/akesi-pil/finding-regroup.ts', import.meta.url)),
      '@pablotech/akesi-pil/pinned-queries': fileURLToPath(new URL('../../brain/akesi-pil/pinned-queries.ts', import.meta.url)),
      '@pablotech/akesi-pil/section-labels': fileURLToPath(new URL('../../brain/akesi-pil/section-labels.ts', import.meta.url)),
      '@pablotech/akesi-pil': fileURLToPath(new URL('../../brain/akesi-pil/index.ts', import.meta.url)),
    },
  },
})
