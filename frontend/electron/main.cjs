const { app, BrowserWindow, ipcMain, safeStorage, session, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { pathToFileURL } = require('url');
const { spawn, execFileSync } = require('child_process');

const BACKEND_HOST = '127.0.0.1';
const BACKEND_PORT = 8765;
const BACKEND_URL = `http://${BACKEND_HOST}:${BACKEND_PORT}`;
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';

let mainWindow = null;
let backendProcess = null;
let isQuitting = false;

function parseSafeExternalUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return null;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      return parsed.toString();
    }
    return null;
  } catch {
    return null;
  }
}

function getKeyFilePath() {
  return path.join(app.getPath('userData'), 'gemini_key.enc');
}

function readStoredApiKey() {
  const keyPath = getKeyFilePath();
  if (!fs.existsSync(keyPath)) {
    return null;
  }
  if (!safeStorage.isEncryptionAvailable()) {
    return null;
  }
  try {
    const encrypted = fs.readFileSync(keyPath);
    const decrypted = safeStorage.decryptString(encrypted).trim();
    return decrypted || null;
  } catch (err) {
    console.error('[Musak] Failed to decrypt stored Gemini API key:', err.message);
    return null;
  }
}

function notifyRendererApiKeySynced() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('musak:api-key-synced');
  }
}

function httpRequest(urlString, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlString);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: options.method || 'GET',
        headers: options.headers || {},
        timeout: options.timeout || 2000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          resolve({ statusCode: res.statusCode || 0, body: data });
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('Request timed out'));
    });
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

async function isUrlReachable(urlString) {
  try {
    const res = await httpRequest(urlString, { method: 'GET', timeout: 1200 });
    return res.statusCode >= 200 && res.statusCode < 500;
  } catch {
    return false;
  }
}

async function pushApiKeyToBackend(apiKey) {
  try {
    let ok = false;
    if (apiKey) {
      const payload = JSON.stringify({ api_key: apiKey });
      const res = await httpRequest(
        `${BACKEND_URL}/api/settings/api-key`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          },
          timeout: 3000,
        },
        payload
      );
      ok = res.statusCode >= 200 && res.statusCode < 300;
    } else {
      const res = await httpRequest(`${BACKEND_URL}/api/settings/api-key`, {
        method: 'DELETE',
        timeout: 3000,
      });
      ok = res.statusCode >= 200 && res.statusCode < 300;
    }

    if (ok) {
      notifyRendererApiKeySynced();
    }
    return ok;
  } catch (err) {
    console.warn('[Musak] Could not sync API key to backend yet:', err.message);
    return false;
  }
}

