/**
 * Future Canvas — JavaScript Engine (Vanilla JS)
 * Handles infinite canvas rendering, node/connection operations, timeline, and Electron IPC.
 */

// Global State
let currentBoard = null;
let boardList = [];
let selectedNodeId = null;

// Design system colors (resolved from CSS variables dynamically)
const colors = {
  bg: '#121316',
  onSurface: '#e3e2e5',
  onSurfaceVar: '#c3c7ce',
  outline: '#8d9198',
  outlineVar: '#43474e',
  primary: '#aac9f0',
  secondary: '#ffb956',
  tertiary: '#00dbe7',
  error: '#ffb4ab'
};

function updateColorsFromCSS() {
  try {
    const style = getComputedStyle(document.documentElement);
    colors.bg = style.getPropertyValue('--bg').trim() || colors.bg;
    colors.onSurface = style.getPropertyValue('--on-surface').trim() || colors.onSurface;
    colors.onSurfaceVar = style.getPropertyValue('--on-surface-var').trim() || colors.onSurfaceVar;
    colors.outline = style.getPropertyValue('--outline').trim() || colors.outline;
    colors.outlineVar = style.getPropertyValue('--outline-var').trim() || colors.outlineVar;
    colors.primary = style.getPropertyValue('--primary').trim() || colors.primary;
    colors.secondary = style.getPropertyValue('--secondary').trim() || colors.secondary;
    colors.tertiary = style.getPropertyValue('--tertiary').trim() || colors.tertiary;
    colors.error = style.getPropertyValue('--error').trim() || colors.error;
  } catch (e) {
    console.error('Error reading CSS color variables:', e);
  }
}

// Camera & Coordinate Zoom System
let camCenterMs = Date.now(); // World X center (milliseconds timestamp)
let camCenterY = 0;          // World Y center
let msPerPixel = (2 * 365.25 * 24 * 60 * 60 * 1000) / 1200; // default zoom: 2 years across 1200px
let yScale = 1.0;            // Screen pixels per world-Y-unit

// Interaction States
let isPanning = false;
let panStartX = 0;
let panStartY = 0;
let panStartCamMs = 0;
let panStartCamY = 0;

let isDraggingNode = false;
let draggedNode = null;
let dragOffsetMs = 0;
let dragOffsetY = 0;

let isConnecting = false;
let connectSourceNode = null;
let connectMouseX = 0;
let connectMouseY = 0;

// Auto-save debounce timer
let saveDebounceTimer = null;

// Elements
let canvas, ctx;
let timelineCanvas, timelineCtx;
let boardSelect;
let filterPanel, filterList;
let nodeModal, boardModal, exportModal;
let ctxMenu;

// Helpers
function generateUUID() {
  return typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Math.random().toString(36).substring(2, 15);
}

// Convert World coordinates to Screen pixels
function worldToScreen(wms, wy) {
  const sx = (wms - camCenterMs) / msPerPixel + canvas.width / 2;
  const sy = (wy - camCenterY) * yScale + canvas.height / 2;
  return { x: sx, y: sy };
}

// Convert Screen pixels to World coordinates
function screenToWorld(sx, sy) {
  const wms = (sx - canvas.width / 2) * msPerPixel + camCenterMs;
  const wy = (sy - canvas.height / 2) / yScale + camCenterY;
  return { wms, wy };
}

// Determine node radius based on importance
function getNodeRadius(node) {
  const baseRadius = 8;
  const importance = node.importance || 5;
  return baseRadius * (importance / 5);
}

// Find node under screen mouse coordinates
function findNodeAt(sx, sy) {
  if (!currentBoard) return null;
  // Search in reverse order to click top-most nodes first
  for (let i = currentBoard.nodes.length - 1; i >= 0; i--) {
    const node = currentBoard.nodes[i];
    // Skip if filtered out
    const sphere = currentBoard.spheres.find(s => s.id === node.sphere);
    if (sphere && !sphere.visible) continue;

    const nodeMs = new Date(node.date).getTime();
    const pos = worldToScreen(nodeMs, node.y);
    const radius = getNodeRadius(node);
    const dist = Math.hypot(sx - pos.x, sy - pos.y);
    if (dist <= radius + 4) {
      return node;
    }
  }
  return null;
}

// Check if mouse is over connection handle (anchor) on the node's right edge
function getAnchorScreenPos(node) {
  const nodeMs = new Date(node.date).getTime();
  const radius = getNodeRadius(node);
  const pos = worldToScreen(nodeMs, node.y);
  return { x: pos.x + radius, y: pos.y };
}

function isOverAnchor(sx, sy, node) {
  const anchor = getAnchorScreenPos(node);
  const dist = Math.hypot(sx - anchor.x, sy - anchor.y);
  return dist <= 10;
}

