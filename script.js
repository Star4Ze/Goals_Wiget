const STORAGE_KEY = 'widget_data';

function loadSavedData() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    try {
      const data = JSON.parse(saved);
      document.getElementById('personal').value = formatInput(data.personal || 800000);
      document.getElementById('managed').value = formatInput(data.managed || 200000);
      document.getElementById('personal-rate').value = data.personalRate || 14;
      document.getElementById('managed-rate').value = data.managedRate || 18;
      document.getElementById('target').value = formatInput(data.target || 5000000);
      if (data.deadline) document.getElementById('deadline').value = data.deadline;
      return data;
    } catch(e) {}
  }
  return null;
}

function saveAllData() {
  const data = {
    personal: parseMoney(document.getElementById('personal').value),
    managed: parseMoney(document.getElementById('managed').value),
    personalRate: parseFloat(document.getElementById('personal-rate').value),
    managedRate: parseFloat(document.getElementById('managed-rate').value),
    target: parseMoney(document.getElementById('target').value),
    deadline: document.getElementById('deadline').value,
    lastUpdated: new Date().toISOString()
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function formatMoney(n) {
  return Math.round(n).toLocaleString('ru-RU') + ' ₽';
}

function parseMoney(str) {
  if (!str) return 0;
  return parseFloat(str.toString().replace(/\s/g, '').replace(/₽/g, '')) || 0;
}

function formatInput(n) {
  return Math.round(n).toLocaleString('ru-RU');
}

function setupMoneyFields() {
  document.querySelectorAll('.money').forEach(input => {
    const val = parseMoney(input.value);
    input.value = formatInput(val);
    
    input.addEventListener('blur', function() {
      this.value = formatInput(parseMoney(this.value));
      calculate();
      saveAllData();
    });
    input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur(); });
  });
}

function setupDateField() {
  const deadline = document.getElementById('deadline');
  if (!deadline) return;

  const openPicker = () => {
    if (typeof deadline.showPicker === 'function') {
      try {
        deadline.showPicker();
      } catch (e) {
        deadline.focus();
      }
    } else {
      deadline.focus();
    }
  };

  deadline.addEventListener('click', openPicker);
  deadline.addEventListener('focus', openPicker);
}

let obsidianTasks = [];
let activeFileName = localStorage.getItem('active_task_file') || 'Дела';
let showAllTasks = localStorage.getItem('show_all_tasks') === 'true';
let dailyTasks = [];

let selectedTask = null;
let selectedTaskFileName = null;
let selectedFileName = null;
let activeSubtaskInputTaskId = null;
let activeEditTaskId = null;
let activeTriggerBtnRect = null;
var breakAlarmTimer = null;
var breakCountdownTimer = null;
var nextBreakAt = null;
var isBreakWindowOpen = false;

function getTaskKey(task, fileName) {
  return `${fileName}:${task.lineIndex}`;
}

