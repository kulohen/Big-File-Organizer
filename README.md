# 大文件管家（Big File Organizer）

一个基于 Electron 的 Windows 桌面小工具：**把指定文件夹里「大于阈值」的文件归置到该文件夹的一级目录，其余文件和文件夹全部删除（移入系统回收站，可恢复）**。

适合清理下载目录、网盘同步目录等：目录层级很深、只想留下其中的大文件（视频、压缩包、安装包等），剩下的杂碎一键清掉。

---

## 功能特性

- 📁 文件夹选择：系统对话框选择 / 手动输入路径，两种方式
- ⚙️ 阈值可配置：默认 `200M`，支持 `200M`、`1000M`、`1.5G`、`500K` 等写法，不带单位默认按 M
- 👀 先预览后执行：预览给出 4 项统计（保留大文件数、需移动数、将删文件数、将删文件夹数）和大文件清单；**只有预览通过且输入未改动，执行按钮才可用**
- ⚠️ 二次确认：正式执行前弹原生确认框，展示完整操作摘要
- 📜 执行反馈：实时滚动日志（每个文件的移动/删除逐条记录）+ 结束汇总
- 🛡️ 安全设计：删除走回收站可恢复；同名自动改名绝不覆盖；移动失败的子树会被保护跳过；执行后强制重新预览

---

## 怎么使用

### 环境要求

