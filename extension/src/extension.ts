// Paper Reader — extension host (Node world).
//
// Pure renderer + file watcher. It NEVER calls a model, touches OAuth/API keys, or
// launches an agent (AGENTS.md rules 1 & 2). It opens a 2-pane webview, streams the
// PDF to PDF.js, reads + validates the summary JSON, and live-reloads it on change.

import * as vscode from "vscode";
import { getHtml } from "./getHtml";
import { validateSummaryBytes } from "./validateSummary";
import type { HostMessage } from "./protocol";

const SKILL_NAME = "paper-summarizer";

// Agent Skills dirs we install into, relative to the workspace root. A single SKILL.md
// works across Claude Code / Codex / Gemini CLI via the .agents/skills alias hub.
const SKILL_TARGET_DIRS = [".agents/skills", ".claude/skills", ".gemini/skills"];

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("paperReader.open", async (uriArg?: vscode.Uri) => {
      const pdfUri = await resolvePdfUri(uriArg);
      if (!pdfUri) {
        return;
      }
      openReader(context, pdfUri);
    }),
    vscode.commands.registerCommand("paperReader.installSkill", () =>
      installSkill(context)
    )
  );
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
    openLabel: "Open in Paper Reader",
    filters: { PDF: ["pdf"] },
  });
  return picked?.[0];
}

function basenameNoExt(uri: vscode.Uri): string {
  const name = uri.path.split("/").pop() ?? "paper";
  return name.replace(/\.pdf$/i, "");
}

function openReader(context: vscode.ExtensionContext, pdfUri: vscode.Uri): void {
  const basename = basenameNoExt(pdfUri);
  const workspaceFolder =
    vscode.workspace.getWorkspaceFolder(pdfUri) ?? vscode.workspace.workspaceFolders?.[0];

  // Per-panel disposables — torn down together when the panel closes (no leaks onto
  // the extension lifetime).
  const disposables: vscode.Disposable[] = [];

  const panel = vscode.window.createWebviewPanel(
    "paperReader",
    `Paper Reader: ${basename}`,
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
        ".paper-reader",
        "summaries",
        `${basename}.summary.json`
      )
    : undefined;
  const summaryRelPath = `.paper-reader/summaries/${basename}.summary.json`;

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
    } else {
      post({ type: "summary-invalid", summaryRelPath, errors: result.errors });
    }
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
          pdfjsLibUri: vendor("pdf.min.mjs"),
          pdfWorkerUri: vendor("pdf.worker.min.mjs"),
          // PDF.js fetches "<dir>/<name>" — directory URIs must end with a slash.
          cMapUri: vendor("cmaps") + "/",
          standardFontUri: vendor("standard_fonts") + "/",
        });
        void sendSummary();
      } else if (msg?.type === "error") {
        console.error("[paper-reader] webview error:", msg.message);
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
 * Copy the bundled paper-summarizer skill into the workspace's agent skill dirs so the
 * user's own agent can run it. This writes files only — it never launches an agent
 * (rule 2). The human triggers the agent themselves afterward.
 */
async function installSkill(context: vscode.ExtensionContext): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    void vscode.window.showErrorMessage(
      "Paper Reader: open a folder/workspace first to install the skill into it."
    );
    return;
  }

  const source = vscode.Uri.joinPath(
    context.extensionUri,
    "assets",
    "skill",
    SKILL_NAME
  );
  try {
    await vscode.workspace.fs.stat(source);
  } catch {
    void vscode.window.showErrorMessage(
      "Paper Reader: bundled skill assets are missing from this build."
    );
    return;
  }

  const written: string[] = [];
  for (const dir of SKILL_TARGET_DIRS) {
    // Create the parent dir tree first — fs.copy does not reliably create missing
    // intermediates, and a fresh workspace has none of these dirs.
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(workspaceFolder.uri, dir));
    const target = vscode.Uri.joinPath(workspaceFolder.uri, dir, SKILL_NAME);
    await vscode.workspace.fs.copy(source, target, { overwrite: true });
    written.push(`${dir}/${SKILL_NAME}`);
  }

  void vscode.window.showInformationMessage(
    `Paper Reader: installed the ${SKILL_NAME} skill into ${written.join(", ")}. ` +
      `Run it with your own agent on a PDF in papers/.`
  );
}
