const { app, BrowserWindow, ipcMain, dialog, Menu, MenuItem } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

let mainWindow;
let breakWindow = null;
let analyticsWindow = null;
let tradingJournalWindow = null;
let connectionsWindow = null;
let futureCanvasWindow = null;

const TARGET_DIR = "C:\\Users\\HomePC\\Documents\\Obsidian\\Progects\\MyLife";
const CONNECTIONS_DIR = "C:\\Users\\HomePC\\Documents\\Obsidian\\Progects\\MyLife\\Моя картотека";
const DAILY_TASKS_FILE_NAME = "Ежедневные задачи";

async function runGitCommand(args) {
  try {
    const { stdout, stderr } = await execPromise(`git -C "${TARGET_DIR}" ${args}`);
    return { success: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

const localWrites = new Map();
let fileWatcher = null;
let fileWatcherDebounceTimers = new Map();

function startFileWatcher() {
  if (fileWatcher) {
    fileWatcher.close();
  }
  try {
    if (!fs.existsSync(TARGET_DIR)) {
      fs.mkdirSync(TARGET_DIR, { recursive: true });
    }
    
    fileWatcher = fs.watch(TARGET_DIR, (eventType, filename) => {
      if (!filename || !filename.endsWith('.md')) return;
      
      // Debounce changes per file
      if (fileWatcherDebounceTimers.has(filename)) {
        clearTimeout(fileWatcherDebounceTimers.get(filename));
      }
      
      const timer = setTimeout(() => {
        fileWatcherDebounceTimers.delete(filename);
        
        // Check if this was a local write
        const lastWrite = localWrites.get(filename);
        if (lastWrite && Date.now() - lastWrite < 2000) {
          return;
        }
        
        logAction(`🔔 Файловый наблюдатель обнаружил внешнее изменение: ${filename}`);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('external-file-change', filename);
        }
      }, 150);
      
      fileWatcherDebounceTimers.set(filename, timer);
    });
    
    logAction(`👁️ Запущен файловый наблюдатель для папки: ${TARGET_DIR}`);
  } catch (err) {
    logAction(`⚠️ Ошибка запуска файлового наблюдателя: ${err.message}`);
  }
}

let isGitSyncing = false;
let gitSyncPending = false;

async function triggerGitSync() {
  if (isGitSyncing) {
    gitSyncPending = true;
    return;
  }

  isGitSyncing = true;
  gitSyncPending = false;

  try {
    logAction("🔄 Автосинк Git: Проверка изменений...");
    
    // 1. Проверяем наличие локальных изменений
    const statusRes = await runGitCommand("status --porcelain");
    let hasLocalChanges = statusRes.success && statusRes.stdout !== "";

    if (hasLocalChanges) {
      logAction(`🔄 Автосинк Git: найдены измененные файлы:\n${statusRes.stdout}`);
      
      // 2. Индексируем изменения
      await runGitCommand("add .");
      
      // Проверяем, есть ли проиндексированные файлы в нашей директории
      const diffCachedRes = await runGitCommand("diff --cached --quiet");
      const hasStagedChanges = !diffCachedRes.success; // если есть изменения, diff возвращает exit код 1
      
      if (hasStagedChanges) {
        // 3. Создаем коммит локально
        const commitRes = await runGitCommand('commit -m "Auto-sync from Goals Widget"');
        if (!commitRes.success) {
          logAction(`⚠️ Автосинк Git (commit): ${commitRes.error || commitRes.stderr}`);
          return; // Если коммит не удался, прекращаем
        }
        logAction("🔄 Автосинк Git: Локальный коммит создан.");
      } else {
        logAction("🔄 Автосинк Git: Нет изменений для коммита в отслеживаемой папке.");
      }
    }

    // 4. Подтягиваем изменения с удаленного репозитория с использованием rebase
    logAction("🔄 Автосинк Git: Получение свежих изменений (pull --rebase)...");
    
    const beforePullRes = await runGitCommand("rev-parse HEAD");
    const beforePullSha = beforePullRes.success ? beforePullRes.stdout : "";

    const pullRes = await runGitCommand("pull --rebase");
    if (!pullRes.success) {
      logAction(`⚠️ Автосинк Git (pull --rebase ошибка): ${pullRes.error || pullRes.stderr}`);
      logAction("🔄 Автосинк Git: Отмена rebase...");
      await runGitCommand("rebase --abort");
      return; // Прекращаем выполнение, так как есть конфликт
    }

    const afterPullRes = await runGitCommand("rev-parse HEAD");
    const afterPullSha = afterPullRes.success ? afterPullRes.stdout : "";

    // Если хэш изменился, значит, прилетели изменения с другого устройства
    if (beforePullSha && afterPullSha && beforePullSha !== afterPullSha) {
      logAction("🔄 Автосинк Git: Получены новые коммиты с другого устройства. Обновление интерфейса...");
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('external-file-change');
      }
    }

    // 5. Отправляем изменения на сервер, если были локальные коммиты
    const logRes = await runGitCommand("log @{u}..@{0} --oneline");
    const needsPush = logRes.success && logRes.stdout !== "";

    if (needsPush) {
      logAction("🔄 Автосинк Git: Отправка изменений в удаленный репозиторий (push)...");
      const pushRes = await runGitCommand("push");
      if (pushRes.success) {
        logAction("✅ Автосинк Git: Все изменения успешно отправлены в репозиторий!");
      } else {
        logAction(`⚠️ Автосинк Git (push): ${pushRes.error || pushRes.stderr}`);
      }
    } else {
      logAction("✅ Автосинк Git: Репозиторий синхронизирован.");
    }

  } catch (err) {
    logAction(`⚠️ Автосинк Git: Непредвиденная ошибка: ${err.message}`);
  } finally {
    isGitSyncing = false;
    if (gitSyncPending) {
      setTimeout(triggerGitSync, 5000);
    }
  }
}

let gitSyncTimeout = null;

function scheduleGitSync() {
  if (gitSyncTimeout) {
    clearTimeout(gitSyncTimeout);
  }
  gitSyncTimeout = setTimeout(() => {
    triggerGitSync();
  }, 5000);
}

function loadConfig() {
  const configPath = path.join(__dirname, 'config.json');
  try {
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    }
  } catch(e) {}
  return {};
}

function saveConfigValue(values) {
  const configPath = path.join(__dirname, 'config.json');
  try {
    const currentConfig = loadConfig();
    fs.writeFileSync(configPath, JSON.stringify({ ...currentConfig, ...values }, null, 2), 'utf-8');
  } catch(e) {}
}

function saveWindowBounds(bounds) {
  saveConfigValue(bounds);
}

function loadWindowBounds() {
  const configPath = path.join(__dirname, 'config.json');
  try {
    if (fs.existsSync(configPath)) {
      const bounds = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      return bounds;
    }
  } catch(e) {}
  return { width: 520, height: 650 };
}

function getFilePath(fileName) {
  try {
    if (!fs.existsSync(TARGET_DIR)) {
      fs.mkdirSync(TARGET_DIR, { recursive: true });
    }
  } catch (e) {}
  
  const safeName = fileName.replace(/[\/\\:\*\?"<>\|]/g, '').trim() || 'Дела';
  return path.join(TARGET_DIR, `${safeName}.md`);
}

function logAction(message) {
  const logPath = path.join(__dirname, 'log.txt');
  const timestamp = new Date().toLocaleString('ru-RU');
  const logMessage = `[${timestamp}] ${message}\n`;
  fs.appendFileSync(logPath, logMessage, 'utf-8');
}

function createWindow() {
  const savedBounds = loadWindowBounds();
  
  mainWindow = new BrowserWindow({
    x: savedBounds.x !== undefined ? savedBounds.x : undefined,
    y: savedBounds.y !== undefined ? savedBounds.y : undefined,
    width: savedBounds.width || 520,
    height: savedBounds.height || 650,
    resizable: true,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    icon: path.join(__dirname, 'icon.ico'),
    show: false
  });

  mainWindow.loadFile('index.html');
  mainWindow.setTitle('Финансовый трекер');
  
  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    console.log(`[RENDERER CONSOLE] ${message} (at ${sourceId}:${line})`);
  });
  
  mainWindow.on('resize', () => {
    const bounds = mainWindow.getBounds();
    saveWindowBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
  });
  
  mainWindow.on('move', () => {
    const bounds = mainWindow.getBounds();
    saveWindowBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
  });

  mainWindow.on('focus', () => {
    // При получении фокуса окном виджета запускаем синхронизацию для получения изменений
    scheduleGitSync();
  });
  
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.show();
  });
}

