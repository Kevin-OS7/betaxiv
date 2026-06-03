import * as vscode from "vscode";

function nonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

/**
 * Build the strict, nonce-locked, CDN-free HTML shell for the webview.
 * All resources load from local `vscode-webview-resource:` URIs (offline; rule 1).
 */
export function getHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const n = nonce();
  const cssUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "media", "webview.css")
  );
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "media", "webview.js")
  );
  const cspSource = webview.cspSource;

  const csp = [
    `default-src 'none'`,
    `img-src ${cspSource} blob: data:`,
    `font-src ${cspSource}`,
    `style-src ${cspSource} 'nonce-${n}'`,
    `script-src 'nonce-${n}' ${cspSource}`,
    `worker-src ${cspSource} blob:`,
    `connect-src ${cspSource} blob: data:`,
  ].join("; ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${cssUri}" rel="stylesheet" nonce="${n}" />
  <title>Paper Reader</title>
</head>
<body>
  <div id="app">
    <section id="pdf-pane" aria-label="PDF">
      <div id="pdf-status" class="status">Loading PDF…</div>
      <div id="pdf-pages"></div>
    </section>
    <div id="zoom-toolbar" aria-label="Zoom controls" hidden>
      <button id="zoom-out" title="Zoom out (Ctrl/Cmd -)" aria-label="Zoom out">−</button>
      <span id="zoom-level" aria-live="polite">100%</span>
      <button id="zoom-in" title="Zoom in (Ctrl/Cmd +)" aria-label="Zoom in">+</button>
      <button id="zoom-reset" title="Fit to width (Ctrl/Cmd 0)" aria-label="Fit to width">Fit</button>
    </div>
    <div id="view-controls">
      <span id="summary-status" hidden></span>
      <button id="summary-toggle" aria-pressed="false" title="Show/hide summary">Summary</button>
    </div>
    <div id="splitter" role="separator" aria-orientation="vertical" tabindex="0"></div>
    <section id="summary-pane" aria-label="Summary">
      <div id="summary-root" class="status">Waiting for summary…</div>
    </section>
  </div>
  <script type="module" nonce="${n}" src="${scriptUri}"></script>
</body>
</html>`;
}
