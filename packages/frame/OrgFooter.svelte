<script lang="ts">
  import { deriveLegalLinks, type OrgIdentity } from "@tinytars/frame/brand";

  let { org }: { org: OrgIdentity } = $props();
  const links = $derived(deriveLegalLinks(org.legalBase, org.legalPaths));
  const year = new Date().getFullYear();
</script>

<footer class="frame-footer">
  <div class="frame-footer__row">
    <div>
      {org.status}
      <br />© {year} {org.name}
    </div>
    <nav class="frame-footer__links" aria-label="Legal">
      {#each links as link (link.href)}
        {#if org.legalBase}
          <a href={link.href} target="_blank" rel="noopener">{link.label}</a>
        {:else}
          <a href={link.href}>{link.label}</a>
        {/if}
      {/each}
    </nav>
  </div>
</footer>
