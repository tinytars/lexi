import { canaryFingerprint } from "./error-pipeline-check";

// The promotion gate looks the canary issue up by label, and the label is derived from the canary
// message rather than written down, so it has to be computed wherever it is needed.
console.log(`fp:${await canaryFingerprint()}`);