function getLineIndent(line) {
  const match = line.match(/^(\s*)-\s*(?:\[([ xX])\])?/);
  if (!match) return -1;
  const indentStr = match[1];
  let indent = 0;
  for (let char of indentStr) {
    if (char === '\t') indent += 1;
    else if (char === ' ') indent += 0.25;
  }
  return Math.round(indent);
}

function getTaskBlockSize(lines, P) {
  const I = getLineIndent(lines[P]);
  if (I === -1) return 1;
  let size = 1;
  for (let i = P + 1; i < lines.length; i++) {
    const nextIndent = getLineIndent(lines[i]);
    if (nextIndent !== -1) {
      if (nextIndent <= I) {
        break;
      }
    }
    size++;
  }
  return size;
}

function shiftBlockIndent(blockLines, delta) {
  if (delta === 0) return blockLines;
  return blockLines.map(line => {
    const match = line.match(/^(\s*)(.*)$/);
    if (!match) return line;
    const currentIndentStr = match[1];
    const rest = match[2];
    
    let indent = 0;
    for (let char of currentIndentStr) {
      if (char === '\t') indent += 1;
      else if (char === ' ') indent += 0.25;
    }
    indent = Math.round(indent);
    
    const newIndent = Math.max(0, indent + delta);
    const isTab = currentIndentStr.includes('\t');
    const newIndentStr = isTab ? '\t'.repeat(newIndent) : '    '.repeat(newIndent);
    
    return newIndentStr + rest;
  });
}

function setTaskDoneState(line, done) {
  if (line.match(/\s*-\s*\[[ xX]\]\s*/)) {
    return line.replace(/-\s*\[[ xX]\]\s*/, done ? '- [x] ' : '- [ ] ');
  }
  return line.replace(/(-\s*)(?!\[[ xX]\])/, done ? '$1[x] ' : '$1[ ] ');
}

function isTaskDoneLine(line) {
  return /^\s*-\s*\[[xX]\]\s*/.test(line);
}

function isTaskOpenLine(line) {
  return /^\s*-\s*\[ \]\s*/.test(line) || /^\s*-\s*(?!\[[ xX]\])/.test(line);
}

function hasOpenChildren(lines, parentIndex) {
  const parentIndent = getLineIndent(lines[parentIndex]);
  for (let i = parentIndex + 1; i < lines.length; i++) {
    const indent = getLineIndent(lines[i]);
    if (indent === -1) continue;
    if (indent <= parentIndent) break;
    if (isTaskOpenLine(lines[i])) return true;
  }
  return false;
}

function getParentIndex(lines, lineIndex) {
  const currentIndent = getLineIndent(lines[lineIndex]);
  if (currentIndent <= 0) return -1;
  for (let i = lineIndex - 1; i >= 0; i--) {
    const indent = getLineIndent(lines[i]);
    if (indent !== -1 && indent < currentIndent) return i;
  }
  return -1;
}

function updateParentCompletion(lines, lineIndex) {
  let parentIndex = getParentIndex(lines, lineIndex);
  while (parentIndex >= 0) {
    lines[parentIndex] = setTaskDoneState(lines[parentIndex], !hasOpenChildren(lines, parentIndex));
    parentIndex = getParentIndex(lines, parentIndex);
  }
}

function getTodayKey() {
  return new Date().toISOString().slice(0, 10);
}

function hasOpenTasks(lines) {
  return lines.some(line => /^\s*-\s*\[ \]\s*/.test(line));
}

function hasDoneTasks(lines) {
  return lines.some(line => /^\s*-\s*\[[xX]\]\s*/.test(line));
}

function resetDoneTasks(lines) {
  return lines.map(line => line.replace(/^(\s*-\s*)\[[xX]\](\s*)/, '$1[ ]$2'));
}

function saveDailyTasksHistory() {
  try {
    const today = getTodayKey();
    const filePath = getFilePath(DAILY_TASKS_FILE_NAME);
    if (!fs.existsSync(filePath)) return;
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split(/\r?\n/);
    
    const tasks = [];
    lines.forEach(line => {
      const match = line.match(/^\s*-\s*\[([ xX])\]\s*(.*)$/);
      if (match) {
        const done = match[1].toLowerCase() === 'x';
        const text = match[2].trim();
        if (text) {
          tasks.push({ text, done });
        }
      }
    });
    
    const historyPath = path.join(TARGET_DIR, 'daily-history.json');
    let history = {};
    if (fs.existsSync(historyPath)) {
      try {
        history = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
      } catch (e) {}
    }
    
    let dayEntry = history[today];
    if (!dayEntry) {
      dayEntry = {
        dailyTasks: tasks,
        completedStandardTasks: []
      };
    } else if (Array.isArray(dayEntry)) {
      dayEntry = {
        dailyTasks: tasks,
        completedStandardTasks: []
      };
    } else if (typeof dayEntry === 'object') {
      dayEntry.dailyTasks = tasks;
    }
    
    history[today] = dayEntry;
    fs.writeFileSync(historyPath, JSON.stringify(history, null, 2), 'utf-8');
    logAction(`📈 История за ${today} сохранена. Ежедневных задач: ${tasks.length}`);
  } catch (e) {
    logAction(`Ошибка сохранения истории: ${e.message}`);
  }
}

function addCompletedStandardTaskToHistory(taskText, fileName) {
  try {
    const today = getTodayKey();
    const historyPath = path.join(TARGET_DIR, 'daily-history.json');
    let history = {};
    if (fs.existsSync(historyPath)) {
      try {
        history = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
      } catch (e) {}
    }
    
    let dayEntry = history[today];
    if (!dayEntry) {
      dayEntry = {
        dailyTasks: [],
        completedStandardTasks: []
      };
    } else if (Array.isArray(dayEntry)) {
      dayEntry = {
        dailyTasks: dayEntry,
        completedStandardTasks: []
      };
    } else if (typeof dayEntry === 'object') {
      if (!dayEntry.dailyTasks) dayEntry.dailyTasks = [];
      if (!dayEntry.completedStandardTasks) dayEntry.completedStandardTasks = [];
    }
    
    const alreadyExists = dayEntry.completedStandardTasks.some(t => t.text === taskText && t.file === fileName);
    if (!alreadyExists) {
      dayEntry.completedStandardTasks.push({
        text: taskText,
        file: fileName,
        timestamp: new Date().toISOString()
      });
      history[today] = dayEntry;
      fs.writeFileSync(historyPath, JSON.stringify(history, null, 2), 'utf-8');
      logAction(`📈 Разовая задача "${taskText}" добавлена в историю выполненных задач за ${today}.`);
    }
  } catch (e) {
    logAction(`Ошибка добавления выполненной разовой задачи в историю: ${e.message}`);
  }
}

function saveDailyTasksHistoryIfNeeded(fileName) {
  if (fileName === DAILY_TASKS_FILE_NAME) {
    saveDailyTasksHistory();
  }
}

function ensureDailyTasksReady() {
  const filePath = getFilePath(DAILY_TASKS_FILE_NAME);
  if (!fs.existsSync(filePath)) {
    localWrites.set(path.basename(filePath), Date.now());
    fs.writeFileSync(filePath, "- [ ] Утренняя проверка целей\n", "utf-8");
    saveDailyTasksHistory();
    return;
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split(/\r?\n/);
  const today = getTodayKey();
  const config = loadConfig();

  if (config.lastDailyResetDate !== today) {
    const resetLines = resetDoneTasks(lines);
    localWrites.set(path.basename(filePath), Date.now());
    fs.writeFileSync(filePath, resetLines.join('\n'), 'utf-8');
    saveConfigValue({ lastDailyResetDate: today });
    saveDailyTasksHistory(); // Save the initial unchecked state of daily tasks for this date
    logAction(`🔄 Ежедневные задачи автоматически обновлены на новый день: ${today}`);
  }
}

function readTasksFromFile(fileName) {
  const filePath = getFilePath(fileName);
  try {
    if (fileName === DAILY_TASKS_FILE_NAME) {
      ensureDailyTasksReady();
    }

    if (!fs.existsSync(filePath)) {
      logAction(`Файл не найден: ${filePath}`);
      return [];
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split(/\r?\n/);
    const rootTasks = [];
    const stack = [];

    for (let i = 0; i < lines.length; i++) {
       const line = lines[i];
       const match = line.match(/^(\s*)-\s*(?:\[([ xX])\])?\s*(.*)$/);
       if (match) {
         const indentStr = match[1];
         let indent = 0;
         for (let char of indentStr) {
           if (char === '\t') indent += 1;
           else if (char === ' ') indent += 0.25;
         }
         indent = Math.round(indent);

         const hasCheckbox = match[2] !== undefined;
         const checkboxChar = match[2];
         const done = hasCheckbox ? (checkboxChar.toLowerCase() === 'x') : false;
         const text = match[3].trim();

         if (!text) continue;

         const taskObj = {
           text: text,
           done: done,
           source: 'obsidian',
           lineIndex: i,
           indent: indent,
           parentLineIndex: null,
           subtasks: []
         };

         while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
           stack.pop();
         }

         if (stack.length > 0) {
           taskObj.parentLineIndex = stack[stack.length - 1].lineIndex;
           stack[stack.length - 1].subtasks.push(taskObj);
         } else {
           taskObj.parentLineIndex = null;
           rootTasks.push(taskObj);
         }

         stack.push(taskObj);
       }
    }

    logAction(`Загружено ${rootTasks.length} корневых задач из ${path.basename(filePath)}`);
    return rootTasks;
  } catch (err) {
    logAction(`Ошибка чтения Obsidian файла: ${err.message}`);
    return [];
  }
}

// Midnight checking routine (live updates)
let lastCheckedDate = getTodayKey();
setInterval(() => {
  const today = getTodayKey();
  if (today !== lastCheckedDate) {
    lastCheckedDate = today;
    ensureDailyTasksReady();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('day-changed', today);
    }
  }
}, 10000);

