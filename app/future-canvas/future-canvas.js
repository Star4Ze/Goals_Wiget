/**
 * Future Canvas — JavaScript Engine (Vanilla JS)
 * Handles 3D perspective timeline planning, node/connection rendering, depth blurring, and Electron IPC.
 */

// Global State
let currentBoard = null;
let boardList = [];
let selectedNodeId = null;
let hoveredNodeId = null;

// Undo/Redo history stacks
const undoStack = [];
const redoStack = [];

// Coordinates for empty space right click
let emptyClickWorldMs = 0;
let emptyClickWorldY = 0;

// Blur state toggle
let isBlurEnabled = localStorage.getItem('fc_blur_enabled') !== 'false';

// Image caching
const imageCache = {};

// Time range constants (1995 to 2100 locked)
const START_MS = new Date('1995-01-01').getTime();
const END_MS = new Date('2100-12-31').getTime();

// 3D Perspective Projection System
let VP_X = 640;               // Vanishing Point X (recalculated on resize)
let VP_Y = 44;                // Vanishing Point Y (set very high, right under titlebar)
let baselineY = 700;          // Baseline Y where timeline lies (recalculated on resize)
const baselineMargin = 60;    // Margin (pixels) left and right for 1995 and 2100 bounds

let camCenterMs = (START_MS + END_MS) / 2; // World X camera (starts centered)
let camCenterY = 0;          // World Y camera (centers average nodes)
let msPerPixel = (END_MS - START_MS) / (1200 - 2 * baselineMargin); // current zoom
let yScale = 1.0;            // Keeps vertical zoom constant (fixed Y axis)

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

// Elements
let canvas, ctx;
let timelineCanvas, timelineCtx; // (Dummy/Hidden)
let boardSelect;
let filterPanel, filterList;
let nodeModal, boardModal, exportModal;
let ctxMenu;

// Helpers
function generateUUID() {
  return typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Math.random().toString(36).substring(2, 15);
}

// Helper to load and cache local or remote images
function getCachedImage(url) {
  if (!url) return null;
  if (imageCache[url]) {
    return imageCache[url].complete && imageCache[url].naturalWidth !== 0 ? imageCache[url] : null;
  }
  const img = new Image();
  img.src = url;
  imageCache[url] = img;
  img.onload = () => {
    triggerRender();
  };
  return null;
}

// Undo/Redo implementation
function pushState() {
  if (!currentBoard) return;
  const state = {
    nodes: JSON.parse(JSON.stringify(currentBoard.nodes)),
    connections: JSON.parse(JSON.stringify(currentBoard.connections))
  };
  
  if (undoStack.length > 0) {
    const top = undoStack[undoStack.length - 1];
    if (JSON.stringify(top.nodes) === JSON.stringify(state.nodes) && 
        JSON.stringify(top.connections) === JSON.stringify(state.connections)) {
      return; // No change
    }
  }
  
  undoStack.push(state);
  redoStack.length = 0; // Clear redo history on new action
  updateUndoRedoButtonsUI();
}

function undo() {
  if (undoStack.length <= 1) return;
  const currentState = undoStack.pop();
  redoStack.push(currentState);
  
  const previousState = undoStack[undoStack.length - 1];
  currentBoard.nodes = JSON.parse(JSON.stringify(previousState.nodes));
  currentBoard.connections = JSON.parse(JSON.stringify(previousState.connections));
  
  updateUndoRedoButtonsUI();
  saveBoardImmediate();
  triggerRender();
}

function redo() {
  if (redoStack.length === 0) return;
  const nextState = redoStack.pop();
  undoStack.push(nextState);
  
  currentBoard.nodes = JSON.parse(JSON.stringify(nextState.nodes));
  currentBoard.connections = JSON.parse(JSON.stringify(nextState.connections));
  
  updateUndoRedoButtonsUI();
  saveBoardImmediate();
  triggerRender();
}

function updateUndoRedoButtonsUI() {
  const undoBtn = document.getElementById('fc-btn-undo');
  const redoBtn = document.getElementById('fc-btn-redo');
  if (!undoBtn || !redoBtn) return;
  
  if (undoStack.length > 1) {
    undoBtn.style.color = '#ffffff';
    undoBtn.style.opacity = '1.0';
    undoBtn.style.pointerEvents = 'auto';
    undoBtn.style.cursor = 'pointer';
  } else {
    undoBtn.style.color = 'var(--outline-var)';
    undoBtn.style.opacity = '0.4';
    undoBtn.style.pointerEvents = 'none';
    undoBtn.style.cursor = 'default';
  }
  
  if (redoStack.length > 0) {
    redoBtn.style.color = '#ffffff';
    redoBtn.style.opacity = '1.0';
    redoBtn.style.pointerEvents = 'auto';
    redoBtn.style.cursor = 'pointer';
  } else {
    redoBtn.style.color = 'var(--outline-var)';
    redoBtn.style.opacity = '0.4';
    redoBtn.style.pointerEvents = 'none';
    redoBtn.style.cursor = 'default';
  }
}

