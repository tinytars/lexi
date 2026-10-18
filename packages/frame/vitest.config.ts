import { defineConfig } from "vitest/config";

// Load CSS for real (vitest blanks it by default) so neutrality.test.ts can read the stylesheets.
export default defineConfig({ test: { css: { include: [/.+/] } } });