async function waitForBackendAndSyncKey(maxAttempts = 40) {
  for (let i = 0; i < maxAttempts; i++) {
    if (isQuitting) return false;
    const healthy = await isUrlReachable(`${BACKEND_URL}/api/health`);
    if (healthy) {
      const storedKey = readStoredApiKey();
      if (storedKey) {
        await pushApiKeyToBackend(storedKey);
      }
      return true;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function ensureBackendRunning() {
  const alreadyRunning = await isUrlReachable(`${BACKEND_URL}/api/health`);
  if (alreadyRunning) {
    const storedKey = readStoredApiKey();
    if (storedKey) {
      await pushApiKeyToBackend(storedKey);
    }
    return;
  }

  const backendDir = path.join(__dirname, '..', '..', 'backend');
  const pythonExe = path.join(backendDir, '.venv', 'Scripts', 'python.exe');
  const serverScript = path.join(backendDir, 'run_server.py');

  if (!fs.existsSync(pythonExe) || !fs.existsSync(serverScript)) {
    console.warn('[Musak] Local Python backend not found at:', pythonExe, serverScript);
    return;
  }

  try {
    backendProcess = spawn(pythonExe, [serverScript], {
      cwd: backendDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    backendProcess.stdout.on('data', (data) => {
      process.stdout.write(`[backend] ${data}`);
    });
    backendProcess.stderr.on('data', (data) => {
      process.stderr.write(`[backend] ${data}`);
    });
    backendProcess.on('exit', (code, signal) => {
      console.log(`[Musak] Backend process exited (code=${code}, signal=${signal})`);
      backendProcess = null;
    });

    waitForBackendAndSyncKey().catch(() => {});
  } catch (err) {
    console.error('[Musak] Failed to spawn local backend:', err);
  }
}

function stopBackendProcess() {
  if (!backendProcess || backendProcess.killed) return;
  const pid = backendProcess.pid;
  try {
    if (process.platform === 'win32' && pid) {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } else {
      backendProcess.kill('SIGTERM');
    }
  } catch (err) {
    console.error('[Musak] Error stopping backend:', err && err.message ? err.message : err);
  }
  backendProcess = null;
}

function configureYouTubeEmbedHeaders() {
  session.defaultSession.webRequest.onBeforeSendHeaders(
    {
      urls: [
        'https://www.youtube.com/embed/*',
        'https://www.youtube-nocookie.com/embed/*',
      ],
    },
    (details, callback) => {
      const headers = { ...details.requestHeaders };
      const existingReferer = headers.Referer || headers.referer || '';
      if (!/^https?:\/\//i.test(existingReferer)) {
        delete headers.referer;
        headers.Referer = 'https://musak.local/';
      }
      callback({ requestHeaders: headers });
    }
  );
}

function isTrustedAppOrigin(candidate, { useDevServer, allowedDistUrl, allowBareFileOrigin }) {
  if (typeof candidate !== 'string' || !candidate) return false;

  if (useDevServer) {
    try {
      const parsed = new URL(candidate);
      const trustedDevOrigins = new Set([
        'http://localhost:5173',
        'http://127.0.0.1:5173',
      ]);
      try {
        trustedDevOrigins.add(new URL(DEV_SERVER_URL).origin);
      } catch {
        // ignore invalid DEV_SERVER_URL
      }
      return trustedDevOrigins.has(parsed.origin);
    } catch {
      return false;
    }
  }

  // Packaged file:// mode
  if (candidate === 'file://') {
    return Boolean(allowBareFileOrigin);
  }
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'file:') {
      return false;
    }
    const normalizedUrl = parsed.href.split(/[?#]/)[0].toLowerCase();
    return normalizedUrl === allowedDistUrl;
  } catch {
    return false;
  }
}

function configureMediaPermissions({ useDevServer, allowedDistUrl }) {
  session.defaultSession.setPermissionCheckHandler(
    (_webContents, permission, requestingOrigin, details) => {
      if (permission === 'fullscreen') {
        return true;
      }
      if (permission !== 'media' && permission !== 'audioCapture') {
        return false;
      }
      if (!details || details.isMainFrame !== true) {
        return false;
      }
      if (details.mediaType === 'video') {
        return false;
      }
      const hasFullUrl = Boolean(details.requestingUrl);
      const candidate = details.requestingUrl || details.securityOrigin || requestingOrigin || '';
      return isTrustedAppOrigin(candidate, {
        useDevServer,
        allowedDistUrl,
        allowBareFileOrigin: !hasFullUrl,
      });
    }
  );

  session.defaultSession.setPermissionRequestHandler(
    (_webContents, permission, callback, details) => {
      if (permission === 'fullscreen') {
        callback(true);
        return;
      }
      if (permission !== 'media' && permission !== 'audioCapture') {
        callback(false);
        return;
      }
      if (!details || details.isMainFrame !== true) {
        callback(false);
        return;
      }
      // Strictly inspect requesting frame details (no webContents.getURL() fallback)
      const hasFullUrl = Boolean(details.requestingUrl);
      const requestingCandidate = details.requestingUrl || details.securityOrigin || '';
      const isTrusted = isTrustedAppOrigin(requestingCandidate, {
        useDevServer,
        allowedDistUrl,
        allowBareFileOrigin: !hasFullUrl,
      });
      const isAudioOnly =
        !Array.isArray(details.mediaTypes) ||
        (details.mediaTypes.length > 0 && details.mediaTypes.every((t) => t === 'audio'));
      callback(isTrusted && isAudioOnly);
    }
  );
}

function registerIpcHandlers() {
  ipcMain.handle('musak:get-backend-url', () => BACKEND_URL);

  ipcMain.handle('musak:get-key-status', async () => {
    const encryptionAvailable = safeStorage.isEncryptionAvailable();
    const storedKey = readStoredApiKey();
    return {
      configured: Boolean(storedKey),
      encryptionAvailable,
    };
  });

  ipcMain.handle('musak:save-api-key', async (_event, apiKey) => {
    const trimmed = typeof apiKey === 'string' ? apiKey.trim() : '';
    if (!trimmed) {
      return { ok: false, configured: false, error: 'API key cannot be empty.' };
    }
    if (!safeStorage.isEncryptionAvailable()) {
      return {
        ok: false,
        configured: false,
        error: 'OS credential encryption (Windows DPAPI) is unavailable.',
      };
    }

    try {
      const encrypted = safeStorage.encryptString(trimmed);
      fs.mkdirSync(path.dirname(getKeyFilePath()), { recursive: true });
      fs.writeFileSync(getKeyFilePath(), encrypted);
      const synced = await pushApiKeyToBackend(trimmed);
      return { ok: true, configured: true, synced };
    } catch (err) {
      return {
        ok: false,
        configured: false,
        error: err && err.message ? err.message : 'Failed to encrypt and save API key.',
      };
    }
  });

  ipcMain.handle('musak:clear-api-key', async () => {
    try {
      const keyPath = getKeyFilePath();
      if (fs.existsSync(keyPath)) {
        fs.unlinkSync(keyPath);
      }
      await pushApiKeyToBackend(null);
      return { ok: true, configured: false };
    } catch (err) {
      return {
        ok: false,
        configured: Boolean(readStoredApiKey()),
        error: err && err.message ? err.message : 'Failed to clear API key.',
      };
    }
  });

  ipcMain.handle('musak:open-external', async (_event, url) => {
    const safeUrl = parseSafeExternalUrl(url);
    if (safeUrl) {
      await shell.openExternal(safeUrl);
      return true;
    }
    return false;
  });
}

async function createMainWindow({ useDevServer, distHtml, allowedDistUrl }) {
  const allowedDevOrigin = new URL(DEV_SERVER_URL).origin;

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: 'Musak',
    backgroundColor: '#0b0c10',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once('ready-to-show', () => {
    if (mainWindow) {
      mainWindow.show();
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const safeUrl = parseSafeExternalUrl(url);
    if (safeUrl) {
      shell.openExternal(safeUrl);
    }
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    try {
      const parsed = new URL(targetUrl);
      if (useDevServer && parsed.origin === allowedDevOrigin) {
        return;
      }
      if (!useDevServer && parsed.protocol === 'file:') {
        const normalizedTarget = parsed.href.split(/[?#]/)[0].toLowerCase();
        if (normalizedTarget === allowedDistUrl) {
          return;
        }
      }
    } catch {
      // Block malformed navigation URLs
    }
    event.preventDefault();
  });

  if (useDevServer) {
    await mainWindow.loadURL(DEV_SERVER_URL);
  } else {
    await mainWindow.loadFile(distHtml);
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  const distHtml = path.join(__dirname, '..', 'dist', 'index.html');
  const allowedDistUrl = pathToFileURL(distHtml).toString().toLowerCase();
  const useDevServer =
    Boolean(process.env.VITE_DEV_SERVER_URL) || (await isUrlReachable(DEV_SERVER_URL));

  configureYouTubeEmbedHeaders();
  configureMediaPermissions({ useDevServer, allowedDistUrl });
  registerIpcHandlers();
  ensureBackendRunning().catch((err) => {
    console.error('[Musak] Backend bootstrap error:', err);
  });
  await createMainWindow({ useDevServer, distHtml, allowedDistUrl });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('before-quit', () => {
  isQuitting = true;
  stopBackendProcess();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
