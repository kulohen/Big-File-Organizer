const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;

// 部分环境 GPU 进程不可用，禁用硬件加速避免启动崩溃
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 740,
    minWidth: 780,
    minHeight: 620,
    title: '大文件管家',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    autoHideMenuBar: true,
    backgroundColor: '#f3f7f5',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/* ---------------- 工具函数 ---------------- */

// 解析 "200M"、"1000M"、"1.5G"、"500K"、"2048"（不带单位默认 M）
function parseSize(input) {
  const m = String(input || '').trim().match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB|K|M|G|T)?$/i);
  if (!m) return null;
  const num = parseFloat(m[1]);
  if (!Number.isFinite(num) || num < 0) return null;
  const unit = (m[2] || 'M').toUpperCase();
  const mult = {
    B: 1,
    K: 1024, KB: 1024,
    M: 1024 ** 2, MB: 1024 ** 2,
    G: 1024 ** 3, GB: 1024 ** 3,
    T: 1024 ** 4, TB: 1024 ** 4,
  }[unit];
  return Math.floor(num * mult);
}

function formatSize(bytes) {
  if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(2) + ' GB';
  if (bytes >= 1024 ** 2) return (bytes / 1024 ** 2).toFixed(2) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(2) + ' KB';
  return bytes + ' B';
}

async function validateInputs(folder, sizeText) {
  const p = String(folder || '').trim().replace(/^"+|"+$/g, '');
  if (!p) return { error: '请先选择或输入目标文件夹路径' };
  let st;
  try {
    st = await fsp.stat(p);
  } catch {
    return { error: '文件夹不存在或无法访问：' + p };
  }
  if (!st.isDirectory()) return { error: '该路径不是文件夹：' + p };
  const threshold = parseSize(sizeText);
  if (threshold == null) {
    return { error: `无法识别的大小写法：「${sizeText}」，示例：200M、1000M、1.5G、500K` };
  }
  return { folder: p, threshold };
}

// 递归扫描：大于阈值的文件（含完整路径与大小）、小文件数、子文件夹数
async function scanFolder(root, threshold) {
  const bigFiles = [];
  let smallFileCount = 0;
  let smallFileBytes = 0;
  let folderCount = 0;
  const errors = [];

  async function walk(dir, isRoot) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (e) {
      errors.push({ path: dir, error: e.message });
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        folderCount++;
        await walk(full, false);
      } else if (ent.isFile()) {
        let st;
        try {
          st = await fsp.stat(full);
        } catch (e) {
          errors.push({ path: full, error: e.message });
          continue;
        }
        if (st.size > threshold) {
          bigFiles.push({ fullPath: full, name: ent.name, size: st.size, atRoot: isRoot });
        } else {
          smallFileCount++;
          smallFileBytes += st.size;
        }
      } else {
        // 符号链接等其它类型：按待删除项统计
        smallFileCount++;
      }
    }
  }

  await walk(root, true);
  return { bigFiles, smallFileCount, smallFileBytes, folderCount, errors };
}

function uniqueDest(root, name) {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let i = 1;
  let dest;
  do {
    dest = path.join(root, `${base} (${i})${ext}`);
    i++;
  } while (fs.existsSync(dest));
  return dest;
}

function sendProgress(data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('exec:progress', data);
  }
}

