const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow;

const TARGET_DIR = "C:\\Users\\HomePC\\Documents\\Obsidian\\Progects\\MyLife";
const DAILY_TASKS_FILE_NAME = "Ежедневные задачи";

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
    transparent: true,        // ← включаем прозрачность
    backgroundColor: '#00000000',  // ← полностью прозрачный фон (#00000000 = rgba(0,0,0,0))
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
  
  mainWindow.on('resize', () => {
    const bounds = mainWindow.getBounds();
    saveWindowBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
  });
  
  mainWindow.on('move', () => {
    const bounds = mainWindow.getBounds();
    saveWindowBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
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

function ensureDailyTasksReady() {
  const filePath = getFilePath(DAILY_TASKS_FILE_NAME);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, "- [ ] Утренняя проверка целей\n", "utf-8");
    return;
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split(/\r?\n/);
  const today = getTodayKey();
  const config = loadConfig();

  if (!hasOpenTasks(lines) && hasDoneTasks(lines) && config.dailyCompletionDate !== today) {
    fs.writeFileSync(filePath, resetDoneTasks(lines).join('\n'), 'utf-8');
    saveConfigValue({ dailyCompletionDate: null });
    logAction(`🔄 Ежедневные задачи обновлены на ${today}`);
  }
}

function maybeSaveDailyCompletion(fileName, lines) {
  if (fileName !== DAILY_TASKS_FILE_NAME) return;
  if (!hasOpenTasks(lines) && hasDoneTasks(lines)) {
    saveConfigValue({ dailyCompletionDate: getTodayKey() });
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

function setupHandlers() {
  ipcMain.handle('close-window', () => {
    if (mainWindow) mainWindow.close();
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
        fs.writeFileSync(filePath, "", "utf-8");
        logAction(`📂 Создан новый файл задач: ${fileName}.md`);
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
      fs.renameSync(oldPath, newPath);
      logAction(`📂 Файл задач переименован: ${oldName}.md → ${safeNewName}.md`);
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
      fs.unlinkSync(filePath);
      logAction(`🗑️ Удален файл задач: ${fileName}.md`);
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
        
      fs.writeFileSync(filePath, newContent, 'utf-8');
      logAction(`📝 Добавлена новая задача в начало ${path.basename(filePath)}: ${taskText}`);
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
        lines[lineIndex] = setTaskDoneState(line, shouldMarkDone);
        updateParentCompletion(lines, lineIndex);
        if (fileName === DAILY_TASKS_FILE_NAME) {
          const size = getTaskBlockSize(lines, lineIndex);
          const taskBlock = lines.splice(lineIndex, size);
          while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
            lines.pop();
          }
          lines.push(...taskBlock);
          maybeSaveDailyCompletion(fileName, lines);
        }
        fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
        logAction(`✅ Выполнена задача на строке ${lineIndex + 1} в ${path.basename(filePath)}`);
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
        
        fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
        logAction(`🗑️ Удалена задача (и её подзадачи, всего строк: ${size}) с индекса ${lineIndex + 1} в ${path.basename(filePath)}`);
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
          
          fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
          logAction(`✏️ Отредактирована задача на строке ${lineIndex + 1}: "${newText}"`);
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
        fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
        logAction(`↳ Добавлена подзадача к строке ${parentLineIndex + 1}: "${subtaskText}"`);
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
        
        fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
        return true;
      }
      return false;
    } catch (err) {
      logAction(`Ошибка приоритезации задачи: ${err.message}`);
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
        
        fs.writeFileSync(sourcePath, sourceLines.join('\n'), 'utf-8');
        
        let targetContent = fs.readFileSync(targetPath, 'utf-8');
        if (targetContent.length > 0 && !targetContent.endsWith('\n')) {
          targetContent += '\n';
        }
        targetContent += taskBlock.join('\n') + '\n';
        fs.writeFileSync(targetPath, targetContent, 'utf-8');
        
        logAction(`📂 Перенесена задача со строки ${lineIndex + 1} из "${sourceFileName}" в "${targetFileName}"`);
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
}

app.whenReady().then(() => {
  setupHandlers();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
