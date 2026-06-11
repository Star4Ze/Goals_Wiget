// Get accent colors from parent app's local storage
const primaryColor = localStorage.getItem('accent_primary') || '#a186f1';
const hoverColor = localStorage.getItem('accent_hover') || '#b399ff';
const darkColor = localStorage.getItem('accent_dark') || '#2a1b5c';

document.documentElement.style.setProperty('--accent-color', primaryColor);
document.documentElement.style.setProperty('--accent-hover', hoverColor);
document.documentElement.style.setProperty('--accent-dark', darkColor);

let contacts = [];
let selectedContact = null;
let currentTab = 'editor'; // 'editor' or 'ai'

document.addEventListener('DOMContentLoaded', () => {
  initUI();
  loadContacts();
  checkGeminiKey();
});

// Check if Gemini key is set and display warnings/placeholders accordingly
async function checkGeminiKey() {
  if (window.electronAPI && window.electronAPI.getGeminiKey) {
    const key = await window.electronAPI.getGeminiKey();
    const warning = document.getElementById('gemini-warning');
    const runBtn = document.getElementById('run-ai-btn');
    
    if (!key) {
      if (warning) warning.style.display = 'block';
      if (runBtn) runBtn.disabled = true;
    } else {
      if (warning) warning.style.display = 'none';
      if (runBtn) runBtn.disabled = false;
    }
  }
}

function initUI() {
  // Close Window
  document.getElementById('close-connections-btn').onclick = () => {
    if (window.electronAPI && window.electronAPI.closeWindow) {
      window.electronAPI.closeWindow();
    }
  };

  // Search input filter
  document.getElementById('contact-search').addEventListener('input', (e) => {
    renderContactsList(e.target.value.trim());
  });

  // Add Contact button
  document.getElementById('add-contact-btn').onclick = () => {
    openCreateModal();
  };

  // Delete Contact button
  document.getElementById('delete-contact-btn').onclick = () => {
    deleteCurrentContact();
  };

  // Save Contact Card button
  document.getElementById('save-contact-btn').onclick = () => {
    saveCurrentContact();
  };

  // Tab switching
  document.getElementById('tab-editor-btn').onclick = () => switchTab('editor');
  document.getElementById('tab-ai-btn').onclick = () => switchTab('ai');

  // AI run button
  document.getElementById('run-ai-btn').onclick = () => runAIAnalysis();

  // Create Modal Actions
  document.getElementById('create-modal-close').onclick = closeCreateModal;
  document.getElementById('create-modal-cancel').onclick = closeCreateModal;
  document.getElementById('create-modal-submit').onclick = submitCreateContact;
}

// Switch tabs inside details panel
function switchTab(tabName) {
  currentTab = tabName;
  
  const editorBtn = document.getElementById('tab-editor-btn');
  const aiBtn = document.getElementById('tab-ai-btn');
  const editorContent = document.getElementById('tab-content-editor');
  const aiContent = document.getElementById('tab-content-ai');

  if (tabName === 'editor') {
    editorBtn.classList.add('active');
    aiBtn.classList.remove('active');
    editorContent.classList.remove('hidden');
    aiContent.classList.add('hidden');
  } else {
    editorBtn.classList.remove('active');
    aiBtn.classList.add('active');
    editorContent.classList.add('hidden');
    aiContent.classList.remove('hidden');
    parseAndRenderAIPlan();
  }
}

// Fetch connections list from main process
async function loadContacts() {
  if (window.electronAPI && window.electronAPI.getConnections) {
    contacts = await window.electronAPI.getConnections();
    renderContactsList();
  }
}

// Group and display contacts in the sidebar list
function renderContactsList(filterText = '') {
  const container = document.getElementById('contacts-list');
  container.innerHTML = '';

  if (contacts.length === 0) {
    container.innerHTML = '<div style="color: var(--text-muted); font-size:11.5px; padding:10px; text-align:center;">Папка пуста. Создайте контакты!</div>';
    return;
  }

  // Filter contacts
  const filtered = contacts.filter(c => {
    if (!filterText) return true;
    return c.name.toLowerCase().includes(filterText.toLowerCase()) || 
           c.group.toLowerCase().includes(filterText.toLowerCase());
  });

  // Group contacts by parent folder
  const groups = {};
  filtered.forEach(c => {
    if (!groups[c.group]) groups[c.group] = [];
    groups[c.group].push(c);
  });

  // Render grouped contacts
  Object.keys(groups).sort().forEach(groupName => {
    const section = document.createElement('div');
    section.className = 'group-section';

    const header = document.createElement('div');
    header.className = 'group-header';
    header.innerHTML = `📁 <span>${groupName}</span>`;
    section.appendChild(header);

    groups[groupName].sort((a, b) => a.name.localeCompare(b.name)).forEach(contact => {
      const item = document.createElement('div');
      item.className = 'contact-item';
      if (selectedContact && selectedContact.fullPath === contact.fullPath) {
        item.classList.add('active');
      }
      item.textContent = contact.name;
      item.onclick = () => selectContact(contact);
      section.appendChild(item);
    });

    container.appendChild(section);
  });
}

