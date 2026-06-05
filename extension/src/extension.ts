// BetaXiv — extension host (Node world).
//
// Pure renderer + file watcher. It NEVER calls a model, touches OAuth/API keys, or
// launches an agent (AGENTS.md rules 1 & 2). It opens a 2-pane webview, streams the
// PDF to PDF.js, reads + validates the summary JSON, and live-reloads it on change.

import * as vscode from "vscode";
import { getHtml } from "./getHtml";
import { validateSummaryBytes } from "./validateSummary";
import { validateDocumentBytes } from "./validateDocument";
import type { HostMessage, Annotation, PaperDoc } from "./protocol";
import {
  mutateIndex,
  resolveContentId,
  repathEntries,
  relPath,
  setTitle,
} from "./contentIndex";

const SKILL_NAME = "betaxiv-summarizer";
const DOCS_SKILL_NAME = "betaxiv-documenter";
// Both bundled skills are installed together so the user's agent can summarize AND document.
const SKILL_NAMES = [SKILL_NAME, DOCS_SKILL_NAME];

// Agent Skills dirs we install into, relative to the workspace root. A single SKILL.md
// works across Claude Code / Codex / Gemini CLI via the .agents/skills alias hub.
const SKILL_TARGET_DIRS = [".agents/skills", ".claude/skills", ".gemini/skills"];

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("betaxiv.open", async (uriArg?: vscode.Uri) => {
      const pdfUri = await resolvePdfUri(uriArg);
      if (!pdfUri) {
        return;
      }
      await openReader(context, pdfUri);
    }),
    vscode.commands.registerCommand("betaxiv.installSkill", () =>
      installSkill(context)
    ),
    // Keep index.json's path->id map current when a PDF (or a folder of them) is renamed/moved
    // INSIDE the editor — just re-point the keys, no re-hash, and the summary/annotation files
    // (named by content id) stay put. Moves done outside the editor self-heal on next open.
    vscode.workspace.onDidRenameFiles((e) => void onDidRenameFiles(e))
  );
}

async function onDidRenameFiles(e: vscode.FileRenameEvent): Promise<void> {
  for (const { oldUri, newUri } of e.files) {
    // Relativize each side against its OWN root. Only a same-root rename/move re-points keys
    // here (no re-hash; the id-named data files stay put). A cross-root move can't be followed
    // by re-pointing — the .betaxiv data lives under the OLD root — so skip it; opening in the
    // new root will re-hash and correctly report "no summary there". (Same-root is the common
    // case: F2 rename, drag within the project.)
    const oldFolder = vscode.workspace.getWorkspaceFolder(oldUri);
    const newFolder = vscode.workspace.getWorkspaceFolder(newUri);
    if (!oldFolder || !newFolder || oldFolder.uri.toString() !== newFolder.uri.toString()) continue;
    const oldRel = relPath(oldFolder, oldUri);
    const newRel = relPath(newFolder, newUri);
    await mutateIndex(newFolder, (index) => repathEntries(index, oldRel, newRel));
  }
}

export function deactivate(): void {
  // Nothing global to tear down; per-panel resources are disposed via onDidDispose.
}

/** Resolve the PDF to open: command arg -> active tab -> open dialog. */
async function resolvePdfUri(uriArg?: vscode.Uri): Promise<vscode.Uri | undefined> {
  if (uriArg && uriArg.scheme === "file" && uriArg.fsPath.toLowerCase().endsWith(".pdf")) {
    return uriArg;
  }

  const activeInput = vscode.window.tabGroups.activeTabGroup.activeTab?.input as
    | { uri?: vscode.Uri }
    | undefined;
  if (activeInput?.uri && activeInput.uri.fsPath.toLowerCase().endsWith(".pdf")) {
    return activeInput.uri;
  }

  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: "Open in BetaXiv",
    filters: { PDF: ["pdf"] },
  });
  return picked?.[0];
}

function basenameNoExt(uri: vscode.Uri): string {
  const name = uri.path.split("/").pop() ?? "paper";
  return name.replace(/\.pdf$/i, "");
}

