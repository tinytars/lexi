<script lang="ts">
  // W25 — shown in body-system-grouped sections when the AI Finding hasn't run yet, so there is no
  // System Analysis (finding.disease) to group under. See system-groups.ts.
  import { PRODUCT_NAME } from "./brand";
</script>

<p class="pending-grouping">ⓘ Grouped by body system once the {PRODUCT_NAME} Translation runs.</p>

<style>
  .pending-grouping { margin: 0 0 1rem; font-size: 0.8rem; font-style: italic; color: var(--muted); }
</style>
