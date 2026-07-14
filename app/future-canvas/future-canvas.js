/**
 * Future Canvas — JavaScript Engine (Vanilla JS)
 * Handles 3D perspective timeline planning, node/connection rendering, depth blurring, and Electron IPC.
 */

// Global State
let currentBoard = null;
let boardList = [];
let selectedNodeId = null;
let hoveredNodeId = null;

// Time range constants (1995 to 2100 locked)
const START_MS = new Date('1995-01-01').getTime();
const END_MS = new Date('2100-12-31').getTime();

// 3D Perspective Projection System
let VP_X = 640;               // Vanishing Point X (recalculated on resize)
let VP_Y = 240;               // Vanishing Point Y
let baselineY = 650;          // Baseline Y where timeline lies
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

// Calculate viewport zoom/pan bounds to lock edges at 1995 and 2100
function applyViewportConstraints() {
  if (!canvas) return;
  const W = canvas.width;
  
  // Max scale: whole 1995-2100 range fits perfectly inside W minus baseline margins
  const maxMsPerPixel = (END_MS - START_MS) / (W - 2 * baselineMargin);
  if (msPerPixel > maxMsPerPixel || isNaN(msPerPixel)) {
    msPerPixel = maxMsPerPixel;
  }
  
  // Min scale: zoomed in to see about 2 years
  const minMsPerPixel = (2.0 * 365.25 * 24 * 60 * 60 * 1000) / W;
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
}