/**
 * One-time, lazy migration from the old filename-keyed layout to content-id keys. For a PDF
 * whose data still lives under `<basename>.*`, copy it to `<contentId>.*` and retire the
 * original into `.betaxiv/legacy/` (kept as a safety net rather than deleted). No-op once the
 * content-id file exists, so it runs at most once per paper and never clobbers newer data.
 *
 * Best-effort: a per-file failure is logged and skipped (the original is left in place) so a
 * migration hiccup never blocks opening the PDF.
 */
async function migrateLegacy(
  wsFolder: vscode.WorkspaceFolder,
  basename: string,
  contentId: string
): Promise<void> {
  if (basename === contentId) return; // already content-keyed (or degenerate fallback)
  const moves: [dir: string, suffix: string][] = [
    ["summaries", ".summary.json"],
    ["annotations", ".json"],
  ];
  for (const [dir, suffix] of moves) {
    try {
      const legacy = vscode.Uri.joinPath(wsFolder.uri, ".betaxiv", dir, `${basename}${suffix}`);
      const target = vscode.Uri.joinPath(wsFolder.uri, ".betaxiv", dir, `${contentId}${suffix}`);
      try {
        await vscode.workspace.fs.stat(target);
        continue; // content-id file already present — nothing to migrate
      } catch {
        // target missing → fall through and try to adopt a legacy file
      }
      try {
        await vscode.workspace.fs.stat(legacy);
      } catch {
        continue; // no legacy file either — fresh paper, nothing to do
      }
      await vscode.workspace.fs.copy(legacy, target, { overwrite: false });
      const backup = vscode.Uri.joinPath(wsFolder.uri, ".betaxiv", "legacy", dir, `${basename}${suffix}`);
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(backup, ".."));
      await vscode.workspace.fs.rename(legacy, backup, { overwrite: true });
    } catch (err) {
      console.warn(`[betaxiv] legacy ${dir} migration for "${basename}" failed; leaving it in place`, err);
    }
  }
}

