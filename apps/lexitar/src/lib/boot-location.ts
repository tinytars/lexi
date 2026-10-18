import { parseHash, type Permalink } from "./permalink";
import { RESUME_MARKER } from "@tinytars/frame/roster-session.svelte";

export interface BootDecision {
  permalink: Permalink | null;
  googleReturn: { error: string | null } | null;
  emailVerify: "ok" | "invalid" | null;
  cleanUrl: string | null;
  resume: boolean;
}

export function bootFromLocation(url: URL, storage: Pick<Storage, "getItem">): BootDecision {
  const params = url.searchParams;
  const isGoogleReturn = params.has("google") || params.has("google_error");
  const ev = params.get("email_verify");
  const emailVerify = ev === "ok" || ev === "invalid" ? ev : null;
  return {
    permalink: parseHash(url.hash),
    googleReturn: isGoogleReturn ? { error: params.get("google_error") } : null,
    emailVerify,
    cleanUrl: isGoogleReturn ? withoutSearch(url) : emailVerify ? withoutParam(url, "email_verify") : null,
    resume: !isGoogleReturn && !!storage.getItem(RESUME_MARKER),
  };
}

function withoutSearch(url: URL): string {
  const clean = new URL(url);
  clean.search = "";
  return clean.toString();
}

function withoutParam(url: URL, name: string): string {
  const clean = new URL(url);
  clean.searchParams.delete(name);
  return clean.toString();
}