// Setup and Event Binding
window.addEventListener('DOMContentLoaded', async () => {
  // Resolve CSS color variables before rendering
  updateColorsFromCSS();

  // DOM Elements initialization
  canvas = document.getElementById('fc-canvas');
  ctx = canvas.getContext('2d');
  timelineCanvas = document.getElementById('fc-timeline-canvas');
  timelineCtx = timelineCanvas.getContext('2d');

  boardSelect = document.getElementById('fc-board-select');
  filterPanel = document.getElementById('fc-filter-panel');
  filterList = document.getElementById('fc-filter-list');
  
  nodeModal = document.getElementById('fc-node-modal-overlay');
  boardModal = document.getElementById('fc-board-modal-overlay');
  exportModal = document.getElementById('fc-export-modal-overlay');
  ctxMenu = document.getElementById('fc-ctx-menu');

  // Window Resize
  window.addEventListener('resize', handleResize);
  handleResize();

  // Load Window Controls
  setupWindowControls();

  // Load Boards List
  await refreshBoardsList();

  // Add canvas interaction events
  setupCanvasEvents();

  // Modal sliders updates
  setupModalSliders();

  // Start rendering loop
  requestAnimationFrame(renderLoop);
});

function handleResize() {
  const wrap = document.getElementById('fc-canvas-wrap');
  if (!wrap) return;
  canvas.width = wrap.clientWidth;
  canvas.height = wrap.clientHeight;
  
  const timelineWrap = document.getElementById('fc-timeline');
  if (timelineWrap) {
    timelineCanvas.width = timelineWrap.clientWidth;
    timelineCanvas.height = timelineWrap.clientHeight;
  }
  
  triggerRender();
}

function setupWindowControls() {
  document.getElementById('fc-btn-min').addEventListener('click', () => {
    window.electronAPI?.minimizeWindow();
  });
  document.getElementById('fc-btn-max').addEventListener('click', () => {
    window.electronAPI?.toggleMaximizeWindow();
  });
  document.getElementById('fc-btn-close').addEventListener('click', () => {
    window.electronAPI?.closeWindow();
  });

  document.getElementById('fc-titlebar').addEventListener('dblclick', (e) => {
    if (e.target.closest('.fc-win-btn')) return;
    window.electronAPI?.toggleMaximizeWindow();
  });

  window.electronAPI?.onWindowStateChange((isMaximized) => {
    const win = document.getElementById('fc-window');
    const maxIcon = document.getElementById('fc-max-icon');
    if (isMaximized) {
      win.classList.add('is-maximized');
      maxIcon.textContent = 'filter_none';
    } else {
      win.classList.remove('is-maximized');
      maxIcon.textContent = 'crop_square';
    }
  });
}

function setupModalSliders() {
  const probSlider = document.getElementById('fc-nm-prob');
  const probVal = document.getElementById('fc-nm-prob-val');
  probSlider.addEventListener('input', () => {
    probVal.textContent = probSlider.value + '%';
  });

  const impSlider = document.getElementById('fc-nm-importance');
  const impVal = document.getElementById('fc-nm-importance-val');
  impSlider.addEventListener('input', () => {
    impVal.textContent = impSlider.value;
  });
}

// Render loop wrapper
function renderLoop() {
  if (isPanning || isDraggingNode || isConnecting) {
    triggerRender();
  }
  requestAnimationFrame(renderLoop);
}

let renderScheduled = false;
function triggerRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    drawCanvas();
    drawTimeline();
    renderScheduled = false;
  });
}

