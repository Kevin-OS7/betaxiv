// Integration tests — run inside a real VS Code Extension Host (Electron) via
// @vscode/test-cli. They exercise the host wiring: activation, command registration,
// and that "Paper Reader: Open" opens a webview tab for a PDF.

import * as assert from "assert";
import * as path from "path";
import * as vscode from "vscode";

const EXT_ID = "betaxiv.paper-reader";

suite("Paper Reader extension", () => {
  test("extension is present and activates", async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `extension ${EXT_ID} not found`);
    await ext!.activate();
    assert.equal(ext!.isActive, true);
  });

  test("commands are registered", async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes("paperReader.open"), "paperReader.open missing");
    assert.ok(
      commands.includes("paperReader.installSkill"),
      "paperReader.installSkill missing"
    );
  });

  test("opening a PDF creates a Paper Reader webview tab", async () => {
    // The workspace root is the repo (opened by .vscode-test.mjs); use the sample PDF.
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, "no workspace folder");
    const pdfUri = vscode.Uri.joinPath(folder.uri, "papers", "sample.pdf");

    await vscode.commands.executeCommand("paperReader.open", pdfUri);

    // Give the webview panel a moment to register as a tab.
    await new Promise((r) => setTimeout(r, 500));

    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs);
    const hasReader = tabs.some((t) => t.label.startsWith("Paper Reader: sample"));
    assert.ok(hasReader, `no Paper Reader tab found; tabs: ${tabs.map((t) => t.label).join(", ")}`);
  });

  test("installSkill copies SKILL.md + schema + crop_helper into a fresh agent dir", async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, "no workspace folder");

    // Each install target expands to a path chain; record which segments already exist so
    // cleanup deletes ONLY what this test created (hermetic even if .agents/etc pre-exist).
    const chains = [".agents", ".claude", ".gemini"].map((top) => [
      vscode.Uri.joinPath(folder.uri, top),
      vscode.Uri.joinPath(folder.uri, top, "skills"),
      vscode.Uri.joinPath(folder.uri, top, "skills", "paper-summarizer"),
    ]);
    const exists = async (u: vscode.Uri) => {
      try {
        await vscode.workspace.fs.stat(u);
        return true;
      } catch {
        return false;
      }
    };
    const preExisting = new Set<string>();
    for (const chain of chains) {
      for (const u of chain) {
        if (await exists(u)) preExisting.add(u.toString());
      }
    }

    try {
      await vscode.commands.executeCommand("paperReader.installSkill");

      const skillDir = vscode.Uri.joinPath(folder.uri, ".agents", "skills", "paper-summarizer");
      // The skill body, its co-located schema, and the (load-bearing) figure helper must land.
      await vscode.workspace.fs.stat(vscode.Uri.joinPath(skillDir, "SKILL.md"));
      await vscode.workspace.fs.stat(vscode.Uri.joinPath(skillDir, "summary.schema.v2.json"));
      await vscode.workspace.fs.stat(vscode.Uri.joinPath(skillDir, "crop_helper.py"));
      // Python build noise must NOT ship into users' workspaces.
      await assert.rejects(
        async () => vscode.workspace.fs.stat(vscode.Uri.joinPath(skillDir, "__pycache__")),
        "__pycache__ should be filtered out of the vendored skill"
      );
    } finally {
      // Delete deepest-first; skip anything that pre-existed (don't clobber a real install).
      for (const chain of chains) {
        for (const u of [...chain].reverse()) {
          if (preExisting.has(u.toString())) continue;
          try {
            await vscode.workspace.fs.delete(u, { recursive: true, useTrash: false });
          } catch {
            /* best-effort cleanup */
          }
        }
      }
    }
  });
});

// Keep the import used so the bundler/types don't prune it.
void path;
