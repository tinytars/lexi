// The five ways a principal row can be coloured, named for the token pair each one uses and for
// nothing else. What a row MEANS — clinician, support agent, recovery key — is the host app's
// vocabulary and stays there; this file only knows that a row has a tone and a tone has two colours.
export type PrincipalTone = "accent" | "provider" | "owner" | "warn" | "muted";

/**
 * Foreground (text + border) and band (fill) for each tone, as the custom-property names declared in
 * theme.css. Every one already existed for the persona bubbles: a chip outside a bubble is the only
 * thing that is new, so this adds no token.
 */
export const TONE_VARS: Record<PrincipalTone, { fg: string; band: string }> = {
  accent: { fg: "--accent", band: "--band" },
  provider: { fg: "--p-provider", band: "--p-provider-band" },
  owner: { fg: "--p-owner", band: "--p-owner-band" },
  warn: { fg: "--warn", band: "--warn-band" },
  // No `--muted-band` exists, and inventing one would be a token for a single caller; a muted chip is
  // a chip that has stopped being coloured, which is what the neutral raised surface already says.
  muted: { fg: "--muted", band: "--surface-2" },
};

/** The tone's own colour, softened toward the ordinary border so a row is tinted and not outlined. */
export const toneBorder = (tone: PrincipalTone): string =>
  `color-mix(in srgb, var(${TONE_VARS[tone].fg}) 45%, var(--border))`;
