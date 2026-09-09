<script module lang="ts">
  /**
   * The lock screen's own slice of a recovery controller: which ladder rung `codeInput` looks like,
   * and the one action (`recover`) the screen triggers. The full controller (issuing codes, the org
   * envelope, the Account modal's blocks) is caller-owned — this only needs enough to render the form.
   */
  export interface LoginRecovery {
    recoverMode: boolean;
    codeInput: string;
    newPassword: string;
    readonly kind: "code" | "grant";
    recover(): Promise<void>;
  }
</script>

<script lang="ts">
  let {
    productName,
    resuming = false,
    resumingLabel = "Restoring your session…",
    email = $bindable(""),
    password = $bindable(""),
    signupMode = $bindable(false),
    error = $bindable(null),
    unlocking = false,
    googleError = null,
    recovery,
    onLogin,
    onSignup,
    onGoogle,
    signInSubheading = "Sign in to your encrypted record.",
    signUpSubheading = "Create your account.",
    recoveryCodeSubheading = "Enter your recovery code — your own, or the one-time code your provider read you — and choose a new password.",
    recoveryNoteCode = "Your passkey and Google sign-in, if you use them, keep working — this replaces the password only.",
    recoveryNoteGrant = "Ask your provider to read you a code — it works once and expires in an hour. Your old password, passkey and Google sign-in will all stop working.",
  }: {
    productName: string;
    resuming?: boolean;
    resumingLabel?: string;
    email?: string;
    password?: string;
    signupMode?: boolean;
    error?: string | null;
    unlocking?: boolean;
    googleError?: string | null;
    recovery: LoginRecovery;
    onLogin: (method: "password" | "passkey") => void;
    onSignup: (method: "password" | "passkey") => void;
    onGoogle: () => void;
    signInSubheading?: string;
    signUpSubheading?: string;
    recoveryCodeSubheading?: string;
    recoveryNoteCode?: string;
    recoveryNoteGrant?: string;
  } = $props();
</script>

{#if resuming}
  <main class="lock">
    <h1>{productName}</h1>
    <p class="sub">{resumingLabel}</p>
  </main>
{:else}
  <main class="lock">
    <h1>{productName}</h1>
    {#if recovery.recoverMode}
      <p class="sub">{recoveryCodeSubheading}</p>
      <form onsubmit={(e) => { e.preventDefault(); recovery.recover(); }}>
        <input type="email" autocomplete="username" placeholder="email" aria-label="Email" bind:value={email} />
        <input type="text" placeholder="recovery code" aria-label="Recovery code" bind:value={recovery.codeInput} />
        <input type="password" autocomplete="new-password" placeholder="new password" aria-label="New password" bind:value={recovery.newPassword} />
        <button type="submit" disabled={unlocking || !email || !recovery.codeInput.trim() || !recovery.newPassword}>{unlocking ? "…" : "Recover"}</button>
      </form>
      {#if recovery.kind === "code"}
        <p class="lock-note">{recoveryNoteCode}</p>
      {:else}
        <p class="lock-note">{recoveryNoteGrant}</p>
      {/if}
      <div class="lock-alt">
        <button class="linkish" onclick={() => { recovery.recoverMode = false; error = null; }}>← Back to sign in</button>
      </div>
    {:else}
      <p class="sub">{signupMode ? signUpSubheading : signInSubheading}</p>
      <form onsubmit={(e) => { e.preventDefault(); signupMode ? onSignup("password") : onLogin("password"); }}>
        <!-- svelte-ignore a11y_autofocus -->
        <input type="email" autocomplete="username" placeholder="email" aria-label="Email" bind:value={email} autofocus />
        <input type="password" autocomplete={signupMode ? "new-password" : "current-password"} placeholder="password" aria-label="Password" bind:value={password} />
        <button type="submit" disabled={unlocking || !email || !password}>
          {unlocking ? "…" : signupMode ? "Create account" : "Sign in"}
        </button>
      </form>
      <button class="google-btn" onclick={onGoogle} disabled={unlocking}>Continue with Google</button>
      <div class="lock-alt">
        <button class="linkish" onclick={() => (signupMode ? onSignup("passkey") : onLogin("passkey"))} disabled={unlocking || !email}>
          {signupMode ? "Create with a passkey" : "Use a passkey"}
        </button>
        <button class="linkish" onclick={() => { signupMode = !signupMode; error = null; }}>
          {signupMode ? "Have an account? Sign in" : "New here? Create an account"}
        </button>
        {#if !signupMode}<button class="linkish" onclick={() => { recovery.recoverMode = true; error = null; }}>Forgot password?</button>{/if}
      </div>
    {/if}
    {#if error}<p class="err">{error}</p>{/if}
    {#if googleError}<p class="err">{googleError}</p>{/if}
  </main>
{/if}

<style>
  .lock { max-width: 360px; margin: 12rem auto; text-align: center; }
  .lock h1 { font-size: 1.5rem; margin: 0 0 0.5rem; }
  .lock .sub { color: var(--muted); margin: 0 0 2rem; }
  .lock form { display: flex; flex-direction: column; gap: 0.5rem; }
  .lock input { flex: 1; padding: 0.6rem 0.75rem; border: 1px solid var(--border); border-radius: 6px; font: inherit; }
  .lock form button { padding: 0.6rem 1rem; border: 1px solid var(--accent); background: var(--accent); color: white; border-radius: 6px; cursor: pointer; }
  .lock button:disabled { opacity: 0.5; cursor: default; }
  .google-btn { margin-top: 0.75rem; width: 100%; padding: 0.6rem 1rem; border: 1px solid var(--border, #d0d5dd); background: white; color: #3c4043; border-radius: 6px; cursor: pointer; font: inherit; font-weight: 500; }
  .google-btn:hover:not(:disabled) { background: #f8f9fa; }
  .google-btn:disabled { opacity: 0.5; cursor: default; }
  .lock-alt { display: flex; flex-direction: column; gap: 0.4rem; margin-top: 1rem; }
  .lock-note { margin: 0.75rem 0 0; font-size: 0.8rem; color: var(--muted, #667); max-width: 22rem; text-align: center; }
  .linkish { background: none; border: none; color: var(--accent); cursor: pointer; font: inherit; font-size: 0.85rem; padding: 0.2rem; }
  .linkish:disabled { color: var(--muted); cursor: default; }
  .err { color: var(--alert); margin-top: 1rem; }
</style>
