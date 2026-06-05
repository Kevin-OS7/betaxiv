// Integration tests — run inside a real VS Code Extension Host (Electron) via
// @vscode/test-cli. They exercise the host wiring: activation, command registration,
// and that "BetaXiv: Open" opens a webview tab for a PDF.

import * as assert from "assert";
import * as path from "path";
import * as vscode from "vscode";

const EXT_ID = "betaxiv.betaxiv";

suite("BetaXiv extension", () => {
  test("extension is present and activates", async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `extension ${EXT_ID} not found`);
    await ext!.activate();
    assert.equal(ext!.isActive, true);
  });

  test("commands are registered", async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes("betaxiv.open"), "betaxiv.open missing");
    assert.ok(
      commands.includes("betaxiv.installSkill"),
      "betaxiv.installSkill missing"
    );
  });

  test("opening a PDF creates a BetaXiv webview tab", async () => {
    // The workspace root is the repo (opened by .vscode-test.mjs); use the sample PDF.
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, "no workspace folder");
    const pdfUri = vscode.Uri.joinPath(folder.uri, "papers", "sample.pdf");

    await vscode.commands.executeCommand("betaxiv.open", pdfUri);

    // Give the webview panel a moment to register as a tab.
    await new Promise((r) => setTimeout(r, 500));

    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs);
    const hasReader = tabs.some((t) => t.label.startsWith("BetaXiv: sample"));
    assert.ok(hasReader, `no BetaXiv tab found; tabs: ${tabs.map((t) => t.label).join(", ")}`);
  });

  test("installSkill copies both skills (SKILL.md + schema + crop_helper) into a fresh agent dir", async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, "no workspace folder");

    // Each install target expands to a path chain; record which segments already exist so
    // cleanup deletes ONLY what this test created (hermetic even if .agents/etc pre-exist).
    const chains = [".agents", ".claude", ".gemini"].map((top) => [
      vscode.Uri.joinPath(folder.uri, top),
      vscode.Uri.joinPath(folder.uri, top, "skills"),
      vscode.Uri.joinPath(folder.uri, top, "skills", "betaxiv-summarizer"),
      vscode.Uri.joinPath(folder.uri, top, "skills", "betaxiv-documenter"),
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
      await vscode.commands.executeCommand("betaxiv.installSkill");

      const agentSkills = vscode.Uri.joinPath(folder.uri, ".agents", "skills");
      // Each skill's body, its co-located contract schema, and the (load-bearing) figure helper
      // must land. Both betaxiv-summarizer and betaxiv-documenter are installed together.
      const summarizer = vscode.Uri.joinPath(agentSkills, "betaxiv-summarizer");
      await vscode.workspace.fs.stat(vscode.Uri.joinPath(summarizer, "SKILL.md"));
      await vscode.workspace.fs.stat(vscode.Uri.joinPath(summarizer, "summary.schema.v2.json"));
      await vscode.workspace.fs.stat(vscode.Uri.joinPath(summarizer, "crop_helper.py"));
      const documenter = vscode.Uri.joinPath(agentSkills, "betaxiv-documenter");
      await vscode.workspace.fs.stat(vscode.Uri.joinPath(documenter, "SKILL.md"));
      await vscode.workspace.fs.stat(vscode.Uri.joinPath(documenter, "document.schema.v1.json"));
      await vscode.workspace.fs.stat(vscode.Uri.joinPath(documenter, "crop_helper.py"));
      // Python build noise must NOT ship into users' workspaces.
      await assert.rejects(
        async () => vscode.workspace.fs.stat(vscode.Uri.joinPath(summarizer, "__pycache__")),
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
