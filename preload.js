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
  onDayChanged: (callback) => ipcRenderer.on('day-changed', (event, today) => callback(today)),
  onExternalFileChange: (callback) => ipcRenderer.on('external-file-change', (event, filename) => callback(filename)),
  onTaskAddedExternally: (callback) => ipcRenderer.on('task-added-externally', (event, data) => callback(data)),
  moveTask: (sourceLineIndex, targetLineIndex, position, fileName) => ipcRenderer.invoke('move-task', sourceLineIndex, targetLineIndex, position, fileName),

  // Trading Journal additions
  openTradingJournal: () => ipcRenderer.invoke('open-trading-journal'),
  getTradingData: () => ipcRenderer.invoke('get-trading-data'),
  saveTradingData: (data) => ipcRenderer.invoke('save-trading-data', data),
  saveTradeScreenshot: (tradeId, imageBase64, type) => ipcRenderer.invoke('save-trade-screenshot', tradeId, imageBase64, type),
  getTBankToken: () => ipcRenderer.invoke('get-tbank-token'),
  saveTBankToken: (token) => ipcRenderer.invoke('save-tbank-token', token),
  syncTBankTickers: () => ipcRenderer.invoke('sync-tbank-tickers'),
  getSyncedTickers: () => ipcRenderer.invoke('get-synced-tickers'),
  getTickerPrice: (ticker) => ipcRenderer.invoke('get-ticker-price', ticker),

  // Connections widget additions
  openConnectionsWindow: () => ipcRenderer.invoke('open-connections-window'),
  getConnections: () => ipcRenderer.invoke('get-connections'),
  getConnectionDetail: (filePath) => ipcRenderer.invoke('get-connection-detail', filePath),
  saveConnectionDetail: (filePath, content) => ipcRenderer.invoke('save-connection-detail', filePath, content),
  analyzeConnection: (filePath, userCommand) => ipcRenderer.invoke('analyze-connection', filePath, userCommand),
  getGeminiKey: () => ipcRenderer.invoke('get-gemini-key'),
  saveGeminiKey: (key) => ipcRenderer.invoke('save-gemini-key', key),
  getLLMConfig: () => ipcRenderer.invoke('get-llm-config'),
  saveLLMConfig: (data) => ipcRenderer.invoke('save-llm-config', data),
  createConnection: (fileName, parentDir) => ipcRenderer.invoke('create-connection', fileName, parentDir),
  deleteConnection: (filePath) => ipcRenderer.invoke('delete-connection', filePath),

  // Future Canvas additions
  openFutureCanvas: () => ipcRenderer.invoke('open-future-canvas'),
  minimizeWindow: () => ipcRenderer.invoke('minimize-window'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('toggle-maximize-window'),
  onWindowStateChange: (callback) => ipcRenderer.on('window-state-change', (event, isMaximized) => callback(isMaximized)),
  getCanvasBoards: () => ipcRenderer.invoke('get-canvas-boards'),
  getCanvasBoardData: (boardId) => ipcRenderer.invoke('get-canvas-board-data', boardId),
  saveCanvasBoardData: (boardId, data) => ipcRenderer.invoke('save-canvas-board-data', boardId, data),
  createCanvasBoard: (name) => ipcRenderer.invoke('create-canvas-board', name),
  renameCanvasBoard: (boardId, newName) => ipcRenderer.invoke('rename-canvas-board', boardId, newName),
  deleteCanvasBoard: (boardId) => ipcRenderer.invoke('delete-canvas-board', boardId),
  fetchUrl: (url) => ipcRenderer.invoke('fetch-url', url)
});
