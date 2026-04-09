'use strict';

const { app, BrowserWindow, Menu, shell, dialog, ipcMain } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

const PORT = process.env.UI_PORT || 3000;
let win = null;
let serverProcess = null;

// ── Start embedded Express server ─────────────────────────────────────────────

function startServer() {
  return new Promise((resolve, reject) => {
    const serverPath = path.join(__dirname, '..', 'server.js');

    serverProcess = spawn(process.execPath, [serverPath], {
      env: { ...process.env, UI_PORT: PORT, ELECTRON: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    serverProcess.stdout.on('data', d => {
      const msg = d.toString();
      process.stdout.write(msg);
      if (msg.includes('Archon')) resolve();
    });

    serverProcess.stderr.on('data', d => process.stderr.write(d.toString()));

    serverProcess.on('error', reject);
    serverProcess.on('exit', code => {
      if (code && code !== 0) console.error(`Server exited with code ${code}`);
    });

    // Fallback resolve: poll until server responds
    const poll = setInterval(() => {
      http.get(`http://localhost:${PORT}/api/docker/status`, () => {
        clearInterval(poll);
        resolve();
      }).on('error', () => {});
    }, 500);

    setTimeout(() => { clearInterval(poll); resolve(); }, 15000);
  });
}

// ── Create browser window ─────────────────────────────────────────────────────

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'Archon',
    icon: path.join(__dirname, 'icon.png'),
    backgroundColor: '#0d1117',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  });

  win.loadURL(`http://localhost:${PORT}`);

  win.once('ready-to-show', () => {
    win.show();
    win.focus();
  });

  win.webContents.on('did-fail-load', (_e, code, desc) => {
    console.error(`Page load failed: ${desc} (${code})`);
    setTimeout(() => win.loadURL(`http://localhost:${PORT}`), 1000);
  });

  // Open external links in the system browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(`http://localhost:${PORT}`)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  win.on('closed', () => { win = null; });
}

// ── Application menu ──────────────────────────────────────────────────────────

function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Project Folder…',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            const result = await dialog.showOpenDialog(win, {
              properties: ['openDirectory'],
              title: 'Select Project Folder',
            });
            if (!result.canceled && result.filePaths.length > 0) {
              win.webContents.send('open-project', result.filePaths[0]);
            }
          },
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'GitHub Repository',
          click: () => shell.openExternal('https://github.com/i84762/copilot-agent-docker'),
        },
        {
          label: 'Open in Browser',
          click: () => shell.openExternal(`http://localhost:${PORT}`),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── IPC handlers ──────────────────────────────────────────────────────────────

ipcMain.handle('select-directory', async () => {
  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory'],
    title: 'Select Folder',
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('select-file', async (_e, filters) => {
  const result = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: filters || [],
    title: 'Select File',
  });
  return result.canceled ? null : result.filePaths[0];
});

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  buildMenu();
  await startServer();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
});
