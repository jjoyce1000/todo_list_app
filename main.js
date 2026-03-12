const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1000,
    height: 750,
    minWidth: 600,
    minHeight: 400,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false,
      preload: path.join(__dirname, 'preload.js')
    },
  });
  mainWindow.loadFile('index.html');

  mainWindow.on('closed', () => {
    app.quit();
  });
}

ipcMain.handle('save-csv', (event, csvText, filename) => {
  const filePath = path.join(__dirname, (filename || 'tasks') + '.csv');
  fs.writeFileSync(filePath, csvText, 'utf8');
  return filePath;
});

ipcMain.handle('show-import-dialog', async () => {
  const win = BrowserWindow.getFocusedWindow();
  const result = await dialog.showOpenDialog(win || null, {
    title: 'Import CSV',
    filters: [{ name: 'CSV', extensions: ['csv'] }],
    properties: ['openFile']
  });
  if (result.canceled || !result.filePaths?.length) return null;
  const filePath = result.filePaths[0];
  const ext = path.extname(filePath).toLowerCase().replace('.', '');
  return { path: filePath, name: path.basename(filePath), ext };
});

ipcMain.handle('show-import-pdf-dialog', async () => {
  const win = BrowserWindow.getFocusedWindow();
  const result = await dialog.showOpenDialog(win || null, {
    title: 'Import PDF (Syllabus / Schedule)',
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
    properties: ['openFile']
  });
  if (result.canceled || !result.filePaths?.length) return null;
  return result.filePaths[0];
});

ipcMain.handle('run-pdf-to-csv', async (event, pdfPath) => {
  const scriptPath = path.join(__dirname, 'pdf_to_csv.py');
  const tempDir = os.tmpdir();
  const tempCsv = path.join(tempDir, `tasktastic_import_${Date.now()}.csv`);
  const py = process.platform === 'win32' ? 'python' : 'python3';
  const child = spawnSync(py, [scriptPath, pdfPath, tempCsv], {
    encoding: 'utf8',
    cwd: __dirname
  });
  if (child.error) throw new Error(`Failed to run PDF converter: ${child.error.message}`);
  if (child.status !== 0) {
    const err = (child.stderr || child.stdout || '').trim() || 'Unknown error';
    throw new Error(`PDF conversion failed: ${err}`);
  }
  try {
    return fs.readFileSync(tempCsv, 'utf8');
  } finally {
    try { fs.unlinkSync(tempCsv); } catch (_) {}
  }
});

ipcMain.handle('read-file-as-text', (event, filePath) => {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
});

ipcMain.handle('read-file-as-buffer', (event, filePath) => {
  try {
    const buf = fs.readFileSync(filePath);
    return buf.toString('base64');
  } catch {
    return null;
  }
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  app.quit();
});