- Windows 10 / 11
- [Node.js](https://nodejs.org/) 18+（仅开发和打包需要，运行打包好的 exe 不需要）

### 1. 安装与运行（开发模式）

```bash
npm install        # 安装依赖
npm start          # 启动应用
```

国内网络建议先切镜像，下载 Electron 快很多：

```bash
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
npm config set registry https://registry.npmmirror.com
npm install
```

### 2. 打包成单文件 exe（免安装）

```bash
npm run dist       # 产物输出到 release/，单文件双击即可运行
```

国内打包再加一条镜像，免得下载 electron-builder 二进制超时：

```bash
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
```

### 3. 程序操作流程

1. **选目录**：点「浏览…」选文件夹，或直接粘贴路径
2. **填阈值**：如 `200M` / `1000M` / `1.5G`
3. **预览**：点「预览」查看将保留/移动/删除的文件与文件夹数量，确认无误
4. **执行**：点「正式执行」→ 弹确认框 → 确认 → 等待日志跑完，看结束汇总

> 删除项全部进**回收站**，万一删错可在回收站还原。

### 4. 运行测试（可选，无需 GUI）

```bash
npm test           # 核心逻辑冒烟测试
```

---

## 关键代码

### ① 解析大小阈值 → 字节数

用户可能写 `200M`、`1000M`、`1.5G` 甚至裸数字，统一解析；不带单位默认 M：

```js
function parseSize(input) {
  const m = String(input || '').trim().match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB|K|M|G|T)?$/i);
  if (!m) return null;
  const num = parseFloat(m[1]);
  if (!Number.isFinite(num) || num < 0) return null;
  const unit = (m[2] || 'M').toUpperCase();
  const mult = {
    B: 1, K: 1024, KB: 1024, M: 1024 ** 2, MB: 1024 ** 2,
    G: 1024 ** 3, GB: 1024 ** 3, T: 1024 ** 4, TB: 1024 ** 4,
  }[unit];
  return Math.floor(num * mult);
}
```

### ② 递归扫描：把文件分成「保留」和「待删」

深度优先遍历整棵目录树，同时收集 4 项统计。`atRoot` 标记表示该大文件已在一级目录、无需移动；符号链接等非普通文件按待删统计（不跟随链接，避免跳出目标目录）：

```js
async function scanFolder(root, threshold) {
  const bigFiles = [];
  let smallFileCount = 0, folderCount = 0;
  const errors = [];

  async function walk(dir, isRoot) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (e) { errors.push({ path: dir, error: e.message }); return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) { folderCount++; await walk(full, false); }
      else if (ent.isFile()) {
        const st = await fsp.stat(full);
        if (st.size > threshold) bigFiles.push({ fullPath: full, name: ent.name, size: st.size, atRoot: isRoot });
        else smallFileCount++;
      } else { smallFileCount++; }  // 符号链接等按待删处理
    }
  }
  await walk(root, true);
  return { bigFiles, smallFileCount, folderCount, errors };
}
```

### ③ 执行：先把大文件「捞」到一级目录

重名时自动加 `(1)` 后缀，绝不覆盖；移动失败则记下，下一步保护其所在子树：

```js
for (const f of scan.bigFiles) {
  const src = path.resolve(f.fullPath);
  if (f.atRoot) { kept.add(src); continue; }            // 已在一级目录，原地保留
  let dest = path.join(root, f.name);
  if (fs.existsSync(dest) && path.resolve(dest) !== src) dest = uniqueDest(root, f.name);
  try { await fsp.rename(f.fullPath, dest); kept.add(path.resolve(dest)); }
  catch (e) { failedMoves.push(src); }                  // 移不动就保护，不删
}
```

### ④ 执行：一级目录下除保留文件外，全部进回收站

关键简化：大文件全捞出后，一级目录剩下的**都要删**，于是删除从「递归逐个删」变成「只遍历一层」，删整个目录时一次 `shell.trashItem` 即可，又快又安全：

```js
const protectedRoots = new Set(failedMoves.map(p => path.relative(root, p).split(path.sep)[0]));
const entries = await fsp.readdir(root, { withFileTypes: true });
for (const ent of entries) {
  const full = path.join(root, ent.name);
  if (ent.isFile() && kept.has(path.resolve(full))) continue;  // 保留的大文件
  if (protectedRoots.has(ent.name)) continue;                    // 受保护的子树
  await shell.trashItem(full);                                   // 进回收站，可恢复
}
```

### ⑤ 安全桥接：preload + IPC

preload 只暴露 4 个白名单方法，渲染进程完全不碰 Node API；执行前主进程会先重扫并弹原生确认框：

```js
// preload.js —— 安全暴露 API
contextBridge.exposeInMainWorld('api', {
  selectFolder: () => ipcRenderer.invoke('dialog:selectFolder'),
  preview: (folder, sizeText) => ipcRenderer.invoke('scan:preview', { folder, sizeText }),
  execute: (folder, sizeText) => ipcRenderer.invoke('scan:execute', { folder, sizeText }),
  onProgress: (cb) => ipcRenderer.on('exec:progress', (_e, data) => cb(data)),
});

// main.js —— 执行前二次确认
ipcMain.handle('scan:execute', async (_e, { folder, sizeText }) => {
  const scan = await scanFolder(folder, parseSize(sizeText));
  const ans = await dialog.showMessageBox(mainWindow, {
    type: 'warning', buttons: ['取消', '确认执行'],
    message: `保留 ${scan.bigFiles.length} 个大文件，删除 ${scan.smallFileCount} 个小文件、${scan.folderCount} 个文件夹`,
  });
  if (ans.response !== 1) return { cancelled: true };
  return executePlan(folder, scan);   // 过程中逐条 send('exec:progress', …) 推日志
});
```

### ⑥ 界面双保险：「预览签名」机制

记录「文件夹 + 阈值」作为签名，签名匹配才点亮执行按钮；任何输入改动或一次执行完成后签名失效，必须重新预览：

```js
const signature = () => folderInput.value.trim() + '|' + sizeInput.value.trim();
executeBtn.disabled = busy || previewSignature !== signature();
```

---

## 实现步骤说明

1. **建工程**：`npm init` 后 `npm i -D electron electron-builder`，配置 `package.json` 的 `build` 字段（portable 单文件、productName、files 白名单、icon）。
2. **主进程骨架**：`app.whenReady()` 创建 `BrowserWindow`，加载 `index.html`，图标用 `assets/icon.png`。遇到无 GPU 的机器加 `app.disableHardwareAcceleration()`。
3. **解析输入**：写 `parseSize` + `validateInputs`，把人写的 `200M/1.5G` 变成字节并校验路径。
4. **扫描**：写 `scanFolder` 递归遍历，产出「大文件清单 / 小文件数 / 文件夹数 / 错误」。
5. **执行**：写 `executePlan`——先 `rename` 移大文件（重名改名、失败保护），再用 `shell.trashItem` 清掉一级目录其余项。
6. **IPC 桥接**：`preload.js` 用 `contextBridge` 暴露 4 个方法；主进程注册 `selectFolder / scan:preview / scan:execute`，执行过程通过 `webContents.send('exec:progress', …)` 推日志。
7. **界面**：`index.html` + `renderer.js`，预览统计卡片、确认弹窗、实时日志、结束汇总；用「预览签名」强制先预览后执行。
8. **打包**：`npm run dist` 用 electron-builder 生成单文件 portable exe。
9. **测试**：`smoke-test.js` 打桩 electron 模块，在临时夹具上验证解析/扫描/执行三段逻辑。

---

## 目录结构

```
big-file-organizer/
├── main.js          # 主进程：扫描 / 移动 / 删除（回收站）/ IPC / 原生对话框
├── preload.js       # contextBridge 安全桥
├── index.html       # 界面结构
├── renderer.js      # 界面交互、预览渲染、日志展示
├── style.css        # 样式
├── smoke-test.js    # 核心逻辑冒烟测试（无需 GUI）
├── assets/icon.png  # 应用图标
├── build/icon.png   # 打包用图标（≥512px，自动转 ICO）
└── package.json     # 含 electron-builder 打包配置
```

## License

[MIT](LICENSE)
