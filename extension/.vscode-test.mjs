import { defineConfig } from "@vscode/test-cli";
import * as path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));

// Open the repo root as the workspace so tests can reach papers/sample.pdf.
const workspace = path.resolve(here, "..");

export default defineConfig({
  files: "out/test/integration/**/*.test.js",
  workspaceFolder: workspace,
  mocha: {
    ui: "tdd",
    timeout: 30000,
  },
});