function clamp(value, min, max) {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

function positionFloatingModal(modalContent, anchorRect) {
  const gap = 8;
  const margin = 12;
  modalContent.style.position = 'absolute';
  modalContent.style.left = '0px';
  modalContent.style.right = 'auto';
  modalContent.style.top = '0px';
  modalContent.style.bottom = 'auto';

  const modalRect = modalContent.getBoundingClientRect();
  const width = modalRect.width || 220;
  const height = modalRect.height || 180;
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const anchor = anchorRect || {
    left: (viewportWidth - width) / 2,
    right: (viewportWidth + width) / 2,
    top: (viewportHeight - height) / 2,
    bottom: (viewportHeight + height) / 2
  };

  const preferAbove = anchor.top > height + gap + margin;
  const top = preferAbove ? anchor.top - height - gap : anchor.bottom + gap;
  const left = anchor.right - width;

  modalContent.style.left = `${clamp(left, margin, viewportWidth - width - margin)}px`;
  modalContent.style.top = `${clamp(top, margin, viewportHeight - height - margin)}px`;
}

function positionDropdownBelow(modalContent, anchorRect) {
  const gap = 8;
  const margin = 12;
  modalContent.style.position = 'absolute';
  modalContent.style.left = '0px';
  modalContent.style.right = 'auto';
  modalContent.style.top = '0px';
  modalContent.style.bottom = 'auto';

  const modalRect = modalContent.getBoundingClientRect();
  const width = modalRect.width || 220;
  const height = modalRect.height || 180;
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const left = anchorRect.left + (anchorRect.width - width) / 2;
  const top = anchorRect.bottom + gap;
  const availableHeight = Math.max(120, viewportHeight - top - margin);

  modalContent.style.left = `${clamp(left, margin, viewportWidth - width - margin)}px`;
  modalContent.style.top = `${Math.max(margin, top)}px`;
  modalContent.style.maxHeight = `${availableHeight}px`;
  modalContent.style.overflow = 'hidden';
}

// Global click listener for click outside cancels
document.addEventListener('click', (e) => {
  if (activeSubtaskInputTaskId !== null) {
    const row = document.querySelector('.add-subtask-row');
    if (row && !row.contains(e.target) && !e.target.classList.contains('task-options-btn') && !e.target.classList.contains('modal-action-btn')) {
      activeSubtaskInputTaskId = null;
      renderTasks();
      renderDailyTasks();
    }
  }
  
  if (activeEditTaskId !== null) {
    const isEditClick = e.target.classList.contains('task-edit-input') || 
                        e.target.classList.contains('task-edit-save-btn') || 
                        e.target.classList.contains('task-edit-cancel-btn');
    if (!isEditClick && !e.target.classList.contains('task-options-btn') && !e.target.classList.contains('modal-action-btn')) {
      activeEditTaskId = null;
      renderTasks();
      renderDailyTasks();
    }
  }

  const inlineAddRow = document.getElementById('inline-add-task-row');
  const triggerBtn = document.getElementById('add-task-trigger-btn');
  if (inlineAddRow && !inlineAddRow.classList.contains('hidden') && triggerBtn) {
    const isClickInside = inlineAddRow.contains(e.target) || triggerBtn.contains(e.target);
    if (!isClickInside) {
      inlineAddRow.classList.add('hidden');
      document.getElementById('inline-new-task-input').value = '';
    }
  }

  const inlineDailyAddRow = document.getElementById('inline-add-daily-task-row');
  const dailyTriggerBtn = document.getElementById('add-daily-task-trigger-btn');
  if (inlineDailyAddRow && !inlineDailyAddRow.classList.contains('hidden') && dailyTriggerBtn) {
    const isClickInside = inlineDailyAddRow.contains(e.target) || dailyTriggerBtn.contains(e.target);
    if (!isClickInside) {
      inlineDailyAddRow.classList.add('hidden');
      document.getElementById('inline-new-daily-task-input').value = '';
    }
  }
});

async function selectActiveFile(fileName) {
  activeFileName = fileName;
  localStorage.setItem('active_task_file', fileName);
  const fileBtn = document.getElementById('active-file-btn');
  if (fileBtn) fileBtn.textContent = fileName;
  await loadObsidianTasks();
}

async function loadObsidianTasks() {
  if (window.electronAPI) {
    obsidianTasks = await window.electronAPI.readObsidianTasks(activeFileName);
    renderTasks();
  } else {
    obsidianTasks = [];
    renderTasks();
  }
}

async function loadDailyTasks() {
  if (window.electronAPI?.readDailyTasks) {
    dailyTasks = await window.electronAPI.readDailyTasks();
  } else {
    dailyTasks = [];
  }
  renderDailyTasks();
}

async function addNewTaskInline() {
  const input = document.getElementById('inline-new-task-input');
  const taskText = input.value.trim();
  if (!taskText) return;
  
  if (window.electronAPI) {
    const result = await window.electronAPI.addNewTask(taskText, activeFileName);
    if (result) {
      input.value = '';
      document.getElementById('inline-add-task-row')?.classList.add('hidden');
      await loadObsidianTasks();
    }
  }
}

async function addDailyTaskInline() {
  const input = document.getElementById('inline-new-daily-task-input');
  const taskText = input.value.trim();
  if (!taskText) return;
  
  if (window.electronAPI) {
    const result = await window.electronAPI.addNewTask(taskText, 'Ежедневные задачи');
    if (result) {
      input.value = '';
      document.getElementById('inline-add-daily-task-row')?.classList.add('hidden');
      await loadDailyTasks();
    }
  }
}

async function markTaskDone(task, fileName = activeFileName) {
  if (task.source === 'obsidian' && window.electronAPI) {
    await window.electronAPI.markTaskDone(task.lineIndex, fileName);
    if (fileName === 'Ежедневные задачи') {
      await loadDailyTasks();
    } else {
      await loadObsidianTasks();
    }
  }
  calculate();
}

function autoResizeWindow() {
  if (window.electronAPI && window.electronAPI.resizeWindow) {
    const container = document.querySelector('.container');
    const settingsModal = document.getElementById('settings-modal');
    const settingsContent = settingsModal?.querySelector('.settings-modal-content');
    const fileModal = document.getElementById('file-selector-modal');
    const fileModalContent = fileModal?.querySelector('.modal-content');
    
    let baseHeight = 0;
    if (container) {
      baseHeight = Math.ceil(container.getBoundingClientRect().height) + 38;
    }
    
    if (settingsModal && !settingsModal.classList.contains('hidden') && settingsContent) {
      const settingsHeight = Math.ceil(settingsContent.getBoundingClientRect().height) + 40;
      baseHeight = Math.max(baseHeight, settingsHeight);
    }
    
    if (fileModal && !fileModal.classList.contains('hidden') && fileModalContent) {
      const fileBtn = document.getElementById('active-file-btn');
      if (fileBtn) {
        const btnRect = fileBtn.getBoundingClientRect();
        // Temporarily clear any maxHeight restrictions to measure natural height
        const originalMaxHeight = fileModalContent.style.maxHeight;
        fileModalContent.style.maxHeight = 'none';
        const modalHeight = fileModalContent.scrollHeight || fileModalContent.getBoundingClientRect().height || 250;
        fileModalContent.style.maxHeight = originalMaxHeight;
        
        const requiredHeight = btnRect.bottom + modalHeight + 25;
        baseHeight = Math.max(baseHeight, requiredHeight);
      }
    }
    
    const width = 520;
    const height = Math.min(1024, baseHeight);
    window.electronAPI.resizeWindow(width, height);
  }
}

function setupCapitalToggle() {
  const toggle = document.getElementById('capital-toggle');
  const content = document.getElementById('capital-content');
  if (!toggle || !content) return;
  
  const isCollapsed = localStorage.getItem('capital_collapsed') === 'true';
  if (isCollapsed) {
    content.classList.add('collapsed');
  }
  
  toggle.addEventListener('click', () => {
    const willCollapse = !content.classList.contains('collapsed');
    if (willCollapse) {
      content.classList.add('collapsed');
      localStorage.setItem('capital_collapsed', 'true');
    } else {
      content.classList.remove('collapsed');
      localStorage.setItem('capital_collapsed', 'false');
      showAllTasks = false;
      localStorage.setItem('show_all_tasks', 'false');
      renderTasks();
    }
    autoResizeWindow();
    setTimeout(autoResizeWindow, 310);
  });
}

function openTaskModal(task, event, isRightClick = false) {
  selectedTask = task;
  selectedTaskFileName = event?.currentTarget?.dataset?.fileName || activeFileName;
  const modal = document.getElementById('task-modal');
  const modalContent = modal.querySelector('.modal-content');
  if (modal && modalContent && event) {
    let rect;
    if (isRightClick) {
      rect = {
        left: event.clientX,
        right: event.clientX,
        top: event.clientY,
        bottom: event.clientY,
        width: 0,
        height: 0
      };
    } else {
      rect = event.currentTarget.getBoundingClientRect();
    }
    activeTriggerBtnRect = rect;

    const pinBtn = document.getElementById('modal-pin-btn');
    const editBtn = document.getElementById('modal-edit-btn');
    const copyBtn = document.getElementById('modal-copy-btn');
    const addSubtaskBtn = document.getElementById('modal-add-subtask-btn');
    const moveBtn = document.getElementById('modal-move-btn');
    const deleteBtn = document.getElementById('modal-delete-btn');

    if (isRightClick) {
      if (pinBtn) pinBtn.style.display = 'none';
      if (editBtn) editBtn.style.display = 'none';
      if (addSubtaskBtn) addSubtaskBtn.style.display = 'none';
      if (moveBtn) moveBtn.style.display = 'none';
    } else {
      if (pinBtn) pinBtn.style.display = '';
      if (editBtn) editBtn.style.display = '';
      if (addSubtaskBtn) addSubtaskBtn.style.display = '';
      if (moveBtn) {
        if (selectedTaskFileName === 'Ежедневные задачи') {
          moveBtn.style.display = 'none';
        } else {
          moveBtn.style.display = '';
        }
      }
    }

    modal.classList.remove('hidden');
    positionFloatingModal(modalContent, rect);
  }
}

function setupSimpleCollapse({ toggleId, buttonId, contentIds, storageKey, onChange }) {
  const toggle = document.getElementById(toggleId);
  const button = buttonId ? document.getElementById(buttonId) : null;
  const contents = contentIds.map(id => document.getElementById(id)).filter(Boolean);
  if (!toggle || contents.length === 0) return;

  const apply = (collapsed) => {
    contents.forEach(content => content.classList.toggle('collapsed', collapsed));
    if (button) {
      button.textContent = collapsed ? '▼' : '▲';
      button.title = collapsed ? 'Развернуть' : 'Свернуть';
    }
    localStorage.setItem(storageKey, collapsed ? 'true' : 'false');
    if (onChange) onChange(collapsed);
    autoResizeWindow();
    setTimeout(autoResizeWindow, 250);
  };

  apply(localStorage.getItem(storageKey) === 'true');

  toggle.addEventListener('click', (e) => {
    if (e.target.closest('button') && (!buttonId || e.target.id !== buttonId)) return;
    const collapsed = !contents[0].classList.contains('collapsed');
    apply(collapsed);
  });

  if (button) {
    button.addEventListener('click', (e) => {
      e.stopPropagation();
      const collapsed = !contents[0].classList.contains('collapsed');
      apply(collapsed);
    });
  }
}

function setupSectionCollapses() {
  setupSimpleCollapse({
    toggleId: 'goal-toggle',
    contentIds: ['goal-content', 'goal-stats'],
    storageKey: 'goal_collapsed',
    onChange: (collapsed) => {
      document.getElementById('goal-card')?.classList.toggle('goal-collapsed', collapsed);
      document.getElementById('capital-card')?.classList.toggle('hidden-by-goal', collapsed);
    }
  });

  document.querySelector('#goal-card .progress')?.addEventListener('click', () => {
    const goalCard = document.getElementById('goal-card');
    if (!goalCard?.classList.contains('goal-collapsed')) return;
    document.getElementById('goal-toggle')?.click();
  });

  setupSimpleCollapse({
    toggleId: 'tasks-toggle',
    contentIds: ['tasks-content'],
    storageKey: 'tasks_card_collapsed',
    onChange: (collapsed) => {
      document.getElementById('add-task-trigger-btn')?.classList.toggle('hidden', collapsed);
      document.getElementById('toggle-expand-tasks-btn')?.classList.toggle('hidden', collapsed);
    }
  });

  setupSimpleCollapse({
    toggleId: 'daily-toggle',
    contentIds: ['daily-content'],
    storageKey: 'daily_card_collapsed',
    onChange: (collapsed) => {
      document.getElementById('add-daily-task-trigger-btn')?.classList.toggle('hidden', collapsed);
    }
  });
}

function closeTaskModal() {
  selectedTask = null;
  selectedTaskFileName = null;
  const modal = document.getElementById('task-modal');
  if (modal) {
    modal.classList.add('hidden');
  }
}

async function openFileSelectorModal(event) {
  const modal = document.getElementById('file-selector-modal');
  const modalContent = modal?.querySelector('.modal-content');
  if (modal && modalContent && event) {
    const rect = event.currentTarget.getBoundingClientRect();
    modal.classList.remove('hidden');
    await renderFileList();
    autoResizeWindow();
    positionDropdownBelow(modalContent, rect);
  }
}

function closeFileSelectorModal() {
  const modal = document.getElementById('file-selector-modal');
  if (modal) {
    modal.classList.add('hidden');
    autoResizeWindow();
  }
}

function openFileActionModal(fileName, event) {
  selectedFileName = fileName;
  const modal = document.getElementById('file-action-modal');
  const modalContent = modal?.querySelector('.modal-content');
  if (modal && modalContent && event) {
    const rect = event.currentTarget.getBoundingClientRect();
    modal.classList.remove('hidden');
    positionFloatingModal(modalContent, rect);
  }
}

function closeFileActionModal() {
  selectedFileName = null;
  const modal = document.getElementById('file-action-modal');
  if (modal) modal.classList.add('hidden');
}

async function renderFileList() {
  const listContainer = document.getElementById('file-selector-list');
  if (!listContainer || !window.electronAPI) return;
  
  const files = await window.electronAPI.getObsidianFiles();
  listContainer.innerHTML = '';
  
  files.forEach(file => {
    const row = document.createElement('div');
    row.className = 'file-list-row';

    const btn = document.createElement('button');
    btn.className = 'file-select-btn';
    btn.textContent = `📁 ${file}`;
    btn.onclick = async () => {
      await selectActiveFile(file);
      closeFileSelectorModal();
    };

    const optionsBtn = document.createElement('button');
    optionsBtn.className = 'file-options-btn';
    optionsBtn.textContent = '•••';
    optionsBtn.title = 'Действия с файлом';
    optionsBtn.onclick = (e) => {
      e.stopPropagation();
      openFileActionModal(file, e);
    };

    row.appendChild(btn);
    row.appendChild(optionsBtn);
    listContainer.appendChild(row);
  });
  
  const sep = document.createElement('div');
  sep.style.borderTop = '1px solid #333';
  sep.style.margin = '6px 0';
  listContainer.appendChild(sep);
  
  const createBtn = document.createElement('button');
  createBtn.className = 'modal-action-btn';
  createBtn.style.color = '#a186f1';
  createBtn.textContent = '➕ Создать файл...';
  createBtn.onclick = () => renderCreateFileInput(listContainer);
  listContainer.appendChild(createBtn);
}

function renderCreateFileInput(listContainer) {
  const oldRow = listContainer.querySelector('.create-file-row');
  if (oldRow) {
    oldRow.querySelector('input')?.focus();
    return;
  }

  const row = document.createElement('div');
  row.className = 'create-file-row';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'create-file-input';
  input.placeholder = 'Название файла';

  const submitBtn = document.createElement('button');
  submitBtn.className = 'create-file-submit';
  submitBtn.textContent = '+';
  submitBtn.title = 'Создать файл';

  const submit = async () => {
    const trimmed = input.value.trim();
    if (!trimmed || !window.electronAPI) return;

    const success = await window.electronAPI.createObsidianFile(trimmed);
    if (success) {
      await selectActiveFile(trimmed);
      closeFileSelectorModal();
    } else {
      input.classList.add('error');
      input.value = '';
      input.placeholder = 'Такой файл уже есть';
      input.focus();
    }
  };

  submitBtn.onclick = submit;
  input.onkeydown = async (e) => {
    if (e.key === 'Enter') await submit();
    if (e.key === 'Escape') row.remove();
  };

  row.appendChild(input);
  row.appendChild(submitBtn);
  listContainer.appendChild(row);
  setTimeout(() => input.focus(), 50);
}

function renderRenameFileInput(fileName) {
  const body = document.querySelector('#file-action-modal .modal-body');
  if (!body) return;

  const oldRow = body.querySelector('.rename-file-row');
  if (oldRow) {
    oldRow.querySelector('input')?.focus();
    return;
  }

  const row = document.createElement('div');
  row.className = 'create-file-row rename-file-row';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'create-file-input';
  input.value = fileName;
  input.placeholder = 'Новое имя файла';

  const submitBtn = document.createElement('button');
  submitBtn.className = 'create-file-submit';
  submitBtn.textContent = '✓';
  submitBtn.title = 'Переименовать файл';

  const submit = async () => {
    const newName = input.value.trim();
    if (!newName || !window.electronAPI?.renameObsidianFile) return;
    const result = await window.electronAPI.renameObsidianFile(fileName, newName);
    const success = typeof result === 'object' ? result.success : result;
    const actualName = typeof result === 'object' && result.fileName ? result.fileName : newName;

    if (success) {
      if (activeFileName === fileName) {
        await selectActiveFile(actualName);
      }
      closeFileActionModal();
      closeFileSelectorModal();
    } else {
      input.classList.add('error');
      input.value = '';
      input.placeholder = 'Не удалось переименовать';
      input.focus();
    }
  };

  submitBtn.onclick = submit;
  input.onkeydown = async (e) => {
    if (e.key === 'Enter') await submit();
    if (e.key === 'Escape') row.remove();
  };

  row.appendChild(input);
  row.appendChild(submitBtn);
  body.appendChild(row);
  setTimeout(() => input.focus(), 50);
}

function openMoveTaskModal(task, targetRect) {
  const modal = document.getElementById('move-task-modal');
  const modalContent = modal.querySelector('.modal-content');
  if (modal && modalContent && targetRect) {
    modal.classList.remove('hidden');
    positionFloatingModal(modalContent, targetRect);
    renderMoveTargets(task);
  }
}

function closeMoveTaskModal() {
  const modal = document.getElementById('move-task-modal');
  if (modal) modal.classList.add('hidden');
}

async function renderMoveTargets(task) {
  const listContainer = document.getElementById('move-task-list');
  if (!listContainer || !window.electronAPI) return;
  
  const files = await window.electronAPI.getObsidianFiles();
  listContainer.innerHTML = '';
  
  const otherFiles = files.filter(f => f !== activeFileName);
  if (otherFiles.length === 0) {
    const info = document.createElement('div');
    info.style.color = '#888';
    info.style.fontSize = '11px';
    info.style.padding = '8px';
    info.style.textAlign = 'center';
    info.textContent = 'Нет других файлов. Создайте файл!';
    listContainer.appendChild(info);
    return;
  }
  
  otherFiles.forEach(file => {
    const btn = document.createElement('button');
    btn.className = 'modal-action-btn';
    btn.textContent = `📂 ${file}`;
    btn.onclick = async () => {
      const success = await window.electronAPI.moveTaskToFile(activeFileName, task.lineIndex, file);
      if (success) {
        closeMoveTaskModal();
        await loadObsidianTasks();
      }
    };
    listContainer.appendChild(btn);
  });
}

function createInlineSubtaskInput(parentTask, parentElement, fileName) {
  const row = document.createElement('div');
  row.className = 'add-subtask-row';
  
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'subtask-input';
  input.placeholder = 'Добавить подзадачу...';
  
  const btn = document.createElement('button');
  btn.className = 'add-subtask-btn-submit';
  btn.textContent = '+';
  
  const submit = async () => {
    const val = input.value.trim();
    if (val && window.electronAPI) {
      await window.electronAPI.addSubtask(parentTask.lineIndex, val, fileName);
      activeSubtaskInputTaskId = null;
      if (fileName === 'Ежедневные задачи') {
        await loadDailyTasks();
      } else {
        await loadObsidianTasks();
      }
    }
  };
  
  btn.onclick = submit;
  input.onkeydown = async (e) => {
    if (e.key === 'Enter') {
      await submit();
    } else if (e.key === 'Escape') {
      activeSubtaskInputTaskId = null;
      renderTasks();
    }
  };
  
  row.appendChild(input);
  row.appendChild(btn);
  parentElement.appendChild(row);
  
  setTimeout(() => input.focus(), 50);
}

function getVisibleChildren(task, showDone) {
  return (task.subtasks || []).filter(child => showDone || !child.done);
}

function countTasks(tasks, showDone = true) {
  return tasks.reduce((sum, task) => {
    if (!showDone && task.done) return sum;
    return sum + 1 + countTasks(getVisibleChildren(task, showDone), showDone);
  }, 0);
}

function renderTaskNode(task, options, depth = 0, indexLabel = '') {
  const fileName = options.fileName;
  const key = getTaskKey(task, fileName);
  const group = document.createElement('div');
  group.className = `task-group depth-${Math.min(depth, 4)}`;

  const div = document.createElement('div');
  div.className = depth > 0 ? 'task subtask' : 'task';
  div.style.setProperty('--task-depth', depth);

  if (task.done) {
    div.classList.add('done');
  }

  if (activeEditTaskId === key) {
    const editInput = document.createElement('input');
    editInput.type = 'text';
    editInput.className = depth > 0 ? 'task-edit-input subtask-edit-input' : 'task-edit-input';
    editInput.value = task.text;

    const saveBtn = document.createElement('button');
    saveBtn.className = 'task-edit-save-btn';
    saveBtn.textContent = '✓';
    saveBtn.title = 'Сохранить';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'task-edit-cancel-btn';
    cancelBtn.textContent = '✕';
    cancelBtn.title = 'Отмена';

    const reload = fileName === 'Ежедневные задачи' ? loadDailyTasks : loadObsidianTasks;
    const submitEdit = async () => {
      const val = editInput.value.trim();
      if (val && window.electronAPI) {
        await window.electronAPI.editTask(task.lineIndex, val, fileName);
        activeEditTaskId = null;
        await reload();
      }
    };

    saveBtn.onclick = submitEdit;
    cancelBtn.onclick = () => {
      activeEditTaskId = null;
      renderTasks();
      renderDailyTasks();
    };

    editInput.onkeydown = async (e) => {
      if (e.key === 'Enter') {
        await submitEdit();
      } else if (e.key === 'Escape') {
        activeEditTaskId = null;
        renderTasks();
        renderDailyTasks();
      }
    };

    div.appendChild(editInput);
    div.appendChild(saveBtn);
    div.appendChild(cancelBtn);
    setTimeout(() => editInput.focus(), 50);
  } else {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'task-check';
    cb.checked = task.done;
    cb.onchange = async () => {
      await markTaskDone(task, fileName);
    };

    const span = document.createElement('span');
    span.className = 'task-text';
    span.textContent = `${indexLabel}${task.text}`;

    div.appendChild(cb);
    div.appendChild(span);

    // Set file name as data attribute for right click retrieval
    div.dataset.fileName = fileName;

    // Right click context menu handler
    div.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      openTaskModal(task, e, true);
    };

    // Hover zone to trigger buttons appearance
    const hoverZone = document.createElement('div');
    hoverZone.className = 'task-hover-zone';
    div.appendChild(hoverZone);

    // Action buttons container
    const actionsContainer = document.createElement('div');
    actionsContainer.className = 'task-actions';

    // Enter-like button for immediate subtask addition
    const addSubtaskBtn = document.createElement('button');
    addSubtaskBtn.className = 'task-action-btn task-add-subtask-btn';
    addSubtaskBtn.innerHTML = '↳';
    addSubtaskBtn.title = 'Добавить подзадачу';
    addSubtaskBtn.onclick = (e) => {
      e.stopPropagation();
      activeSubtaskInputTaskId = key;
      renderTasks();
      renderDailyTasks();
    };
    actionsContainer.appendChild(addSubtaskBtn);

    // Three dots options button
    const optBtn = document.createElement('button');
    optBtn.className = 'task-action-btn task-options-btn';
    optBtn.textContent = '•••';
    optBtn.title = 'Опции';
    optBtn.dataset.fileName = fileName;
    optBtn.onclick = (e) => {
      e.stopPropagation();
      openTaskModal(task, e);
    };
    actionsContainer.appendChild(optBtn);

    div.appendChild(actionsContainer);

    // Make the task draggable and add event handlers for drag & drop
    div.draggable = true;

    div.ondragstart = (e) => {
      div.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', JSON.stringify({
        lineIndex: task.lineIndex,
        fileName: fileName
      }));
    };

    div.ondragend = () => {
      div.classList.remove('dragging');
      document.querySelectorAll('.task').forEach(el => {
        el.classList.remove('drag-over-before', 'drag-over-after', 'drag-over-inside');
      });
    };

    div.ondragover = (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';

      if (div.classList.contains('dragging')) return;

      const rect = div.getBoundingClientRect();
      const relativeY = e.clientY - rect.top;
      const height = rect.height;

      div.classList.remove('drag-over-before', 'drag-over-after', 'drag-over-inside');

      if (relativeY < height * 0.25) {
        div.classList.add('drag-over-before');
      } else if (relativeY > height * 0.75) {
        div.classList.add('drag-over-after');
      } else {
        div.classList.add('drag-over-inside');
      }
    };

    div.ondragleave = () => {
      div.classList.remove('drag-over-before', 'drag-over-after', 'drag-over-inside');
    };

    div.ondrop = async (e) => {
      e.preventDefault();
      div.classList.remove('drag-over-before', 'drag-over-after', 'drag-over-inside');

      try {
        const data = JSON.parse(e.dataTransfer.getData('text/plain'));
        if (data && data.fileName === fileName) {
          const sourceLineIndex = data.lineIndex;
          const targetLineIndex = task.lineIndex;

          if (sourceLineIndex === targetLineIndex) return;

          const rect = div.getBoundingClientRect();
          const relativeY = e.clientY - rect.top;
          const height = rect.height;

          let position = 'inside';
          if (relativeY < height * 0.25) {
            position = 'before';
          } else if (relativeY > height * 0.75) {
            position = 'after';
          }

          if (window.electronAPI && window.electronAPI.moveTask) {
            const success = await window.electronAPI.moveTask(sourceLineIndex, targetLineIndex, position, fileName);
            if (success) {
              const reload = fileName === 'Ежедневные задачи' ? loadDailyTasks : loadObsidianTasks;
              await reload();
            }
          }
        }
      } catch (err) {
        console.error('Drop error:', err);
      }
    };
  }

  group.appendChild(div);

  if (activeSubtaskInputTaskId === key) {
    createInlineSubtaskInput(task, group, fileName);
  }

  const children = getVisibleChildren(task, options.showDone);
  if (children.length > 0) {
    const childContainer = document.createElement('div');
    childContainer.className = 'subtasks-container';
    children.forEach((child, childIdx) => {
      childContainer.appendChild(renderTaskNode(child, options, depth + 1, `${childIdx + 1}. `));
    });
    group.appendChild(childContainer);
  }

  return group;
}