// DRAWING CANVAS
function drawCanvas() {
  if (!canvas || !ctx) return;
  
  // Clear canvas
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const startWorld = screenToWorld(0, 0);
  const endWorld = screenToWorld(canvas.width, canvas.height);

  // 1. Draw Grid Lines (faint time lines)
  ctx.strokeStyle = 'rgba(67, 71, 78, 0.15)';
  ctx.lineWidth = 1;
  
  // Determine grid interval based on zoom
  const daysInView = (endWorld.wms - startWorld.wms) / (24 * 60 * 60 * 1000);
  let stepMs;
  if (daysInView > 365 * 5) {
    stepMs = 365.25 * 24 * 60 * 60 * 1000; // year
  } else if (daysInView > 30 * 6) {
    stepMs = 30 * 24 * 60 * 60 * 1000; // month
  } else if (daysInView > 7) {
    stepMs = 7 * 24 * 60 * 60 * 1000; // week
  } else {
    stepMs = 24 * 60 * 60 * 1000; // day
  }

  const firstTick = Math.ceil(startWorld.wms / stepMs) * stepMs;
  for (let t = firstTick; t < endWorld.wms; t += stepMs) {
    const sx = (t - camCenterMs) / msPerPixel + canvas.width / 2;
    ctx.beginPath();
    ctx.moveTo(sx, 0);
    ctx.lineTo(sx, canvas.height);
    ctx.stroke();
  }

  // 2. Draw Connections (sigmoidal/Bézier paths)
  if (currentBoard) {
    ctx.shadowBlur = 0; // reset shadow
    currentBoard.connections.forEach(conn => {
      const fromNode = currentBoard.nodes.find(n => n.id === conn.fromNodeId);
      const toNode = currentBoard.nodes.find(n => n.id === conn.toNodeId);
      
      if (!fromNode || !toNode) return;
      
      // Skip if sphere filtered out
      const fromSphere = currentBoard.spheres.find(s => s.id === fromNode.sphere);
      const toSphere = currentBoard.spheres.find(s => s.id === toNode.sphere);
      if ((fromSphere && !fromSphere.visible) || (toSphere && !toSphere.visible)) return;

      const fromMs = new Date(fromNode.date).getTime();
      const toMs = new Date(toNode.date).getTime();

      const pStart = worldToScreen(fromMs, fromNode.y);
      const pEnd = worldToScreen(toMs, toNode.y);

      // Path opacity & styling
      const prob = fromNode.probability || 50;
      const thickness = Math.max(1.0, prob / 25);
      ctx.lineWidth = thickness;
      
      // Discarded connections get faded
      const isDiscarded = fromNode.status === 'discarded' || toNode.status === 'discarded';
      ctx.strokeStyle = isDiscarded ? 'rgba(141, 145, 152, 0.15)' : 'rgba(141, 145, 152, 0.45)';

      // Bezier curve
      ctx.beginPath();
      ctx.moveTo(pStart.x, pStart.y);
      
      const dx = pEnd.x - pStart.x;
      if (dx > 0) {
        ctx.bezierCurveTo(
          pStart.x + dx * 0.4, pStart.y,
          pEnd.x - dx * 0.4, pEnd.y,
          pEnd.x, pEnd.y
        );
      } else {
        // backward link curve
        ctx.bezierCurveTo(
          pStart.x + 50, pStart.y,
          pEnd.x - 50, pEnd.y,
          pEnd.x, pEnd.y
        );
      }
      ctx.stroke();
    });
  }

  // 3. Draw Now Line
  const nowMs = Date.now();
  const nowX = (nowMs - camCenterMs) / msPerPixel + canvas.width / 2;
  ctx.strokeStyle = colors.tertiary;
  ctx.lineWidth = 1;
  ctx.shadowColor = colors.tertiary;
  ctx.shadowBlur = 10;
  ctx.beginPath();
  ctx.moveTo(nowX, 0);
  ctx.lineTo(nowX, canvas.height);
  ctx.stroke();
  ctx.shadowBlur = 0; // reset

  // Label "СЕЙЧАС"
  ctx.fillStyle = colors.tertiary;
  ctx.font = '700 9px "JetBrains Mono", monospace';
  ctx.textAlign = 'center';
  ctx.fillText('СЕЙЧАС', nowX, 15);

  // 4. Draw Nodes
  if (currentBoard) {
    currentBoard.nodes.forEach(node => {
      const sphere = currentBoard.spheres.find(s => s.id === node.sphere);
      if (sphere && !sphere.visible) return;

      const nodeMs = new Date(node.date).getTime();
      const pos = worldToScreen(nodeMs, node.y);
      const radius = getNodeRadius(node);

      // Check off-screen
      if (pos.x + radius + 100 < 0 || pos.x - radius - 100 > canvas.width ||
          pos.y + radius + 50 < 0 || pos.y - radius - 50 > canvas.height) {
        return;
      }

      const color = sphere ? sphere.color : '#aac9f0';
      const isSelected = (node.id === selectedNodeId);

      // Handle Opacity by status
      let opacity = 1.0;
      if (node.status === 'hypothetical') opacity = 0.65;
      if (node.status === 'discarded') opacity = 0.25;

      ctx.save();
      ctx.globalAlpha = opacity;

      // Glow effect for Goals or Selected Node
      if (node.type === 'goal' || isSelected) {
        ctx.shadowColor = color;
        ctx.shadowBlur = isSelected ? 20 : 12;
      } else {
        ctx.shadowBlur = 0;
      }

      ctx.lineWidth = isSelected ? 3.0 : 1.5;

      if (node.type === 'decision') {
        // Draw Diamond
        ctx.strokeStyle = color;
        ctx.fillStyle = isSelected ? color : 'rgba(30, 32, 34, 0.8)';
        ctx.beginPath();
        ctx.moveTo(pos.x, pos.y - radius * 1.2);
        ctx.lineTo(pos.x + radius * 1.2, pos.y);
        ctx.lineTo(pos.x, pos.y + radius * 1.2);
        ctx.lineTo(pos.x - radius * 1.2, pos.y);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      } else {
        // Draw Event / Goal Circle
        ctx.strokeStyle = color;
        ctx.fillStyle = (node.status === 'realized' || isSelected) ? color : 'rgba(30, 32, 34, 0.8)';
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        // Inner circle dot for event types
        if (node.type === 'event' && node.status !== 'realized' && !isSelected) {
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(pos.x, pos.y, radius * 0.4, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // Draw hover connection handle anchor if hovering
      if (isSelected) {
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 1.0;
        ctx.fillStyle = colors.tertiary;
        ctx.beginPath();
        ctx.arc(pos.x + radius, pos.y, 4, 0, Math.PI * 2);
        ctx.fill();
      }

      // Label below node
      ctx.shadowBlur = 0;
      ctx.fillStyle = isSelected ? colors.onSurface : colors.onSurfaceVar;
      ctx.font = isSelected ? '600 11px "JetBrains Mono", monospace' : '500 11px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      
      let titleText = node.title || 'Без названия';
      if (node.probability !== undefined && node.type !== 'goal') {
        titleText += ` (${node.probability}%)`;
      }
      ctx.fillText(titleText, pos.x, pos.y + radius + 15);

      ctx.restore();
    });
  }

  // 5. Draw Temp Drag Connection Line
  if (isConnecting && connectSourceNode) {
    const fromMs = new Date(connectSourceNode.date).getTime();
    const pStart = worldToScreen(fromMs, connectSourceNode.y);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = colors.tertiary;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(pStart.x, pStart.y);
    ctx.lineTo(connectMouseX, connectMouseY);
    ctx.stroke();
    ctx.setLineDash([]); // reset
  }
}

// DRAWING TIMELINE
function drawTimeline() {
  if (!timelineCanvas || !timelineCtx) return;

  timelineCtx.clearRect(0, 0, timelineCanvas.width, timelineCanvas.height);

  const startWorld = screenToWorld(0, 0);
  const endWorld = screenToWorld(timelineCanvas.width, timelineCanvas.height);

  // Line track
  timelineCtx.strokeStyle = 'rgba(141, 145, 152, 0.2)';
  timelineCtx.lineWidth = 2;
  timelineCtx.beginPath();
  timelineCtx.moveTo(0, timelineCanvas.height / 2);
  timelineCtx.lineTo(timelineCanvas.width, timelineCanvas.height / 2);
  timelineCtx.stroke();

  // Find ticks
  const daysInView = (endWorld.wms - startWorld.wms) / (24 * 60 * 60 * 1000);
  let ticks = [];
  let formatLabel;

  if (daysInView > 365 * 10) {
    const step = 5 * 365.25 * 24 * 60 * 60 * 1000;
    const startYear = new Date(startWorld.wms).getFullYear();
    const firstYear = Math.ceil(startYear / 5) * 5;
    let t = new Date(firstYear, 0, 1).getTime();
    while (t < endWorld.wms) {
      ticks.push(t);
      t += step;
    }
    formatLabel = ms => new Date(ms).getFullYear();
  } else if (daysInView > 365 * 2) {
    const startYear = new Date(startWorld.wms).getFullYear();
    let t = new Date(startYear + 1, 0, 1).getTime();
    while (t < endWorld.wms) {
      ticks.push(t);
      t = new Date(new Date(t).getFullYear() + 1, 0, 1).getTime();
    }
    formatLabel = ms => new Date(ms).getFullYear();
  } else if (daysInView > 90) {
    const startDate = new Date(startWorld.wms);
    let current = new Date(startDate.getFullYear(), startDate.getMonth() + 1, 1);
    while (current.getTime() < endWorld.wms) {
      ticks.push(current.getTime());
      current.setMonth(current.getMonth() + 1);
    }
    const months = ['Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн', 'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек'];
    formatLabel = ms => {
      const d = new Date(ms);
      return months[d.getMonth()] + ' ' + d.getFullYear();
    };
  } else if (daysInView > 14) {
    const step = 7 * 24 * 60 * 60 * 1000;
    const first = Math.ceil(startWorld.wms / step) * step;
    for (let t = first; t < endWorld.wms; t += step) {
      ticks.push(t);
    }
    formatLabel = ms => {
      const d = new Date(ms);
      return d.getDate() + '.' + String(d.getMonth() + 1).padStart(2, '0');
    };
  } else {
    const step = 24 * 60 * 60 * 1000;
    const first = Math.ceil(startWorld.wms / step) * step;
    for (let t = first; t < endWorld.wms; t += step) {
      ticks.push(t);
    }
    formatLabel = ms => {
      const d = new Date(ms);
      return d.getDate() + ' ' + ['Вс','Пн','Вт','Ср','Чт','Пт','Сб'][d.getDay()];
    };
  }

  // Draw ticks
  timelineCtx.font = '500 10px "JetBrains Mono", monospace';
  timelineCtx.textAlign = 'center';
  timelineCtx.textBaseline = 'top';

  ticks.forEach(t => {
    const sx = (t - camCenterMs) / msPerPixel + timelineCanvas.width / 2;
    timelineCtx.strokeStyle = 'rgba(141, 145, 152, 0.4)';
    timelineCtx.lineWidth = 1;
    timelineCtx.beginPath();
    timelineCtx.moveTo(sx, timelineCanvas.height / 2 - 4);
    timelineCtx.lineTo(sx, timelineCanvas.height / 2 + 4);
    timelineCtx.stroke();

    timelineCtx.fillStyle = colors.onSurfaceVar;
    timelineCtx.fillText(formatLabel(t), sx, timelineCanvas.height / 2 + 10);
  });

  // Draw "Now" indicator
  const nowMs = Date.now();
  const nowX = (nowMs - camCenterMs) / msPerPixel + timelineCanvas.width / 2;
  if (nowX >= 0 && nowX <= timelineCanvas.width) {
    timelineCtx.fillStyle = colors.tertiary;
    timelineCtx.shadowColor = colors.tertiary;
    timelineCtx.shadowBlur = 8;
    timelineCtx.beginPath();
    timelineCtx.arc(nowX, timelineCanvas.height / 2, 4, 0, Math.PI * 2);
    timelineCtx.fill();
    timelineCtx.shadowBlur = 0;

    timelineCtx.fillStyle = colors.tertiary;
    timelineCtx.font = '700 9px "JetBrains Mono", monospace';
    timelineCtx.fillText(new Date().getFullYear().toString(), nowX, timelineCanvas.height / 2 - 14);
  }
}

// CANVAS INTERACTION EVENTS
function setupCanvasEvents() {
  // Zoom
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const mouseWorldMs = (mouseX - canvas.width / 2) * msPerPixel + camCenterMs;
    const mouseWorldY = (mouseY - canvas.height / 2) / yScale + camCenterY;

    const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
    const minZoom = 1000 * 60 * 30; // 30 mins per pixel
    const maxZoom = 1000 * 60 * 60 * 24 * 365 * 15; // 15 years per pixel
    
    msPerPixel = Math.max(minZoom, Math.min(maxZoom, msPerPixel * factor));
    yScale = Math.max(0.1, Math.min(10.0, yScale / factor));

    camCenterMs = mouseWorldMs - (mouseX - canvas.width / 2) * msPerPixel;
    camCenterY = mouseWorldY - (mouseY - canvas.height / 2) / yScale;

    triggerRender();
    saveBoardDebounced();
  }, { passive: false });

  // Mouse Down
  canvas.addEventListener('mousedown', (e) => {
    hideContextMenu();
    
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    if (e.button === 0) { // Left Click
      const node = findNodeAt(mx, my);
      if (node) {
        if (isOverAnchor(mx, my, node)) {
          isConnecting = true;
          connectSourceNode = node;
          connectMouseX = e.clientX;
          connectMouseY = e.clientY;
        } else {
          isDraggingNode = true;
          draggedNode = node;
          const w = screenToWorld(mx, my);
          dragOffsetMs = w.wms - new Date(node.date).getTime();
          dragOffsetY = w.wy - node.y;
          selectedNodeId = node.id;
        }
      } else {
        isPanning = true;
        panStartX = e.clientX;
        panStartY = e.clientY;
        panStartCamMs = camCenterMs;
        panStartCamY = camCenterY;
        selectedNodeId = null;
      }
      triggerRender();
    }
  });

  // Mouse Move
  window.addEventListener('mousemove', (e) => {
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    if (isPanning) {
      const dx = e.clientX - panStartX;
      const dy = e.clientY - panStartY;
      
      camCenterMs = panStartCamMs - dx * msPerPixel;
      camCenterY = panStartCamY - dy / yScale;
      triggerRender();
    } else if (isDraggingNode && draggedNode) {
      const w = screenToWorld(mx, my);
      draggedNode.y = w.wy - dragOffsetY;

      const targetMs = w.wms - dragOffsetMs;
      draggedNode.date = new Date(targetMs).toISOString().slice(0, 10);
      triggerRender();
    } else if (isConnecting) {
      connectMouseX = mx;
      connectMouseY = my;
      triggerRender();
    }
  });

  // Mouse Up
  window.addEventListener('mouseup', (e) => {
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    if (isPanning) {
      isPanning = false;
      saveBoardDebounced();
    } else if (isDraggingNode) {
      isDraggingNode = false;
      draggedNode = null;
      saveBoardDebounced();
    } else if (isConnecting) {
      isConnecting = false;
      const targetNode = findNodeAt(mx, my);
      if (targetNode && connectSourceNode && targetNode.id !== connectSourceNode.id) {
        const exists = currentBoard.connections.some(c => 
          (c.fromNodeId === connectSourceNode.id && c.toNodeId === targetNode.id) ||
          (c.fromNodeId === targetNode.id && c.toNodeId === connectSourceNode.id)
        );
        if (!exists) {
          currentBoard.connections.push({
            id: generateUUID(),
            fromNodeId: connectSourceNode.id,
            toNodeId: targetNode.id
          });
          saveBoardDebounced();
        }
      }
      connectSourceNode = null;
      triggerRender();
    }
  });

  // Double Click (Create/Edit Node)
  canvas.addEventListener('dblclick', (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    const clickedNode = findNodeAt(mx, my);
    if (clickedNode) {
      showNodeModal(clickedNode);
    } else {
      const w = screenToWorld(mx, my);
      const tempNode = {
        id: '',
        type: 'event',
        title: '',
        description: '',
        date: new Date(w.wms).toISOString().slice(0, 10),
        probability: 50,
        sphere: 'work',
        status: 'hypothetical',
        importance: 5,
        y: w.wy
      };
      showNodeModal(tempNode, true);
    }
  });

  // Right Click (Context Menu)
  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    const node = findNodeAt(mx, my);
    if (node) {
      selectedNodeId = node.id;
      triggerRender();
      showContextMenu(e.clientX, e.clientY, node);
    }
  });

  // Timeline Click
  timelineCanvas.addEventListener('click', (e) => {
    const rect = timelineCanvas.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const targetMs = (clickX - timelineCanvas.width / 2) * msPerPixel + camCenterMs;
    camCenterMs = targetMs;
    triggerRender();
    saveBoardDebounced();
  });

  // Keyboard Shortcuts
  window.addEventListener('keydown', (e) => {
    if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;

    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (selectedNodeId) {
        deleteNode(selectedNodeId);
        selectedNodeId = null;
        triggerRender();
      }
    }
    if (e.key === 'Escape') {
      hideContextMenu();
      closeAllModals();
      selectedNodeId = null;
      triggerRender();
    }
    if (e.key === 'Home') {
      camCenterMs = Date.now();
      camCenterY = 0;
      triggerRender();
      saveBoardDebounced();
    }
  });

  // Toolbar events
  document.getElementById('fc-btn-add').addEventListener('click', () => {
    const tempNode = {
      id: '',
      type: 'event',
      title: '',
      description: '',
      date: new Date().toISOString().slice(0, 10),
      probability: 50,
      sphere: 'work',
      status: 'hypothetical',
      importance: 5,
      y: 0
    };
    showNodeModal(tempNode, true);
  });

  document.getElementById('fc-btn-now').addEventListener('click', () => {
    camCenterMs = Date.now();
    camCenterY = 0;
    triggerRender();
    saveBoardDebounced();
  });

  document.getElementById('fc-btn-filter').addEventListener('click', () => {
    filterPanel.classList.toggle('visible');
  });

  document.getElementById('fc-btn-export').addEventListener('click', () => {
    showExportModal();
  });

  document.getElementById('fc-btn-settings').addEventListener('click', () => {
    alert('Future Canvas Terminal v1.0.0\nТема: Void (#0A0E14)\nСохранение: автоматическое в D:/GoogleDisk/Docs/FutureCanvas');
  });

  document.getElementById('fc-btn-new-board').addEventListener('click', () => {
    boardModal.classList.add('visible');
    document.getElementById('fc-bm-name').value = '';
    document.getElementById('fc-bm-name').focus();
  });
}

