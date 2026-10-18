// The shape of one item in a LeafActionMenu, as a plain .ts module.
//
// Same reason as sidebar-rows.ts and sidebar-labels.ts: a type exported from a .svelte file is
// resolvable only by svelte-check, so declaring it inside LeafActionMenu.svelte put every pure
// module that builds menus (leaf-actions.ts, and through it every Node-side importer) beyond the
// reach of a plain `tsc`. The component keeps the menu; the shape lives here.
export interface LeafMenuItem {
  // Defaults to `title ?? label` (a caller only needs to set this explicitly if two items in the
  // same menu would otherwise share both).
  key?: string;
  label: string;
  icon?: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  title?: string;
}