function renderTasks() {
  const container = document.getElementById('tasks');
  const counter = document.getElementById('task-counter');
  if (!container) return;

  const activeRoot = obsidianTasks.filter(t => !t.done);
  const active = showAllTasks ? activeRoot : activeRoot.slice(0, 5);
  const visibleCount = countTasks(active, false);
  const totalActiveCount = countTasks(activeRoot, false);
  counter.textContent = `${totalActiveCount} осталось`;

  container.classList.toggle('expanded', showAllTasks);

  const toggleBtn = document.getElementById('toggle-expand-tasks-btn');
  if (toggleBtn) {
    toggleBtn.textContent = showAllTasks ? '▲' : '▼';
  }

  container.innerHTML = '';
  active.forEach((task, idx) => {
    container.appendChild(renderTaskNode(task, { fileName: activeFileName, showDone: false }, 0, `${idx + 1}. `));
  });

  autoResizeWindow();
}

function renderDailyTasks() {
  const container = document.getElementById('daily-tasks');
  const counter = document.getElementById('daily-task-counter');
  if (!container) return;

  const openCount = countTasks(dailyTasks, false);
  const totalCount = countTasks(dailyTasks, true);
  if (counter) counter.textContent = `${openCount} осталось`;

  container.innerHTML = '';
  dailyTasks.forEach((task, idx) => {
    container.appendChild(renderTaskNode(task, { fileName: 'Ежедневные задачи', showDone: true }, 0, `${idx + 1}. `));
  });

  autoResizeWindow();
}