// BOARD MANAGEMENT
async function refreshBoardsList() {
  if (!window.electronAPI) return;
  boardList = await window.electronAPI.getCanvasBoards();
  
  boardSelect.innerHTML = '';
  boardList.forEach(b => {
    const opt = document.createElement('option');
    opt.value = b.id;
    opt.textContent = b.name;
    boardSelect.appendChild(opt);
  });

  let lastBoardId = localStorage.getItem('fc_last_board_id') || 'personal';
  if (!boardList.some(b => b.id === lastBoardId) && boardList.length > 0) {
    lastBoardId = boardList[0].id;
  }
  boardSelect.value = lastBoardId;
  await loadBoard(lastBoardId);
}

async function loadBoard(boardId) {
  if (!window.electronAPI) return;
  
  if (currentBoard) {
    await saveBoardImmediate();
  }

  currentBoard = await window.electronAPI.getCanvasBoardData(boardId);
  if (currentBoard) {
    localStorage.setItem('fc_last_board_id', boardId);
    
    if (currentBoard.viewport) {
      camCenterMs = currentBoard.viewport.panX || Date.now();
      camCenterY = currentBoard.viewport.panY || 0;
      msPerPixel = currentBoard.viewport.scale || ((2 * 365.25 * 24 * 60 * 60 * 1000) / 1200);
    }
    
    document.getElementById('fc-title-board').textContent = `/ доска: ${currentBoard.name}`;
    document.getElementById('fc-status-board').textContent = `Доска: ${currentBoard.name}`;
    
    buildFilterPanel();
    updateStatusBar();
    triggerRender();
  }
}