// Calculate viewport zoom/pan bounds to lock edges at 1995 and 2100
function applyViewportConstraints() {
  if (!canvas) return;
  const W = canvas.width;
  
  // Max scale: whole 1995-2100 range fits perfectly inside W minus baseline margins
  const maxMsPerPixel = (END_MS - START_MS) / (W - 2 * baselineMargin);
  if (msPerPixel > maxMsPerPixel || isNaN(msPerPixel)) {
    msPerPixel = maxMsPerPixel;
  }
  
  // Min scale: zoomed in to see about 3 days across screen width (allows days view)
  const minMsPerPixel = (3.0 * 24 * 60 * 60 * 1000) / W;
  if (msPerPixel < minMsPerPixel) {
    msPerPixel = minMsPerPixel;
  }
  
  // Constrain camCenterMs so view boundaries cannot exceed START_MS and END_MS
  const halfWidthMs = (W / 2 - baselineMargin) * msPerPixel;
  const minCamMs = START_MS + halfWidthMs;
  const maxCamMs = END_MS - halfWidthMs;
  
  if (camCenterMs < minCamMs) {
    camCenterMs = minCamMs;
  } else if (camCenterMs > maxCamMs) {
    camCenterMs = maxCamMs;
  }

  // Toggle "Вернуться в реальность" button based on distance from today (now)
  const diff = Math.abs(camCenterMs - Date.now());
  const showRealityBtn = diff > 45 * 24 * 60 * 60 * 1000; // 45 days panned away from today
  const realityBtn = document.getElementById('fc-btn-reality');
  if (realityBtn) {
    if (showRealityBtn) {
      realityBtn.classList.add('visible');
    } else {
      realityBtn.classList.remove('visible');
    }
  }
}

// Get 3D perspective projected position for a node
// Under the new requirement, the node stays completely stationary on hover!
// ignoreHover parameter is retained for backwards compatibility.
function getProjectedPosition(node, ignoreHover = false) {
  const nodeMs = new Date(node.date).getTime();
  const W = canvas.width;
  
  // 1. Calculate X position on the baseline (linear timeline)
  const sxOnBaseline = (nodeMs - camCenterMs) / msPerPixel + W / 2;
  
  // 2. Probability (0-100%) maps to depth Z (0.0 to 1.0)
  const z = (node.probability !== undefined ? node.probability : 50) / 100;
  const depth = Math.pow(z, 0.75);             // non-linear perspective mapping
  
  // 3. Project baseline to vanishing point VP
  const px = VP_X + (sxOnBaseline - VP_X) * depth;
  const py = VP_Y + (baselineY - VP_Y) * depth;
  
  // 4. Vertical offset (height above grid) - stays static (no Y-shifting on hover)
  const heightOffset = -node.y; // Positive Y in board goes down, negative goes up
  const pyFinal = py - heightOffset * depth;
  
  // Visual scale hover expands size slightly without changing projected screen center
  const hoverFactor = ignoreHover ? 0 : (node.hoverFactor || 0);

  return {
    x: px,
    y: pyFinal,
    depth: depth,
    // Radius expands slightly on hover (e.g. 25% larger)
    radius: getNodeRadius(node) * (0.5 + 0.5 * depth) * (1.0 + 0.25 * hoverFactor)
  };
}

// Convert screen coordinates back to 3D perspective world coordinates
function screenToWorld(sx, sy) {
  // We assume default depth (z = 0.5, 50% probability) for conversion of new/clicked nodes
  const depth = Math.pow(0.5, 0.75);
  const sxOnBaseline = (sx - VP_X) / depth + VP_X;
  const wms = (sxOnBaseline - canvas.width / 2) * msPerPixel + camCenterMs;
  
  const py = VP_Y + (baselineY - VP_Y) * depth;
  const visualHeight = py - sy;
  const wy = -(visualHeight / depth);
  
  return { wms, wy };
}

// Determine base node radius based on importance
function getNodeRadius(node) {
  const baseRadius = 8;
  const importance = node.importance || 5;
  return baseRadius * (importance / 5);
}

// Find node under screen mouse coordinates using projected 3D positions
function findNodeAt(sx, sy) {
  if (!currentBoard) return null;
  // Search in reverse order to select top-most nodes first
  for (let i = currentBoard.nodes.length - 1; i >= 0; i--) {
    const node = currentBoard.nodes[i];
    const sphere = currentBoard.spheres.find(s => s.id === node.sphere);
    if (sphere && !sphere.visible) continue;

    // Hit-testing uses the exact projected position
    const pos = getProjectedPosition(node);
    const dist = Math.hypot(sx - pos.x, sy - pos.y);
    if (dist <= pos.radius + 7) {
      return node;
    }
  }
  return null;
}

// Connection handles (anchors)
function getAnchorScreenPos(node) {
  const pos = getProjectedPosition(node);
  return { x: pos.x + pos.radius, y: pos.y };
}

function isOverAnchor(sx, sy, node) {
  const anchor = getAnchorScreenPos(node);
  const dist = Math.hypot(sx - anchor.x, sy - anchor.y);
  return dist <= 10;
}

// Setup and Event Binding
window.addEventListener('DOMContentLoaded', async () => {
  updateColorsFromCSS();

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

  window.addEventListener('resize', handleResize);
  handleResize();

  setupWindowControls();
  await refreshBoardsList();
  setupCanvasEvents();
  setupModalSliders();
  updateBlurButtonUI();

  requestAnimationFrame(renderLoop);
});

function handleResize() {
  const wrap = document.getElementById('fc-canvas-wrap');
  if (!wrap) return;
  canvas.width = wrap.clientWidth;
  canvas.height = wrap.clientHeight;
  
  // Set Vanishing Point very high and Baseline right above status bar
  VP_X = canvas.width / 2;
  VP_Y = 44; // Just under custom titlebar
  baselineY = canvas.height - 35; // Just above status bar (28px height + spacing)

  const timelineWrap = document.getElementById('fc-timeline');
  if (timelineWrap) {
    timelineCanvas.width = timelineWrap.clientWidth;
    timelineCanvas.height = timelineWrap.clientHeight;
  }
  
  applyViewportConstraints();
  triggerRender();
}