async function addIncome() {
  const amountInput = document.getElementById('income-amount');
  const amount = parseMoney(amountInput.value);
  
  if (amount <= 0) return;
  
  const personalInput = document.getElementById('personal');
  const currentPersonal = parseMoney(personalInput.value);
  const newPersonal = currentPersonal + amount;
  
  personalInput.value = formatInput(newPersonal);
  
  if (window.electronAPI) {
    await window.electronAPI.addIncome(amount, newPersonal);
  }
  
  amountInput.value = formatInput(0);
  calculate();
  saveAllData();
}

function setupCloseButton() {
  const closeBtn = document.getElementById('close-btn');
  if (closeBtn && window.electronAPI) {
    closeBtn.addEventListener('click', () => {
      window.electronAPI.closeWindow();
    });
  }
}

function calculate() {
  const target = parseMoney(document.getElementById('target').value);
  const deadline = document.getElementById('deadline').value;
  const personal = parseMoney(document.getElementById('personal').value);
  const personalRate = parseFloat(document.getElementById('personal-rate').value) / 100 || 0;
  const managed = parseMoney(document.getElementById('managed').value);
  const managedRate = parseFloat(document.getElementById('managed-rate').value) / 100 || 0;
  
  const totalCap = personal + managed;
  
  let days = 0;
  if (deadline) {
    const now = new Date(); now.setHours(0,0,0,0);
    const dl = new Date(deadline);
    days = Math.max(0, Math.ceil((dl - now) / 86400000));
  }
  const years = days / 365;
  
  const avgRate = totalCap > 0 
    ? (personal * personalRate + managed * managedRate) / totalCap
    : (personalRate + managedRate) / 2;
  
  const futureValue = totalCap * Math.pow(1 + avgRate, years);
  const pct = target > 0 ? Math.min(100, (futureValue / target) * 100) : 0;
  
  document.getElementById('bar').style.width = pct + '%';
  document.getElementById('percent').textContent = pct.toFixed(1) + '%';
  
  const remain = Math.max(0, target - futureValue);
  const capitalBadge = document.getElementById('capital-total-badge');
  if (capitalBadge) {
    capitalBadge.textContent = formatMoney(totalCap);
  }
  document.getElementById('remain').innerHTML = formatMoney(remain);
  document.getElementById('days').textContent = days ? days + ' дн.' : '—';
  
  let monthly = 0;
  let daily = 0;
  if (days > 0 && remain > 0 && avgRate > 0) {
    const rDaily = Math.pow(1 + avgRate, 1/365) - 1;
    daily = remain * rDaily / (Math.pow(1 + rDaily, days) - 1);

    const rMonthly = Math.pow(1 + avgRate, 1/12) - 1;
    const months = days * 12 / 365;
    if (months > 0) {
      monthly = remain * rMonthly / (Math.pow(1 + rMonthly, months) - 1);
    }
  } else if (days > 0 && remain > 0) {
    daily = remain / days;
    const months = days * 12 / 365;
    if (months > 0) {
      monthly = remain / months;
    }
  }
  
  const monthlyEl = document.getElementById('monthly');
  if (monthlyEl) {
    monthlyEl.innerHTML = monthly > 0 ? formatMoney(monthly) : '—';
  }

  const dailyEl = document.getElementById('daily');
  if (dailyEl) {
    dailyEl.innerHTML = daily > 0 ? formatMoney(daily) : '—';
  }
}

