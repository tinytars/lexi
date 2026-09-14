import { describe, it, expect, vi } from "vitest";
import { claimDictation, releaseDictation } from "@tinytars/frame/dictate-registry";

describe("dictate-registry", () => {
  it("claiming while another session is active stops the previous one", () => {
    const stopA = vi.fn();
    const stopB = vi.fn();
    claimDictation(stopA);
    claimDictation(stopB);
    expect(stopA).toHaveBeenCalledOnce();
    expect(stopB).not.toHaveBeenCalled();
  });

  it("releasing the active session clears it, so a later claim doesn't call it", () => {
    const stopA = vi.fn();
    claimDictation(stopA);
    releaseDictation(stopA);
    const stopB = vi.fn();
    claimDictation(stopB);
    expect(stopA).not.toHaveBeenCalled();
  });

  it("releasing a stale (already-superseded) stop is a no-op", () => {
    const stopA = vi.fn();
    const stopB = vi.fn();
    claimDictation(stopA);
    claimDictation(stopB);
    releaseDictation(stopA);
    releaseDictation(stopB);
    const stopC = vi.fn();
    claimDictation(stopC);
    expect(stopB).not.toHaveBeenCalled();
  });
});