function setupWindowControls() {
  document.getElementById('fc-btn-reload')?.addEventListener('click', () => {
    window.location.reload();
  });
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

// Render loop wrapper with hover animation transitions
let lastTime = Date.now();
function renderLoop() {
  const now = Date.now();
  const dt = (now - lastTime) / 1000;
  lastTime = now;

  let animating = false;

  if (currentBoard) {
    // Smoothly update hoverFactor for all nodes
    currentBoard.nodes.forEach(node => {
      if (!node.hoverFactor) node.hoverFactor = 0;
      
      const target = (node.id === hoveredNodeId) ? 1.0 : 0.0;
      const diff = target - node.hoverFactor;
      
      if (Math.abs(diff) > 0.005) {
        node.hoverFactor += diff * 0.15; // smooth visual transition
        animating = true;
      } else {
        node.hoverFactor = target;
      }
    });
  }

  if (isPanning || isDraggingNode || isConnecting || animating) {
    triggerRender();
  } else {
    // Slide camera Y smoothly back to average height of all visible nodes
    if (currentBoard && currentBoard.nodes.length > 0) {
      let sumY = 0;
      let count = 0;
      currentBoard.nodes.forEach(node => {
        const sphere = currentBoard.spheres.find(s => s.id === node.sphere);
        if (!sphere || sphere.visible !== false) {
          sumY += node.y;
          count++;
        }
      });
      if (count > 0) {
        const targetY = sumY / count;
        if (Math.abs(camCenterY - targetY) > 0.5) {
          camCenterY += (targetY - camCenterY) * 0.08;
          triggerRender();
        }
      }
    }
  }
  requestAnimationFrame(renderLoop);
}

let renderScheduled = false;
function triggerRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    drawCanvas();
    drawTimeline(); // Dummy
    renderScheduled = false;
  });
}

// Get the appropriate grid interval dynamically based on the current zoom scale
// (Lowered threshold to 60px to show months, weeks, and days lines early when zooming)
function getGridIntervalMs() {
  const intervals = [
    { ms: 10 * 365.25 * 24 * 60 * 60 * 1000, step: 10, type: 'year' }, // 10 years
    { ms: 5 * 365.25 * 24 * 60 * 60 * 1000, step: 5, type: 'year' },   // 5 years
    { ms: 365.25 * 24 * 60 * 60 * 1000, step: 1, type: 'year' },       // 1 year
    { ms: 90 * 24 * 60 * 60 * 1000, step: 3, type: 'month' },          // quarter
    { ms: 30 * 24 * 60 * 60 * 1000, step: 1, type: 'month' },          // month
    { ms: 7 * 24 * 60 * 60 * 1000, step: 1, type: 'week' },            // week
    { ms: 24 * 60 * 60 * 1000, step: 1, type: 'day' }                  // day
  ];
  
  // Find the first interval (starting from smallest) that leaves at least 60px spacing at the baseline
  for (let i = intervals.length - 1; i >= 0; i--) {
    const spacing = intervals[i].ms / msPerPixel;
    if (spacing >= 60) {
      return intervals[i];
    }
  }
  return intervals[0];
}

// Generate ticks with labels aligned to intervals
function getGridTicks(interval) {
  const ticks = [];
  const startYear = new Date(START_MS).getFullYear();
  const endYear = new Date(END_MS).getFullYear();
  
  if (interval.type === 'year') {
    const stepYears = interval.step;
    const firstYear = Math.ceil(startYear / stepYears) * stepYears;
    for (let yr = firstYear; yr <= endYear; yr += stepYears) {
      ticks.push({
        ms: new Date(`${yr}-01-01`).getTime(),
        label: yr.toString()
      });
    }
  } else if (interval.type === 'month') {
    const months = ['Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн', 'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек'];
    let current = new Date(START_MS);
    current.setDate(1);
    current.setHours(0, 0, 0, 0);
    
    while (current.getTime() <= END_MS) {
      ticks.push({
        ms: current.getTime(),
        label: `${months[current.getMonth()]} ${current.getFullYear()}`
      });
      current.setMonth(current.getMonth() + interval.step);
    }
  } else if (interval.type === 'week') {
    let current = new Date(START_MS);
    const day = current.getDay();
    const diff = current.getDate() - day + (day === 0 ? -6 : 1);
    current.setDate(diff);
    current.setHours(0, 0, 0, 0);
    
    while (current.getTime() <= END_MS) {
      ticks.push({
        ms: current.getTime(),
        label: `${current.getDate()}.${String(current.getMonth() + 1).padStart(2, '0')}`
      });
      current.setTime(current.getTime() + 7 * 24 * 60 * 60 * 1000);
    }
  } else {
    // Day
    let current = new Date(START_MS);
    current.setHours(0, 0, 0, 0);
    
    while (current.getTime() <= END_MS) {
      ticks.push({
        ms: current.getTime(),
        label: `${current.getDate()} ${['Вс','Пн','Вт','Ср','Чт','Пт','Сб'][current.getDay()]}`
      });
      current.setTime(current.getTime() + 24 * 60 * 60 * 1000);
    }
  }
  return ticks;
}

