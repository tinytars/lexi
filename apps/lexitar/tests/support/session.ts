import { signSession } from "../../functions/_lib/session";

export const SESSION_SECRET = "test-secret";

export async function cookieFor(accountId: string, secret = SESSION_SECRET): Promise<string> {
  return `hd_session=${await signSession({ SESSION_SECRET: secret }, accountId)}`;
}
