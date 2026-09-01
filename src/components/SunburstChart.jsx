import React, { useRef, useEffect, useCallback, useState } from 'react';
import { recordPerfEvent } from '../debug/perfTelemetry';

const COLOR_FAMILY = {
  Users: '#eab308',
  System: '#22c55e',
  Applications: '#06b6d4',
  Library: '#3b82f6',
  private: '#8b5cf6',
  opt: '#a855f7',
  Volumes: '#6366f1',
  usr: '#ec4899',
  'smaller objects...': '#52525b',
  'hidden space...': '#7e22ce'
};

const RING_COLORS = [
  '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6',
  '#ec4899', '#f97316', '#14b8a6', '#6366f1', '#a855f7'
];

function getBaseColor(node, index, theme) {
  const name = typeof node === 'string' ? node : node?.name;
  const type = typeof node === 'string' ? null : node?.type;
  if (theme === 'matrix') return '#39ff66';
  if (name === 'smaller objects...') return COLOR_FAMILY['smaller objects...'];
  if (name === 'hidden space...' || type === 'special') return COLOR_FAMILY['hidden space...'];
  if (type === 'file') return '#64748b';
  if (type === 'directory') return COLOR_FAMILY[name] || RING_COLORS[index % RING_COLORS.length];
  return COLOR_FAMILY[name] || RING_COLORS[index % RING_COLORS.length];
}

const MAX_RINGS = 10;          // show up to 10 enclosure levels at once
const MIN_SWEEP = 0.0004;      // rad — below this a slice is not drawn
const SINK_MS = 380;           // drill-down animation duration
const MAX_LAZY_CONCURRENT = 3;  // avoid a scan storm on a large frontier
const MAX_LAZY_QUEUE = 12;
const PULSE_FRAME_MS = 40;      // 25 FPS is enough for alpha pulse and leaves headroom for interaction
const BULK_MIN_SWEEP = 0.0026;  // about 0.15°: below a pixel-scale arc, group visually
const BULK_MIN_ITEMS = 3;
const MAX_CHILDREN_PER_PARENT = 40;

const easeIn = t => t * t;