// DRAWING CANVAS (3D Perspective)
function drawCanvas() {
  if (!canvas || !ctx) return;
  
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  applyViewportConstraints();

  const W = canvas.width;
  
  // 1. Draw 3D Perspective Grid
  // Draw baseline
  ctx.strokeStyle = 'rgba(67, 71, 78, 0.4)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(baselineMargin, baselineY);
  ctx.lineTo(W - baselineMargin, baselineY);
  ctx.stroke();

  // Get dynamic ticks based on zoom level
  const interval = getGridIntervalMs();
  const ticks = getGridTicks(interval);
  const visibleTicks = ticks.filter(t => {
    const sx = (t.ms - camCenterMs) / msPerPixel + W / 2;
    return sx >= -100 && sx <= W + 100;
  });

  // Draw receding lines converging towards VP, fading out 60% (depth = 0.2) of the way
  visibleTicks.forEach(t => {
    const sxOnBaseline = (t.ms - camCenterMs) / msPerPixel + W / 2;
    
    // Stop drawing grid lines 80% of the way to the vanishing point (depth = 0.2)
    const lx = VP_X + (sxOnBaseline - VP_X) * 0.2;
    const ly = VP_Y + (baselineY - VP_Y) * 0.2;
    
    const grad = ctx.createLinearGradient(sxOnBaseline, baselineY, lx, ly);
    grad.addColorStop(0, 'rgba(67, 71, 78, 0.35)'); // Opaque at the bottom
    grad.addColorStop(0.5, 'rgba(67, 71, 78, 0.15)'); // Fading
    grad.addColorStop(1, 'rgba(67, 71, 78, 0.0)');    // Fully transparent
    
    ctx.strokeStyle = grad;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(sxOnBaseline, baselineY);
    ctx.lineTo(lx, ly);
    ctx.stroke();
  });

  // Draw horizontal depth guides (Probability levels)
  const sx1995 = (START_MS - camCenterMs) / msPerPixel + W / 2;
  const sx2100 = (END_MS - camCenterMs) / msPerPixel + W / 2;
  const probLevels = [0, 25, 50, 75, 100];
  probLevels.forEach(prob => {
    const z = prob / 100;
    const depth = Math.pow(z, 0.75);
    
    const lx = VP_X + (sx1995 - VP_X) * depth;
    const rx = VP_X + (sx2100 - VP_X) * depth;
    const gy = VP_Y + (baselineY - VP_Y) * depth;
    
    ctx.strokeStyle = prob === 100 ? 'rgba(67, 71, 78, 0.35)' : 'rgba(67, 71, 78, 0.08)';
    ctx.lineWidth = prob === 100 ? 1.5 : 1.0;
    ctx.beginPath();
    ctx.moveTo(lx, gy);
    ctx.lineTo(rx, gy);
    ctx.stroke();
  });

  // 2. Draw Connections (Sigmoidal Bézier curves in 3D perspective space)
  if (currentBoard) {
    currentBoard.connections.forEach(conn => {
      const fromNode = currentBoard.nodes.find(n => n.id === conn.fromNodeId);
      const toNode = currentBoard.nodes.find(n => n.id === conn.toNodeId);
      if (!fromNode || !toNode) return;

      const fromSphere = currentBoard.spheres.find(s => s.id === fromNode.sphere);
      const toSphere = currentBoard.spheres.find(s => s.id === toNode.sphere);
      if ((fromSphere && !fromSphere.visible) || (toSphere && !toSphere.visible)) return;

      const pStart = getProjectedPosition(fromNode);
      const pEnd = getProjectedPosition(toNode);

      const prob = fromNode.probability || 50;
      const thickness = Math.max(1.0, (prob / 25) * (0.4 + 0.6 * pStart.depth));
      ctx.lineWidth = thickness;
      
      const isDiscarded = fromNode.status === 'discarded' || toNode.status === 'discarded';
      ctx.strokeStyle = isDiscarded ? 'rgba(141, 145, 152, 0.08)' : `rgba(141, 145, 152, ${0.1 + 0.35 * pStart.depth})`;

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
        ctx.bezierCurveTo(
          pStart.x + 50 * pStart.depth, pStart.y,
          pEnd.x - 50 * pEnd.depth, pEnd.y,
          pEnd.x, pEnd.y
        );
      }
      ctx.stroke();
    });
  }

  // 3. Draw vertical NOW line in perspective
  const nowMs = Date.now();
  const nowXOnBaseline = (nowMs - camCenterMs) / msPerPixel + W / 2;
  
  // Stop now line 80% of the way to the vanishing point (depth = 0.2)
  const nowEndLx = VP_X + (nowXOnBaseline - VP_X) * 0.2;
  const nowEndLy = VP_Y + (baselineY - VP_Y) * 0.2;

  const nowGrad = ctx.createLinearGradient(nowXOnBaseline, baselineY, nowEndLx, nowEndLy);
  nowGrad.addColorStop(0, colors.tertiary);
  nowGrad.addColorStop(1, 'rgba(0, 219, 231, 0.0)');

  ctx.strokeStyle = nowGrad;
  ctx.lineWidth = 1.0;
  ctx.beginPath();
  ctx.moveTo(nowXOnBaseline, baselineY);
  ctx.lineTo(nowEndLx, nowEndLy);
  ctx.stroke();

  // NOW Label on baseline
  ctx.fillStyle = colors.tertiary;
  ctx.font = '700 9px "JetBrains Mono", monospace';
  ctx.textAlign = 'center';
  ctx.fillText('СЕЙЧАС', nowXOnBaseline, baselineY - 10);

  // 4. Draw Nodes (Sorted by depth - Painter's Algorithm)
  let hoveredNode = null;
  if (currentBoard) {
    const sortedNodes = [...currentBoard.nodes].map(node => {
      return { node, pos: getProjectedPosition(node) };
    }).sort((a, b) => a.pos.depth - b.pos.depth);

    sortedNodes.forEach(({ node, pos }) => {
      const sphere = currentBoard.spheres.find(s => s.id === node.sphere);
      if (sphere && !sphere.visible) return;

      if (node.id === hoveredNodeId) {
        hoveredNode = node;
      }

      const color = sphere ? sphere.color : '#aac9f0';
      const isSelected = (node.id === selectedNodeId);

      const baseOpacity = node.status === 'discarded' ? 0.25 : (node.status === 'hypothetical' ? 0.65 : 1.0);
      const opacity = baseOpacity * (0.3 + 0.7 * pos.depth);

      // Depth of Field (DoF) Blur (Bypassed if user toggled blur off)
      const hoverFactor = node.hoverFactor || 0;
      const blurVal = isBlurEnabled ? Math.max(0, (1 - pos.depth) * 4.5 * (1 - hoverFactor)) : 0;

      ctx.save();
      ctx.globalAlpha = opacity;
      
      if (blurVal > 0.5) {
        ctx.filter = `blur(${blurVal}px)`;
      } else {
        ctx.filter = 'none';
      }

      // Neon glowing shadows
      if (node.type === 'goal' || isSelected) {
        ctx.shadowColor = color;
        ctx.shadowBlur = isSelected ? 22 : 12;
      } else {
        ctx.shadowBlur = 0;
      }

      ctx.lineWidth = isSelected ? 3.0 : 1.5;

      if (node.type === 'decision') {
        // Draw Diamond
        ctx.strokeStyle = color;
        ctx.fillStyle = isSelected ? color : 'rgba(30, 32, 34, 0.8)';
        ctx.beginPath();
        ctx.moveTo(pos.x, pos.y - pos.radius * 1.25);
        ctx.lineTo(pos.x + pos.radius * 1.25, pos.y);
        ctx.lineTo(pos.x, pos.y + pos.radius * 1.25);
        ctx.lineTo(pos.x - pos.radius * 1.25, pos.y);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      } else {
        // Draw Circle
        ctx.strokeStyle = color;
        ctx.fillStyle = (node.status === 'realized' || isSelected) ? color : 'rgba(30, 32, 34, 0.8)';
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, pos.radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        // Inner dot
        if (node.type === 'event' && node.status !== 'realized' && !isSelected) {
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(pos.x, pos.y, pos.radius * 0.4, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // Selected connection anchor handle
      if (isSelected) {
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 1.0;
        ctx.fillStyle = colors.tertiary;
        ctx.beginPath();
        ctx.arc(pos.x + pos.radius, pos.y, 4, 0, Math.PI * 2);
        ctx.fill();
      }

      // Label below node
      ctx.shadowBlur = 0;
      ctx.fillStyle = isSelected ? 'var(--on-surface)' : 'var(--on-surface-var)';
      ctx.font = isSelected ? '600 11px "JetBrains Mono", monospace' : '500 11px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      
      let titleText = node.title || 'Без названия';
      if (node.probability !== undefined && node.type !== 'goal') {
        titleText += ` (${node.probability}%)`;
      }
      ctx.fillText(titleText, pos.x, pos.y + pos.radius + 15);

      ctx.restore();
    });
  }

  // 5. Draw Temp Drag Connection Line
  if (isConnecting && connectSourceNode) {
    const pStart = getProjectedPosition(connectSourceNode);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = colors.tertiary;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(pStart.x, pStart.y);
    ctx.lineTo(connectMouseX, connectMouseY);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // 6. Draw 3D Timeline Axis along baseline
  drawTimelineOnMainCanvas(visibleTicks);

  // 7. Draw Tooltip description card if hovered
  if (hoveredNode) {
    drawNodeTooltip(hoveredNode);
  }
}

// DRAW TIMELINE DIRECTLY ON THE CANVAS
function drawTimelineOnMainCanvas(visibleTicks) {
  const W = canvas.width;
  ctx.strokeStyle = 'rgba(141, 145, 152, 0.4)';
  ctx.lineWidth = 1;
  
  ctx.font = '600 10px "JetBrains Mono", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  
  visibleTicks.forEach(t => {
    const sx = (t.ms - camCenterMs) / msPerPixel + W / 2;
    if (sx < baselineMargin - 10 || sx > W - baselineMargin + 10) return;
    
    // Draw tick mark
    ctx.strokeStyle = 'rgba(141, 145, 152, 0.4)';
    ctx.beginPath();
    ctx.moveTo(sx, baselineY);
    ctx.lineTo(sx, baselineY + 6);
    ctx.stroke();
    
    // Draw Year/Date Label
    ctx.fillStyle = colors.onSurfaceVar;
    ctx.fillText(t.label, sx, baselineY + 10);
  });
}

// DRAW HOVER TOOLTIP CARD INSIDE CANVAS
function drawNodeTooltip(node) {
  const pos = getProjectedPosition(node);
  
  ctx.save();
  ctx.shadowBlur = 15;
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  
  const cardW = 240;
  const cardH = 110;
  const cardX = Math.max(10, Math.min(canvas.width - cardW - 10, pos.x - cardW / 2));
  const cardY = Math.max(50, pos.y - pos.radius - cardH - 15);
  
  const sphere = currentBoard.spheres.find(s => s.id === node.sphere);
  const color = sphere ? sphere.color : 'var(--tertiary)';
  
  // Image cache check
  const img = getCachedImage(node.imageUrl);
  const hasImage = !!img;

  // Draw card frame
  ctx.fillStyle = 'rgba(18, 19, 22, 0.95)';
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.rect(cardX, cardY, cardW, cardH);
  ctx.fill();
  ctx.stroke();
  
  ctx.shadowBlur = 0;
  
  // Draw image if loaded
  if (hasImage) {
    ctx.drawImage(img, cardX + cardW - 72, cardY + 12, 60, 60);
    ctx.strokeStyle = 'rgba(141, 145, 152, 0.3)';
    ctx.lineWidth = 1;
    ctx.strokeRect(cardX + cardW - 72, cardY + 12, 60, 60);
  }

  // Title (wrap narrower if image present)
  ctx.fillStyle = 'var(--on-surface)';
  ctx.font = 'bold 12px "JetBrains Mono", monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  const title = node.title || 'Без названия';
  const maxTitleChars = hasImage ? 18 : 26;
  ctx.fillText(truncateText(title, maxTitleChars), cardX + 12, cardY + 12);
  
  // Type metadata
  const typeMap = { 'event': 'Событие', 'decision': 'Решение', 'goal': 'Цель' };
  const typeText = typeMap[node.type] || 'Узел';
  ctx.fillStyle = color;
  ctx.font = '700 9px "JetBrains Mono", monospace';
  ctx.fillText(typeText.toUpperCase(), cardX + 12, cardY + 30);
  
  ctx.fillStyle = 'var(--on-surface-var)';
  ctx.font = '500 10px "JetBrains Mono", monospace';
  ctx.fillText(`Дата: ${node.date}`, cardX + (hasImage ? 90 : 110), cardY + 30);
  
  // Stats
  ctx.fillStyle = 'var(--on-surface-var)';
  ctx.fillText(`Вероятность: ${node.probability}%`, cardX + 12, cardY + 45);
  if (!hasImage) {
    ctx.fillText(`Важность: ${node.importance}/10`, cardX + 130, cardY + 45);
  }
  
  // Line separator
  ctx.strokeStyle = 'rgba(67, 71, 78, 0.3)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cardX + 12, cardY + 60);
  ctx.lineTo(cardX + cardW - 12, cardY + 60);
  ctx.stroke();
  
  // Description wrap
  ctx.fillStyle = 'rgba(227, 226, 229, 0.85)';
  ctx.font = '11px "Inter", sans-serif';
  const desc = node.description || 'Описание отсутствует';
  wrapText(ctx, desc, cardX + 12, cardY + 68, hasImage ? cardW - 90 : cardW - 24, 14, 2);
  
  ctx.restore();
}

function truncateText(text, maxChars) {
  if (text.length > maxChars) {
    return text.substring(0, maxChars - 3) + '...';
  }
  return text;
}

function wrapText(context, text, x, y, maxWidth, lineHeight, maxLines) {
  const words = text.split(' ');
  let line = '';
  let lineCount = 0;

  for (let n = 0; n < words.length; n++) {
    let testLine = line + words[n] + ' ';
    let metrics = context.measureText(testLine);
    let testWidth = metrics.width;
    if (testWidth > maxWidth && n > 0) {
      context.fillText(line, x, y);
      line = words[n] + ' ';
      y += lineHeight;
      lineCount++;
      if (lineCount >= maxLines) return;
    } else {
      line = testLine;
    }
  }
  context.fillText(line, x, y);
}

// DUMMY/LEGACY FUNCTION (No-op)
function drawTimeline() {
  // Timeline features are integrated in main canvas rendering loop
}

// ICS Parsing helper (zero dependencies VEVENT splitter)
function parseICS(icsText) {
  const events = [];
  const parts = icsText.split('BEGIN:VEVENT');
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i].split('END:VEVENT')[0];
    
    const summaryMatch = part.match(/SUMMARY:(.*)/);
    if (!summaryMatch) continue;
    let summary = summaryMatch[1].trim();
    summary = summary.replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\n/g, '\n');
    
    const descMatch = part.match(/DESCRIPTION:(.*)/);
    let description = descMatch ? descMatch[1].trim().replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\n/g, '\n') : '';
    
    const dtStartMatch = part.match(/DTSTART(?:;VALUE=DATE|;TZID=[^:]+)?:(.*)/);
    if (!dtStartMatch) continue;
    
    const rawDate = dtStartMatch[1].trim();
    if (rawDate.length >= 8) {
      const yr = rawDate.substring(0, 4);
      const mo = rawDate.substring(4, 6);
      const dy = rawDate.substring(6, 8);
      const dateStr = `${yr}-${mo}-${dy}`;
      
      events.push({
        id: 'yandex-' + generateUUID(),
        type: 'event',
        title: `[Яндекс] ${summary}`,
        description: description,
        date: dateStr,
        probability: 100,
        sphere: 'work',
        status: 'active',
        importance: 5,
        y: -60
      });
    }
  }
  return events;
}

