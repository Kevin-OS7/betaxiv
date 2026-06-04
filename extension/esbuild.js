// Build script for the Paper Reader extension.
//
// Two physically separate bundles enforce the "two worlds" rule from AGENTS.md:
//   - host:    Node/CommonJS, loaded by VS Code. `vscode` is external (runtime-provided).
//   - webview: browser/ESM, runs inside the sandboxed webview. No Node, no `vscode`.
//
// It also copies the vendored PDF.js library + worker into media/vendor/pdfjs/ so the
// webview loads them from a local, CSP-pinned URI (offline; no CDN; Apache-2.0).

const esbuild = require("esbuild");
const fs = require("node:fs");
const path = require("node:path");

const watch = process.argv.includes("--watch");
const root = __dirname;

// --- Locate PDF.js artifacts to vendor -------------------------------------
function resolvePdfjs() {
  // Locate the package root via its package.json (always exported), then read the
  // build dir off the filesystem — avoids subpath `exports` restrictions.
  const pkgRoot = path.dirname(require.resolve("pdfjs-dist/package.json"));
  const candidates = [
    path.join(pkgRoot, "legacy", "build"),
    path.join(pkgRoot, "build"),
  ];
  for (const dir of candidates) {
    const lib = fs.existsSync(path.join(dir, "pdf.min.mjs")) ? "pdf.min.mjs" : "pdf.mjs";
    const worker = fs.existsSync(path.join(dir, "pdf.worker.min.mjs"))
      ? "pdf.worker.min.mjs"
      : "pdf.worker.mjs";
    if (fs.existsSync(path.join(dir, lib)) && fs.existsSync(path.join(dir, worker))) {
      return { dir, lib, worker };
    }
  }
  throw new Error("Could not locate pdfjs-dist build artifacts. Run `npm install`.");
}

function copyPdfjs() {
  const { dir, lib, worker } = resolvePdfjs();
  const pkgRoot = path.dirname(require.resolve("pdfjs-dist/package.json"));
  const outDir = path.join(root, "media", "vendor", "pdfjs");
  fs.mkdirSync(outDir, { recursive: true });
  // Always emit canonical names so the host/webview can reference them statically.
  fs.copyFileSync(path.join(dir, lib), path.join(outDir, "pdf.min.mjs"));
  fs.copyFileSync(path.join(dir, worker), path.join(outDir, "pdf.worker.min.mjs"));

  // Vendor standard (base-14) font data and CMaps so base-14 fonts and CJK encodings
  // render offline (no standardFontDataUrl/cMapUrl warnings, no network).
  for (const sub of ["standard_fonts", "cmaps"]) {
    const src = path.join(pkgRoot, sub);
    if (fs.existsSync(src)) {
      fs.cpSync(src, path.join(outDir, sub), { recursive: true });
    }
  }
  console.log(`[pdfjs] vendored ${lib} + ${worker} + standard_fonts + cmaps -> media/vendor/pdfjs/`);
}

// --- Build configs ----------------------------------------------------------
const hostConfig = {
  entryPoints: [path.join(root, "src", "extension.ts")],
  outfile: path.join(root, "dist", "extension.js"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["vscode"],
  sourcemap: true,
  minify: !watch,
  logLevel: "info",
};

const webviewConfig = {
  entryPoints: [path.join(root, "src", "webview", "webview.ts")],
  outfile: path.join(root, "media", "webview.js"),
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  sourcemap: true,
  minify: !watch,
  logLevel: "info",
};

// Vendor the canonical skill + schema (which live at the repo root, OUTSIDE this package)
// INTO the extension so they ship in the VSIX. Repo root stays the single source of truth.
function copyAssets() {
  const repoRoot = path.resolve(root, "..");
  const skillSrc = path.join(repoRoot, "skill", "paper-summarizer");
  const schemaFile = path.join(repoRoot, "schema", "summary.schema.v2.json");
  const exampleFile = path.join(repoRoot, "schema", "example.summary.json");

  const skillDst = path.join(root, "assets", "skill", "paper-summarizer");
  // Purge the dest first: cpSync(filter) only skips copying — it never deletes pre-existing
  // files, so a stale __pycache__/*.pyc from an earlier build would otherwise survive and ship
  // in the VSIX (built from the generated assets/**). Wipe, then re-vendor cleanly.
  fs.rmSync(skillDst, { recursive: true, force: true });
  fs.mkdirSync(skillDst, { recursive: true });
  // Vendor everything except Python build noise (so the VSIX / installed skill stays clean).
  fs.cpSync(skillSrc, skillDst, {
    recursive: true,
    filter: (src) => !/(^|[/\\])(__pycache__|.*\.pyc)$/.test(src),
  });
  // Co-locate the schema with the installed skill so it is self-contained in any workspace.
  fs.copyFileSync(schemaFile, path.join(skillDst, "summary.schema.v2.json"));

  const schemaDst = path.join(root, "assets", "schema");
  fs.mkdirSync(schemaDst, { recursive: true });
  fs.copyFileSync(schemaFile, path.join(schemaDst, "summary.schema.v2.json"));
  fs.copyFileSync(exampleFile, path.join(schemaDst, "example.summary.json"));

  console.log("[assets] vendored skill/paper-summarizer + schema -> assets/");
}

async function main() {
  copyPdfjs();
  copyAssets();
  if (watch) {
    const hostCtx = await esbuild.context(hostConfig);
    const webviewCtx = await esbuild.context(webviewConfig);
    await Promise.all([hostCtx.watch(), webviewCtx.watch()]);
    console.log("[esbuild] watching...");
  } else {
    await Promise.all([esbuild.build(hostConfig), esbuild.build(webviewConfig)]);
    console.log("[esbuild] build complete");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