// Dropdown Change
document.getElementById('fc-board-select').addEventListener('change', async (e) => {
  await loadBoard(e.target.value);
});

// Create Board
document.getElementById('fc-bm-save').addEventListener('click', async () => {
  const name = document.getElementById('fc-bm-name').value.trim();
  if (!name) return;

  if (window.electronAPI) {
    const newB = await window.electronAPI.createCanvasBoard(name);
    if (newB) {
      boardModal.classList.remove('visible');
      await refreshBoardsList();
      boardSelect.value = newB.id;
      await loadBoard(newB.id);
    }
  }
});

document.getElementById('fc-bm-cancel').addEventListener('click', () => {
  boardModal.classList.remove('visible');
});

// Auto-save logic
function saveBoardDebounced() {
  if (saveDebounceTimer) clearTimeout(saveDebounceTimer);
  saveDebounceTimer = setTimeout(saveBoardImmediate, 500);
}

async function saveBoardImmediate() {
  if (!window.electronAPI || !currentBoard) return;
  
  currentBoard.viewport = {
    panX: camCenterMs,
    panY: camCenterY,
    scale: msPerPixel
  };

  await window.electronAPI.saveCanvasBoardData(currentBoard.id, currentBoard);
  updateStatusBar();
}

function updateStatusBar() {
  if (!currentBoard) return;
  document.getElementById('fc-status-nodes').textContent = `Узлов: ${currentBoard.nodes.length}`;
}

