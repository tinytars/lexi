import { describe, it, expect } from "vitest";
import { RESUME_MARKER } from "@tinytars/frame/roster-session.svelte";
import { bootFromLocation } from "../../src/lib/boot-location";

const empty = { getItem: () => null };
const resumable = { getItem: (k: string) => (k === RESUME_MARKER ? "key" : null) };
const boot = (href: string, storage: Pick<Storage, "getItem"> = empty) => bootFromLocation(new URL(href), storage);

describe("bootFromLocation", () => {
  it("does nothing for a plain first visit", () => {
    expect(boot("https://app.test/")).toEqual({ permalink: null, googleReturn: null, emailVerify: null, cleanUrl: null, resume: false });
  });

  it("seeds the permalink from the hash", () => {
    expect(boot("https://app.test/#alex/markers").permalink).toMatchObject({ client: "alex", section: "markers" });
  });

  it("resumes when the storage carries the resume marker", () => {
    expect(boot("https://app.test/", resumable).resume).toBe(true);
  });

  it("treats a Google return as the login and never also resumes", () => {
    const d = boot("https://app.test/?google=1#alex/markers", resumable);
    expect(d.googleReturn).toEqual({ error: null });
    expect(d.resume).toBe(false);
    expect(d.cleanUrl).toBe("https://app.test/#alex/markers");
  });

  it("carries the Google error code and strips every query param", () => {
    const d = boot("https://app.test/?google_error=state&email_verify=ok");
    expect(d.googleReturn).toEqual({ error: "state" });
    expect(d.emailVerify).toBe("ok");
    expect(d.cleanUrl).toBe("https://app.test/");
  });

  it("strips only email_verify on a verification return", () => {
    const d = boot("https://app.test/?email_verify=invalid&x=1");
    expect(d.emailVerify).toBe("invalid");
    expect(d.cleanUrl).toBe("https://app.test/?x=1");
    expect(d.googleReturn).toBeNull();
  });

  it("ignores an unrecognized email_verify value and leaves the URL alone", () => {
    const d = boot("https://app.test/?email_verify=maybe");
    expect(d.emailVerify).toBeNull();
    expect(d.cleanUrl).toBeNull();
  });
});
