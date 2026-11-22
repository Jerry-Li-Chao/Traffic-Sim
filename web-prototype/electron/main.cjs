// Electron shell for the desktop build. Loads the Vite production bundle from dist/.
// Steam integration (achievements, cloud saves) is optional: it activates only when
// steamworks.js is installed and Steam is running with a valid app id.
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('node:path');

let steam = null;
function initSteam() {
  const appId = Number(process.env.FLOWLINE_STEAM_APP_ID || 0);
  if (!appId) return;
  try {
    // eslint-disable-next-line import/no-unresolved
    const steamworks = require('steamworks.js');
    steam = steamworks.init(appId);
  } catch (err) {
    console.warn('[steam] not available:', err && err.message);
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#5f6b4a',
    title: 'Flowline',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  // CI / smoke check: quit after the renderer reports it booted
  if (process.env.FLOWLINE_SMOKE) {
    win.webContents.on('did-finish-load', async () => {
      setTimeout(async () => {
        const ok = await win.webContents.executeJavaScript('!!window.game && !!document.querySelector("[data-testid=menu]") && (window.game.sim.curr?.time ?? 0) > 5 && window.game.sim.curr.vehicleCount > 0');
        console.log(ok ? 'FLOWLINE_SMOKE_OK' : 'FLOWLINE_SMOKE_FAIL');
        app.exit(ok ? 0 : 1);
      }, 2500);
    });
  }
  return win;
}

ipcMain.handle('steam:achievement', (_e, id) => {
  if (!steam) return false;
  try {
    return steam.achievement.activate(String(id));
  } catch {
    return false;
  }
});
ipcMain.handle('steam:available', () => !!steam);

app.whenReady().then(() => {
  initSteam();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
