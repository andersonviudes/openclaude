const vscode = require('vscode');
const crypto = require('crypto');

function launchOpenClaude() {
  const configured = vscode.workspace.getConfiguration('openclaude');
  const launchCommand = configured.get('launchCommand', 'openclaude');
  const terminalName = configured.get('terminalName', 'OpenClaude');

  const terminal = vscode.window.createTerminal({
    name: terminalName,
    env: {
      CLAUDE_CODE_USE_OPENAI: configured.get('useOpenAIShim', true) ? '1' : undefined,
    },
  });

  terminal.show(true);
  terminal.sendText(launchCommand, true);
}

class OpenClaudeControlCenterProvider {
  resolveWebviewView(webviewView) {
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (message) => {
      if (message?.type === 'launch') {
        launchOpenClaude();
        return;
      }

      if (message?.type === 'docs') {
        await vscode.env.openExternal(vscode.Uri.parse('https://github.com/devNull-bootloader/openclaude'));
        return;
      }

      if (message?.type === 'theme') {
        await vscode.commands.executeCommand('workbench.action.selectTheme');
      }
    });
  }

  getHtml(webview) {
    const nonce = crypto.randomBytes(16).toString('base64');
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      padding: 12px;
    }
    .card {
      border: 1px solid var(--vscode-editorWidget-border);
      border-radius: 10px;
      padding: 12px;
      background: color-mix(in srgb, var(--vscode-editor-background) 92%, #000 8%);
      display: grid;
      gap: 10px;
    }
    .title {
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.2px;
    }
    .sub {
      font-size: 12px;
      opacity: 0.85;
      line-height: 1.4;
    }
    button {
      border: 0;
      border-radius: 8px;
      padding: 8px 10px;
      cursor: pointer;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      text-align: left;
      font-size: 12px;
    }
    button.secondary {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }
    button:hover {
      filter: brightness(1.05);
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="title">OpenClaude Control Center</div>
    <div class="sub">Launch OpenClaude, jump to docs, and quickly tune the editor vibe.</div>
    <button id="launch">⚡ Launch OpenClaude</button>
    <button id="docs" class="secondary">📚 Open Repository</button>
    <button id="theme" class="secondary">🎨 Pick Theme</button>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById('launch').addEventListener('click', () => vscode.postMessage({ type: 'launch' }));
    document.getElementById('docs').addEventListener('click', () => vscode.postMessage({ type: 'docs' }));
    document.getElementById('theme').addEventListener('click', () => vscode.postMessage({ type: 'theme' }));
  </script>
</body>
</html>`;
  }
}

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  const startCommand = vscode.commands.registerCommand('openclaude.start', async () => {
    launchOpenClaude();
  });

  const openDocsCommand = vscode.commands.registerCommand('openclaude.openDocs', async () => {
    await vscode.env.openExternal(vscode.Uri.parse('https://github.com/devNull-bootloader/openclaude'));
  });

  const openUiCommand = vscode.commands.registerCommand('openclaude.openControlCenter', async () => {
    await vscode.commands.executeCommand('workbench.view.extension.openclaude');
  });

  const provider = new OpenClaudeControlCenterProvider();
  const providerDisposable = vscode.window.registerWebviewViewProvider('openclaude.controlCenter', provider);

  context.subscriptions.push(startCommand, openDocsCommand, openUiCommand, providerDisposable);
}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
};