// Sync Yandex Calendar XML/ICS export feed using CORS-free main net.fetch handler
async function syncYandexCalendar() {
  if (!currentBoard || !currentBoard.yandexCalendarUrl) return;
  try {
    document.body.style.cursor = 'wait';
    const icsText = await window.electronAPI.fetchUrl(currentBoard.yandexCalendarUrl);
    const events = parseICS(icsText);
    
    if (events.length === 0) {
      alert('Не найдено событий в календаре. Проверьте правильность iCal (.ics) ссылки.');
      return;
    }
    
    // Filter out old Yandex import nodes and merge new ones
    currentBoard.nodes = currentBoard.nodes.filter(n => !n.id.startsWith('yandex-'));
    currentBoard.nodes.push(...events);
    
    pushState(); // Push state to undo stack
    alert(`Яндекс.Календарь успешно синхронизирован! Импортировано событий: ${events.length}`);
    await saveBoardImmediate();
    triggerRender();
  } catch (e) {
    alert(`Ошибка синхронизации Яндекс.Календаря: ${e.message}`);
  } finally {
    document.body.style.cursor = 'default';
  }
}

// Update Yandex Calendar from the configured iCal address asynchronously on load
async function autoSyncCalendarOnLoad() {
  if (currentBoard && currentBoard.yandexCalendarUrl) {
    await syncYandexCalendar();
  }
}