// FILTER PANEL
function buildFilterPanel() {
  if (!currentBoard) return;
  filterList.innerHTML = '';

  currentBoard.spheres.forEach(s => {
    const row = document.createElement('div');
    row.className = 'fc-filter-item';

    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.checked = s.visible !== false;
    chk.addEventListener('change', () => {
      s.visible = chk.checked;
      triggerRender();
      saveBoardDebounced();
    });

    const dot = document.createElement('span');
    dot.className = 'fc-filter-dot';
    dot.style.backgroundColor = s.color;

    const lbl = document.createElement('span');
    lbl.textContent = s.name;

    row.appendChild(chk);
    row.appendChild(dot);
    row.appendChild(lbl);
    filterList.appendChild(row);
  });
}

// CONTEXT MENU
function showContextMenu(x, y, node) {
  ctxMenu.style.display = 'block';
  ctxMenu.style.left = x + 'px';
  ctxMenu.style.top = y + 'px';
}

function hideContextMenu() {
  ctxMenu.style.display = 'none';
}

document.getElementById('fc-ctx-edit').addEventListener('click', () => {
  const node = currentBoard.nodes.find(n => n.id === selectedNodeId);
  if (node) showNodeModal(node);
  hideContextMenu();
});

document.getElementById('fc-ctx-connect').addEventListener('click', () => {
  const node = currentBoard.nodes.find(n => n.id === selectedNodeId);
  if (node) {
    isConnecting = true;
    connectSourceNode = node;
    const pos = getAnchorScreenPos(node);
    connectMouseX = pos.x;
    connectMouseY = pos.y;
    triggerRender();
  }
  hideContextMenu();
});

