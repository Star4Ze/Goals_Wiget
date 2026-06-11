// Settings Color Palette Definitions
const premiumColors = [
  { name: 'Фиолетовый', primary: '#a186f1', hover: '#b399ff', dark: '#2a1b5c' },
  { name: 'Мятный', primary: '#3ddc84', hover: '#5beb9b', dark: '#0a4224' },
  { name: 'Синий', primary: '#4db8ff', hover: '#75caff', dark: '#0a355c' },
  { name: 'Оранжевый', primary: '#ff9100', hover: '#ffa733', dark: '#5c3100' },
  { name: 'Розовый', primary: '#ff5370', hover: '#ff758f', dark: '#5c0d1b' },
  { name: 'Желтый', primary: '#ffc400', hover: '#ffd133', dark: '#5c4500' }
];

// Load and apply theme and opacity settings on start
let currentAccent = localStorage.getItem('connections_accent') || localStorage.getItem('accent_primary') || '#a186f1';
let currentHover = localStorage.getItem('connections_accent_hover') || localStorage.getItem('accent_hover') || '#b399ff';
let currentDark = localStorage.getItem('connections_accent_dark') || localStorage.getItem('accent_dark') || '#2a1b5c';
let currentOpacity = parseFloat(localStorage.getItem('connections_opacity') || '0.92');
let currentBlur = parseInt(localStorage.getItem('connections_blur') || '25');

function applyWindowSettings() {
  document.documentElement.style.setProperty('--accent-color', currentAccent);
  document.documentElement.style.setProperty('--accent-hover', currentHover);
  document.documentElement.style.setProperty('--accent-dark', currentDark);
  document.documentElement.style.setProperty('--window-opacity', currentOpacity);
  document.documentElement.style.setProperty('--window-blur', `${currentBlur}px`);
}

applyWindowSettings();

let contacts = [];
let selectedContact = null;
let currentTab = 'profile'; // 'profile', 'editor', or 'ai'