// ==========================================
// Trading Journal (TradingDiary) Config & Helpers
// ==========================================
const TRADING_DIR = "D:\\GoogleDisk\\Docs\\TradingDiary";
const TRADING_IMAGES_DIR = path.join(TRADING_DIR, "images");
const TRADING_DB_PATH = path.join(TRADING_DIR, "trades.json");
const TRADING_DATA_DIR = path.join(TRADING_DIR, "data");
const TRADING_TICKERS_PATH = path.join(TRADING_DATA_DIR, "tickers.json");

const CANVAS_DIR = path.join(__dirname, 'app', 'future-canvas', 'boards');

function ensureTradingDir() {
  try {
    if (!fs.existsSync(TRADING_DIR)) {
      fs.mkdirSync(TRADING_DIR, { recursive: true });
    }
    if (!fs.existsSync(TRADING_IMAGES_DIR)) {
      fs.mkdirSync(TRADING_IMAGES_DIR, { recursive: true });
    }
    if (!fs.existsSync(TRADING_DATA_DIR)) {
      fs.mkdirSync(TRADING_DATA_DIR, { recursive: true });
    }
  } catch (e) {
    logAction(`Ошибка создания папок трейдинга: ${e.message}`);
  }
}

function ensureCanvasDir() {
  try {
    if (!fs.existsSync(CANVAS_DIR)) {
      fs.mkdirSync(CANVAS_DIR, { recursive: true });
    }
  } catch (e) {
    logAction(`Ошибка создания папки Future Canvas: ${e.message}`);
  }
}

async function syncTBankTickers(token) {
  ensureTradingDir();
  if (!token) return { success: false, error: 'Токен пуст' };
  
  try {
    logAction('Запуск синхронизации тикеров с Т-Банком (Акции и Фьючерсы)...');
    
    const [sharesRes, futuresRes] = await Promise.all([
      fetch('https://invest-public-api.tinkoff.ru/rest/tinkoff.public.invest.api.contract.v1.InstrumentsService/Shares', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ instrumentStatus: 'INSTRUMENT_STATUS_BASE' })
      }),
      fetch('https://invest-public-api.tinkoff.ru/rest/tinkoff.public.invest.api.contract.v1.InstrumentsService/Futures', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ instrumentStatus: 'INSTRUMENT_STATUS_BASE' })
      })
    ]);
    
    if (!sharesRes.ok && !futuresRes.ok) {
      throw new Error(`Обе попытки запроса API завершились с ошибками. Shares status: ${sharesRes.status}, Futures status: ${futuresRes.status}`);
    }
    
    const sharesData = sharesRes.ok ? await sharesRes.json() : { instruments: [] };
    const futuresData = futuresRes.ok ? await futuresRes.json() : { instruments: [] };
    
    const sharesList = (sharesData.instruments || [])
      .filter(ins => ins.ticker && ins.figi && (ins.classCode === 'TQBR' || ins.classCode === 'TQTF'))
      .map(ins => {
        const lotVal = parseInt(ins.lot) || 1;
        return {
          name: ins.ticker,
          lot: lotVal,
          fullname: ins.name || '',
          figi: ins.figi,
          multiplier: lotVal
        };
      });
      
    const futuresList = (futuresData.instruments || [])
      .filter(ins => ins.ticker && ins.figi && ins.classCode === 'SPBFUT')
      .map(ins => {
        let assetSize = 1;
        if (ins.basicAssetSize) {
          const units = parseInt(ins.basicAssetSize.units) || 0;
          const nano = parseInt(ins.basicAssetSize.nano) || 0;
          assetSize = units + (nano / 1e9);
        }
        
        let priceMult = assetSize || parseInt(ins.lot) || 1;
        if (ins.minPriceIncrement && ins.minPriceIncrementAmount) {
          const inc = (parseInt(ins.minPriceIncrement.units) || 0) + ((parseInt(ins.minPriceIncrement.nano) || 0) / 1e9);
          const amt = (parseInt(ins.minPriceIncrementAmount.units) || 0) + ((parseInt(ins.minPriceIncrementAmount.nano) || 0) / 1e9);
          if (inc > 0) {
            priceMult = amt / inc;
          }
        }
        
        return {
          name: ins.ticker,
          lot: assetSize || parseInt(ins.lot) || 1,
          fullname: ins.name || '',
          figi: ins.figi,
          multiplier: priceMult
        };
      });
      
    const tickers = [...sharesList, ...futuresList];
    
    fs.writeFileSync(TRADING_TICKERS_PATH, JSON.stringify(tickers, null, 2), 'utf-8');
    logAction(`Синхронизировано ${tickers.length} тикеров MOEX (Акции: ${sharesList.length}, Фьючерсы: ${futuresList.length}). Успешно сохранено в ${TRADING_TICKERS_PATH}`);
    return { success: true, count: tickers.length };
  } catch (e) {
    logAction(`Ошибка синхронизации тикеров: ${e.message}`);
    return { success: false, error: e.message };
  }
}