// Update the blur button UI based on active state
function updateBlurButtonUI() {
  const blurBtn = document.getElementById('fc-btn-blur');
  if (!blurBtn) return;
  const icon = blurBtn.querySelector('.material-symbols-outlined');
  if (isBlurEnabled) {
    icon.textContent = 'blur_on';
    blurBtn.title = 'Выключить размытие фона';
    blurBtn.style.color = 'var(--tertiary)';
  } else {
    icon.textContent = 'blur_off';
    blurBtn.title = 'Включить размытие фона';
    blurBtn.style.color = 'var(--on-surface-var)';
  }
}

// CANVAS INTERACTION EVENTS
function setupCanvasEvents() {
  // Image chooser dialog triggers
  document.getElementById('fc-btn-choose-image').addEventListener('click', () => {
    document.getElementById('fc-nm-image-file').click();
  });
  
  document.getElementById('fc-nm-image-file').addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      // In Electron, File.path holds the absolute native filesystem path!
      document.getElementById('fc-nm-image').value = e.target.files[0].path;
    }
  });

  // Blur toggle button click
  document.getElementById('fc-btn-blur').addEventListener('click', () => {
    isBlurEnabled = !isBlurEnabled;
    localStorage.setItem('fc_blur_enabled', isBlurEnabled);
    updateBlurButtonUI();
    triggerRender();
  });

  // Undo/Redo button clicks
  document.getElementById('fc-btn-undo').addEventListener('click', undo);
  document.getElementById('fc-btn-redo').addEventListener('click', redo);

  // Reality Button (smooth easing back to now)
  document.getElementById('fc-btn-reality').addEventListener('click', () => {
    const startMs = camCenterMs;
    const targetMs = Date.now();
    const startTime = Date.now();
    const duration = 600; // 600ms transition duration
    
    const animatePan = () => {
      const elapsed = Date.now() - startTime;
      const progress = Math.min(1.0, elapsed / duration);
      // Ease In Out Cubic
      const ease = progress < 0.5 ? 4 * progress * progress * progress : 1 - Math.pow(-2 * progress + 2, 3) / 2;
      
      camCenterMs = startMs + (targetMs - startMs) * ease;
      applyViewportConstraints();
      triggerRender();
      
      if (progress < 1.0) {
        requestAnimationFrame(animatePan);
      } else {
        saveBoardDebounced();
      }
    };
    
    camCenterY = 0; // Reset vertical centering as well
    animatePan();
  });

  // Yandex Calendar import trigger
  document.getElementById('fc-btn-calendar').addEventListener('click', async () => {
    if (!currentBoard) return;
    const url = prompt('Введите приватный iCal (.ics) адрес Яндекс.Календаря:', currentBoard.yandexCalendarUrl || '');
    if (url !== null) {
      currentBoard.yandexCalendarUrl = url.trim();
      if (currentBoard.yandexCalendarUrl) {
        await syncYandexCalendar();
      }
    }
  });

  // Zoom (X-axis timeline only, centering year under the mouse using perspective projection)
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    // Calculate perspective depth at mouse cursor Y
    let depth = 1.0;
    if (mouseY > VP_Y && baselineY !== VP_Y) {
      const z = (mouseY - VP_Y) / (baselineY - VP_Y);
      depth = Math.max(0.1, Math.min(1.0, z));
    }
    
    // Reverse project screen mouseX to get corresponding baseline X coordinate
    const sxOnBaseline = (mouseX - VP_X) / depth + VP_X;
    const mouseWorldMs = (sxOnBaseline - canvas.width / 2) * msPerPixel + camCenterMs;

    const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
    msPerPixel = msPerPixel * factor;
    applyViewportConstraints();

    // Recalculate camera center so the mouse is still hovering exactly over the same date
    camCenterMs = mouseWorldMs - (sxOnBaseline - canvas.width / 2) * msPerPixel;
    applyViewportConstraints();

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
      applyViewportConstraints();
      triggerRender();
    } else if (isDraggingNode && draggedNode) {
      // Dragging node in 3D space
      const z = (draggedNode.probability !== undefined ? draggedNode.probability : 50) / 100;
      const depth = Math.pow(z, 0.75);
      
      const sxOnBaseline = (mx - VP_X) / depth + VP_X;
      const targetMs = (sxOnBaseline - canvas.width / 2) * msPerPixel + camCenterMs;
      const constrainedMs = Math.max(START_MS, Math.min(END_MS, targetMs));
      draggedNode.date = new Date(constrainedMs).toISOString().slice(0, 10);
      
      const py = VP_Y + (baselineY - VP_Y) * depth;
      const visualHeight = py - my;
      const heightOffset = visualHeight / depth;
      draggedNode.y = -Math.max(-400, Math.min(400, heightOffset));
      
      triggerRender();
    } else if (isConnecting) {
      connectMouseX = mx;
      connectMouseY = my;
      triggerRender();
    } else {
      // Hover hit detection
      const node = findNodeAt(mx, my);
      if (node) {
        if (hoveredNodeId !== node.id) {
          hoveredNodeId = node.id;
          document.body.style.cursor = 'pointer';
        }
      } else {
        if (hoveredNodeId !== null) {
          hoveredNodeId = null;
          document.body.style.cursor = 'default';
        }
      }
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
      pushState(); // Save state after node dragging finishes
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
          pushState(); // Save state after connection creation
          saveBoardDebounced();
        }
      }
      connectSourceNode = null;
      triggerRender();
    }
  });

  // Double Click (Create Node / Edit Node)
  canvas.addEventListener('dblclick', (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    const clickedNode = findNodeAt(mx, my);
    if (clickedNode) {
      showNodeModal(clickedNode);
    } else {
      // Calculate 3D projected point under cursor (assuming default 50% probability depth)
      const depth = Math.pow(0.5, 0.75);
      const sxOnBaseline = (mx - VP_X) / depth + VP_X;
      const targetMs = (sxOnBaseline - canvas.width / 2) * msPerPixel + camCenterMs;
      const constrainedMs = Math.max(START_MS, Math.min(END_MS, targetMs));
      
      const py = VP_Y + (baselineY - VP_Y) * depth;
      const visualHeight = py - my;
      const heightOffset = visualHeight / depth;
      
      const tempNode = {
        id: '',
        type: 'event',
        title: '',
        description: '',
        date: new Date(constrainedMs).toISOString().slice(0, 10),
        probability: 50,
        sphere: 'work',
        status: 'hypothetical',
        importance: 5,
        y: -heightOffset
      };
      showNodeModal(tempNode, true);
    }
  });

  // Right Click (Context Menu - handles nodes and empty spaces dynamically)
  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    const node = findNodeAt(mx, my);
    if (node) {
      selectedNodeId = node.id;
      triggerRender();
      showContextMenu(e.clientX, e.clientY, true);
    } else {
      selectedNodeId = null;
      const w = screenToWorld(mx, my);
      emptyClickWorldMs = w.wms;
      emptyClickWorldY = w.wy;
      showContextMenu(e.clientX, e.clientY, false);
    }
  });

  // Keyboard Shortcuts (Handles Ctrl+Z / Ctrl+Y undo redo)
  window.addEventListener('keydown', (e) => {
    if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;

    if (e.ctrlKey && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      undo();
      return;
    }
    if (e.ctrlKey && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      redo();
      return;
    }

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
      camCenterMs = (START_MS + END_MS) / 2;
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
    // Center Y on nodes
    if (currentBoard && currentBoard.nodes.length > 0) {
      let sumY = 0;
      currentBoard.nodes.forEach(n => sumY += n.y);
      camCenterY = sumY / currentBoard.nodes.length;
    } else {
      camCenterY = 0;
    }
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
    alert('Future Canvas Terminal v1.0.0\nТема: Void (#0A0E14)\nСохранение: автоматическое в папку boards внутри проекта.');
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
      camCenterMs = currentBoard.viewport.panX || (START_MS + END_MS) / 2;
      camCenterY = currentBoard.viewport.panY || 0;
      msPerPixel = currentBoard.viewport.scale || ((END_MS - START_MS) / (canvas.width - 2 * baselineMargin));
    }
    
    document.getElementById('fc-title-board').textContent = `/ доска: ${currentBoard.name}`;
    document.getElementById('fc-status-board').textContent = `Доска: ${currentBoard.name}`;
    
    buildFilterPanel();
    updateStatusBar();
    triggerRender();

    // Initialize session history stack
    undoStack.length = 0;
    redoStack.length = 0;
    undoStack.push({
      nodes: JSON.parse(JSON.stringify(currentBoard.nodes)),
      connections: JSON.parse(JSON.stringify(currentBoard.connections))
    });
    updateUndoRedoButtonsUI();

    // Trigger Yandex Calendar background auto-sync if url is configured
    setTimeout(autoSyncCalendarOnLoad, 1000);
  }
}

