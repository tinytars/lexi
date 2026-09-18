import { defineConfig, type Plugin } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { writeFile, mkdir, readFile, rename } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

// W47 — write-to-temp-then-rename so a save-vault write is never observably partial. A plain
// writeFile(path, data) opens the destination in truncate mode ('w') and THEN streams the
// content; if the process dies between the truncate and the flush (killed dev server, a crash,
// two concurrent writes racing), the file is left at 0 bytes — exactly the corruption seen twice
// on records/private/blair/vault.json with no reproducing command. rename() on the same filesystem
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
            //
            // @tinytars/vault ships raw .ts with no compiled dist, and Node's native
            // type-stripping refuses to load a .ts file under node_modules — so this import
            // must stay dynamic and deferred to request time. A static top-level import of
            // the same specifier makes `vite build` itself fail (the config file is loaded
            // by the same Node loader), even though this whole branch is dev-only.
            try {
              const { decryptVault } = await import('@tinytars/vault/crypto');
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
  define: { 'import.meta.env.VITE_BUILD_SHA': JSON.stringify(process.env.CF_PAGES_COMMIT_SHA ?? '') },
})