document.addEventListener('DOMContentLoaded', () => {
  initUI();
  initSettingsValues();
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

// Initialize settings panel controls and sliders
function initSettingsValues() {
  // Opacity Slider
  const opacitySlider = document.getElementById('connections-opacity-slider');
  const opacityLabel = document.getElementById('opacity-label');
  if (opacitySlider && opacityLabel) {
    opacitySlider.value = currentOpacity;
    opacityLabel.textContent = `Прозрачность окна: ${Math.round(currentOpacity * 100)}%`;
    
    opacitySlider.addEventListener('input', (e) => {
      currentOpacity = parseFloat(e.target.value);
      opacityLabel.textContent = `Прозрачность окна: ${Math.round(currentOpacity * 100)}%`;
      document.documentElement.style.setProperty('--window-opacity', currentOpacity);
      localStorage.setItem('connections_opacity', currentOpacity);
    });
  }

  // Blur Slider
  const blurSlider = document.getElementById('connections-blur-slider');
  const blurLabel = document.getElementById('blur-label');
  if (blurSlider && blurLabel) {
    blurSlider.value = currentBlur;
    blurLabel.textContent = `Размытие фона: ${currentBlur}px`;
    
    blurSlider.addEventListener('input', (e) => {
      currentBlur = parseInt(e.target.value);
      blurLabel.textContent = `Размытие фона: ${currentBlur}px`;
      document.documentElement.style.setProperty('--window-blur', `${currentBlur}px`);
      localStorage.setItem('connections_blur', currentBlur);
    });
  }

  // Accent Colors Palette
  const palette = document.getElementById('connections-color-palette');
  if (palette) {
    palette.innerHTML = '';
    premiumColors.forEach(color => {
      const circle = document.createElement('div');
      circle.className = 'color-circle-option';
      circle.style.backgroundColor = color.primary;
      circle.title = color.name;
      
      if (color.primary === currentAccent) {
        circle.classList.add('active');
      }
      
      circle.onclick = () => {
        document.querySelectorAll('.color-circle-option').forEach(c => c.classList.remove('active'));
        circle.classList.add('active');
        
        currentAccent = color.primary;
        currentHover = color.hover;
        currentDark = color.dark;
        
        applyWindowSettings();
        
        localStorage.setItem('connections_accent', currentAccent);
        localStorage.setItem('connections_accent_hover', currentHover);
        localStorage.setItem('connections_accent_dark', currentDark);
      };
      
      palette.appendChild(circle);
    });
  }
}

function initUI() {
  // Close Window
  document.getElementById('close-connections-btn').onclick = () => {
    if (window.electronAPI && window.electronAPI.closeWindow) {
      window.electronAPI.closeWindow();
    }
  };

  // Toggle Settings Modal
  const settingsModal = document.getElementById('connections-settings-modal');
  document.getElementById('connections-settings-btn').onclick = () => {
    settingsModal.classList.remove('hidden');
  };
  document.getElementById('connections-settings-close').onclick = () => {
    settingsModal.classList.add('hidden');
  };
  settingsModal.onclick = (e) => {
    if (e.target === settingsModal) {
      settingsModal.classList.add('hidden');
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
  document.getElementById('tab-profile-btn').onclick = () => switchTab('profile');
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
  
  const profileBtn = document.getElementById('tab-profile-btn');
  const editorBtn = document.getElementById('tab-editor-btn');
  const aiBtn = document.getElementById('tab-ai-btn');
  
  const profileContent = document.getElementById('tab-content-profile');
  const editorContent = document.getElementById('tab-content-editor');
  const aiContent = document.getElementById('tab-content-ai');

  profileBtn.classList.remove('active');
  editorBtn.classList.remove('active');
  aiBtn.classList.remove('active');
  
  profileContent.classList.add('hidden');
  editorContent.classList.add('hidden');
  aiContent.classList.add('hidden');

  if (tabName === 'profile') {
    profileBtn.classList.add('active');
    profileContent.classList.remove('hidden');
    renderProfileCard();
  } else if (tabName === 'editor') {
    editorBtn.classList.add('active');
    editorContent.classList.remove('hidden');
  } else {
    aiBtn.classList.add('active');
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

  // Switch to profile viewing tab by default
  switchTab('profile');
}

// Parses YAML frontmatter block from file content
function parseFrontmatterAndMarkdown(content) {
  let frontmatter = {};
  let markdown = content;
  
  // Match metadata between --- block
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (match) {
    const yamlText = match[1];
    markdown = match[2];
    
    yamlText.split(/\r?\n/).forEach(line => {
      const parts = line.split(':');
      if (parts.length >= 2) {
        const key = parts[0].trim().toLowerCase();
        const value = parts.slice(1).join(':').trim();
        frontmatter[key] = value;
      }
    });
  }
  
  return { frontmatter, markdown };
}

// Calculate days elapsed between last contact and today
function calculateDaysSince(dateStr) {
  if (!dateStr || dateStr.toLowerCase().includes('mm-dd') || dateStr.toLowerCase().includes('yyyy-mm-dd') || dateStr === '') {
    return null;
  }
  
  try {
    const lastDate = new Date(dateStr);
    if (isNaN(lastDate.getTime())) return null;
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    lastDate.setHours(0, 0, 0, 0);
    
    const diffTime = Math.abs(today - lastDate);
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    
    // Return negative if date is in the future
    return today >= lastDate ? diffDays : -diffDays;
  } catch (e) {
    return null;
  }
}

// Beautiful visualized profile tab renderer
function renderProfileCard() {
  const content = document.getElementById('markdown-textarea').value;
  const { frontmatter, markdown } = parseFrontmatterAndMarkdown(content);
  
  const gridContainer = document.getElementById('profile-meta-grid');
  const bodyContainer = document.getElementById('profile-body-content');
  
  // Clean MD text from AI recommendations if displayed in main profile
  const mainMarkdown = markdown.split('## План общения (ИИ)')[0].trim();
  
  // Set up frontmatter fields
  const status = frontmatter['статус'] || 'Не указан';
  const city = frontmatter['город'] || 'Не указан';
  const phone = frontmatter['телефон'] || 'Не указан';
  const birthday = frontmatter['день_рождения'] || 'Не указан';
  const lastContact = frontmatter['последний_контакт'] || '';
  const freq = parseInt(frontmatter['частота_поддежки_связей_дней'] || '30');
  const strength = frontmatter['сила_связи'] || 'Не указана';

  // Compute contact health
  let healthHTML = '';
  const daysSince = calculateDaysSince(lastContact);
  
  if (daysSince === null) {
    healthHTML = `
      <div class="profile-health-badge warning">
        <span>🟡</span>
        <span>История общений не найдена. Укажите 'последний_контакт' в формате ГГГГ-ММ-ДД.</span>
      </div>
    `;
  } else if (daysSince > freq) {
    healthHTML = `
      <div class="profile-health-badge alert">
        <span>🔴</span>
        <span>Пора связаться! Прошло ${daysSince} дней с последней беседы (лимит поддержки: ${freq} дн.)</span>
      </div>
    `;
  } else {
    healthHTML = `
      <div class="profile-health-badge good">
        <span>🟢</span>
        <span>Связь поддерживается (прошло ${daysSince} дн. из ${freq})</span>
      </div>
    `;
  }

  // Populate metrics grid
  gridContainer.innerHTML = `
    ${healthHTML}
    <div class="profile-card-metric">
      <div class="profile-card-lbl">Статус</div>
      <div class="profile-card-val" title="${status}">${status}</div>
    </div>
    <div class="profile-card-metric">
      <div class="profile-card-lbl">Город</div>
      <div class="profile-card-val" title="${city}">${city}</div>
    </div>
    <div class="profile-card-metric">
      <div class="profile-card-lbl">Телефон</div>
      <div class="profile-card-val" title="${phone}">${phone}</div>
    </div>
    <div class="profile-card-metric">
      <div class="profile-card-lbl">День рождения</div>
      <div class="profile-card-val" title="${birthday}">${birthday}</div>
    </div>
    <div class="profile-card-metric">
      <div class="profile-card-lbl">Последний контакт</div>
      <div class="profile-card-val" title="${lastContact || 'Нет данных'}">${lastContact || 'Нет данных'}</div>
    </div>
    <div class="profile-card-metric">
      <div class="profile-card-lbl">Сила связи</div>
      <div class="profile-card-val" title="${strength}">${strength}</div>
    </div>
  `;

  // Render markdown body
  bodyContainer.innerHTML = renderMarkdownHTML(mainMarkdown);
}

// Advanced Markdown to HTML parser supporting tables and bullet lists
function renderMarkdownHTML(md) {
  if (!md) return '<p style="color: var(--text-muted); font-style: italic;">Карточка пуста.</p>';

  let html = md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/^### (.*$)/gim, '<h3>$1</h3>')
    .replace(/^## (.*$)/gim, '<h2>$1</h2>')
    .replace(/^# (.*$)/gim, '<h1>$1</h1>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>');

  const lines = html.split('\n');
  let inList = false;
  let inTable = false;
  let tableLines = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    // Process markdown tables
    if (line.startsWith('|') && line.endsWith('|')) {
      if (inList) {
        lines[i - 1] = lines[i - 1] + '</ul>';
        inList = false;
      }
      if (!inTable) {
        inTable = true;
        tableLines = [];
      }
      tableLines.push(line);
      lines[i] = ''; // clear original line index
    } else {
      if (inTable) {
        lines[i - 1] = renderTableHTML(tableLines);
        inTable = false;
      }
      
      // Process unordered lists
      if (line.startsWith('- ') || line.startsWith('* ')) {
        const content = line.substring(2).trim();
        lines[i] = (inList ? '' : '<ul>') + `<li>${content}</li>`;
        inList = true;
      } else if (inList) {
        lines[i - 1] = lines[i - 1] + '</ul>';
        inList = false;
      }
    }
  }
  
  // Close any opened blocks at EOF
  if (inTable) {
    lines[lines.length - 1] = renderTableHTML(tableLines);
  }
  if (inList) {
    lines[lines.length - 1] = lines[lines.length - 1] + '</ul>';
  }

  // Wrap standard text nodes in paragraphs
  html = lines.map(line => {
    if (!line.startsWith('<h') && !line.startsWith('<ul') && !line.startsWith('<li') && !line.startsWith('</ul') && !line.startsWith('<table') && !line.startsWith('</table') && !line.startsWith('<tr') && !line.startsWith('</tr') && line.trim() !== '') {
      return `<p>${line}</p>`;
    }
    return line;
  }).join('\n');

  return html;
}

// Helper to convert table rows into an HTML table structure
function renderTableHTML(rows) {
  if (rows.length < 2) return '';
  
  let html = '<table>';
  let hasHeader = false;
  
  // Delimiter indicator |---|---|
  if (/^\|[\s-|-]*\|$/.test(rows[1].trim())) {
    hasHeader = true;
  }
  
  rows.forEach((row, idx) => {
    if (hasHeader && idx === 1) return; // skip row separator
    
    const cells = row.split('|').slice(1, -1).map(c => c.trim());
    html += '<tr>';
    cells.forEach(cell => {
      const tag = (hasHeader && idx === 0) ? 'th' : 'td';
      html += `<${tag}>${cell}</${tag}>`;
    });
    html += '</tr>';
  });
  
  html += '</table>';
  return html;
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
    markdownOutput.innerHTML = renderMarkdownHTML(aiPlanSection);
    
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