async function init() {
  try {
    initThemeAndAccent();
  initBreakTimer();
  initSettingsListeners();
  setupMoneyFields();
  setupDateField();
  loadSavedData();
  setupCloseButton();
  setupCapitalToggle();
  setupSectionCollapses();
  
  const fileBtn = document.getElementById('active-file-btn');
  if (fileBtn) fileBtn.textContent = activeFileName;
  
  const ids = ['target', 'deadline', 'personal', 'personal-rate', 'managed', 'managed-rate'];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', () => { calculate(); saveAllData(); autoResizeWindow(); });
    if (el && id === 'deadline') el.addEventListener('change', () => { calculate(); saveAllData(); autoResizeWindow(); });
  });
  
  document.getElementById('add-income-btn')?.addEventListener('click', async () => {
    await addIncome();
    autoResizeWindow();
  });
  document.getElementById('income-amount')?.addEventListener('keydown', async e => {
    if (e.key === 'Enter') {
      await addIncome();
      autoResizeWindow();
    }
  });

  document.getElementById('toggle-expand-tasks-btn')?.addEventListener('click', () => {
    showAllTasks = !showAllTasks;
    localStorage.setItem('show_all_tasks', showAllTasks ? 'true' : 'false');
    renderTasks();
  });

  document.getElementById('active-file-btn')?.addEventListener('click', (e) => {
    openFileSelectorModal(e);
  });

  document.getElementById('add-task-trigger-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const row = document.getElementById('inline-add-task-row');
    if (row) {
      const isHidden = row.classList.contains('hidden');
      if (isHidden) {
        row.classList.remove('hidden');
        const input = document.getElementById('inline-new-task-input');
        setTimeout(() => input.focus(), 50);
      } else {
        row.classList.add('hidden');
        document.getElementById('inline-new-task-input').value = '';
      }
      autoResizeWindow();
    }
  });

  document.getElementById('inline-add-task-submit')?.addEventListener('click', async () => {
    await addNewTaskInline();
    autoResizeWindow();
  });
  document.getElementById('inline-new-task-input')?.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      await addNewTaskInline();
      autoResizeWindow();
    }
  });

  document.getElementById('add-daily-task-trigger-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const row = document.getElementById('inline-add-daily-task-row');
    if (row) {
      const isHidden = row.classList.contains('hidden');
      if (isHidden) {
        row.classList.remove('hidden');
        const input = document.getElementById('inline-new-daily-task-input');
        setTimeout(() => input.focus(), 50);
      } else {
        row.classList.add('hidden');
        document.getElementById('inline-new-daily-task-input').value = '';
      }
      autoResizeWindow();
    }
  });

  document.getElementById('inline-add-daily-task-submit')?.addEventListener('click', async () => {
    await addDailyTaskInline();
    autoResizeWindow();
  });
  document.getElementById('inline-new-daily-task-input')?.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      await addDailyTaskInline();
      autoResizeWindow();
    }
  });

  const modalOverlay = document.getElementById('task-modal');
  const fileSelectorOverlay = document.getElementById('file-selector-modal');
  const fileActionOverlay = document.getElementById('file-action-modal');
  const moveTaskOverlay = document.getElementById('move-task-modal');

  if (modalOverlay) {
    modalOverlay.addEventListener('click', (e) => {
      if (e.target === modalOverlay) closeTaskModal();
    });
  }
  if (fileSelectorOverlay) {
    fileSelectorOverlay.addEventListener('click', (e) => {
      if (e.target === fileSelectorOverlay) closeFileSelectorModal();
    });
  }
  if (fileActionOverlay) {
    fileActionOverlay.addEventListener('click', (e) => {
      if (e.target === fileActionOverlay) closeFileActionModal();
    });
  }
  if (moveTaskOverlay) {
    moveTaskOverlay.addEventListener('click', (e) => {
      if (e.target === moveTaskOverlay) closeMoveTaskModal();
    });
  }

  const modalPinBtn = document.getElementById('modal-pin-btn');
  const modalEditBtn = document.getElementById('modal-edit-btn');
  const modalCopyBtn = document.getElementById('modal-copy-btn');
  const modalAddSubtaskBtn = document.getElementById('modal-add-subtask-btn');
  const modalMoveBtn = document.getElementById('modal-move-btn');
  const modalDeleteBtn = document.getElementById('modal-delete-btn');
  const fileRenameBtn = document.getElementById('file-rename-btn');
  const fileDeleteBtn = document.getElementById('file-delete-btn');

  if (fileRenameBtn) {
    fileRenameBtn.addEventListener('click', () => {
      if (!selectedFileName) return;
      renderRenameFileInput(selectedFileName);
    });
  }

  if (fileDeleteBtn) {
    fileDeleteBtn.addEventListener('click', async () => {
      if (!selectedFileName || !window.electronAPI?.deleteObsidianFile) return;
      const deletedName = selectedFileName;
      const success = await window.electronAPI.deleteObsidianFile(deletedName);
      if (success) {
        const files = await window.electronAPI.getObsidianFiles();
        if (activeFileName === deletedName) {
          await selectActiveFile(files[0] || 'Дела');
        }
        closeFileActionModal();
        await renderFileList();
      }
    });
  }

  if (modalPinBtn) {
    modalPinBtn.addEventListener('click', async () => {
      if (selectedTask && window.electronAPI) {
        const fileName = selectedTaskFileName || activeFileName;
        await window.electronAPI.pinTask(selectedTask.lineIndex, selectedTask.parentLineIndex, fileName);
        closeTaskModal();
        if (fileName === 'Ежедневные задачи') await loadDailyTasks();
        else await loadObsidianTasks();
      }
    });
  }

  if (modalEditBtn) {
    modalEditBtn.addEventListener('click', () => {
      if (selectedTask) {
        activeEditTaskId = getTaskKey(selectedTask, selectedTaskFileName || activeFileName);
        closeTaskModal();
        renderTasks();
        renderDailyTasks();
      }
    });
  }

  if (modalCopyBtn) {
    modalCopyBtn.addEventListener('click', async () => {
      if (selectedTask) {
        try {
          await navigator.clipboard.writeText(selectedTask.text);
          showToast('Текст задачи скопирован!', '📋');
        } catch (err) {
          console.error('Не удалось скопировать: ', err);
        }
        closeTaskModal();
      }
    });
  }

  if (modalAddSubtaskBtn) {
    modalAddSubtaskBtn.addEventListener('click', () => {
      if (selectedTask) {
        activeSubtaskInputTaskId = getTaskKey(selectedTask, selectedTaskFileName || activeFileName);
        closeTaskModal();
        renderTasks();
        renderDailyTasks();
      }
    });
  }

  if (modalMoveBtn) {
    modalMoveBtn.addEventListener('click', (e) => {
      if (selectedTask && activeTriggerBtnRect && selectedTaskFileName !== 'Ежедневные задачи') {
        const taskToMove = selectedTask;
        const rect = activeTriggerBtnRect;
        closeTaskModal();
        openMoveTaskModal(taskToMove, rect);
      }
    });
  }

  if (modalDeleteBtn) {
    modalDeleteBtn.addEventListener('click', async () => {
      if (selectedTask && window.electronAPI) {
        const fileName = selectedTaskFileName || activeFileName;
        await window.electronAPI.deleteTask(selectedTask.lineIndex, fileName);
        closeTaskModal();
        if (fileName === 'Ежедневные задачи') await loadDailyTasks();
        else await loadObsidianTasks();
      }
    });
  }

  // Click & IPC Listeners
  document.getElementById('settings-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    openSettingsModal();
  });

  document.getElementById('daily-analytics-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    openAnalyticsWindow();
  });

  if (window.electronAPI && window.electronAPI.onDayChanged) {
    window.electronAPI.onDayChanged(() => {
      loadDailyTasks();
    });
  }
  
  if (window.electronAPI && window.electronAPI.onExternalFileChange) {
    window.electronAPI.onExternalFileChange((filename) => {
      if (!filename) {
        loadObsidianTasks();
        loadDailyTasks();
        return;
      }
      const baseName = filename.replace(/\.md$/, '');
      if (baseName === activeFileName) {
        loadObsidianTasks();
        showToast(`Файл "${activeFileName}" обновлен извне`, '🔄');
      } else if (baseName === 'Ежедневные задачи') {
        loadDailyTasks();
        showToast('Ежедневные задачи обновлены извне', '🔄');
      }
    });
  }

  if (window.electronAPI && window.electronAPI.onTaskAddedExternally) {
    window.electronAPI.onTaskAddedExternally(({ taskText, fileName }) => {
      if (fileName === activeFileName) {
        loadObsidianTasks();
      } else if (fileName === 'Ежедневные задачи') {
        loadDailyTasks();
      }
      showToast(`Добавлено дело: "${taskText}"`, '📝');
    });
  }
  
  // Open trading journal
  document.getElementById('addon-trading-btn')?.addEventListener('click', () => {
    if (window.electronAPI && window.electronAPI.openTradingJournal) {
      window.electronAPI.openTradingJournal();
    }
  });

  // Open connections window
  document.getElementById('addon-connections-btn')?.addEventListener('click', () => {
    if (window.electronAPI && window.electronAPI.openConnectionsWindow) {
      window.electronAPI.openConnectionsWindow();
    }
  });

  // Open Future Canvas
  document.getElementById('addon-canvas-btn')?.addEventListener('click', () => {
    if (window.electronAPI && window.electronAPI.openFutureCanvas) {
      window.electronAPI.openFutureCanvas();
    }
  });
  
  await loadObsidianTasks();
  await loadDailyTasks();
  calculate();
  autoResizeWindow();
  } catch (error) {
    if (window.electronAPI && window.electronAPI.logAction) {
      window.electronAPI.logAction("CRITICAL INIT ERROR: " + error.message + " | stack: " + error.stack);
    }
  }
}

