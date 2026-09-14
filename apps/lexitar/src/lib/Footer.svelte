<script lang="ts">
  import { FOUNDATION_NAME, FOUNDATION_STATUS, LEGAL_LINKS } from "./brand";
  const year = new Date().getFullYear();
</script>

<footer class="tt-footer">
  <div class="tt-footer__row">
    <div>
      {FOUNDATION_STATUS}
      <br />© {year} {FOUNDATION_NAME}
    </div>
    <nav class="tt-footer__links" aria-label="Legal">
      {#each LEGAL_LINKS as link (link.href)}
        <a href={link.href} target="_blank" rel="noopener">{link.label}</a>
      {/each}
    </nav>
  </div>
</footer>

<style>
  .tt-footer {
    max-width: var(--leaf-max);
    margin: 1.25rem auto 2rem;
    padding: 0 1.25rem;
  }

  .tt-footer__row {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 0.5rem;
    color: var(--muted);
    font-size: 0.78rem;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--panel);
    padding: 0.75rem 1rem;
  }
</style>
