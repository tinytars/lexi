import { fileURLToPath } from "node:url";

// True only when `url`'s module is the process entry point, so a test can import a script without running it.
export const isMain = (url: string): boolean => !!process.argv[1] && fileURLToPath(url) === process.argv[1];