init();

// ==========================================================================
// Settings, Theme & Break Timer Additions
// ==========================================================================

const premiumColors = [
  { name: 'Purple', primary: '#a186f1', hover: '#b399ff', dark: '#1e1e1e' },
  { name: 'Mint', primary: '#3ddc84', hover: '#5beb9b', dark: '#1e1e1e' },
  { name: 'Sky Blue', primary: '#4db8ff', hover: '#70c7ff', dark: '#1e1e1e' },
  { name: 'Pink', primary: '#ff75b5', hover: '#ff94c7', dark: '#1e1e1e' },
  { name: 'Sunset Orange', primary: '#ff8f59', hover: '#ffa57a', dark: '#1e1e1e' },
  { name: 'Golden Yellow', primary: '#ffcc00', hover: '#ffe066', dark: '#1e1e1e' },
  { name: 'Teal', primary: '#00f5d4', hover: '#33ffd6', dark: '#1e1e1e' }
];

function initThemeAndAccent() {
  // Apply saved theme
  const savedTheme = localStorage.getItem('widget_theme') || 'dark';
  if (savedTheme === 'light') {
    document.body.classList.add('light-theme');
    document.getElementById('theme-light-btn')?.classList.add('active');
    document.getElementById('theme-dark-btn')?.classList.remove('active');
  } else {
    document.body.classList.remove('light-theme');
    document.getElementById('theme-dark-btn')?.classList.add('active');
    document.getElementById('theme-light-btn')?.classList.remove('active');
  }
  
  // Apply saved accent color
  const primaryColor = localStorage.getItem('accent_primary') || '#a186f1';
  const hoverColor = localStorage.getItem('accent_hover') || '#b399ff';
  const darkColor = localStorage.getItem('accent_dark') || '#1e1e1e';
  
  document.documentElement.style.setProperty('--accent-color', primaryColor);
  document.documentElement.style.setProperty('--accent-hover', hoverColor);
  document.documentElement.style.setProperty('--accent-dark', darkColor);
}