// Get 3D perspective projected position for a node
function getProjectedPosition(node) {
  const nodeMs = new Date(node.date).getTime();
  const W = canvas.width;
  
  // 1. Calculate X position on the baseline (linear timeline)
  const sxOnBaseline = (nodeMs - camCenterMs) / msPerPixel + W / 2;
  
  // 2. Probability (0-100%) maps to depth Z (0.0 to 1.0)
  // Hover makes node fly forward towards user (Z -> 1.0)
  const z = (node.probability !== undefined ? node.probability : 50) / 100;
  const hoverFactor = node.hoverFactor || 0;
  const visualZ = z + (1.0 - z) * hoverFactor * 0.6; // fly forward
  const depth = Math.pow(visualZ, 0.75);             // non-linear perspective mapping
  
  // 3. Project baseline to vanishing point VP
  const px = VP_X + (sxOnBaseline - VP_X) * depth;
  const py = VP_Y + (baselineY - VP_Y) * depth;
  
  // 4. Vertical offset (height above grid)
  const heightOffset = -node.y; // Positive Y in board goes down, negative goes up
  const visualHeight = heightOffset * depth + 40 * hoverFactor; // fly up on hover
  const pyFinal = py - visualHeight;
  
  return {
    x: px,
    y: pyFinal,
    depth: depth,
    radius: getNodeRadius(node) * (0.5 + 0.5 * depth)
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

    const pos = getProjectedPosition(node);
    const dist = Math.hypot(sx - pos.x, sy - pos.y);
    if (dist <= pos.radius + 6) {
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

  requestAnimationFrame(renderLoop);
});

function handleResize() {
  const wrap = document.getElementById('fc-canvas-wrap');
  if (!wrap) return;
  canvas.width = wrap.clientWidth;
  canvas.height = wrap.clientHeight;
  
  // Set Vanishing Point and Baseline relative to viewport size
  VP_X = canvas.width / 2;
  VP_Y = canvas.height * 0.32;
  baselineY = canvas.height * 0.8;

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

  // Draw timeline perspective lines converging in distance (every 10 years)
  ctx.strokeStyle = 'rgba(67, 71, 78, 0.12)';
  ctx.lineWidth = 1;
  for (let yr = 2000; yr <= 2100; yr += 10) {
    const ms = new Date(`${yr}-01-01`).getTime();
    const sxOnBaseline = (ms - camCenterMs) / msPerPixel + W / 2;
    
    ctx.beginPath();
    ctx.moveTo(sxOnBaseline, baselineY);
    ctx.lineTo(VP_X, VP_Y);
    ctx.stroke();
  }

  // Draw horizontal depth guides (Probability boundaries)
  const sx1995 = (START_MS - camCenterMs) / msPerPixel + W / 2;
  const sx2100 = (END_MS - camCenterMs) / msPerPixel + W / 2;
  const probLevels = [0, 25, 50, 75, 100];
  probLevels.forEach(prob => {
    const z = prob / 100;
    const depth = Math.pow(z, 0.75);
    
    const lx = VP_X + (sx1995 - VP_X) * depth;
    const rx = VP_X + (sx2100 - VP_X) * depth;
    const gy = VP_Y + (baselineY - VP_Y) * depth;
    
    ctx.strokeStyle = prob === 100 ? 'rgba(67, 71, 78, 0.3)' : 'rgba(67, 71, 78, 0.08)';
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
  ctx.strokeStyle = colors.tertiary;
  ctx.lineWidth = 1.0;
  ctx.beginPath();
  ctx.moveTo(nowXOnBaseline, baselineY);
  ctx.lineTo(VP_X, VP_Y);
  ctx.stroke();

  // NOW Label
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

      // Depth of Field (DoF) Blur
      const hoverFactor = node.hoverFactor || 0;
      const blurVal = Math.max(0, (1 - pos.depth) * 4.5 * (1 - hoverFactor));

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
  drawTimelineOnMainCanvas();

  // 7. Draw Tooltip description card if hovered
  if (hoveredNode) {
    drawNodeTooltip(hoveredNode);
  }
}

// DRAW TIMELINE DIRECTLY ON THE CANVAS
function drawTimelineOnMainCanvas() {
  const W = canvas.width;
  ctx.strokeStyle = 'rgba(141, 145, 152, 0.3)';
  ctx.lineWidth = 1;
  
  const stepYears = (W > 900) ? 5 : 10;
  const startYear = 1995;
  const endYear = 2100;
  
  ctx.font = '600 10px "JetBrains Mono", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  
  for (let yr = startYear; yr <= endYear; yr += stepYears) {
    const ms = new Date(`${yr}-01-01`).getTime();
    const sx = (ms - camCenterMs) / msPerPixel + W / 2;
    
    if (sx < baselineMargin - 10 || sx > W - baselineMargin + 10) continue;
    
    // Draw tick
    ctx.strokeStyle = 'rgba(141, 145, 152, 0.4)';
    ctx.beginPath();
    ctx.moveTo(sx, baselineY);
    ctx.lineTo(sx, baselineY + 6);
    ctx.stroke();
    
    // Draw Year Label
    ctx.fillStyle = colors.onSurfaceVar;
    ctx.fillText(yr.toString(), sx, baselineY + 10);
  }
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
  
  // Draw card frame
  ctx.fillStyle = 'rgba(18, 19, 22, 0.95)';
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.rect(cardX, cardY, cardW, cardH);
  ctx.fill();
  ctx.stroke();
  
  ctx.shadowBlur = 0;
  
  // Title
  ctx.fillStyle = 'var(--on-surface)';
  ctx.font = 'bold 12px "JetBrains Mono", monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  const title = node.title || 'Без названия';
  ctx.fillText(truncateText(title, 26), cardX + 12, cardY + 12);
  
  // Type metadata
  const typeMap = { 'event': 'Событие', 'decision': 'Решение', 'goal': 'Цель' };
  const typeText = typeMap[node.type] || 'Узел';
  ctx.fillStyle = color;
  ctx.font = '700 9px "JetBrains Mono", monospace';
  ctx.fillText(typeText.toUpperCase(), cardX + 12, cardY + 30);
  
  ctx.fillStyle = 'var(--on-surface-var)';
  ctx.font = '500 10px "JetBrains Mono", monospace';
  ctx.fillText(`Дата: ${node.date}`, cardX + 110, cardY + 30);
  
  // Stats
  ctx.fillStyle = 'var(--on-surface-var)';
  ctx.fillText(`Вероятность: ${node.probability}%`, cardX + 12, cardY + 45);
  ctx.fillText(`Важность: ${node.importance}/10`, cardX + 130, cardY + 45);
  
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
  wrapText(ctx, desc, cardX + 12, cardY + 68, cardW - 24, 14, 2);
  
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

// CANVAS INTERACTION EVENTS
function setupCanvasEvents() {
  // Zoom (X-axis timeline only)
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;

    const mouseWorldMs = (mouseX - canvas.width / 2) * msPerPixel + camCenterMs;
    const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
    
    msPerPixel = msPerPixel * factor;
    applyViewportConstraints();

    camCenterMs = mouseWorldMs - (mouseX - canvas.width / 2) * msPerPixel;
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
          const pos = getProjectedPosition(node);
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
      const hoverFactor = draggedNode.hoverFactor || 0;
      const visualZ = z + (1.0 - z) * hoverFactor * 0.6;
      const depth = Math.pow(visualZ, 0.75);
      
      const sxOnBaseline = (mx - VP_X) / depth + VP_X;
      const targetMs = (sxOnBaseline - canvas.width / 2) * msPerPixel + camCenterMs;
      const constrainedMs = Math.max(START_MS, Math.min(END_MS, targetMs));
      draggedNode.date = new Date(constrainedMs).toISOString().slice(0, 10);
      
      const py = VP_Y + (baselineY - VP_Y) * depth;
      const visualHeight = py - my;
      const heightOffset = (visualHeight - 40 * hoverFactor) / depth;
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
