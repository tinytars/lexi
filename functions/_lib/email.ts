// W47 — outbound email via the Gmail API, sending as a tinytars.foundation Workspace mailbox.
// Auth is Google Workspace domain-wide delegation: a service account (managed under the org) mints a
// JWT that impersonates the sender mailbox (GMAIL_SENDER, e.g. noreply@tinytars.foundation) for the
// gmail.send scope. No per-user refresh token, no 7-day-testing expiry. When the SA secrets are absent
// (local dev / not yet provisioned) sendEmail no-ops and logs, so the flow is testable without a live
// send. This is the ONLY module that talks to Gmail.
import { signValue, verifyValue } from "./session";
import { toArrayBuffer } from "./bytes";

export interface EmailEnv {
  SESSION_SECRET: string;
  GMAIL_SA_CLIENT_EMAIL?: string; // service-account email (JWT iss)
  GMAIL_SA_PRIVATE_KEY?: string; // service-account PKCS8 PEM (may carry literal \n)
  GMAIL_SENDER?: string; // impersonated mailbox (JWT sub + envelope From), e.g. noreply@tinytars.foundation
  EMAIL_FROM?: string; // optional display From; defaults to "TinyTars <GMAIL_SENDER>"
}

const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.send";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const EMAIL_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days
const enc = new TextEncoder();

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToPkcs8Bytes(pem: string): Uint8Array {
  const b64 = pem.replace(/\\n/g, "\n").replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Domain-wide-delegation access token: sign a JWT with the SA key, sub=impersonated mailbox, and
// exchange it at Google's token endpoint (grant_type=jwt-bearer).
async function gmailAccessToken(env: EmailEnv): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = bytesToBase64Url(enc.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const claims = bytesToBase64Url(
    enc.encode(
      JSON.stringify({
        iss: env.GMAIL_SA_CLIENT_EMAIL,
        sub: env.GMAIL_SENDER,
        scope: GMAIL_SCOPE,
        aud: TOKEN_ENDPOINT,
        iat: now,
        exp: now + 3600,
      }),
    ),
  );
  const signingInput = `${header}.${claims}`;
  const key = await (globalThis.crypto as Crypto).subtle.importKey(
    "pkcs8",
    toArrayBuffer(pemToPkcs8Bytes(env.GMAIL_SA_PRIVATE_KEY ?? "")),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await (globalThis.crypto as Crypto).subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(signingInput)));
  const assertion = `${signingInput}.${bytesToBase64Url(sig)}`;

  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  if (!res.ok) throw new Error(`gmail token exchange failed: ${res.status}`);
  const body = (await res.json()) as { access_token?: string };
  if (!body.access_token) throw new Error("gmail token exchange: no access_token");
  return body.access_token;
}

// RFC-822 message. When `html` is present, send multipart/alternative (text + HTML) — a proper
// alternative part and real structure land in the inbox far more reliably than a bare-link text mail.
function buildRaw(from: string, to: string, subject: string, text: string, html?: string): string {
  const headers =
    `From: ${from}\r\n` +
    `To: ${to}\r\n` +
    `Subject: ${subject}\r\n` +
    `MIME-Version: 1.0\r\n`;
  if (!html) {
    return headers + `Content-Type: text/plain; charset="UTF-8"\r\n\r\n` + text;
  }
  const b = "lexitar_boundary_a1b2c3";
  return (
    headers +
    `Content-Type: multipart/alternative; boundary="${b}"\r\n\r\n` +
    `--${b}\r\nContent-Type: text/plain; charset="UTF-8"\r\n\r\n${text}\r\n\r\n` +
    `--${b}\r\nContent-Type: text/html; charset="UTF-8"\r\n\r\n${html}\r\n\r\n` +
    `--${b}--`
  );
}

export async function sendEmail(
  env: EmailEnv,
  msg: { to: string; subject: string; text: string; html?: string },
): Promise<{ sent: boolean }> {
  if (!env.GMAIL_SA_CLIENT_EMAIL || !env.GMAIL_SA_PRIVATE_KEY || !env.GMAIL_SENDER) {
    // Not provisioned (dev). Log (no recipient PII) so the flow is hand-verifiable without a real send.
    console.log(`[email] not sent — Gmail unconfigured: ${msg.subject}`);
    return { sent: false };
  }
  const accessToken = await gmailAccessToken(env);
  const from = env.EMAIL_FROM ?? `TinyTars <${env.GMAIL_SENDER}>`;
  const raw = buildRaw(from, msg.to, msg.subject, msg.text, msg.html);
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ raw: bytesToBase64Url(enc.encode(raw)) }),
  });
  if (!res.ok) throw new Error(`gmail send failed: ${res.status} ${await res.text().catch(() => "")}`);
  console.log(`[email] sent: ${msg.subject}`); // PHI/PII-free audit line
  return { sent: true };
}

// The verification link carries a signed, expiring, email-bound token (same HMAC scheme as the
// session cookie). Binding the email means a later email change auto-invalidates outstanding links.
interface EmailToken extends Record<string, unknown> {
  accountId: string;
  email: string;
  purpose: "email-confirm";
}