export default function SunburstChart({
  data,
  onSelectNode,
  onCenterClick,
  onNeedChildren,
  setHoveredNode,
  onContextMenu,
  highlightedPath,
  colorAssignments = {},
  theme = 'classic',
  collectedPaths = new Set(),
  centerValue = '',
  centerUnit = ''
}) {
  const [canvasSize, setCanvasSize] = useState(540);
  const stageRef = useRef(null);
  const canvasRef = useRef(null);
  const pulseCanvasRef = useRef(null);
  const sliceAnglesRef = useRef([]);
  const bulkPulseLookupRef = useRef(new Map());
  const requestedPathsRef = useRef(new Set()); // dirs already queued for lazy children
  const animRef = useRef(null);                // { start, renderData, transition }
  const pendingTransitionRef = useRef(null);
  const lastDataPathRef = useRef(null);
  const lastDataRef = useRef(null);
  const rafRef = useRef(0);
  const pulseRafRef = useRef(0);
  const pulseValueRef = useRef(0);
  const lastPulseFrameRef = useRef(0);
  const pulseDrawRef = useRef(null);
  const hoveredPathRef = useRef(null);
  const lazyQueueRef = useRef([]);
  const lazyPendingRef = useRef(new Set());
  const lazyActiveRef = useRef(0);
  const centerRadiusRef = useRef(44);

  useEffect(() => {
    const stage = stageRef.current;
    const chartArea = stage?.parentElement;
    if (!chartArea || typeof ResizeObserver === 'undefined') return undefined;
    const updateSize = () => {
      const rect = chartArea.getBoundingClientRect();
      const next = Math.max(1, Math.floor(Math.min(rect.width, rect.height)));
      setCanvasSize(previous => previous === next ? previous : next);
    };
    const observer = new ResizeObserver(updateSize);
    observer.observe(chartArea);
    updateSize();
    return () => observer.disconnect();
  }, []);

  const drainLazyQueue = useCallback(() => {
    while (lazyActiveRef.current < MAX_LAZY_CONCURRENT && lazyQueueRef.current.length > 0) {
      const node = lazyQueueRef.current.shift();
      lazyActiveRef.current += 1;
      Promise.resolve(onNeedChildren?.(node))
        .catch(() => {})
        .finally(() => {
          lazyActiveRef.current -= 1;
          lazyPendingRef.current.delete(node.path);
          drainLazyQueue();
        });
    }
  }, [onNeedChildren]);

  const queueLazyChildren = useCallback((node) => {
    if (!onNeedChildren || !node?.path || node.path.startsWith('__') || lazyPendingRef.current.has(node.path)) return;
    if (requestedPathsRef.current.has(node.path)) return;
    requestedPathsRef.current.add(node.path);
    lazyPendingRef.current.add(node.path);
    if (lazyQueueRef.current.length < MAX_LAZY_QUEUE) {
      lazyQueueRef.current.push(node);
      drainLazyQueue();
    } else {
      lazyPendingRef.current.delete(node.path);
      requestedPathsRef.current.delete(node.path);
    }
  }, [drainLazyQueue, onNeedChildren]);

  /** Full redraw. sink = { depth, t } collapses rings deeper than `depth`
   *  toward the center by factor t ∈ [0,1]. */
  const draw = useCallback((sink, renderData = data, transition = null, captureSlices = true) => {
    const canvas = canvasRef.current;
    if (!canvas || !renderData) return;
    const startedAt = performance.now();
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    const cx = w / 2, cy = h / 2;
    const scale = Math.min(w, h) / 540;
    const outerR = Math.min(w, h) / 2 - 6 * scale;
    const innerRadius = 46 * scale;
    centerRadiusRef.current = Math.max(1, innerRadius - 2 * scale);
    const ringWidth = (outerR - innerRadius) / MAX_RINGS;

    ctx.clearRect(0, 0, w, h);
    const pulseCanvas = pulseCanvasRef.current;
    if (pulseCanvas) pulseCanvas.getContext('2d')?.clearRect(0, 0, pulseCanvas.width, pulseCanvas.height);
    const slices = [];
    let bulkSlices = 0;
    let bulkItems = 0;

    function createBulkNode(parent, children) {
      return {
        path: `__bulk__:${parent.path}:${children[0]?.path || 'items'}`,
        name: 'smaller objects...',
        type: 'bulk',
        size: children.reduce((sum, child) => sum + (Number(child.size) || 0), 0),
        children,
        parentPath: parent.path,
        isBulk: true
      };
    }

    function getRenderableChildren(parent, children, span) {
      if (children.length < BULK_MIN_ITEMS) return children;
      const total = children.reduce((sum, child) => sum + (Number(child.size) || 0), 0);
      if (total <= 0) return children;

      const grouped = [];
      const eligible = [];
      children.forEach(child => {
        const childSweep = ((Number(child.size) || 0) / total) * span;
        if (collectedPaths.has(child.path)) eligible.push(child);
        else if (childSweep < BULK_MIN_SWEEP) grouped.push(child);
        else eligible.push(child);
      });

      // Keep collected items individually so the collector state is always
      // visible and actionable. Only uncollected items may be folded into bulk.
      const uncollectedEligible = eligible.filter(child => !collectedPaths.has(child.path));
      if (uncollectedEligible.length > MAX_CHILDREN_PER_PARENT) {
        const keep = new Set(uncollectedEligible
          .sort((a, b) => (Number(b.size) || 0) - (Number(a.size) || 0))
          .slice(0, MAX_CHILDREN_PER_PARENT));
        uncollectedEligible.forEach(child => {
          if (!keep.has(child)) grouped.push(child);
        });
      }

      if (grouped.length < BULK_MIN_ITEMS) return children;
      const groupedSet = new Set(grouped);
      const firstGroupedIndex = children.findIndex(child => groupedSet.has(child));
      const bulk = createBulkNode(parent, grouped);
      bulkSlices += 1;
      bulkItems += grouped.length;
      const result = [];
      let inserted = false;
      children.forEach((child, index) => {
        if (index === firstGroupedIndex) {
          result.push(bulk);
          inserted = true;
        }
        if (!groupedSet.has(child)) result.push(child);
      });
      if (!inserted) result.push(bulk);
      return result;
    }

    function drawNode(node, startAngle, endAngle, depth, color) {
      if (depth > MAX_RINGS || endAngle - startAngle < MIN_SWEEP) return;

      // Ring geometry; deeper rings sink toward the center during animation
      let r1 = innerRadius + (depth - 1) * ringWidth;
      let alphaBoost = 0;
      if (sink && depth > sink.depth) {
        const f = easeIn(Math.min(1, sink.t));
        r1 = r1 * (1 - f) + innerRadius * 0.35 * f;
        alphaBoost = f;
      }
      let r2 = Math.max(r1 + 1, r1 + ringWidth - 1.2);
      let transitionOpacity = 1;
      if (transition?.kind === 'enter-out') {
        const isSelected = node.path === transition.selectedPath;
        const isSelectedDescendant = !isSelected && node.path.startsWith(`${transition.selectedPath}/`);
        transitionOpacity = isSelected
          ? Math.max(0, 1 - transition.t * 0.95)
          : isSelectedDescendant
            ? Math.max(0, 1 - transition.t * 1.6)
            : Math.max(0, 1 - transition.t * 1.35);
        if (isSelected) {
          const angleT = Math.min(1, transition.t * 1.8);
          const mid = (startAngle + endAngle) / 2;
          startAngle += (mid - Math.PI - startAngle) * angleT;
          endAngle += (mid + Math.PI - endAngle) * angleT;
          const sinkT = Math.min(1, transition.t * 0.9);
          r1 += (innerRadius * 0.55 - r1) * sinkT;
          r2 += (innerRadius * 0.85 - r2) * sinkT;
        }
      } else if (transition?.kind === 'up-out') {
        transitionOpacity = Math.max(0, 1 - transition.t);
        const sinkT = easeIn(transition.t);
        r1 += (innerRadius * 0.42 - r1) * sinkT;
        r2 += (innerRadius * 0.62 - r2) * sinkT;
      } else if (transition?.kind === 'enter-in' || transition?.kind === 'up-in') {
        const expand = transition.t <= 0 ? 0 : 1 - easeIn(1 - transition.t);
        const mid = (startAngle + endAngle) / 2;
        startAngle = mid + (startAngle - mid) * expand;
        endAngle = mid + (endAngle - mid) * expand;
        r1 = innerRadius + (r1 - innerRadius) * expand;
        r2 = innerRadius + (r2 - innerRadius) * expand;
        transitionOpacity = expand;
      }

      const isCollected = collectedPaths.has(node.path);
      const angularGap = theme === 'matrix' ? Math.min(0.003, (endAngle - startAngle) * 0.25) : 0;
      const visualStart = startAngle + angularGap;
      const visualEnd = endAngle - angularGap;

      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, r1, visualStart, visualEnd, false);
      ctx.arc(cx, cy, r2, visualEnd, visualStart, true);
      ctx.closePath();
      const isOtherProtectedSpace = node?.name === 'Other protected space' && node?.hiddenSpaceAdminUnlocked;
      ctx.fillStyle = isOtherProtectedSpace
        ? '#ff7b8a'
        : theme === 'matrix'
          ? '#39ff66'
          : isCollected
            ? '#3a3d45'
            : node.isBulk
              ? COLOR_FAMILY['smaller objects...']
              : color;
      const baseAlpha = isOtherProtectedSpace
        ? 0.9 * (1 - alphaBoost)
        : theme === 'matrix'
          ? Math.max(0.19, 1 - (depth - 1) * 0.09) * (1 - alphaBoost)
          : isCollected ? 0.6 * (1 - alphaBoost)
            : Math.max(0.45, 1 - (depth - 1) * 0.06) * (1 - alphaBoost);
      ctx.globalAlpha = baseAlpha * transitionOpacity;
      ctx.fill();
      if (theme !== 'matrix') {
        ctx.strokeStyle = '#1d2127';
        ctx.lineWidth = 0.75;
        ctx.stroke();
      }
      ctx.restore();

      if (!isCollected) {
        slices.push({ node, r1, r2, startAngle, endAngle, depth });
      }

      // Recurse into children within this node's own arc span. Bulk nodes are
      // visual proxies; their real children are shown by the content tree when
      // the proxy is hovered, not as another hidden canvas fan-out.
      // At the last visible ring there is no reason to invoke drawNode for
      // every deeper child: those calls return immediately and can still walk
      // tens of thousands of entries in a cache directory.
      if (node.isBulk || depth >= MAX_RINGS) return;
      const children = (node.children || []).filter(c => (c.size || 0) > 0 && !(sink && depth >= sink.depth));
      if (!children.length) return;
      const span = endAngle - startAngle;
      const renderChildren = getRenderableChildren(node, children, span);
      const sum = renderChildren.reduce((s, c) => s + (c.size || 0), 0);
      if (sum <= 0 || span <= MIN_SWEEP) return;
      let a = startAngle;
      renderChildren.forEach(child => {
        const sweep = ((child.size || 0) / sum) * span;
        drawNode(child, a, a + sweep, depth + 1, color);
        a += sweep;
      });
    }

    // Root ring across the full circle
    const top = (renderData.children || []).filter(c => (c.size || 0) > 0);
    const topSum = top.reduce((s, c) => s + (c.size || 0), 0);
    let a = 0;
    top.forEach((child, i) => {
      const sweep = topSum > 0 ? ((child.size || 0) / topSum) * Math.PI * 2 : 0;
              drawNode(child, a, a + sweep, 1, colorAssignments[child.path] || getBaseColor(child, i, theme));

      a += sweep;
    });

    // Center hub (click target for "one level up")
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, innerRadius - 2, 0, Math.PI * 2);
    ctx.fillStyle = theme === 'matrix' ? 'rgba(57,255,102,0.05)' : 'rgba(255,255,255,0.04)';
    ctx.fill();
    ctx.restore();

    if (captureSlices) {
      sliceAnglesRef.current = slices;
      bulkPulseLookupRef.current.clear();
    }
    recordPerfEvent('sunburst.draw', performance.now() - startedAt, {
      path: renderData.path || null,
      slices: slices.length,
      children: top.length,
      bulkSlices,
      bulkItems,
      mode: sink ? 'sink' : 'static'
    });

    // Lazy children are requested on demand from pointer interaction below.
    // Scanning every visible frontier here caused a burst of IPC work on large disks.
  }, [data, colorAssignments, collectedPaths, theme]);

  const clearPulseOverlay = useCallback(() => {
    const canvas = pulseCanvasRef.current;
    if (!canvas) return;
    canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
  }, []);

  const drawPulseOverlay = useCallback(() => {
    const canvas = pulseCanvasRef.current;
    const activePath = hoveredPathRef.current || highlightedPath;
    if (!canvas || !activePath) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    let slice = sliceAnglesRef.current.find(candidate => candidate.node.path === activePath);
    if (!slice && bulkPulseLookupRef.current.has(activePath)) {
      slice = bulkPulseLookupRef.current.get(activePath);
    }
    if (!slice) {
      for (const candidate of sliceAnglesRef.current) {
        if (!candidate.node.isBulk) continue;
        if ((candidate.node.children || []).some(child => child.path === activePath)) {
          slice = candidate;
          bulkPulseLookupRef.current.set(activePath, candidate);
          break;
        }
      }
    }
    if (!slice) return;

    const pulseAlpha = theme === 'matrix'
      ? pulseValueRef.current * 0.9
      : 0.1 + pulseValueRef.current * 0.9;
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const angularGap = theme === 'matrix' ? Math.min(0.003, (slice.endAngle - slice.startAngle) * 0.25) : 0;
    const visualStart = slice.startAngle + angularGap;
    const visualEnd = slice.endAngle - angularGap;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, slice.r1, visualStart, visualEnd, false);
    ctx.arc(cx, cy, slice.r2, visualEnd, visualStart, true);
    ctx.closePath();
    ctx.fillStyle = theme === 'matrix' ? '#000000' : '#ffffff';
    ctx.globalAlpha = pulseAlpha;
    ctx.fill();
    ctx.restore();
  }, [highlightedPath, theme]);

  const stopPulse = useCallback(() => {
    if (pulseRafRef.current) cancelAnimationFrame(pulseRafRef.current);
    pulseRafRef.current = 0;
    pulseDrawRef.current = null;
    pulseValueRef.current = 0;
    clearPulseOverlay();
  }, [clearPulseOverlay]);

  const startPulse = useCallback(() => {
    // A new draw callback means the navigated/filtered canvas data changed.
    // Never let an old RAF continue painting its stale closure over the new data.
    if (pulseRafRef.current && pulseDrawRef.current !== drawPulseOverlay) {
      cancelAnimationFrame(pulseRafRef.current);
      pulseRafRef.current = 0;
    }
    if (pulseRafRef.current) return;
    pulseDrawRef.current = drawPulseOverlay;
    const tick = now => {
      if (!hoveredPathRef.current && !highlightedPath) {
        pulseRafRef.current = 0;
        pulseDrawRef.current = null;
        pulseValueRef.current = 0;
        clearPulseOverlay();
        return;
      }
      if (now - lastPulseFrameRef.current < PULSE_FRAME_MS) {
        pulseRafRef.current = requestAnimationFrame(tick);
        return;
      }
      lastPulseFrameRef.current = now;
      pulseValueRef.current = (Math.sin(now / 260) + 1) / 2;
      drawPulseOverlay();
      pulseRafRef.current = requestAnimationFrame(tick);
    };
    pulseRafRef.current = requestAnimationFrame(tick);
  }, [clearPulseOverlay, drawPulseOverlay, highlightedPath]);

  useEffect(() => {
    if (highlightedPath || hoveredPathRef.current) startPulse();
    else stopPulse();
  }, [highlightedPath, startPulse, stopPulse]);

  const runTransition = useCallback((renderData, transition, onComplete) => {
    cancelAnimationFrame(rafRef.current);
    animRef.current = { start: performance.now(), renderData, transition };
    const step = now => {
      const anim = animRef.current;
      if (!anim) return;
      const t = Math.min(1, (now - anim.start) / SINK_MS);
      draw(null, anim.renderData, { ...anim.transition, t }, false);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(step);
      } else {
        animRef.current = null;
        onComplete?.();
      }
    };
    rafRef.current = requestAnimationFrame(step);
  }, [draw]);

  // A navigation callback changes the data path only after the old view has
  // completed its exit. The new snapshot then expands from the center.
  useEffect(() => {
    const nextPath = data?.path || null;
    if (lastDataPathRef.current === null) {
      lastDataPathRef.current = nextPath;
      lastDataRef.current = data;
      if (!animRef.current) draw(null);
      return;
    }
    if (nextPath !== lastDataPathRef.current) {
      const previousData = lastDataRef.current;
      lastDataPathRef.current = nextPath;
      lastDataRef.current = data;
      const pending = pendingTransitionRef.current;
      pendingTransitionRef.current = null;
      const inferredKind = pending?.kind || (
        previousData?.path && nextPath && nextPath.startsWith(`${previousData.path}/`)
          ? 'enter-in'
          : previousData?.path && nextPath && previousData.path.startsWith(`${nextPath}/`)
            ? 'up-in'
            : null
      );
      if (inferredKind && data) {
        runTransition(data, { kind: inferredKind }, () => draw(null));
      } else if (!animRef.current) {
        draw(null);
      }
    } else {
      lastDataRef.current = data;
      if (!animRef.current) draw(null);
    }
  }, [data, draw, runTransition]);

  useEffect(() => {
    if (!animRef.current) draw(null);
  }, [draw, canvasSize]);

  // Drill-down: siblings fade, the selected slice closes toward a full ring,
  // then the renderer navigates and expands the new children fan-wise.
  const startEnter = useCallback((slice) => {
    if (!slice?.node || !data) return;
    runTransition(data, { kind: 'enter-out', selectedPath: slice.node.path }, () => {
      pendingTransitionRef.current = { kind: 'enter-in' };
      if (slice.node.type === 'directory') onSelectNode(slice.node);
    });
  }, [data, onSelectNode, runTransition]);

  const startUp = useCallback(() => {
    if (!data) return;
    runTransition(data, { kind: 'up-out' }, () => {
      pendingTransitionRef.current = { kind: 'up-in' };
      onCenterClick?.();
    });
  }, [data, onCenterClick, runTransition]);

  useEffect(() => () => {
    cancelAnimationFrame(rafRef.current);
    cancelAnimationFrame(pulseRafRef.current);
  }, []);

  function hitTest(e) {
    const canvas = canvasRef.current;
    if (!canvas) return { center: false, slice: null };
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = (e.clientX - rect.left) * scaleX - canvas.width / 2;
    const y = (e.clientY - rect.top) * scaleY - canvas.height / 2;
    const dist = Math.sqrt(x * x + y * y);
    if (dist <= centerRadiusRef.current) return { center: true, slice: null };   // center hub zone
    let ang = Math.atan2(y, x);
    if (ang < 0) ang += Math.PI * 2;
    let best = null;
    for (const s of sliceAnglesRef.current) {
      if (dist >= s.r1 && dist <= s.r2 && ang >= s.startAngle && ang <= s.endAngle) {
        if (!best || s.depth > best.depth) best = s; // prefer innermost enclosure match
      }
    }
    return { center: false, slice: best };
  }

  return (
    <div
      ref={stageRef}
      className="sunburst-stage"
      style={{ width: `${canvasSize}px`, height: `${canvasSize}px` }}
    >
      <canvas
        ref={canvasRef}
        width={canvasSize}
        height={canvasSize}
        className="sunburst-canvas"
        style={{ cursor: 'pointer' }}
        onMouseDown={event => {
          const node = hitTest(event).slice?.node;
          const canDrag = Boolean(node && !node.isBulk && !node.path?.startsWith('__') && node.type !== 'special');
          if (canDrag) event.currentTarget.setAttribute('draggable', 'true');
          else event.currentTarget.removeAttribute('draggable');
        }}
        onMouseMove={e => {
        if (animRef.current) return;
        const { center, slice } = hitTest(e);
        const nextPath = slice?.node?.path || null;
        if (hoveredPathRef.current !== nextPath) {
          hoveredPathRef.current = nextPath;
          setHoveredNode(slice ? slice.node : null);
        }
        if (slice) {
          startPulse();
          const node = slice.node;
          if (node.type === 'directory' && (!node.children || node.children.length === 0) && (node.size || 0) > 0) {
            queueLazyChildren(node);
          }
        }
        e.currentTarget.style.cursor = center ? 'zoom-out' : slice ? 'pointer' : 'default';
      }}
        onDragStart={event => {
          const { slice } = hitTest(event);
          const node = slice?.node;
          if (!node || node.isBulk || node.path?.startsWith('__') || node.type === 'special') {
            event.preventDefault();
            return;
          }
          event.dataTransfer.setData('application/json', JSON.stringify({
            path: node.path,
            name: node.name,
            size: Number(node.size) || 0,
            type: node.type
          }));
          const dragImage = document.createElement('div');
          dragImage.textContent = node.name;
          dragImage.style.cssText = 'position:fixed;top:-1000px;left:-1000px;padding:5px 8px;border:1px solid #64748b;border-radius:5px;background:#252a32;color:#e1e4e8;font:11px -apple-system,sans-serif;white-space:nowrap;';
          document.body.appendChild(dragImage);
          event.dataTransfer.setDragImage(dragImage, 8, 8);
          window.setTimeout(() => dragImage.remove(), 0);
          event.dataTransfer.effectAllowed = 'copy';
        }}
        onDragEnd={event => event.currentTarget.removeAttribute('draggable')}
        onMouseLeave={() => {

        if (hoveredPathRef.current !== null) {
          hoveredPathRef.current = null;
          setHoveredNode(null);
        }
        if (!highlightedPath) stopPulse();
      }}
      onContextMenu={e => {
        if (animRef.current) return;
        const { slice } = hitTest(e);
        if (slice && !slice.node.isBulk) onContextMenu?.(e, slice.node);
      }}
          onClick={e => {
        if (animRef.current) return;
        const { center, slice } = hitTest(e);
        if (center) { startUp(); return; }
        if (slice) {
          if (slice.node.type === 'directory') startEnter(slice);
          else onSelectNode(slice.node); // files remain selection-only
        }
        }}
      />
      <canvas
        ref={pulseCanvasRef}
        width={canvasSize}
        height={canvasSize}
        className="sunburst-pulse-canvas"
        aria-hidden="true"
      />
      <div
        className="center-size-badge"
        style={{
          fontSize: `${Math.max(12, Math.min(24, canvasSize * 18 / 540))}px`,
          lineHeight: 1.1
        }}
        aria-hidden="true"
      >
        {centerValue}
        <span style={{ fontSize: `${Math.max(9, Math.min(16, canvasSize * 12 / 540))}px` }}>{centerUnit}</span>
      </div>
    </div>
  );
}
