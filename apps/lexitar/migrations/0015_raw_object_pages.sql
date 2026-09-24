-- Report corpus — how many pages each raw PDF has, so the corpus ceiling can be checked
-- without reading a single byte from R2.
--
-- WHY HERE AND NOT R2. `ObjectBucket` (functions/_lib/object-bucket.ts) has no metadata channel:
-- `list` returns keys and `put` takes only `onlyIf`. Widening that port to carry customMetadata
-- would be a Cloudflare-shaped feature in the one abstraction that exists to keep this app off
-- Cloudflare specifics, and it would change a two-host conformance suite. `raw_objects` already
-- holds exactly one row per raw key, written on the same request as the bytes and pruned on
-- delete, so the count rides along with the ownership record it belongs beside.
--
-- WHY THE BROWSER SUPPLIES IT. pdf.js does not run on Workers, so the Function that receives the
-- upload cannot count pages. The browser already has `doc.numPages` from opening the PDF to
-- render it, and passes it as `?pages=`.
--
-- Both columns are NULLABLE and stay that way: every object written before this migration has no
-- count, and a corpus refuses to assemble rather than guess. See scripts/raw-pages-backfill.ts.
ALTER TABLE raw_objects ADD COLUMN pages INTEGER;
ALTER TABLE raw_objects ADD COLUMN bytes INTEGER;