// Select contact from list and load details
async function selectContact(contact) {
  selectedContact = contact;
  
  // Highlight active element in list
  document.querySelectorAll('.contact-item').forEach(el => {
    el.classList.remove('active');
    if (el.textContent === contact.name) {
      el.classList.add('active');
    }
  });

  // Hide placeholder and show panel
  document.getElementById('details-placeholder').classList.add('hidden');
  document.getElementById('details-content').classList.remove('hidden');

  // Fill in header
  document.getElementById('current-contact-name').textContent = contact.name;
  document.getElementById('current-contact-path').textContent = contact.relativePath;

  // Load details from file
  if (window.electronAPI && window.electronAPI.getConnectionDetail) {
    const content = await window.electronAPI.getConnectionDetail(contact.fullPath);
    document.getElementById('markdown-textarea').value = content;
  }

  // Switch to editor tab by default on connection select
  switchTab('editor');
}

// Parse AI plan out of markdown file content
function parseAndRenderAIPlan() {
  const content = document.getElementById('markdown-textarea').value;
  const parts = content.split('## План общения (ИИ)');
  
  const aiPlanSection = parts[1] ? parts[1].trim() : '';
  const markdownOutput = document.getElementById('ai-output-markdown');
  const tasksContainer = document.getElementById('ai-tasks-container');
  const tasksList = document.getElementById('ai-tasks-list');
  
  if (aiPlanSection) {
    markdownOutput.innerHTML = renderMarkdown(aiPlanSection);
    
    // Parse tasks
    const tasks = [];
    aiPlanSection.split(/\r?\n/).forEach(line => {
      if (line.includes('СПИСОК_ДЕЛ:')) {
        const t = line.substring(line.indexOf('СПИСОК_ДЕЛ:') + 11).trim();
        if (t) tasks.push(t);
      }
    });

    if (tasks.length > 0) {
      tasksList.innerHTML = '';
      tasks.forEach(taskText => {
        const card = document.createElement('div');
        card.className = 'ai-task-card';
        
        const textSpan = document.createElement('span');
        textSpan.className = 'ai-task-text';
        textSpan.textContent = taskText;

        const addBtn = document.createElement('button');
        addBtn.className = 'ai-task-add-btn';
        addBtn.innerHTML = '+';
        addBtn.title = 'Добавить в дела';
        addBtn.onclick = async () => {
          const activeFile = localStorage.getItem('active_task_file') || 'Дела';
          if (window.electronAPI && window.electronAPI.addNewTask) {
            const success = await window.electronAPI.addNewTask(taskText, activeFile);
            if (success) {
              addBtn.innerHTML = '✓';
              addBtn.style.borderColor = 'var(--success-color)';
              addBtn.style.color = 'var(--success-color)';
              addBtn.disabled = true;
            }
          }
        };

        card.appendChild(textSpan);
        card.appendChild(addBtn);
        tasksList.appendChild(card);
      });
      tasksContainer.classList.remove('hidden');
    } else {
      tasksContainer.classList.add('hidden');
    }
  } else {
    markdownOutput.innerHTML = '<p style="color: var(--text-muted); font-style: italic;">План общения ещё не сгенерирован. Нажмите кнопку выше для запуска ИИ-анализа.</p>';
    tasksContainer.classList.add('hidden');
  }
}