function setupHandlers() {
  ipcMain.handle('close-window', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      win.close();
    } else if (mainWindow) {
      mainWindow.close();
    }
  });

  ipcMain.handle('resize-window', (event, width, height) => {
    if (mainWindow) {
      mainWindow.setSize(width, Math.min(1024, Math.round(height)));
    }
  });

  ipcMain.handle('get-obsidian-files', async () => {
    try {
      if (!fs.existsSync(TARGET_DIR)) {
        fs.mkdirSync(TARGET_DIR, { recursive: true });
      }
      let files = fs.readdirSync(TARGET_DIR)
        .filter(file => file.endsWith('.md'))
        .filter(file => path.basename(file, '.md') !== DAILY_TASKS_FILE_NAME)
        .map(file => path.basename(file, '.md'));
      
      if (files.length === 0) {
        localWrites.set("Дела.md", Date.now());
        fs.writeFileSync(path.join(TARGET_DIR, "Дела.md"), "- [ ] Моя первая задача\n", "utf-8");
        files.push("Дела");
      }
      return files;
    } catch (e) {
      logAction(`Ошибка получения списка файлов: ${e.message}`);
      return ["Дела"];
    }
  });

  ipcMain.handle('create-obsidian-file', async (event, fileName) => {
    try {
      if (fileName === DAILY_TASKS_FILE_NAME) return false;
      const filePath = getFilePath(fileName);
      if (!fs.existsSync(filePath)) {
        localWrites.set(path.basename(filePath), Date.now());
        fs.writeFileSync(filePath, "", "utf-8");
        logAction(`📂 Создан новый файл задач: ${fileName}.md`);
        scheduleGitSync();
        return true;
      }
      return false;
    } catch (e) {
      logAction(`Ошибка создания файла задач: ${e.message}`);
      return false;
    }
  });

  ipcMain.handle('rename-obsidian-file', async (event, oldName, newName) => {
    try {
      if (oldName === DAILY_TASKS_FILE_NAME || newName === DAILY_TASKS_FILE_NAME) {
        return { success: false, error: 'reserved' };
      }
      const safeNewName = newName.replace(/[\/\\:\*\?"<>\|]/g, '').trim();
      if (!safeNewName) return { success: false, error: 'empty' };
      const oldPath = getFilePath(oldName);
      const newPath = getFilePath(safeNewName);
      if (!fs.existsSync(oldPath)) return { success: false, error: 'missing' };
      if (fs.existsSync(newPath)) return { success: false, error: 'exists' };
      localWrites.set(path.basename(oldPath), Date.now());
      localWrites.set(path.basename(newPath), Date.now());
      fs.renameSync(oldPath, newPath);
      logAction(`📂 Файл задач переименован: ${oldName}.md → ${safeNewName}.md`);
      scheduleGitSync();
      return { success: true, fileName: safeNewName };
    } catch (e) {
      logAction(`Ошибка переименования файла задач: ${e.message}`);
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('delete-obsidian-file', async (event, fileName) => {
    try {
      if (fileName === DAILY_TASKS_FILE_NAME) return false;
      const filePath = getFilePath(fileName);
      if (!fs.existsSync(filePath)) return false;
      localWrites.set(path.basename(filePath), Date.now());
      fs.unlinkSync(filePath);
      logAction(`🗑️ Удален файл задач: ${fileName}.md`);
      scheduleGitSync();
      return true;
    } catch (e) {
      logAction(`Ошибка удаления файла задач: ${e.message}`);
      return false;
    }
  });

  ipcMain.handle('read-daily-tasks', async () => {
    return readTasksFromFile(DAILY_TASKS_FILE_NAME);
  });

  ipcMain.handle('read-obsidian-tasks', async (event, fileName) => {
    return readTasksFromFile(fileName);
  });

  ipcMain.handle('add-new-task', async (event, taskText, fileName) => {
    const filePath = getFilePath(fileName);
    try {
      let content = '';
      if (fs.existsSync(filePath)) {
        content = fs.readFileSync(filePath, 'utf-8');
      }
      
      const newTask = `- [ ] ${taskText}`;
      const newContent = content.length > 0 
        ? newTask + '\n' + content 
        : newTask + '\n';
        
      localWrites.set(path.basename(filePath), Date.now());
      fs.writeFileSync(filePath, newContent, 'utf-8');
      saveDailyTasksHistoryIfNeeded(fileName);
      logAction(`📝 Добавлена новая задача в начало ${path.basename(filePath)}: ${taskText}`);
      scheduleGitSync();

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('task-added-externally', { taskText, fileName });
      }
      return true;
    } catch (err) {
      logAction(`Ошибка добавления задачи: ${err.message}`);
      return false;
    }
  });

  ipcMain.handle('mark-task-done', async (event, lineIndex, fileName) => {
    const filePath = getFilePath(fileName);
    try {
      if (!fs.existsSync(filePath)) return false;
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split(/\r?\n/);
      if (lineIndex >= 0 && lineIndex < lines.length) {
        const line = lines[lineIndex];
        const shouldMarkDone = fileName === DAILY_TASKS_FILE_NAME ? !isTaskDoneLine(line) : true;
        
        // Track completed standard tasks
        if (fileName !== DAILY_TASKS_FILE_NAME && shouldMarkDone) {
          const cleanText = line.replace(/^\s*-\s*(?:\[[ xX]\])?\s*/, '').trim();
          if (cleanText) {
            addCompletedStandardTaskToHistory(cleanText, fileName);
          }
        }
        
        lines[lineIndex] = setTaskDoneState(line, shouldMarkDone);
        updateParentCompletion(lines, lineIndex);
        if (fileName === DAILY_TASKS_FILE_NAME) {
          const size = getTaskBlockSize(lines, lineIndex);
          const taskBlock = lines.splice(lineIndex, size);
          while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
            lines.pop();
          }
          lines.push(...taskBlock);
        }
        localWrites.set(path.basename(filePath), Date.now());
        fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
        saveDailyTasksHistoryIfNeeded(fileName);
        logAction(`✅ Выполнена задача на строке ${lineIndex + 1} в ${path.basename(filePath)}`);
        scheduleGitSync();
        return true;
      }
      return false;
    } catch (err) {
      logAction(`Ошибка выполнения задачи: ${err.message}`);
      return false;
    }
  });

  ipcMain.handle('delete-task', async (event, lineIndex, fileName) => {
    const filePath = getFilePath(fileName);
    try {
      if (!fs.existsSync(filePath)) return false;
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split(/\r?\n/);
      if (lineIndex >= 0 && lineIndex < lines.length) {
        const size = getTaskBlockSize(lines, lineIndex);
        lines.splice(lineIndex, size);
        
        localWrites.set(path.basename(filePath), Date.now());
        fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
        saveDailyTasksHistoryIfNeeded(fileName);
        logAction(`🗑️ Удалена задача (и её подзадачи, всего строк: ${size}) с индекса ${lineIndex + 1} в ${path.basename(filePath)}`);
        scheduleGitSync();
        return true;
      }
      return false;
    } catch (err) {
      logAction(`Ошибка удаления задачи: ${err.message}`);
      return false;
    }
  });

  ipcMain.handle('edit-task', async (event, lineIndex, newText, fileName) => {
    const filePath = getFilePath(fileName);
    try {
      if (!fs.existsSync(filePath)) return false;
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split(/\r?\n/);
      if (lineIndex >= 0 && lineIndex < lines.length) {
        const line = lines[lineIndex];
        const match = line.match(/^(\s*)-\s*(?:\[([ xX])\])?\s*(.*)$/);
        if (match) {
          const indentStr = match[1];
          const checkbox = match[2] !== undefined ? `[${match[2]}] ` : '';
          const newLine = `${indentStr}- ${checkbox}${newText}`;
          lines[lineIndex] = newLine;
          
          localWrites.set(path.basename(filePath), Date.now());
          fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
          saveDailyTasksHistoryIfNeeded(fileName);
          logAction(`✏️ Отредактирована задача на строке ${lineIndex + 1}: "${newText}"`);
          scheduleGitSync();
          return true;
        }
      }
      return false;
    } catch (err) {
      logAction(`Ошибка редактирования задачи: ${err.message}`);
      return false;
    }
  });

  ipcMain.handle('add-subtask', async (event, parentLineIndex, subtaskText, fileName) => {
    const filePath = getFilePath(fileName);
    try {
      if (!fs.existsSync(filePath)) return false;
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split(/\r?\n/);
      if (parentLineIndex >= 0 && parentLineIndex < lines.length) {
        const parentLine = lines[parentLineIndex];
        const whitespaceMatch = parentLine.match(/^(\s*)/);
        const parentWhitespace = whitespaceMatch ? whitespaceMatch[1] : '';
        
        let indentIncrement = '    ';
        if (parentWhitespace.includes('\t')) {
          indentIncrement = '\t';
        }
        
        const subtaskLine = `${parentWhitespace}${indentIncrement}- [ ] ${subtaskText}`;
        const size = getTaskBlockSize(lines, parentLineIndex);
        const insertIndex = parentLineIndex + size;
        
        lines.splice(insertIndex, 0, subtaskLine);
        lines[parentLineIndex] = setTaskDoneState(lines[parentLineIndex], false);
        updateParentCompletion(lines, parentLineIndex);
        localWrites.set(path.basename(filePath), Date.now());
        fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
        saveDailyTasksHistoryIfNeeded(fileName);
        logAction(`↳ Добавлена подзадача к строке ${parentLineIndex + 1}: "${subtaskText}"`);
        scheduleGitSync();
        return true;
      }
      return false;
    } catch (err) {
      logAction(`Ошибка добавления подзадачи: ${err.message}`);
      return false;
    }
  });

  ipcMain.handle('pin-task', async (event, lineIndex, parentLineIndex, fileName) => {
    const filePath = getFilePath(fileName);
    try {
      if (!fs.existsSync(filePath)) return false;
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split(/\r?\n/);
      if (lineIndex >= 0 && lineIndex < lines.length) {
        const size = getTaskBlockSize(lines, lineIndex);
        const taskBlock = lines.splice(lineIndex, size);
        
        if (parentLineIndex === null || parentLineIndex === undefined || parentLineIndex < 0) {
          lines.splice(0, 0, ...taskBlock);
          logAction(`📌 Задача со строки ${lineIndex + 1} закреплена в самый верх файла`);
        } else {
          let actualParentIndex = parentLineIndex;
          if (lineIndex < parentLineIndex) {
            actualParentIndex -= size;
          }
          lines.splice(actualParentIndex + 1, 0, ...taskBlock);
          logAction(`📌 Подзадача со строки ${lineIndex + 1} закреплена наверху у родителя на строке ${actualParentIndex + 1}`);
        }
        
        localWrites.set(path.basename(filePath), Date.now());
        fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
        saveDailyTasksHistoryIfNeeded(fileName);
        scheduleGitSync();
        return true;
      }
      return false;
    } catch (err) {
      logAction(`Ошибка приоритезации задачи: ${err.message}`);
      return false;
    }
  });

  ipcMain.handle('move-task', async (event, sourceLineIndex, targetLineIndex, position, fileName) => {
    const filePath = getFilePath(fileName);
    try {
      if (!fs.existsSync(filePath)) return false;
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split(/\r?\n/);
      
      if (sourceLineIndex < 0 || sourceLineIndex >= lines.length) {
        return false;
      }
      
      const size = getTaskBlockSize(lines, sourceLineIndex);
      
      // Safety Check: Prevent nesting a parent inside its own descendants
      if (targetLineIndex >= sourceLineIndex && targetLineIndex < sourceLineIndex + size) {
        logAction(`⚠️ Попытка переместить задачу саму в себя или в свои подзадачи.`);
        return false;
      }
      
      const oldParentLineIndex = getParentIndex(lines, sourceLineIndex);
      
      // Extract block
      const block = lines.splice(sourceLineIndex, size);
      
      // Adjust target line index after splice
      let adjustedTargetIndex = targetLineIndex;
      if (sourceLineIndex < targetLineIndex) {
        adjustedTargetIndex -= size;
      }
      
      if (adjustedTargetIndex < 0 || adjustedTargetIndex > lines.length) {
        return false;
      }
      
      // Calculate delta indent
      const rootLine = block[0];
      const rootIndent = getLineIndent(rootLine);
      
      let newIndent = 0;
      let insertIndex = adjustedTargetIndex;
      
      if (position === 'inside') {
        const targetLine = lines[adjustedTargetIndex];
        const targetIndent = getLineIndent(targetLine);
        newIndent = targetIndent + 1;
        
        const targetBlockSize = getTaskBlockSize(lines, adjustedTargetIndex);
        insertIndex = adjustedTargetIndex + targetBlockSize;
        
        // Ensure parent is not completed
        lines[adjustedTargetIndex] = setTaskDoneState(lines[adjustedTargetIndex], false);
      } else if (position === 'before') {
        const targetLine = lines[adjustedTargetIndex];
        newIndent = getLineIndent(targetLine);
        insertIndex = adjustedTargetIndex;
      } else if (position === 'after') {
        const targetLine = lines[adjustedTargetIndex];
        newIndent = getLineIndent(targetLine);
        const targetBlockSize = getTaskBlockSize(lines, adjustedTargetIndex);
        insertIndex = adjustedTargetIndex + targetBlockSize;
      }
      
      const delta = newIndent - rootIndent;
      const shiftedBlock = shiftBlockIndent(block, delta);
      
      lines.splice(insertIndex, 0, ...shiftedBlock);
      
      // Adjust oldParentLineIndex if it was after the insertion point (or if the insertion shifted it)
      let adjustedOldParentIndex = oldParentLineIndex;
      if (oldParentLineIndex >= 0) {
        if (sourceLineIndex < oldParentLineIndex) {
          adjustedOldParentIndex -= size;
        }
        if (insertIndex <= adjustedOldParentIndex) {
          adjustedOldParentIndex += size;
        }
      }
      
      // Update parent completions
      if (adjustedOldParentIndex >= 0) {
        updateParentCompletion(lines, adjustedOldParentIndex);
      }
      updateParentCompletion(lines, insertIndex);
      
      localWrites.set(path.basename(filePath), Date.now());
      fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
      saveDailyTasksHistoryIfNeeded(fileName);
      logAction(`↕ Перемещена задача со строки ${sourceLineIndex + 1} в позицию "${position}" относительно строки ${targetLineIndex + 1}`);
      scheduleGitSync();
      return true;
    } catch (err) {
      logAction(`Ошибка перемещения задачи: ${err.message}`);
      return false;
    }
  });

  ipcMain.handle('move-task-to-file', async (event, sourceFileName, lineIndex, targetFileName) => {
    const sourcePath = getFilePath(sourceFileName);
    const targetPath = getFilePath(targetFileName);
    try {
      if (!fs.existsSync(sourcePath) || !fs.existsSync(targetPath)) return false;
      const sourceContent = fs.readFileSync(sourcePath, 'utf-8');
      const sourceLines = sourceContent.split(/\r?\n/);
      
      if (lineIndex >= 0 && lineIndex < sourceLines.length) {
        const size = getTaskBlockSize(sourceLines, lineIndex);
        const taskBlock = sourceLines.splice(lineIndex, size);
        
        // Strip base indentation from the moved block so it becomes a root task
        const baseWhitespaceMatch = taskBlock[0].match(/^(\s*)/);
        const baseWhitespace = baseWhitespaceMatch ? baseWhitespaceMatch[1] : '';
        if (baseWhitespace) {
          for (let i = 0; i < taskBlock.length; i++) {
            if (taskBlock[i].startsWith(baseWhitespace)) {
              taskBlock[i] = taskBlock[i].slice(baseWhitespace.length);
            }
          }
        }
        
        localWrites.set(path.basename(sourcePath), Date.now());
        fs.writeFileSync(sourcePath, sourceLines.join('\n'), 'utf-8');
        
        let targetContent = fs.readFileSync(targetPath, 'utf-8');
        if (targetContent.length > 0 && !targetContent.endsWith('\n')) {
          targetContent += '\n';
        }
        targetContent += taskBlock.join('\n') + '\n';
        localWrites.set(path.basename(targetPath), Date.now());
        fs.writeFileSync(targetPath, targetContent, 'utf-8');
        
        logAction(`📂 Перенесена задача со строки ${lineIndex + 1} из "${sourceFileName}" в "${targetFileName}"`);
        scheduleGitSync();
        return true;
      }
      return false;
    } catch (err) {
      logAction(`Ошибка переноса задачи: ${err.message}`);
      return false;
    }
  });

  ipcMain.handle('log-action', (event, message) => {
    logAction(message);
  });

  ipcMain.handle('add-income', (event, amount, newTotal) => {
    logAction(`💰 Добавлен доход: ${amount.toLocaleString('ru-RU')} ₽ → личный капитал: ${newTotal.toLocaleString('ru-RU')} ₽`);
  });

  // Settings & Break Window Handlers
  ipcMain.handle('select-media-file', async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Выберите картинку или видео для перерыва',
      filters: [
        { name: 'Медиа файлы', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'mp4', 'webm', 'mov'] }
      ],
      properties: ['openFile']
    });
    
    if (!result.canceled && result.filePaths.length > 0) {
      return result.filePaths[0];
    }
    return null;
  });

  ipcMain.handle('show-break-window', (event, mediaPath, accentColor, accentHover, sound) => {
    if (breakWindow) {
      breakWindow.focus();
      return;
    }
    
    const query = new URLSearchParams();
    if (mediaPath) query.set('media', mediaPath);
    if (accentColor) query.set('accent', accentColor);
    if (accentHover) query.set('hover', accentHover);
    if (sound) query.set('sound', sound);
    
    breakWindow = new BrowserWindow({
      width: 800,
      height: 600,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      fullscreen: true,
      backgroundColor: '#00000000',
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
      }
    });
    
    breakWindow.loadURL(`file://${path.join(__dirname, 'break.html')}?${query.toString()}`);
    
    breakWindow.on('closed', () => {
      breakWindow = null;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('break-window-closed');
      }
    });
  });

  // Analytics Window Handlers
  ipcMain.handle('get-daily-history', async () => {
    const historyPath = path.join(TARGET_DIR, 'daily-history.json');
    try {
      if (fs.existsSync(historyPath)) {
        return JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
      }
    } catch (e) {
      logAction(`Ошибка чтения истории: ${e.message}`);
    }
    return {};
  });

  ipcMain.handle('show-analytics-window', (event, accentColor, accentHover) => {
    if (analyticsWindow) {
      analyticsWindow.focus();
      return;
    }
    
    const query = new URLSearchParams();
    if (accentColor) query.set('accent', accentColor);
    if (accentHover) query.set('hover', accentHover);
    
    analyticsWindow = new BrowserWindow({
      width: 720,
      height: 520,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: true,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
      }
    });
    
    analyticsWindow.loadURL(`file://${path.join(__dirname, 'analytics.html')}?${query.toString()}`);
    
    analyticsWindow.on('closed', () => {
      analyticsWindow = null;
    });
  });

  // Trading Journal handlers will use the global TRADING_* constants and ensureTradingDir()

  ipcMain.handle('get-trading-data', async () => {
    ensureTradingDir();
    try {
      if (fs.existsSync(TRADING_DB_PATH)) {
        return JSON.parse(fs.readFileSync(TRADING_DB_PATH, 'utf-8'));
      }
    } catch (e) {
      logAction(`Ошибка чтения базы сделок: ${e.message}`);
    }
    return {
      deposit: 100000,
      settings: {
        maxRiskPerTradePercent: 2,
        maxRiskPerMonthPercent: 6
      },
      trades: []
    };
  });

  ipcMain.handle('save-trading-data', async (event, data) => {
    ensureTradingDir();
    try {
      fs.writeFileSync(TRADING_DB_PATH, JSON.stringify(data, null, 2), 'utf-8');
      return true;
    } catch (e) {
      logAction(`Ошибка записи базы сделок: ${e.message}`);
      return false;
    }
  });

  ipcMain.handle('save-trade-screenshot', async (event, tradeId, imageBase64, type) => {
    ensureTradingDir();
    try {
      const matches = imageBase64.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
      if (!matches || matches.length !== 3) {
        throw new Error('Некорректный формат base64');
      }
      const mimeType = matches[1];
      const buffer = Buffer.from(matches[2], 'base64');
      
      let ext = 'png';
      if (mimeType.includes('jpeg') || mimeType.includes('jpg')) ext = 'jpg';
      else if (mimeType.includes('webp')) ext = 'webp';
      else if (mimeType.includes('gif')) ext = 'gif';
      
      const filename = `trade_${tradeId}_${type}.${ext}`;
      const filepath = path.join(TRADING_IMAGES_DIR, filename);
      
      fs.writeFileSync(filepath, buffer);
      
      // Return absolute file URL
      const fileUrl = `file:///${filepath.replace(/\\/g, '/')}`;
      return { success: true, url: fileUrl, filename: filename };
    } catch (e) {
      logAction(`Ошибка сохранения скриншота: ${e.message}`);
      return { success: false, error: e.message };
    }
  });

  // syncTBankTickers is defined globally

  ipcMain.handle('get-synced-tickers', async () => {
    ensureTradingDir();
    try {
      if (fs.existsSync(TRADING_TICKERS_PATH)) {
        return JSON.parse(fs.readFileSync(TRADING_TICKERS_PATH, 'utf-8'));
      }
    } catch (e) {}
    return [];
  });

  ipcMain.handle('get-ticker-price', async (event, tickerName) => {
    const config = loadConfig();
    const token = config.tbankToken;
    if (!token) return null;
    
    ensureTradingDir();
    try {
      let figi = null;
      if (fs.existsSync(TRADING_TICKERS_PATH)) {
        const tickers = JSON.parse(fs.readFileSync(TRADING_TICKERS_PATH, 'utf-8'));
        const found = tickers.find(t => t.name === tickerName.toUpperCase());
        if (found) figi = found.figi;
      }
      
      // Fallback figi dictionary for popular assets
      if (!figi) {
        const popularFigis = {
          'SBER': 'BBG004730N88',
          'SBERP': 'BBG004730DP9',
          'GAZP': 'BBG004730RP0',
          'LKOH': 'BBG004731032',
          'ROSN': 'BBG004730ZJ9',
          'VTBR': 'BBG004730JJ2',
          'YNDX': 'BBG006L8G4H1',
          'GMKN': 'BBG004731489',
          'AFLT': 'BBG004730G32',
          'MGNT': 'BBG0047315Y7',
          'TATN': 'BBG0047315D0'
        };
        figi = popularFigis[tickerName.toUpperCase()];
      }
      
      if (!figi) return null;
      
      const response = await fetch('https://invest-public-api.tinkoff.ru/rest/tinkoff.public.invest.api.contract.v1.MarketDataService/GetLastPrices', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ figi: [figi] })
      });
      
      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }
      
      const result = await response.json();
      if (result.lastPrices && result.lastPrices.length > 0) {
        const priceObj = result.lastPrices[0].price;
        if (priceObj) {
          const units = parseInt(priceObj.units) || 0;
          const nano = parseInt(priceObj.nano) || 0;
          const finalPrice = units + (nano / 1e9);
          return finalPrice;
        }
      }
      return null;
    } catch (e) {
      logAction(`Ошибка получения цены для ${tickerName}: ${e.message}`);
      return null;
    }
  });

  ipcMain.handle('get-tbank-token', async () => {
    const config = loadConfig();
    return config.tbankToken || '';
  });

  ipcMain.handle('save-tbank-token', async (event, token) => {
    try {
      saveConfigValue({ tbankToken: token });
      if (token) {
        // Run background sync immediately
        syncTBankTickers(token).then(res => {
          if (res.success) {
            logAction(`Авто-синхронизация при сохранении токена успешна. Загружено ${res.count} тикеров.`);
          }
        });
      }
      return true;
    } catch (e) {
      logAction(`Ошибка сохранения токена Т-Банка: ${e.message}`);
      return false;
    }
  });

  ipcMain.handle('sync-tbank-tickers', async () => {
    const config = loadConfig();
    const token = config.tbankToken;
    if (!token) return { success: false, error: 'Токен отсутствует. Сохраните сначала токен.' };
    return await syncTBankTickers(token);
  });

  ipcMain.handle('open-trading-journal', (event) => {
    if (tradingJournalWindow) {
      tradingJournalWindow.focus();
      return;
    }
    
    tradingJournalWindow = new BrowserWindow({
      width: 1100,
      height: 750,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'preload.js'),
        webSecurity: false // allow loading local images using file://
      }
    });
    
    tradingJournalWindow.loadFile(path.join(__dirname, 'app', 'frontend.html'));
    
    tradingJournalWindow.on('closed', () => {
      tradingJournalWindow = null;
    });
  });

  // ==========================================
  // Connections Widget (Мои связи) Handlers
  // ==========================================
  ipcMain.handle('get-gemini-key', async () => {
    const config = loadConfig();
    return config.geminiKey || '';
  });

  ipcMain.handle('save-gemini-key', async (event, key) => {
    try {
      saveConfigValue({ geminiKey: key });
      return true;
    } catch (e) {
      logAction(`Ошибка сохранения ключа Gemini: ${e.message}`);
      return false;
    }
  });

  ipcMain.handle('get-llm-config', async () => {
    const config = loadConfig();
    return {
      provider: config.llmProvider || 'gemini',
      geminiKey: config.geminiKey || '',
      localUrl: config.localLlmUrl || 'http://localhost:11434/v1',
      localModel: config.localLlmModel || 'llama3'
    };
  });

  ipcMain.handle('save-llm-config', async (event, data) => {
    try {
      saveConfigValue({
        llmProvider: data.provider,
        geminiKey: data.geminiKey,
        localLlmUrl: data.localUrl,
        localLlmModel: data.localModel
      });
      return true;
    } catch (e) {
      logAction(`Ошибка сохранения настроек ИИ: ${e.message}`);
      return false;
    }
  });

  ipcMain.handle('open-connections-window', (event) => {
    if (connectionsWindow) {
      connectionsWindow.focus();
      return;
    }
    
    connectionsWindow = new BrowserWindow({
      width: 980,
      height: 680,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'preload.js'),
        webSecurity: false
      }
    });
    
    connectionsWindow.loadFile(path.join(__dirname, 'app', 'connections.html'));
    
    connectionsWindow.on('closed', () => {
      connectionsWindow = null;
    });
  });

  ipcMain.handle('get-connections', async () => {
    try {
      if (!fs.existsSync(CONNECTIONS_DIR)) {
        fs.mkdirSync(CONNECTIONS_DIR, { recursive: true });
      }
      
      const getMDs = (dir) => {
        let results = [];
        if (!fs.existsSync(dir)) return results;
        const list = fs.readdirSync(dir);
        list.forEach(file => {
          const fullPath = path.join(dir, file);
          const stat = fs.statSync(fullPath);
          if (stat && stat.isDirectory()) {
            results = results.concat(getMDs(fullPath));
          } else if (file.endsWith('.md')) {
            const relPath = path.relative(CONNECTIONS_DIR, fullPath);
            const parentDir = path.dirname(relPath);
            const groupName = parentDir === '.' ? 'Общие' : parentDir;
            results.push({
              name: path.basename(file, '.md'),
              relativePath: relPath,
              fullPath: fullPath,
              group: groupName
            });
          }
        });
        return results;
      };
      
      return getMDs(CONNECTIONS_DIR);
    } catch (e) {
      logAction(`Ошибка получения связей: ${e.message}`);
      return [];
    }
  });

  ipcMain.handle('get-connection-detail', async (event, filePath) => {
    try {
      if (fs.existsSync(filePath)) {
        return fs.readFileSync(filePath, 'utf-8');
      }
      return '';
    } catch (e) {
      logAction(`Ошибка чтения карточки связи: ${e.message}`);
      return '';
    }
  });

  ipcMain.handle('save-connection-detail', async (event, filePath, content) => {
    try {
      const filename = path.basename(filePath);
      localWrites.set(filename, Date.now());
      fs.writeFileSync(filePath, content, 'utf-8');
      logAction(`💾 Сохранена карточка связи: ${filename}`);
      scheduleGitSync();
      return true;
    } catch (e) {
      logAction(`Ошибка сохранения карточки связи: ${e.message}`);
      return false;
    }
  });

  ipcMain.handle('create-connection', async (event, fileName, parentDir) => {
    try {
      const safeName = fileName.replace(/[\/\\:\*\?"<>\|]/g, '').trim();
      if (!safeName) return false;
      
      const dirPath = parentDir ? path.join(CONNECTIONS_DIR, parentDir) : CONNECTIONS_DIR;
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
      }
      
      const filePath = path.join(dirPath, `${safeName}.md`);
      if (fs.existsSync(filePath)) return false;

      // Scan existing cards for PER-XXX IDs to auto-increment
      let nextNum = 1;
      try {
        if (fs.existsSync(CONNECTIONS_DIR)) {
          const scanDir = (dir) => {
            const list = fs.readdirSync(dir);
            list.forEach(file => {
              const fullPath = path.join(dir, file);
              const stat = fs.statSync(fullPath);
              if (stat.isDirectory()) {
                scanDir(fullPath);
              } else if (file.endsWith('.md')) {
                const content = fs.readFileSync(fullPath, 'utf-8');
                const idMatch = content.match(/id:\s*PER-(\d+)/i);
                if (idMatch) {
                  const num = parseInt(idMatch[1]);
                  if (num >= nextNum) {
                    nextNum = num + 1;
                  }
                }
              }
            });
          };
          scanDir(CONNECTIONS_DIR);
        }
      } catch (e) {
        logAction(`Ошибка при расчете следующего ID контакта: ${e.message}`);
      }
      const nextId = `PER-${String(nextNum).padStart(3, '0')}`;
      
      const defaultTemplate = `---
id: ${nextId}
статус: друг
город: 
телефон: 
день_рождения: MM-DD
дата_знакомства: YYYY-MM-DD
последний_контакт: YYYY-MM-DD
частота_поддежки_связей_дней: 30
сила_связи: 
---

# ${safeName}
## О человеке

- **Работа:** Должность, Компания
- **Интересы:** 
- **Что обсуждаем:** 

## Знакомство

- **Где:** 
- **Как:** 

## Контакты

| Дата | Канал | О чём |
|------|-------|-------|
| | | |

## Связи

- [[Имя]] — как связаны

## Заметки

- 
`;
      
      const filename = path.basename(filePath);
      localWrites.set(filename, Date.now());
      fs.writeFileSync(filePath, defaultTemplate, 'utf-8');
      logAction(`🤝 Создана новая карточка связи: ${safeName}.md`);
      scheduleGitSync();
      return true;
    } catch (e) {
      logAction(`Ошибка создания связи: ${e.message}`);
      return false;
    }
  });

  ipcMain.handle('delete-connection', async (event, filePath) => {
    try {
      if (fs.existsSync(filePath)) {
        const filename = path.basename(filePath);
        localWrites.set(filename, Date.now());
        fs.unlinkSync(filePath);
        logAction(`🗑️ Удалена карточка связи: ${filename}`);
        scheduleGitSync();
        return true;
      }
      return false;
    } catch (e) {
      logAction(`Ошибка удаления связи: ${e.message}`);
      return false;
    }
  });

  ipcMain.handle('analyze-connection', async (event, filePath, userCommand) => {
    try {
      const config = loadConfig();
      const provider = config.llmProvider || 'gemini';
      
      if (provider === 'gemini' && !config.geminiKey) {
        return { success: false, error: 'no-key' };
      }
      if (provider === 'local' && !config.localLlmUrl) {
        return { success: false, error: 'no-local-url' };
      }
      
      if (!fs.existsSync(filePath)) {
        return { success: false, error: 'Файл не найден' };
      }
      
      const content = fs.readFileSync(filePath, 'utf-8');
      const filename = path.basename(filePath, '.md');
      
      logAction(`🤖 Запуск ИИ-анализа (${provider}) для связи: ${filename}${userCommand ? ' [Команда: ' + userCommand + ']' : ''}`);
      
      let prompt = '';
      if (userCommand) {
        prompt = `Ты — AI-ассистент по нетворкингу и ведению картотеки контактов в Obsidian.
Твоя задача — изменить или дополнить карточку контакта в формате Markdown на основе команды/инструкции пользователя.

Текущая карточка:
"""markdown
${content}
"""

Команда пользователя: "${userCommand}"

Правила:
1. Верни ТОЛЬКО обновленный текст карточки в формате Markdown.
2. Сохрани оригинальную структуру YAML frontmatter (между ---) и все разделы шаблона.
3. Не добавляй никаких вступительных или заключительных слов (например, "Вот обновленная карточка:"), не используй обрамление \`\`\`markdown ... \`\`\` в качестве внешнего контейнера для всего ответа — верни только чистый текст файла.`;
      } else {
        prompt = `Ты — AI-ассистент по нетворкингу и социальным связям. Проанализируй карточку контакта из Obsidian и предложи конкретные, практические идеи и дела для общения с этим человеком.
      
Имя контакта: ${filename}
Содержимое карточки:
\`\`\`markdown
${content}
\`\`\`

Твоя задача — составить план общения на русском языке. Ответ должен быть в красивом формате Markdown:
1. Краткий анализ отношений и интересов.
2. Темы для разговора и идеи для следующей встречи.
3. 2-3 конкретных действия/задачи. **ВАЖНО: Каждое действие/задачу начни со строгого префикса "СПИСОК_ДЕЛ: ", чтобы система могла их распознать и предложить добавить в дела.** Например:
СПИСОК_ДЕЛ: Позвонить ${filename} и узнать как дела с собакой
СПИСОК_ДЕЛ: Предложить ${filename} попить кофе на выходных`;
      }

      let text = '';
      if (provider === 'gemini') {
        const apiKey = config.geminiKey;
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            contents: [{
              parts: [{
                text: prompt
              }]
            }]
          })
        });
        
        if (!response.ok) {
          throw new Error(`Gemini API вернул код ${response.status}`);
        }
        
        const data = await response.json();
        if (data.candidates && data.candidates.length > 0 && data.candidates[0].content && data.candidates[0].content.parts && data.candidates[0].content.parts.length > 0) {
          text = data.candidates[0].content.parts[0].text;
        } else {
          throw new Error('Некорректный ответ от API Gemini');
        }
      } else {
        // Local LLM (OpenAI-compatible)
        const localUrl = config.localLlmUrl || 'http://localhost:11434/v1';
        const model = config.localLlmModel || 'llama3';
        const baseUrl = localUrl.endsWith('/') ? localUrl.slice(0, -1) : localUrl;
        const fullUrl = `${baseUrl}/chat/completions`;
        
        logAction(`🤖 Запрос к локальной LLM (${model}) по адресу: ${fullUrl}`);
        
        const response = await fetch(fullUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: model,
            messages: [
              {
                role: 'user',
                content: prompt
              }
            ],
            temperature: 0.7
          })
        });
        
        if (!response.ok) {
          throw new Error(`Локальный LLM вернул код ${response.status}`);
        }
        
        const data = await response.json();
        if (data.choices && data.choices.length > 0 && data.choices[0].message && data.choices[0].message.content) {
          text = data.choices[0].message.content;
        } else {
          throw new Error('Некорректный ответ от локального LLM');
        }
      }

      const fileBase = path.basename(filePath);
      localWrites.set(fileBase, Date.now());

      if (userCommand) {
        // Clean markdown backticks wrapper if any
        let responseText = text.trim();
        if (responseText.startsWith('\`\`\`markdown')) {
          responseText = responseText.substring(11).trim();
        } else if (responseText.startsWith('\`\`\`')) {
          responseText = responseText.substring(3).trim();
        }
        if (responseText.endsWith('\`\`\`')) {
          responseText = responseText.substring(0, responseText.length - 3).trim();
        }
        
        fs.writeFileSync(filePath, responseText, 'utf-8');
        logAction(`🤖 Карточка изменена по ИИ-команде для ${filename}`);
        scheduleGitSync();
        return { success: true, text: responseText, isCommand: true };
      } else {
        let updatedContent = content;
        const sectionHeader = '\n\n## План общения (ИИ)\n';
        const sectionIndex = content.indexOf('## План общения (ИИ)');
        if (sectionIndex !== -1) {
          updatedContent = content.substring(0, sectionIndex) + '## План общения (ИИ)\n' + text;
        } else {
          updatedContent = content + sectionHeader + text;
        }
        
        fs.writeFileSync(filePath, updatedContent, 'utf-8');
        logAction(`🤖 План общения сохранен в карточку для ${filename}`);
        scheduleGitSync();
        return { success: true, text: text, isCommand: false };
      }
      
    } catch (e) {
      logAction(`Ошибка ИИ-анализа: ${e.message}`);
      return { success: false, error: e.message };
    }
  });

  // ==========================================
  // Future Canvas Handlers
  // ==========================================

  ipcMain.handle('open-future-canvas', (event) => {
    if (futureCanvasWindow) {
      futureCanvasWindow.focus();
      return;
    }

    futureCanvasWindow = new BrowserWindow({
      width: 1280,
      height: 800,
      minWidth: 900,
      minHeight: 600,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'preload.js')
      }
    });

    futureCanvasWindow.loadFile(path.join(__dirname, 'app', 'future-canvas', 'future-canvas.html'));

    futureCanvasWindow.on('maximize', () => {
      if (futureCanvasWindow && !futureCanvasWindow.isDestroyed()) {
        futureCanvasWindow.webContents.send('window-state-change', true);
      }
    });
    futureCanvasWindow.on('unmaximize', () => {
      if (futureCanvasWindow && !futureCanvasWindow.isDestroyed()) {
        futureCanvasWindow.webContents.send('window-state-change', false);
      }
    });

    futureCanvasWindow.on('closed', () => {
      futureCanvasWindow = null;
    });
  });

  ipcMain.handle('minimize-window', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) win.minimize();
  });

  ipcMain.handle('toggle-maximize-window', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      if (win.isMaximized()) {
        win.unmaximize();
      } else {
        win.maximize();
      }
    }
  });

  ipcMain.handle('get-canvas-boards', async () => {
    ensureCanvasDir();
    try {
      const files = fs.readdirSync(CANVAS_DIR)
        .filter(f => f.endsWith('.json'))
        .map(f => {
          const filePath = path.join(CANVAS_DIR, f);
          try {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            return { id: path.basename(f, '.json'), name: data.name || path.basename(f, '.json'), createdAt: data.createdAt || null };
          } catch (e) {
            return { id: path.basename(f, '.json'), name: path.basename(f, '.json'), createdAt: null };
          }
        });

      if (files.length === 0) {
        const defaultBoard = {
          id: 'personal',
          name: 'Личная доска',
          createdAt: new Date().toISOString(),
          nodes: [],
          connections: [],
          spheres: [
            { id: 'work', name: 'Работа', color: '#5B7A9D', visible: true },
            { id: 'trading', name: 'Трейдинг', color: '#00dbe7', visible: true },
            { id: 'health', name: 'Здоровье', color: '#00e676', visible: true },
            { id: 'lumifi', name: 'LumiFi', color: '#a186f1', visible: true }
          ],
          viewport: { panX: 0, panY: 0, scale: 1 }
        };
        fs.writeFileSync(path.join(CANVAS_DIR, 'personal.json'), JSON.stringify(defaultBoard, null, 2), 'utf-8');
        logAction('📐 Создана доска Future Canvas по умолчанию: personal');
        return [{ id: 'personal', name: 'Личная доска', createdAt: defaultBoard.createdAt }];
      }

      return files;
    } catch (e) {
      logAction(`Ошибка чтения досок Future Canvas: ${e.message}`);
      return [];
    }
  });

  ipcMain.handle('get-canvas-board-data', async (event, boardId) => {
    ensureCanvasDir();
    try {
      const filePath = path.join(CANVAS_DIR, `${boardId}.json`);
      if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      }
      return null;
    } catch (e) {
      logAction(`Ошибка чтения доски ${boardId}: ${e.message}`);
      return null;
    }
  });

  ipcMain.handle('save-canvas-board-data', async (event, boardId, data) => {
    ensureCanvasDir();
    try {
      const filePath = path.join(CANVAS_DIR, `${boardId}.json`);
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
      return true;
    } catch (e) {
      logAction(`Ошибка сохранения доски ${boardId}: ${e.message}`);
      return false;
    }
  });

  ipcMain.handle('create-canvas-board', async (event, name) => {
    ensureCanvasDir();
    try {
      const id = name.toLowerCase().replace(/[^a-zа-яё0-9]/gi, '_').replace(/_+/g, '_').substring(0, 50) || 'board';
      let finalId = id;
      let counter = 1;
      while (fs.existsSync(path.join(CANVAS_DIR, `${finalId}.json`))) {
        finalId = `${id}_${counter}`;
        counter++;
      }
      const board = {
        id: finalId,
        name: name,
        createdAt: new Date().toISOString(),
        nodes: [],
        connections: [],
        spheres: [
          { id: 'work', name: 'Работа', color: '#5B7A9D', visible: true },
          { id: 'trading', name: 'Трейдинг', color: '#00dbe7', visible: true },
          { id: 'health', name: 'Здоровье', color: '#00e676', visible: true },
          { id: 'lumifi', name: 'LumiFi', color: '#a186f1', visible: true }
        ],
        viewport: { panX: 0, panY: 0, scale: 1 }
      };
      fs.writeFileSync(path.join(CANVAS_DIR, `${finalId}.json`), JSON.stringify(board, null, 2), 'utf-8');
      logAction(`📐 Создана новая доска Future Canvas: ${name} (${finalId})`);
      return { id: finalId, name: name };
    } catch (e) {
      logAction(`Ошибка создания доски: ${e.message}`);
      return null;
    }
  });

  ipcMain.handle('rename-canvas-board', async (event, boardId, newName) => {
    ensureCanvasDir();
    try {
      const filePath = path.join(CANVAS_DIR, `${boardId}.json`);
      if (!fs.existsSync(filePath)) return false;
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      data.name = newName;
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
      logAction(`📐 Доска переименована: ${boardId} → ${newName}`);
      return true;
    } catch (e) {
      logAction(`Ошибка переименования доски: ${e.message}`);
      return false;
    }
  });

  ipcMain.handle('delete-canvas-board', async (event, boardId) => {
    ensureCanvasDir();
    try {
      const filePath = path.join(CANVAS_DIR, `${boardId}.json`);
      if (!fs.existsSync(filePath)) return false;
      fs.unlinkSync(filePath);
      logAction(`🗑️ Удалена доска Future Canvas: ${boardId}`);
      return true;
    } catch (e) {
      logAction(`Ошибка удаления доски: ${e.message}`);
      return false;
    }
  });
}