function openSettingsModal() {
  const modal = document.getElementById('settings-modal');
  const modalContent = modal?.querySelector('.modal-content');
  if (modal && modalContent) {
    // Generate color palette dots
    const palette = document.getElementById('color-palette');
    if (palette) {
      palette.innerHTML = '';
      const currentAccent = localStorage.getItem('accent_primary') || '#a186f1';
      
      premiumColors.forEach(color => {
        const dot = document.createElement('div');
        dot.className = 'color-circle';
        dot.style.backgroundColor = color.primary;
        dot.title = color.name;
        if (color.primary === currentAccent) {
          dot.classList.add('active');
        }
        
        dot.onclick = () => {
          document.querySelectorAll('.color-circle').forEach(d => d.classList.remove('active'));
          dot.classList.add('active');
          
          // Apply variables live
          document.documentElement.style.setProperty('--accent-color', color.primary);
          document.documentElement.style.setProperty('--accent-hover', color.hover);
          document.documentElement.style.setProperty('--accent-dark', color.dark);
          
          // Save
          localStorage.setItem('accent_primary', color.primary);
          localStorage.setItem('accent_hover', color.hover);
          localStorage.setItem('accent_dark', color.dark);
        };
        palette.appendChild(dot);
      });
    }
    
    // Set break timer selector values
    const select = document.getElementById('break-interval-select');
    if (select) {
      select.value = localStorage.getItem('break_interval') || '0';
    }

    const soundSelect = document.getElementById('break-sound-select');
    if (soundSelect) {
      soundSelect.value = localStorage.getItem('break_sound') || 'chime';
    }
    
    const mediaInput = document.getElementById('break-media-path');
    if (mediaInput) {
      const savedPath = localStorage.getItem('break_media_path') || '';
      mediaInput.value = savedPath ? savedPath.split(/[\\\/]/).pop() : '';
      mediaInput.title = savedPath;
    }

    const mainProviderSelect = document.getElementById('main-llm-provider');
    const mainGeminiGroup = document.getElementById('main-gemini-key-group');
    const mainLocalGroup = document.getElementById('main-local-llm-group');
    const mainGeminiInput = document.getElementById('gemini-key-input');
    const mainLocalUrlInput = document.getElementById('main-local-url');
    const mainLocalModelInput = document.getElementById('main-local-model');

    if (window.electronAPI && window.electronAPI.getLLMConfig) {
      window.electronAPI.getLLMConfig().then(config => {
        if (mainProviderSelect) mainProviderSelect.value = config.provider || 'gemini';
        if (mainGeminiInput) mainGeminiInput.value = config.geminiKey || '';
        if (mainLocalUrlInput) mainLocalUrlInput.value = config.localUrl || 'http://localhost:11434/v1';
        if (mainLocalModelInput) mainLocalModelInput.value = config.localModel || 'llama3';

        // Toggle visibility based on loaded provider
        const isLocal = config.provider === 'local';
        if (mainGeminiGroup) mainGeminiGroup.style.display = isLocal ? 'none' : 'flex';
        if (mainLocalGroup) mainLocalGroup.style.display = isLocal ? 'flex' : 'none';
      });
    }

    // Load break enabled status
    updateBreakSettingsState();

    modal.classList.remove('hidden');
    autoResizeWindow();
    updateBreakCountdownStatus();
  }
}

function closeSettingsModal() {
  const modal = document.getElementById('settings-modal');
  if (modal) {
    modal.classList.add('hidden');
    autoResizeWindow();
  }
}

function updateBreakSettingsState() {
  const enabled = localStorage.getItem('break_enabled') !== 'false';
  const toggle = document.getElementById('break-enabled-toggle');
  if (toggle) toggle.checked = enabled;

  const intervalSelect = document.getElementById('break-interval-select');
  const soundSelect = document.getElementById('break-sound-select');
  const mediaBtn = document.getElementById('select-media-btn');
  const testBtn = document.getElementById('test-break-btn');

  const rowsToDim = [
    intervalSelect?.closest('.setting-row'),
    soundSelect?.closest('.setting-row'),
    mediaBtn?.closest('.setting-row')
  ].filter(Boolean);

  if (enabled) {
    if (intervalSelect) intervalSelect.removeAttribute('disabled');
    if (soundSelect) soundSelect.removeAttribute('disabled');
    if (mediaBtn) mediaBtn.removeAttribute('disabled');
    if (testBtn) testBtn.removeAttribute('disabled');
    rowsToDim.forEach(row => row.style.opacity = '1');
  } else {
    if (intervalSelect) intervalSelect.setAttribute('disabled', 'true');
    if (soundSelect) soundSelect.setAttribute('disabled', 'true');
    if (mediaBtn) mediaBtn.setAttribute('disabled', 'true');
    if (testBtn) testBtn.setAttribute('disabled', 'true');
    rowsToDim.forEach(row => row.style.opacity = '0.5');
  }
}