// Convert subset of Markdown to HTML
function renderMarkdown(md) {
  if (!md) return '';
  
  // Filter out raw СПИСОК_ДЕЛ prefix lines from markdown display
  let cleanMd = md.split('\n')
    .filter(line => !line.includes('СПИСОК_ДЕЛ:'))
    .join('\n');

  // Basic HTML sanitization and styling replacement
  let html = cleanMd
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/^### (.*$)/gim, '<h3>$1</h3>')
    .replace(/^## (.*$)/gim, '<h2>$1</h2>')
    .replace(/^# (.*$)/gim, '<h1>$1</h1>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>');

  // Handle unordered list items
  const lines = html.split('\n');
  let inList = false;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('- ') || line.startsWith('* ')) {
      const content = line.substring(2).trim();
      lines[i] = (inList ? '' : '<ul>') + `<li>${content}</li>`;
      inList = true;
    } else if (inList) {
      lines[i - 1] = lines[i - 1] + '</ul>';
      inList = false;
    }
  }
  if (inList) {
    lines[lines.length - 1] = lines[lines.length - 1] + '</ul>';
  }

  // Wrap remaining text blocks in paragraph tags
  html = lines.map(line => {
    if (!line.startsWith('<h') && !line.startsWith('<ul') && !line.startsWith('<li') && !line.startsWith('</ul') && line.trim() !== '') {
      return `<p>${line}</p>`;
    }
    return line;
  }).join('\n');

  return html;
}

// Save connection profile card details to Obsidian
async function saveCurrentContact() {
  if (!selectedContact) return;
  const content = document.getElementById('markdown-textarea').value;
  const statusSpan = document.getElementById('save-status');

  if (window.electronAPI && window.electronAPI.saveConnectionDetail) {
    const success = await window.electronAPI.saveConnectionDetail(selectedContact.fullPath, content);
    if (success) {
      statusSpan.style.opacity = '1';
      setTimeout(() => {
        statusSpan.style.opacity = '0';
      }, 2000);
      
      // Update local contacts cache details if needed
      await loadContacts();
    }
  }
}

// Call Gemini API to execute LLM analysis
async function runAIAnalysis() {
  if (!selectedContact) return;
  
  const statusText = document.getElementById('ai-status');
  const runBtn = document.getElementById('run-ai-btn');
  const markdownOutput = document.getElementById('ai-output-markdown');

  statusText.innerHTML = '<span class="loader"></span> Анализ карточки и выработка рекомендаций...';
  runBtn.disabled = true;

  if (window.electronAPI && window.electronAPI.analyzeConnection) {
    const result = await window.electronAPI.analyzeConnection(selectedContact.fullPath);
    runBtn.disabled = false;
    
    if (result.success) {
      statusText.textContent = 'Анализ успешно завершен!';
      
      // Reload connection detail into text editor
      const updatedContent = await window.electronAPI.getConnectionDetail(selectedContact.fullPath);
      document.getElementById('markdown-textarea').value = updatedContent;
      
      // Re-parse and render new plan
      parseAndRenderAIPlan();
    } else {
      if (result.error === 'no-key') {
        statusText.textContent = 'Ошибка: не задан API ключ!';
        markdownOutput.innerHTML = '<p style="color: var(--danger-color); font-weight: 600;">Укажите валидный API ключ Gemini в настройках основного виджета (иконка шестерёнки ⚙️).</p>';
      } else {
        statusText.textContent = 'Произошла ошибка при анализе.';
        markdownOutput.innerHTML = `<p style="color: var(--danger-color);">Детали ошибки: ${result.error}</p>`;
      }
    }
  }
}

// Delete connection profile from Obsidian
async function deleteCurrentContact() {
  if (!selectedContact) return;
  
  const confirmDel = confirm(`Вы действительно хотите удалить карточку контакта "${selectedContact.name}"?`);
  if (!confirmDel) return;

  if (window.electronAPI && window.electronAPI.deleteConnection) {
    const success = await window.electronAPI.deleteConnection(selectedContact.fullPath);
    if (success) {
      selectedContact = null;
      document.getElementById('details-placeholder').classList.remove('hidden');
      document.getElementById('details-content').classList.add('hidden');
      await loadContacts();
    }
  }
}

// Create connection profile modal controllers
function openCreateModal() {
  document.getElementById('new-contact-name').value = '';
  document.getElementById('new-contact-group').value = '';
  document.getElementById('create-modal').classList.remove('hidden');
  document.getElementById('new-contact-name').focus();
}

function closeCreateModal() {
  document.getElementById('create-modal').classList.add('hidden');
}

async function submitCreateContact() {
  const name = document.getElementById('new-contact-name').value.trim();
  const group = document.getElementById('new-contact-group').value.trim();

  if (!name) {
    alert('Пожалуйста, введите имя контакта!');
    return;
  }

  if (window.electronAPI && window.electronAPI.createConnection) {
    const success = await window.electronAPI.createConnection(name, group);
    if (success) {
      closeCreateModal();
      await loadContacts();
      
      // Find the newly created contact and select it
      const newContact = contacts.find(c => c.name === name);
      if (newContact) {
        selectContact(newContact);
      }
    } else {
      alert('Ошибка при создании контакта. Возможно, контакт с таким именем уже существует.');
    }
  }
}