export function signEmailToken(env: EmailEnv, accountId: string, email: string): Promise<string> {
  return signValue(env.SESSION_SECRET, { accountId, email, purpose: "email-confirm" }, EMAIL_TOKEN_TTL_SECONDS);
}

export async function verifyEmailToken(env: EmailEnv, token: string | null): Promise<EmailToken | null> {
  const parsed = await verifyValue<EmailToken>(env.SESSION_SECRET, token);
  if (!parsed || parsed.purpose !== "email-confirm" || typeof parsed.accountId !== "string" || typeof parsed.email !== "string") {
    return null;
  }
  return parsed;
}

// Sign a link and send it. Fire-and-forget from the caller (never block signup on delivery).
export async function sendVerificationEmail(
  env: EmailEnv,
  opts: { to: string; accountId: string; origin: string },
): Promise<{ sent: boolean }> {
  const token = await signEmailToken(env, opts.accountId, opts.to);
  const link = `${opts.origin}/api/auth/email/confirm?token=${encodeURIComponent(token)}`;
  const text =
    `Confirm your email address to finish setting up your account.\r\n\r\n` +
    `${link}\r\n\r\n` +
    `This link expires in 7 days. If you didn't create this account, you can ignore this email.`;
  const html =
    `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;color:#111;line-height:1.5">` +
    `<h2 style="font-size:18px;margin:0 0 12px">Confirm your email address</h2>` +
    `<p style="margin:0 0 20px;color:#444">Finish setting up your account by confirming this email address.</p>` +
    `<p style="margin:0 0 24px"><a href="${link}" style="display:inline-block;background:#2b6aa8;color:#fff;text-decoration:none;padding:10px 20px;border-radius:6px;font-weight:600">Confirm email</a></p>` +
    `<p style="margin:0 0 8px;font-size:13px;color:#667">Or paste this link into your browser:</p>` +
    `<p style="margin:0 0 24px;font-size:13px;word-break:break-all"><a href="${link}" style="color:#2b6aa8">${link}</a></p>` +
    `<p style="margin:0;font-size:12px;color:#889">This link expires in 7 days. If you didn't create this account, you can ignore this email.</p>` +
    `</div>`;
  return sendEmail(env, { to: opts.to, subject: "Confirm your email address", text, html });
}

// ── W73 security notices ─────────────────────────────────────────────────────
// These are NOTIFICATIONS, not authorization. Nothing here carries a link that grants anything, and
// nothing here carries key material — see RECOVERY.md I2. Their whole job is to make a silent takeover
// impossible: every one of them tells someone that something changed on their account, at the address
// that would otherwise never hear about it.

const noticeHtml = (heading: string, body: string, footer: string): string =>
  `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;color:#111;line-height:1.5">` +
  `<h2 style="font-size:18px;margin:0 0 12px">${heading}</h2>` +
  `<p style="margin:0 0 20px;color:#444">${body}</p>` +
  `<p style="margin:0;font-size:12px;color:#889">${footer}</p>` +
  `</div>`;

/**
 * Sent to the address being REPLACED, which is the only address that can tell us the change was not
 * wanted. The new address already gets a verification link; without this one, a stolen session cookie
 * changes the email and the real owner learns nothing — the first step of a silent, permanent takeover.
 */
export async function sendEmailChangedNotice(
  env: EmailEnv,
  opts: { to: string; newEmail: string },
): Promise<{ sent: boolean }> {
  // The new address is shown so the owner can see WHERE their account went. It is their own account and
  // their own change in the ordinary case; in the attack case, knowing the destination is the single
  // most useful thing we can give them.
  const text =
    `The email address on your account was changed to ${opts.newEmail}.\r\n\r\n` +
    `If you made this change, nothing more is needed.\r\n\r\n` +
    `If you did not, someone else may have access to your account. Contact your provider immediately — ` +
    `this address will no longer receive account messages.`;
  return sendEmail(env, {
    to: opts.to,
    subject: "The email address on your account was changed",
    text,
    html: noticeHtml(
      "Your account email was changed",
      `The email address on your account was changed to <strong>${opts.newEmail}</strong>. If you made this change, nothing more is needed.`,
      "If you did not make this change, someone else may have access to your account. Contact your provider immediately — this address will no longer receive account messages.",
    ),
  });
}

/**
 * Sent when a login method is added. Adding one is how a stolen cookie becomes permanent access — the
 * new credential outlives the cookie — so the owner is told even though they are usually the one who
 * did it.
 */
export async function sendMethodAddedNotice(
  env: EmailEnv,
  opts: { to: string; method: string },
): Promise<{ sent: boolean }> {
  const text =
    `A new sign-in method (${opts.method}) was added to your account.\r\n\r\n` +
    `If this was you, nothing more is needed.\r\n\r\n` +
    `If it was not, remove it in Account settings and change your password.`;
  return sendEmail(env, {
    to: opts.to,
    subject: `A new sign-in method was added to your account`,
    text,
    html: noticeHtml(
      "A new sign-in method was added",
      `A new sign-in method (<strong>${opts.method}</strong>) was added to your account. If this was you, nothing more is needed.`,
      "If it was not, remove it in Account settings and change your password.",
    ),
  });
}