document.getElementById('fc-ctx-realized').addEventListener('click', () => {
  const node = currentBoard.nodes.find(n => n.id === selectedNodeId);
  if (node) {
    node.status = 'realized';
    triggerRender();
    saveBoardImmediate();
  }
  hideContextMenu();
});

document.getElementById('fc-ctx-discarded').addEventListener('click', () => {
  const node = currentBoard.nodes.find(n => n.id === selectedNodeId);
  if (node) {
    node.status = 'discarded';
    triggerRender();
    saveBoardImmediate();
  }
  hideContextMenu();
});

document.getElementById('fc-ctx-delete').addEventListener('click', () => {
  if (selectedNodeId) {
    deleteNode(selectedNodeId);
    selectedNodeId = null;
    triggerRender();
  }
  hideContextMenu();
});

function deleteNode(id) {
  if (!currentBoard) return;
  currentBoard.nodes = currentBoard.nodes.filter(n => n.id !== id);
  currentBoard.connections = currentBoard.connections.filter(c => c.fromNodeId !== id && c.toNodeId !== id);
  saveBoardImmediate();
}

// NODE EDIT MODAL
let modalTargetNode = null;
let isNewNodeModal = false;

function showNodeModal(node, isNew = false) {
  modalTargetNode = node;
  isNewNodeModal = isNew;

  document.getElementById('fc-nm-heading').textContent = isNew ? 'Новый узел' : 'Редактировать узел';
  document.getElementById('fc-nm-type').value = node.type;
  document.getElementById('fc-nm-title').value = node.title || '';
  document.getElementById('fc-nm-desc').value = node.description || '';
  document.getElementById('fc-nm-date').value = node.date || new Date().toISOString().slice(0, 10);
  
  const prob = node.probability !== undefined ? node.probability : 50;
  document.getElementById('fc-nm-prob').value = prob;
  document.getElementById('fc-nm-prob-val').textContent = prob + '%';

  document.getElementById('fc-nm-sphere').value = node.sphere || 'work';
  document.getElementById('fc-nm-status').value = node.status || 'hypothetical';
  
  const importance = node.importance !== undefined ? node.importance : 5;
  document.getElementById('fc-nm-importance').value = importance;
  document.getElementById('fc-nm-importance-val').textContent = importance;

  document.getElementById('fc-nm-delete').style.display = isNew ? 'none' : 'block';

  nodeModal.classList.add('visible');
  document.getElementById('fc-nm-title').focus();
}