async function openReader(context: vscode.ExtensionContext, pdfUri: vscode.Uri): Promise<void> {
  const basename = basenameNoExt(pdfUri);
  const workspaceFolder =
    vscode.workspace.getWorkspaceFolder(pdfUri) ?? vscode.workspace.workspaceFolders?.[0];

  // Resolve the PDF's content id — the key its summary/annotations are stored under, so they
  // survive a rename/move (the id is recomputed from bytes). index.json caches path->id. If we
  // can't read the PDF or there's no workspace, fall back to the old filename key so nothing
  // breaks. Keep the relative path in scope to upsert the title once we read a summary.
  let rel = "";
  let keyId = basename;
  if (workspaceFolder) {
    const resolved = await resolveContentId(workspaceFolder, pdfUri);
    if (resolved) {
      keyId = resolved.id;
      rel = resolved.rel;
      if (resolved.write) {
        const entry = resolved.write;
        await mutateIndex(workspaceFolder, (index) => {
          index.entries[rel] = entry;
          return true;
        });
      }
      // One-time, lazy, best-effort: adopt any summary/annotations left under the old filename key.
      await migrateLegacy(workspaceFolder, basename, keyId);
    }
  }

  // Per-panel disposables — torn down together when the panel closes (no leaks onto
  // the extension lifetime).
  const disposables: vscode.Disposable[] = [];

  const panel = vscode.window.createWebviewPanel(
    "betaxiv",
    `BetaXiv: ${basename}`,
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: localRoots(context.extensionUri, pdfUri),
    }
  );

  const summaryUri = workspaceFolder
    ? vscode.Uri.joinPath(
        workspaceFolder.uri,
        ".betaxiv",
        "summaries",
        `${keyId}.summary.json`
      )
    : undefined;
  const summaryRelPath = `.betaxiv/summaries/${keyId}.summary.json`;

  // AIDocs: a directory of agent-authored documents for this paper, keyed by content id like
  // the summary. The extension reads/validates/renders them and live-reloads on change — it
  // never writes or generates them (same boundary as the summary).
  const docsDirUri = workspaceFolder
    ? vscode.Uri.joinPath(workspaceFolder.uri, ".betaxiv", "docs", keyId)
    : undefined;
  const docsRelGlob = `.betaxiv/docs/${keyId}/*.doc.json`;

  // Highlights + notes the user creates in the webview. The webview is the source of truth
  // during a session; the host just loads this once on open and writes it back on each edit
  // (same file boundary as the summary — the webview never touches the filesystem).
  const annotationsUri = workspaceFolder
    ? vscode.Uri.joinPath(workspaceFolder.uri, ".betaxiv", "annotations", `${keyId}.json`)
    : undefined;

  const post = (msg: HostMessage) => panel.webview.postMessage(msg);

  const sendSummary = async () => {
    if (!summaryUri) {
      post({ type: "summary-missing", summaryRelPath, skillName: SKILL_NAME });
      return;
    }
    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(summaryUri);
    } catch {
      post({ type: "summary-missing", summaryRelPath, skillName: SKILL_NAME });
      return;
    }
    const result = validateSummaryBytes(bytes);
    if (result.valid && result.summary) {
      post({ type: "summary", summary: result.summary });
      // Keep index.json human-readable: record the paper's title against its path. Fresh
      // read-modify-write so we don't clobber entries written since this panel opened.
      if (workspaceFolder && rel) {
        const title = result.summary.paper.title;
        await mutateIndex(workspaceFolder, (index) => setTitle(index, rel, title));
      }
    } else {
      post({ type: "summary-invalid", summaryRelPath, errors: result.errors });
    }
  };

  const sendDocs = async () => {
    if (!docsDirUri) {
      post({ type: "docs", docs: [], invalid: [], docsSkillName: DOCS_SKILL_NAME });
      return;
    }
    let entries: [string, vscode.FileType][] = [];
    try {
      entries = await vscode.workspace.fs.readDirectory(docsDirUri);
    } catch {
      // Directory doesn't exist yet → no docs. The watcher picks up the first one written.
      post({ type: "docs", docs: [], invalid: [], docsSkillName: DOCS_SKILL_NAME });
      return;
    }
    const docs: PaperDoc[] = [];
    const invalid: { relPath: string; errors: string[] }[] = [];
    // Stable, predictable order in the dropdown regardless of filesystem listing order.
    const files = entries
      .filter(([name, type]) => type === vscode.FileType.File && name.endsWith(".doc.json"))
      .map(([name]) => name)
      .sort();
    for (const name of files) {
      const relPathStr = `.betaxiv/docs/${keyId}/${name}`;
      try {
        const bytes = await vscode.workspace.fs.readFile(
          vscode.Uri.joinPath(docsDirUri, name)
        );
        const result = validateDocumentBytes(bytes);
        if (result.valid && result.doc) docs.push(result.doc);
        else invalid.push({ relPath: relPathStr, errors: result.errors });
      } catch (err) {
        invalid.push({ relPath: relPathStr, errors: [`Could not read: ${(err as Error).message}`] });
      }
    }
    post({ type: "docs", docs, invalid, docsSkillName: DOCS_SKILL_NAME });
  };

  // Delete an AIDoc file on explicit user action. Resolves the target either by relPath (must be
  // inside this paper's docs dir and a .doc.json) or by matching a valid doc's content id-keyed
  // `doc.id`. Confirms first, then deletes to the trash (recoverable). The watcher re-sends docs.
  const deleteDoc = async (req: { docId?: string; relPath?: string; label?: string }) => {
    if (!workspaceFolder || !docsDirUri) return;
    let target: vscode.Uri | undefined;
    let label = req.label?.trim() || "this document";
    const expectedPrefix = `.betaxiv/docs/${keyId}/`;
    if (req.relPath) {
      if (!req.relPath.startsWith(expectedPrefix) || !req.relPath.endsWith(".doc.json")) return;
      target = vscode.Uri.joinPath(workspaceFolder.uri, req.relPath);
      label = req.label?.trim() || (req.relPath.split("/").pop() ?? label);
    } else if (req.docId) {
      try {
        const entries = await vscode.workspace.fs.readDirectory(docsDirUri);
        for (const [name, type] of entries) {
          if (type !== vscode.FileType.File || !name.endsWith(".doc.json")) continue;
          const uri = vscode.Uri.joinPath(docsDirUri, name);
          try {
            const result = validateDocumentBytes(await vscode.workspace.fs.readFile(uri));
            if (result.valid && result.doc?.doc.id === req.docId) {
              target = uri;
              label = req.label?.trim() || result.doc.doc.title || name;
              break;
            }
          } catch {
            /* skip unreadable file */
          }
        }
      } catch {
        return; // no docs dir
      }
    }
    if (!target) return;
    const choice = await vscode.window.showWarningMessage(
      `Delete AIDoc “${label}”?`,
      { modal: true, detail: "It's moved to the trash where supported, otherwise deleted permanently." },
      "Delete"
    );
    if (choice !== "Delete") return;
    try {
      // Prefer the trash (recoverable), but some providers (e.g. on WSL/Linux) don't support it
      // and throw — fall back to a permanent delete so the action still works.
      try {
        await vscode.workspace.fs.delete(target, { useTrash: true });
      } catch {
        await vscode.workspace.fs.delete(target, { useTrash: false });
      }
    } catch (err) {
      void vscode.window.showErrorMessage(`BetaXiv: could not delete the doc — ${(err as Error).message}`);
      return;
    }
    void sendDocs(); // refresh immediately (the watcher also fires)
  };

  // Delete this paper's summary file on explicit user action (confirm → trash, falling back to a
  // permanent delete). The summary watcher's onDidDelete re-renders the pane as "not summarized".
  const deleteSummary = async () => {
    if (!summaryUri) return;
    const choice = await vscode.window.showWarningMessage(
      `Delete the summary for “${basename}”?`,
      { modal: true, detail: "It's moved to the trash where supported, otherwise deleted permanently." },
      "Delete"
    );
    if (choice !== "Delete") return;
    try {
      try {
        await vscode.workspace.fs.delete(summaryUri, { useTrash: true });
      } catch {
        await vscode.workspace.fs.delete(summaryUri, { useTrash: false });
      }
    } catch (err) {
      void vscode.window.showErrorMessage(`BetaXiv: could not delete the summary — ${(err as Error).message}`);
      return;
    }
    post({ type: "summary-missing", summaryRelPath, skillName: SKILL_NAME }); // immediate; watcher also fires
  };

  const sendAnnotations = async () => {
    if (!annotationsUri) {
      post({ type: "annotations", annotations: [] });
      return;
    }
    let annotations: Annotation[] = [];
    try {
      const bytes = await vscode.workspace.fs.readFile(annotationsUri);
      const data = JSON.parse(new TextDecoder().decode(bytes));
      // Accept the wrapped `{ annotations: [...] }` form (what we write) or a bare array.
      const list = Array.isArray(data) ? data : data?.annotations;
      if (Array.isArray(list)) annotations = list;
    } catch {
      // No file yet, or malformed → start empty (the webview will create the file on first edit).
    }
    post({ type: "annotations", annotations });
  };

  const saveAnnotations = async (annotations: Annotation[]) => {
    if (!annotationsUri) return;
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(annotationsUri, ".."));
    const body = JSON.stringify({ annotations }, null, 2);
    await vscode.workspace.fs.writeFile(annotationsUri, new TextEncoder().encode(body));
  };

  // Wait for the webview's ready handshake before posting (avoids a race).
  disposables.push(
    panel.webview.onDidReceiveMessage((msg) => {
      if (msg?.type === "ready") {
        const vendor = (...p: string[]) =>
          panel.webview
            .asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "media", "vendor", "pdfjs", ...p))
            .toString();
        post({
          type: "bootstrap",
          pdfUri: panel.webview.asWebviewUri(pdfUri).toString(),
          pdfRelPath: rel, // workspace-relative PDF path for copy provenance ("" if no workspace)
          pdfjsLibUri: vendor("pdf.min.mjs"),
          pdfViewerLibUri: vendor("pdf_viewer.mjs"),
          pdfWorkerUri: vendor("pdf.worker.min.mjs"),
          // PDF.js fetches "<dir>/<name>" — directory URIs must end with a slash.
          cMapUri: vendor("cmaps") + "/",
          standardFontUri: vendor("standard_fonts") + "/",
        });
        void sendSummary();
        void sendDocs();
        void sendAnnotations();
      } else if (msg?.type === "annotations-save") {
        void saveAnnotations(Array.isArray(msg.annotations) ? msg.annotations : []);
      } else if (msg?.type === "doc-delete") {
        void deleteDoc({ docId: msg.docId, relPath: msg.relPath, label: msg.label });
      } else if (msg?.type === "summary-delete") {
        void deleteSummary();
      } else if (msg?.type === "error") {
        console.error("[betaxiv] webview error:", msg.message);
      }
    })
  );

  // Live-reload the summary on change/create/delete (FR-5).
  if (workspaceFolder) {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(workspaceFolder, summaryRelPath)
    );
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const onChange = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => void sendSummary(), 150);
    };
    watcher.onDidCreate(onChange);
    watcher.onDidChange(onChange);
    watcher.onDidDelete(() =>
      post({ type: "summary-missing", summaryRelPath, skillName: SKILL_NAME })
    );
    disposables.push(
      watcher,
      new vscode.Disposable(() => {
        if (debounce) clearTimeout(debounce);
      })
    );

    // Live-reload the AIDocs set on any add/change/delete in the docs dir. We re-read the
    // whole directory each time (it's small) so the dropdown always reflects what's on disk.
    const docsWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(workspaceFolder, docsRelGlob)
    );
    let docsDebounce: ReturnType<typeof setTimeout> | undefined;
    const onDocsChange = () => {
      if (docsDebounce) clearTimeout(docsDebounce);
      docsDebounce = setTimeout(() => void sendDocs(), 150);
    };
    docsWatcher.onDidCreate(onDocsChange);
    docsWatcher.onDidChange(onDocsChange);
    docsWatcher.onDidDelete(onDocsChange);
    disposables.push(
      docsWatcher,
      new vscode.Disposable(() => {
        if (docsDebounce) clearTimeout(docsDebounce);
      })
    );
  }

  panel.onDidDispose(() => {
    for (const d of disposables.splice(0)) {
      d.dispose();
    }
  });

  panel.webview.html = getHtml(panel.webview, context.extensionUri);
}

