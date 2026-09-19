import type { D1Database } from "../_lib/identity-types";
import { getAccount, markEmailChanged, setEmailConfirmed, updateAccountProfile } from "../_lib/identity-accounts";
import { requireSession } from "../_lib/session";
import { logRequest } from "../_lib/log";
import type { EmailEnv } from "../_lib/email";
import { sendVerificationEmail, sendEmailChangedNotice } from "../_lib/email";
import { json } from "../_lib/http";

// W44 P2 — session-gated account profile read/update.
interface Env extends EmailEnv {
  DB: D1Database;
}

interface Ctx {
  request: Request;
  env: Env;
  waitUntil?: (p: Promise<unknown>) => void;
}

const ROUTE = "/api/account";

function serialize(account: NonNullable<Awaited<ReturnType<typeof getAccount>>>) {
  return {
    id: account.id,
    email: account.email,
    emailConfirmed: account.emailConfirmed,
    displayName: account.displayName,
    lifecycleStage: account.lifecycleStage,
    providerKind: account.providerKind,
    unitSystem: account.unitSystem,
  };
}

export async function onRequestGet(context: Ctx): Promise<Response> {
  const { request, env } = context;
  const start = Date.now();
  const log = (status: number, errorCode?: string) =>
    logRequest({ route: ROUTE, status, latencyMs: Date.now() - start, errorCode });

  const session = await requireSession(request, env);
  if (session instanceof Response) {
    log(401, "unauthorized");
    return session;
  }

  const account = await getAccount(env.DB, session.accountId);
  if (!account) {
    log(404, "not_found");
    return json(404, { error: "account not found" });
  }

  log(200);
  return json(200, serialize(account));
}

export async function onRequestPatch(context: Ctx): Promise<Response> {
  const { request, env } = context;
  const start = Date.now();
  const log = (status: number, errorCode?: string) =>
    logRequest({ route: ROUTE, status, latencyMs: Date.now() - start, errorCode });

  const session = await requireSession(request, env);
  if (session instanceof Response) {
    log(401, "unauthorized");
    return session;
  }

  try {
    const body = (await request.json()) as Partial<{ email: string; displayName: string; unitSystem: "metric" | "imperial" | null }>;
    const prev = await getAccount(env.DB, session.accountId);
    const emailChanged = body.email !== undefined && body.email !== (prev?.email ?? null);

    await updateAccountProfile(env.DB, session.accountId, {
      email: body.email,
      displayName: body.displayName,
      unitSystem: body.unitSystem,
    });

    // W47 — a changed email is unverified again; reset the flag and (re)send a verification link.
    if (emailChanged && body.email) {
      await setEmailConfirmed(env.DB, session.accountId, false);
      await markEmailChanged(env.DB, session.accountId, new Date().toISOString());
      const origin = new URL(request.url).origin;
      const verify = sendVerificationEmail(env, { to: body.email, accountId: session.accountId, origin }).catch((e) =>
        console.log(`[email] email-change verification send failed: ${(e as Error).message}`),
      );
      if (context.waitUntil) context.waitUntil(verify);
      else await verify;

      // W73 — tell the address being REPLACED. It is the only address that can tell us the change was
      // not wanted, and until now it heard nothing: a stolen session cookie could repoint the mailbox
      // in silence, which is step one of turning a 30-day cookie into permanent access. The new
      // address gets the verification link above; this is the other half.
      if (prev?.email) {
        const notice = sendEmailChangedNotice(env, { to: prev.email, newEmail: body.email }).catch((e) =>
          console.log(`[email] email-change notice send failed: ${(e as Error).message}`),
        );
        if (context.waitUntil) context.waitUntil(notice);
        else await notice;
      }
    }

    const account = await getAccount(env.DB, session.accountId);
    if (!account) {
      log(404, "not_found");
      return json(404, { error: "account not found" });
    }

    log(200);
    return json(200, serialize(account));
  } catch {
    log(500, "update_failed");
    return json(500, { error: "update failed" });
  }
}