document.getElementById('fc-nm-save').addEventListener('click', () => {
  if (!currentBoard || !modalTargetNode) return;

  const title = document.getElementById('fc-nm-title').value.trim();
  modalTargetNode.title = title || 'Без названия';
  modalTargetNode.type = document.getElementById('fc-nm-type').value;
  modalTargetNode.description = document.getElementById('fc-nm-desc').value.trim();
  modalTargetNode.date = document.getElementById('fc-nm-date').value;
  modalTargetNode.probability = parseInt(document.getElementById('fc-nm-prob').value);
  modalTargetNode.sphere = document.getElementById('fc-nm-sphere').value;
  modalTargetNode.status = document.getElementById('fc-nm-status').value;
  modalTargetNode.importance = parseInt(document.getElementById('fc-nm-importance').value);

  if (isNewNodeModal) {
    modalTargetNode.id = generateUUID();
    currentBoard.nodes.push(modalTargetNode);
  }

  nodeModal.classList.remove('visible');
  saveBoardImmediate();
  triggerRender();
});

document.getElementById('fc-nm-cancel').addEventListener('click', () => {
  nodeModal.classList.remove('visible');
});

document.getElementById('fc-nm-delete').addEventListener('click', () => {
  if (modalTargetNode && !isNewNodeModal) {
    deleteNode(modalTargetNode.id);
    selectedNodeId = null;
    nodeModal.classList.remove('visible');
    triggerRender();
  }
});

function closeAllModals() {
  nodeModal.classList.remove('visible');
  boardModal.classList.remove('visible');
  exportModal.classList.remove('visible');
  filterPanel.classList.remove('visible');
}

// EXPORT TO AI
function showExportModal() {
  if (!currentBoard) return;
  
  let output = `ДОСКА: ${currentBoard.name}\nДАТА СОЗДАНИЯ: ${currentBoard.createdAt}\n`;
  output += `========================================\n\n`;
  output += `УЗЛЫ:\n`;
  
  currentBoard.nodes.forEach(n => {
    output += `- [${n.type.toUpperCase()}] ${n.title} (Дата: ${n.date}, Сфера: ${n.sphere}, Статус: ${n.status}, Вероятность: ${n.probability}%, Важность: ${n.importance}/10)\n`;
    if (n.description) output += `  Описание: ${n.description}\n`;
  });
  
  output += `\nСВЯЗИ (КАРТА ВЕТВЛЕНИЯ):\n`;
  currentBoard.connections.forEach(c => {
    const from = currentBoard.nodes.find(n => n.id === c.fromNodeId);
    const to = currentBoard.nodes.find(n => n.id === c.toNodeId);
    if (from && to) {
      output += `- "${from.title}" ===[ведет к]===> "${to.title}"\n`;
    }
  });

  document.getElementById('fc-export-text').value = output;
  exportModal.classList.add('visible');
}

document.getElementById('fc-export-copy').addEventListener('click', () => {
  const text = document.getElementById('fc-export-text');
  text.select();
  document.execCommand('copy');
  
  const copyBtn = document.getElementById('fc-export-copy');
  const prevText = copyBtn.textContent;
  copyBtn.textContent = 'Скопировано!';
  setTimeout(() => {
    copyBtn.textContent = prevText;
  }, 1500);
});

document.getElementById('fc-export-close').addEventListener('click', () => {
  exportModal.classList.remove('visible');
});
