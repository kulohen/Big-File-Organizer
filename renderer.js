const $ = (id) => document.getElementById(id);

const folderInput = $('folderInput');
const sizeInput = $('sizeInput');
const browseBtn = $('browseBtn');
const previewBtn = $('previewBtn');
const executeBtn = $('executeBtn');
const busyText = $('busyText');
const previewCard = $('previewCard');
const logCard = $('logCard');
const logEl = $('log');
const summaryLine = $('summaryLine');

let previewSignature = null; // 预览通过后才允许正式执行

function currentSignature() {
  return folderInput.value.trim() + '|' + sizeInput.value.trim();
}

function setBusy(busy) {
  previewBtn.disabled = busy;
  browseBtn.disabled = busy;
  executeBtn.disabled = busy || previewSignature !== currentSignature();
  busyText.hidden = !busy;
}

function refreshExecuteState() {
  executeBtn.disabled = previewSignature !== currentSignature();
}

folderInput.addEventListener('input', refreshExecuteState);
sizeInput.addEventListener('input', refreshExecuteState);

browseBtn.addEventListener('click', async () => {
  const p = await window.api.selectFolder();
  if (p) {
    folderInput.value = p;
    refreshExecuteState();
  }
});

function fmt(bytes) {
  if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(2) + ' GB';
  if (bytes >= 1024 ** 2) return (bytes / 1024 ** 2).toFixed(2) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(2) + ' KB';
  return bytes + ' B';
}

previewBtn.addEventListener('click', async () => {
  setBusy(true);
  previewCard.hidden = true;
  try {
    const r = await window.api.preview(folderInput.value, sizeInput.value);
    if (!r.ok) {
      alert(r.error);
      previewSignature = null;
      return;
    }
    $('statKeep').textContent = r.bigFileCount;
    $('statKeepSize').textContent = '共 ' + fmt(r.bigFileBytes);
    $('statMove').textContent = r.moveCount;
    $('statThreshold').textContent = '阈值：> ' + r.thresholdText;
    $('statDelFiles').textContent = r.smallFileCount;
    $('statDelSize').textContent = '约 ' + fmt(r.smallFileBytes);
    $('statDelFolders').textContent = r.folderCount;

    const list = $('bigList');
    list.innerHTML = '';
    for (const f of r.bigFiles) {
      const li = document.createElement('li');
      const left = document.createElement('span');
      left.className = 'path';
      left.textContent = f.fullPath + (f.atRoot ? '' : '　→ 将移至一级目录');
      const right = document.createElement('span');
      right.className = 'size';
      right.textContent = f.sizeText;
      li.appendChild(left);
      li.appendChild(right);
      list.appendChild(li);
    }
    $('bigListWrap').hidden = r.bigFiles.length === 0;
    $('bigListTrunc').hidden = !r.truncated;

    const errBox = $('scanErrors');
    if (r.scanErrors && r.scanErrors.length > 0) {
      errBox.hidden = false;
      errBox.textContent = '扫描中有 ' + r.scanErrors.length +
        ' 个项目无法读取：\n' + r.scanErrors.map((e) => e.path + '（' + e.error + '）').join('\n');
    } else {
      errBox.hidden = true;
    }

    previewCard.hidden = false;
    previewSignature = currentSignature();
  } catch (e) {
    alert('预览失败：' + e.message);
    previewSignature = null;
  } finally {
    setBusy(false);
    refreshExecuteState();
  }
});

function appendLog(message, cls) {
  const line = document.createElement('div');
  if (cls) line.className = cls;
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const time = document.createElement('span');
  time.className = 't';
  time.textContent = '[' + t + '] ';
  line.appendChild(time);
  line.appendChild(document.createTextNode(message));
  logEl.appendChild(line);
  // 限制日志行数，避免超长
  while (logEl.childNodes.length > 2000) logEl.removeChild(logEl.firstChild);
  logEl.scrollTop = logEl.scrollHeight;
}

window.api.onProgress((d) => {
  if (d.phase === 'done') return;
  const cls = d.phase === 'error' ? 'err' : d.phase === 'skip' ? 'skip' : '';
  appendLog(d.message, cls);
});

executeBtn.addEventListener('click', async () => {
  setBusy(true);
  logCard.hidden = false;
  logEl.innerHTML = '';
  summaryLine.textContent = '正在执行…';
  appendLog('开始执行任务');
  try {
    const r = await window.api.execute(folderInput.value, sizeInput.value);
    if (r.cancelled) {
      summaryLine.textContent = '已取消，未做任何改动。';
      appendLog('用户取消执行', 'skip');
      return;
    }
    if (!r.ok) {
      summaryLine.textContent = '';
      alert(r.error);
      appendLog('执行失败：' + r.error, 'err');
      return;
    }
    const errCount = r.errors ? r.errors.length : 0;
    summaryLine.innerHTML =
      '执行完成：保留大文件 <b>' + r.keptCount + '</b> 个（新移入一级目录 <b>' + r.movedCount + '</b> 个），' +
      '删除顶层文件 <b>' + r.trashedFiles + '</b> 个、文件夹 <b>' + r.trashedFolders + '</b> 个' +
      (r.skippedProtected ? '，<span class="bad">因移动失败被保护跳过的顶层项目 ' + r.skippedProtected + ' 个</span>' : '') +
      (errCount ? '，<span class="bad">' + errCount + ' 条错误（详见日志）</span>' : '，无错误');
    appendLog('任务结束：保留 ' + r.keptCount + '，移动 ' + r.movedCount +
      '，删除文件 ' + r.trashedFiles + '，删除文件夹 ' + r.trashedFolders +
      (errCount ? '，错误 ' + errCount + ' 条' : ''));
    if (r.errors && r.errors.length) {
      for (const e of r.errors) appendLog('错误：' + e.path + '（' + e.error + '）', 'err');
    }
  } catch (e) {
    summaryLine.textContent = '';
    appendLog('执行异常：' + e.message, 'err');
  } finally {
    setBusy(false);
    previewSignature = null; // 执行完后强制重新预览
    refreshExecuteState();
  }
});
