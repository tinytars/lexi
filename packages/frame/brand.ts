// The shape of an organization's brand, not its values: each host app declares its own
// OrgIdentity (see ARCHITECTURE.md, "Entity neutrality").
export type LegalLink = { path: string; label: string };

export type OrgIdentity = {
  name: string;
  status: string;
  /** Origin the legal pages live on; "" when they are served by the host app itself. */
  legalBase: string;
  legalPaths: LegalLink[];
};

export function deriveLegalLinks(base: string, paths: LegalLink[]): { href: string; label: string }[] {
  return paths.map((l) => ({ href: `${base}${l.path}`, label: l.label }));
}
