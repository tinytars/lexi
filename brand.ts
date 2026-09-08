// Domain-neutral half of the brand split: the {path,label} -> absolute-link derivation, usable
// by any consuming app's own brand constants. The LexiTar-specific values (PRODUCT_NAME,
// MEDICAL_DISCLAIMER, ...) stay in packages/brand, which is not a dependency any other app takes.
export type LegalLink = { path: string; label: string };

export function deriveLegalLinks(base: string, paths: LegalLink[]): { href: string; label: string }[] {
  return paths.map((l) => ({ href: `${base}${l.path}`, label: l.label }));
}