// Global context menu for text fields (Cut, Copy, Paste, Select All)
app.on('web-contents-created', (event, contents) => {
  // Global developer shortcuts (Ctrl+R to reload, Ctrl+Shift+I to toggle DevTools)
  contents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown') {
      if (input.control && input.key.toLowerCase() === 'r') {
        contents.reload();
        e.preventDefault();
      }
      if (input.control && input.shift && input.key.toLowerCase() === 'i') {
        contents.toggleDevTools();
        e.preventDefault();
      }
    }
  });

  contents.on('context-menu', (e, params) => {
    const menu = new Menu();

    if (params.dictionarySuggestions && params.dictionarySuggestions.length > 0) {
      for (const suggestion of params.dictionarySuggestions) {
        menu.append(new MenuItem({
          label: suggestion,
          click: () => contents.replaceMisspelling(suggestion)
        }));
      }
      menu.append(new MenuItem({ type: 'separator' }));
    }

    if (params.isEditable) {
      menu.append(new MenuItem({ label: 'Вырезать', role: 'cut' }));
      menu.append(new MenuItem({ label: 'Копировать', role: 'copy' }));
      menu.append(new MenuItem({ label: 'Вставить', role: 'paste' }));
      menu.append(new MenuItem({ type: 'separator' }));
      menu.append(new MenuItem({ label: 'Выделить всё', role: 'selectall' }));
    } else if (params.selectionText && params.selectionText.trim() !== '') {
      menu.append(new MenuItem({ label: 'Копировать', role: 'copy' }));
      menu.append(new MenuItem({ type: 'separator' }));
      menu.append(new MenuItem({ label: 'Выделить всё', role: 'selectall' }));
    } else {
      return;
    }

    menu.popup({ window: BrowserWindow.fromWebContents(contents) });
  });
});

app.whenReady().then(() => {
  setupHandlers();
  startFileWatcher();
  createWindow();
  
  // Запуск фоновой синхронизации Git при старте приложения через 2 секунды
  setTimeout(() => {
    triggerGitSync().catch(err => logAction(`Ошибка автосинка при старте: ${err.message}`));
  }, 2000);

  // Периодический опрос обновлений Git каждые 10 минут
  setInterval(() => {
    triggerGitSync().catch(err => logAction(`Ошибка периодического автосинка: ${err.message}`));
  }, 10 * 60 * 1000);
  
  // Asynchronously sync tickers 5 seconds after startup if token exists
  const config = loadConfig();
  if (config.tbankToken) {
    setTimeout(() => {
      syncTBankTickers(config.tbankToken).then(res => {
        if (res.success) {
          logAction(`Авто-синхронизация при запуске успешна. Обновлено ${res.count} тикеров с актуальной стоимостью шага.`);
        }
      }).catch(() => {});
    }, 5000);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