function localRoots(extensionUri: vscode.Uri, pdfUri: vscode.Uri): vscode.Uri[] {
  // The webview only needs its own assets and the PDF itself. The summary JSON is read
  // by the host (never the webview), so the workspace root is intentionally NOT granted
  // — keeps the webview's file reach minimal as defense-in-depth.
  return [
    vscode.Uri.joinPath(extensionUri, "media"),
    vscode.Uri.joinPath(pdfUri, ".."),
  ];
}

/**
 * Copy the bundled BetaXiv skills (betaxiv-summarizer + betaxiv-documenter) into the
 * workspace's agent skill dirs so the user's own agent can run them. This writes files only
 * — it never launches an agent (rule 2). The human triggers the agent themselves afterward.
 */
async function installSkill(context: vscode.ExtensionContext): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    void vscode.window.showErrorMessage(
      "BetaXiv: open a folder/workspace first to install the skills into it."
    );
    return;
  }

  // Verify every bundled skill is present before writing anything.
  const sources = new Map<string, vscode.Uri>();
  for (const name of SKILL_NAMES) {
    const source = vscode.Uri.joinPath(context.extensionUri, "assets", "skill", name);
    try {
      await vscode.workspace.fs.stat(source);
    } catch {
      void vscode.window.showErrorMessage(
        `BetaXiv: bundled skill assets for ${name} are missing from this build.`
      );
      return;
    }
    sources.set(name, source);
  }

  for (const dir of SKILL_TARGET_DIRS) {
    // Create the parent dir tree first — fs.copy does not reliably create missing
    // intermediates, and a fresh workspace has none of these dirs.
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(workspaceFolder.uri, dir));
    for (const [name, source] of sources) {
      const target = vscode.Uri.joinPath(workspaceFolder.uri, dir, name);
      await vscode.workspace.fs.copy(source, target, { overwrite: true });
    }
  }

  void vscode.window.showInformationMessage(
    `BetaXiv: installed the ${SKILL_NAMES.join(" + ")} skills into ${SKILL_TARGET_DIRS.join(", ")}. ` +
      `Run them with your own agent on a PDF in papers/.`
  );
}
