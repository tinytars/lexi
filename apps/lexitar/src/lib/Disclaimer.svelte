<script lang="ts">
  import { MEDICAL_DISCLAIMER, PRIVACY_STATEMENT, LEGAL_BASE } from "./brand";
</script>

<section class="disclaimer" aria-label="Medical disclaimer and privacy">
  <div class="disclaimer-box">
    <p><strong>Medical Disclaimer:</strong> {MEDICAL_DISCLAIMER}</p>
  </div>
  <div class="disclaimer-box">
    <p>
      <strong>Privacy &amp; Data Security:</strong> {PRIVACY_STATEMENT}
      Read our full <a href={`${LEGAL_BASE}/privacy`} target="_blank" rel="noopener">Privacy Policy</a>
      and <a href={`${LEGAL_BASE}/terms`} target="_blank" rel="noopener">Terms of Service</a>.
    </p>
  </div>
</section>

<style>
  .disclaimer {
    max-width: var(--leaf-max);
    margin: 2rem auto 0;
    padding: 0 1.25rem;
    display: grid;
    gap: 0.75rem;
  }
  .disclaimer-box {
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--panel);
    padding: 0.75rem 1rem;
  }
  .disclaimer-box p {
    margin: 0;
    font-size: 0.8rem;
    line-height: 1.5;
    color: var(--muted);
  }
  .disclaimer-box a {
    color: var(--accent);
  }
</style>
