const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  readObsidianTasks: (fileName) => ipcRenderer.invoke('read-obsidian-tasks', fileName),
  markTaskDone: (lineIndex, fileName) => ipcRenderer.invoke('mark-task-done', lineIndex, fileName),
  addNewTask: (taskText, fileName) => ipcRenderer.invoke('add-new-task', taskText, fileName),
  logAction: (message) => ipcRenderer.invoke('log-action', message),
  addIncome: (amount, newTotal) => ipcRenderer.invoke('add-income', amount, newTotal),
  closeWindow: () => ipcRenderer.invoke('close-window'),
  onAppLoaded: (callback) => ipcRenderer.on('app-loaded', callback),
  resizeWindow: (width, height) => ipcRenderer.invoke('resize-window', width, height),
  deleteTask: (lineIndex, fileName) => ipcRenderer.invoke('delete-task', lineIndex, fileName),
  editTask: (lineIndex, newText, fileName) => ipcRenderer.invoke('edit-task', lineIndex, newText, fileName),
  addSubtask: (parentLineIndex, subtaskText, fileName) => ipcRenderer.invoke('add-subtask', parentLineIndex, subtaskText, fileName),
  pinTask: (lineIndex, parentLineIndex, fileName) => ipcRenderer.invoke('pin-task', lineIndex, parentLineIndex, fileName),
  getObsidianFiles: () => ipcRenderer.invoke('get-obsidian-files'),
  createObsidianFile: (fileName) => ipcRenderer.invoke('create-obsidian-file', fileName),
  renameObsidianFile: (oldName, newName) => ipcRenderer.invoke('rename-obsidian-file', oldName, newName),
  deleteObsidianFile: (fileName) => ipcRenderer.invoke('delete-obsidian-file', fileName),
  readDailyTasks: () => ipcRenderer.invoke('read-daily-tasks'),
  moveTaskToFile: (sourceFile, lineIndex, targetFile) => ipcRenderer.invoke('move-task-to-file', sourceFile, lineIndex, targetFile),
  
  // Settings, Breaks & Analytics additions
  selectMediaFile: () => ipcRenderer.invoke('select-media-file'),
  showBreakWindow: (mediaPath, accent, hover, sound) => ipcRenderer.invoke('show-break-window', mediaPath, accent, hover, sound),
  showAnalyticsWindow: (accent, hover) => ipcRenderer.invoke('show-analytics-window', accent, hover),
  onBreakWindowClosed: (callback) => ipcRenderer.on('break-window-closed', callback),
  onDayChanged: (callback) => ipcRenderer.on('day-changed', (event, today) => callback(today))
});
