// 冒烟测试：打桩 electron 模块，验证解析/扫描/执行逻辑（在 workspace 内的临时目录上操作）
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;

// ---- 打桩 electron ----
const electronPath = require.resolve('electron');
const stub = {
  app: {
    whenReady: () => ({ then() {} }),
    on() {},
    disableHardwareAcceleration() {},
    commandLine: { appendSwitch() {} },
  },
  BrowserWindow: function () {},
  ipcMain: { handle() {} },
  dialog: {},
  // 用真实删除模拟回收站（测试夹具是脚本自己创建的）
  shell: { trashItem: async (p) => fsp.rm(p, { recursive: true, force: true }) },
};
require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: stub };

const { parseSize, scanFolder, executePlan } = require('./main.js');

async function main() {
  // 1. 解析测试
  const cases = { '200M': 200 * 1024 ** 2, '1000M': 1000 * 1024 ** 2, '1.5G': Math.floor(1.5 * 1024 ** 3), '500K': 500 * 1024, '2048': 2048 * 1024 ** 2, '10mb': 10 * 1024 ** 2, '2g': 2 * 1024 ** 3 };
  for (const [k, v] of Object.entries(cases)) {
    if (parseSize(k) !== v) throw new Error(`parseSize(${k}) = ${parseSize(k)}, 期望 ${v}`);
  }
  if (parseSize('abc') !== null || parseSize('') !== null) throw new Error('非法输入应返回 null');
  console.log('PASS: parseSize 8 组用例');

  // 2. 构造测试夹具
  const root = path.join(__dirname, '__fixture__');
  await fsp.rm(root, { recursive: true, force: true });
  await fsp.mkdir(path.join(root, 'sub', 'sub2'), { recursive: true });
  await fsp.writeFile(path.join(root, 'big1.bin'), Buffer.alloc(300));        // 一级目录大文件
  await fsp.writeFile(path.join(root, 'small1.txt'), Buffer.alloc(10));
  await fsp.writeFile(path.join(root, 'sub', 'big2.bin'), Buffer.alloc(500)); // 子目录大文件
  await fsp.writeFile(path.join(root, 'sub', 'small2.txt'), Buffer.alloc(20));
  await fsp.writeFile(path.join(root, 'sub', 'sub2', 'small3.txt'), Buffer.alloc(30));

  // 3. 扫描测试（阈值 200B）
  const scan = await scanFolder(root, 200);
  if (scan.bigFiles.length !== 2) throw new Error('bigFiles 应为 2，实际 ' + scan.bigFiles.length);
  if (scan.smallFileCount !== 3) throw new Error('smallFileCount 应为 3，实际 ' + scan.smallFileCount);
  if (scan.folderCount !== 2) throw new Error('folderCount 应为 2，实际 ' + scan.folderCount);
  const atRoot = scan.bigFiles.find((f) => f.name === 'big1.bin');
  const nested = scan.bigFiles.find((f) => f.name === 'big2.bin');
  if (!atRoot.atRoot || nested.atRoot) throw new Error('atRoot 标记错误');
  console.log('PASS: scanFolder 统计正确（2 大文件 / 3 小文件 / 2 文件夹）');

  // 4. 执行测试
  const result = await executePlan(root, scan);
  if (result.movedCount !== 1 || result.keptCount !== 2) throw new Error('执行结果异常: ' + JSON.stringify(result));
  const left = await fsp.readdir(root);
  const names = left.sort().join(',');
  if (names !== 'big1.bin,big2.bin') throw new Error('一级目录应只剩 big1.bin 和 big2.bin，实际: ' + names);
  console.log('PASS: executePlan 后一级目录仅剩 big1.bin, big2.bin');

  await fsp.rm(root, { recursive: true, force: true });
  console.log('ALL SMOKE TESTS PASSED');
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