document.getElementById('fc-board-select').addEventListener('change', async (e) => {
  await loadBoard(e.target.value);
});

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
function showContextMenu(x, y, isNode) {
  ctxMenu.style.display = 'block';
  ctxMenu.style.left = x + 'px';
  ctxMenu.style.top = y + 'px';

  const nodeItems = ctxMenu.querySelectorAll('.fc-ctx-node-only');
  const emptyItems = ctxMenu.querySelectorAll('.fc-ctx-empty-only');

  if (isNode) {
    nodeItems.forEach(el => el.style.display = 'block');
    emptyItems.forEach(el => el.style.display = 'none');
  } else {
    nodeItems.forEach(el => el.style.display = 'none');
    emptyItems.forEach(el => el.style.display = 'block');
  }
}

// Hide Context Menu
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
    pushState(); // Save state
    triggerRender();
    saveBoardImmediate();
  }
  hideContextMenu();
});

document.getElementById('fc-ctx-discarded').addEventListener('click', () => {
  const node = currentBoard.nodes.find(n => n.id === selectedNodeId);
  if (node) {
    node.status = 'discarded';
    pushState(); // Save state
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

// Empty space right click actions
document.getElementById('fc-ctx-add-goal').addEventListener('click', () => {
  const tempNode = createTempNodeAtClick('goal');
  showNodeModal(tempNode, true);
  hideContextMenu();
});

document.getElementById('fc-ctx-add-event').addEventListener('click', () => {
  const tempNode = createTempNodeAtClick('event');
  showNodeModal(tempNode, true);
  hideContextMenu();
});

document.getElementById('fc-ctx-add-decision').addEventListener('click', () => {
  const tempNode = createTempNodeAtClick('decision');
  showNodeModal(tempNode, true);
  hideContextMenu();
});

function createTempNodeAtClick(type) {
  return {
    id: '',
    type: type,
    title: '',
    description: '',
    date: new Date(emptyClickWorldMs).toISOString().slice(0, 10),
    probability: type === 'goal' ? 100 : 50,
    sphere: 'work',
    status: 'hypothetical',
    importance: 5,
    y: emptyClickWorldY
  };
}

function deleteNode(id) {
  if (!currentBoard) return;
  currentBoard.nodes = currentBoard.nodes.filter(n => n.id !== id);
  currentBoard.connections = currentBoard.connections.filter(c => c.fromNodeId !== id && c.toNodeId !== id);
  pushState(); // Save state
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

  // Add Image path field value
  document.getElementById('fc-nm-image').value = node.imageUrl || '';
  document.getElementById('fc-nm-image-file').value = ''; // reset file input

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

  // Save image path
  modalTargetNode.imageUrl = document.getElementById('fc-nm-image').value.trim();

  if (isNewNodeModal) {
    modalTargetNode.id = generateUUID();
    currentBoard.nodes.push(modalTargetNode);
  }

  pushState(); // Save state to history stack
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