function initBreakTimer() {
  if (breakAlarmTimer) {
    clearTimeout(breakAlarmTimer);
    breakAlarmTimer = null;
  }

  if (breakCountdownTimer) {
    clearInterval(breakCountdownTimer);
    breakCountdownTimer = null;
  }
  
  const enabled = localStorage.getItem('break_enabled') !== 'false';
  const interval = enabled ? parseInt(localStorage.getItem('break_interval') || '0') : 0;
  if (interval > 0) {
    const ms = interval * 60 * 1000;
    nextBreakAt = Date.now() + ms;
    breakAlarmTimer = setTimeout(triggerBreakWindow, ms);
    breakCountdownTimer = setInterval(updateBreakCountdownStatus, 1000);
  } else {
    nextBreakAt = null;
  }

  updateBreakCountdownStatus();
}

function triggerBreakWindow() {
  if (window.electronAPI && window.electronAPI.showBreakWindow) {
    if (breakAlarmTimer) {
      clearTimeout(breakAlarmTimer);
      breakAlarmTimer = null;
    }
    nextBreakAt = null;
    isBreakWindowOpen = true;
    updateBreakCountdownStatus();

    const mediaPath = localStorage.getItem('break_media_path') || '';
    const accent = localStorage.getItem('accent_primary') || '#a186f1';
    const hover = localStorage.getItem('accent_hover') || '#b399ff';
    const sound = localStorage.getItem('break_sound') || 'chime';
    window.electronAPI.showBreakWindow(mediaPath, accent, hover, sound);
  }
}

function formatBreakDuration(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours} ч ${String(minutes).padStart(2, '0')} мин`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function updateBreakCountdownStatus() {
  const status = document.getElementById('break-countdown-status');
  if (!status) return;

  const enabled = localStorage.getItem('break_enabled') !== 'false';
  const interval = enabled ? parseInt(localStorage.getItem('break_interval') || '0') : 0;
  if (interval <= 0) {
    status.textContent = 'Уведомления выключены';
    return;
  }

  if (isBreakWindowOpen) {
    status.textContent = 'Перерыв идет. Следующий отсчет начнется после кнопки "Вернуться к работе".';
    return;
  }

  if (!nextBreakAt) {
    status.textContent = 'Отсчет начнется после возврата к работе.';
    return;
  }

  status.textContent = `Следующее уведомление через ${formatBreakDuration(nextBreakAt - Date.now())}`;
}

function handleBreakWindowClosed() {
  isBreakWindowOpen = false;
  initBreakTimer();
}

function initSettingsListeners() {
  // Theme Dark
  document.getElementById('theme-dark-btn')?.addEventListener('click', () => {
    document.body.classList.remove('light-theme');
    document.getElementById('theme-dark-btn')?.classList.add('active');
    document.getElementById('theme-light-btn')?.classList.remove('active');
    localStorage.setItem('widget_theme', 'dark');
  });
  
  // Theme Light
  document.getElementById('theme-light-btn')?.addEventListener('click', () => {
    document.body.classList.add('light-theme');
    document.getElementById('theme-light-btn')?.classList.add('active');
    document.getElementById('theme-dark-btn')?.classList.remove('active');
    localStorage.setItem('widget_theme', 'light');
  });
  
  // Break Enabled change
  document.getElementById('break-enabled-toggle')?.addEventListener('change', (e) => {
    localStorage.setItem('break_enabled', e.target.checked ? 'true' : 'false');
    updateBreakSettingsState();
    initBreakTimer();
  });

  // Break Interval change
  document.getElementById('break-interval-select')?.addEventListener('change', (e) => {
    localStorage.setItem('break_interval', e.target.value);
    initBreakTimer(); // restart timer
  });

  document.getElementById('break-sound-select')?.addEventListener('change', (e) => {
    localStorage.setItem('break_sound', e.target.value);
  });
  
  // Choose media
  document.getElementById('select-media-btn')?.addEventListener('click', async () => {
    if (window.electronAPI && window.electronAPI.selectMediaFile) {
      const filePath = await window.electronAPI.selectMediaFile();
      if (filePath) {
        localStorage.setItem('break_media_path', filePath);
        const mediaInput = document.getElementById('break-media-path');
        if (mediaInput) {
          mediaInput.value = filePath.split(/[\\\/]/).pop();
          mediaInput.title = filePath;
        }
      }
    }
  });
  
  // Test alarm
  document.getElementById('test-break-btn')?.addEventListener('click', () => {
    triggerBreakWindow();
  });

  // Save LLM Config
  const saveMainLLMConfig = async () => {
    if (!window.electronAPI || !window.electronAPI.saveLLMConfig) return;
    const provider = document.getElementById('main-llm-provider')?.value || 'gemini';
    const geminiKey = document.getElementById('gemini-key-input')?.value.trim() || '';
    const localUrl = document.getElementById('main-local-url')?.value.trim() || 'http://localhost:11434/v1';
    const localModel = document.getElementById('main-local-model')?.value.trim() || 'llama3';

    const success = await window.electronAPI.saveLLMConfig({ provider, geminiKey, localUrl, localModel });
    if (success) {
      showToast('Настройки ИИ сохранены', '🤖');
    }
  };

  document.getElementById('main-llm-provider')?.addEventListener('change', (e) => {
    const isLocal = e.target.value === 'local';
    const mainGeminiGroup = document.getElementById('main-gemini-key-group');
    const mainLocalGroup = document.getElementById('main-local-llm-group');
    if (mainGeminiGroup) mainGeminiGroup.style.display = isLocal ? 'none' : 'flex';
    if (mainLocalGroup) mainLocalGroup.style.display = isLocal ? 'flex' : 'none';
    saveMainLLMConfig();
  });

  document.getElementById('gemini-key-input')?.addEventListener('change', saveMainLLMConfig);
  document.getElementById('main-local-url')?.addEventListener('change', saveMainLLMConfig);
  document.getElementById('main-local-model')?.addEventListener('change', saveMainLLMConfig);

  if (window.electronAPI?.onBreakWindowClosed) {
    window.electronAPI.onBreakWindowClosed(handleBreakWindowClosed);
  }

  // Settings Modal Overlay Click cancels
  const settingsOverlay = document.getElementById('settings-modal');
  if (settingsOverlay) {
    settingsOverlay.addEventListener('click', (e) => {
      if (e.target === settingsOverlay) closeSettingsModal();
    });
  }

}

function openAnalyticsWindow() {
  if (window.electronAPI && window.electronAPI.showAnalyticsWindow) {
    const accent = localStorage.getItem('accent_primary') || '#a186f1';
    const hover = localStorage.getItem('accent_hover') || '#b399ff';
    window.electronAPI.showAnalyticsWindow(accent, hover);
  }
}

function showToast(message, icon = 'ℹ️') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.innerHTML = `<span class="toast-icon">${icon}</span><span class="toast-text">${message}</span>`;
  container.appendChild(toast);

  // Trigger browser paint then animate
  requestAnimationFrame(() => {
    toast.classList.add('show');
  });

  // Remove after 3 seconds
  setTimeout(() => {
    toast.classList.remove('show');
    // Wait for transition to finish before removing from DOM
    toast.addEventListener('transitionend', () => {
      toast.remove();
    });
  }, 3000);
}