async function executePlan(root, scan) {
  const errors = [...scan.errors];
  const kept = new Set();       // 保留在一级目录的大文件（绝对路径）
  const failedMoves = [];       // 移动失败的大文件（保护其所在顶层文件夹不被删除）
  let movedCount = 0;

  // 第一步：把不在一级目录的大文件移动到一级目录
  for (const f of scan.bigFiles) {
    const src = path.resolve(f.fullPath);
    if (f.atRoot) {
      kept.add(src);
      continue;
    }
    let dest = path.join(root, f.name);
    if (fs.existsSync(dest) && path.resolve(dest) !== src) {
      dest = uniqueDest(root, f.name);
    }
    try {
      await fsp.rename(f.fullPath, dest);
      kept.add(path.resolve(dest));
      movedCount++;
      sendProgress({ phase: 'move', message: `移动：${f.fullPath}  →  ${dest}` });
    } catch (e) {
      errors.push({ path: f.fullPath, error: `移动失败：${e.message}` });
      failedMoves.push(src);
      sendProgress({ phase: 'error', message: `移动失败：${f.fullPath}（${e.message}）` });
    }
  }

  // 含移动失败文件的顶层条目需要保护，整棵子树跳过删除
  const protectedRoots = new Set(
    failedMoves.map((p) => path.relative(root, p).split(path.sep)[0])
  );

  // 第二步：一级目录下，除保留的大文件外全部移入回收站
  let trashedFiles = 0;
  let trashedFolders = 0;
  let skippedProtected = 0;

  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch (e) {
    errors.push({ path: root, error: e.message });
    sendProgress({ phase: 'done' });
    return { movedCount, keptCount: kept.size, trashedFiles, trashedFolders, skippedProtected, errors };
  }

  for (const ent of entries) {
    const full = path.join(root, ent.name);
    if (ent.isFile() && kept.has(path.resolve(full))) continue;
    if (protectedRoots.has(ent.name)) {
      skippedProtected++;
      sendProgress({ phase: 'skip', message: `跳过（内含未成功移动的大文件）：${full}` });
      continue;
    }
    try {
      await shell.trashItem(full);
      if (ent.isDirectory()) trashedFolders++;
      else trashedFiles++;
      sendProgress({ phase: 'trash', message: `删除（移入回收站）：${full}` });
    } catch (e) {
      errors.push({ path: full, error: `删除失败：${e.message}` });
      sendProgress({ phase: 'error', message: `删除失败：${full}（${e.message}）` });
    }
  }

  sendProgress({ phase: 'done' });
  return { movedCount, keptCount: kept.size, trashedFiles, trashedFolders, skippedProtected, errors };
}

/* ---------------- IPC ---------------- */

ipcMain.handle('dialog:selectFolder', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: '选择要整理的文件夹',
    properties: ['openDirectory'],
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('scan:preview', async (_e, { folder, sizeText }) => {
  const check = await validateInputs(folder, sizeText);
  if (check.error) return { ok: false, error: check.error };

  const scan = await scanFolder(check.folder, check.threshold);
  const moveCount = scan.bigFiles.filter((f) => !f.atRoot).length;
  const bigFileBytes = scan.bigFiles.reduce((s, f) => s + f.size, 0);

  return {
    ok: true,
    folder: check.folder,
    threshold: check.threshold,
    thresholdText: formatSize(check.threshold),
    bigFileCount: scan.bigFiles.length,
    bigFileBytes,
    moveCount,
    smallFileCount: scan.smallFileCount,
    smallFileBytes: scan.smallFileBytes,
    folderCount: scan.folderCount,
    bigFiles: scan.bigFiles.slice(0, 500).map((f) => ({
      fullPath: f.fullPath,
      sizeText: formatSize(f.size),
      atRoot: f.atRoot,
    })),
    truncated: scan.bigFiles.length > 500,
    scanErrors: scan.errors.slice(0, 50),
  };
});

ipcMain.handle('scan:execute', async (_e, { folder, sizeText }) => {
  const check = await validateInputs(folder, sizeText);
  if (check.error) return { ok: false, error: check.error };

  const scan = await scanFolder(check.folder, check.threshold);
  const moveCount = scan.bigFiles.filter((f) => !f.atRoot).length;

  const ans = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['取消', '确认执行'],
    defaultId: 0,
    cancelId: 0,
    title: '确认执行',
    message: `即将整理文件夹：${check.folder}`,
    detail:
      `阈值：大于 ${formatSize(check.threshold)}\n` +
      `保留 ${scan.bigFiles.length} 个大文件（其中 ${moveCount} 个将被移动到一级目录）\n` +
      `删除 ${scan.smallFileCount} 个小文件、${scan.folderCount} 个文件夹（移入回收站）\n\n` +
      `确定要继续吗？`,
  });
  if (ans.response !== 1) return { ok: false, cancelled: true };

  const result = await executePlan(check.folder, scan);
  return { ok: true, ...result };
});

// 供自动化冒烟测试引用（Electron 运行时不会用到）
module.exports = { parseSize, formatSize, validateInputs, scanFolder, executePlan };
