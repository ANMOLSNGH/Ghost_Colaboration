"use client"

import { useRef, useState, useCallback, useEffect } from "react"
import { useReactFlow, useViewport } from "@xyflow/react"
import { useBroadcastEvent, useEventListener } from "@liveblocks/react"
import { Check, RotateCcw, Trash2, Pencil, Eraser } from "lucide-react"

export type DrawTool = "pencil" | "eraser" | "select"

export interface Point {
  x: number
  y: number
}

export interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export interface Stroke {
  id: string
  points: Point[]
  path: string
  bounds: Bounds
  color: string
  width: number
}

interface DrawingOverlayProps {
  tool: DrawTool
  color?: string
  strokeWidth?: number
  projectId?: string
  onDone?: () => void
}

const ERASER_BASE_RADIUS = 22

function computeBounds(points: Point[]): Bounds {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  return { minX, minY, maxX, maxY }
}

function pathFromPoints(points: Point[]): string {
  const len = points.length
  if (len === 0) return ""
  if (len === 1) {
    return `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)} l 0.1 0`
  }
  let d = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`
  for (let i = 1; i < len; i++) {
    const prev = points[i - 1]
    const curr = points[i]
    const mx = ((prev.x + curr.x) / 2).toFixed(1)
    const my = ((prev.y + curr.y) / 2).toFixed(1)
    d += ` Q ${prev.x.toFixed(1)} ${prev.y.toFixed(1)} ${mx} ${my}`
  }
  const last = points[len - 1]
  d += ` L ${last.x.toFixed(1)} ${last.y.toFixed(1)}`
  return d
}

function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y)
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

function strokeNearPoint(stroke: Stroke, point: Point, radius: number): boolean {
  // Fast AABB rejection test (prevents looping over hundreds of points)
  if (
    point.x < stroke.bounds.minX - radius ||
    point.x > stroke.bounds.maxX + radius ||
    point.y < stroke.bounds.minY - radius ||
    point.y > stroke.bounds.maxY + radius
  ) {
    return false
  }

  const pts = stroke.points
  for (let i = 0; i < pts.length - 1; i++) {
    if (distToSegment(point, pts[i], pts[i + 1]) < radius) return true
  }
  if (pts.length === 1) {
    return Math.hypot(pts[0].x - point.x, pts[0].y - point.y) < radius
  }
  return false
}

// Ensure any loaded or incoming stroke has path and bounds precomputed
function normalizeStroke(raw: Partial<Stroke>): Stroke {
  const points = raw.points || []
  return {
    id: raw.id || `stroke-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    points,
    path: raw.path || pathFromPoints(points),
    bounds: raw.bounds || computeBounds(points),
    color: raw.color || "#f97316",
    width: raw.width || 3,
  }
}

export function DrawingOverlay({
  tool,
  color = "#f97316",
  strokeWidth = 3,
  projectId,
  onDone,
}: DrawingOverlayProps) {
  const svgRef = useRef<SVGSVGElement>(null)
  const activePathRef = useRef<SVGPathElement>(null)
  const eraserCircleRef = useRef<SVGCircleElement>(null)

  const { screenToFlowPosition } = useReactFlow()
  const viewport = useViewport()
  const broadcast = useBroadcastEvent()

  const storageKey = projectId ? `ghost_strokes_${projectId}` : null

  // Strokes state — only updated on stroke completion or actual erase
  const [strokes, setStrokes] = useState<Stroke[]>(() => {
    if (typeof window !== "undefined" && storageKey) {
      try {
        const saved = localStorage.getItem(storageKey)
        if (saved) {
          const parsed = JSON.parse(saved)
          if (Array.isArray(parsed)) return parsed.map(normalizeStroke)
        }
      } catch {
        return []
      }
    }
    return []
  })

  // Synchronous drawing refs — completely decoupled from React state for 120fps smoothness
  const isDrawingRef = useRef(false)
  const currentStrokeRef = useRef<{
    id: string
    points: Point[]
    color: string
    width: number
  } | null>(null)
  const erasedIdsThisDrag = useRef<Set<string>>(new Set())

  // Debounced persistence to avoid blocking the main thread during interaction
  useEffect(() => {
    if (!storageKey) return
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(storageKey, JSON.stringify(strokes))
      } catch {}
    }, 400)
    return () => clearTimeout(timer)
  }, [storageKey, strokes])

  // Sync real-time stroke events with collaborators
  useEventListener(({ event }) => {
    if (!event || typeof event !== "object") return
    const ev = event as { type?: string; stroke?: Partial<Stroke>; strokeId?: string }

    if (ev.type === "stroke-add" && ev.stroke) {
      const incoming = normalizeStroke(ev.stroke)
      setStrokes((prev) => {
        if (prev.some((s) => s.id === incoming.id)) return prev
        return [...prev, incoming]
      })
    } else if (ev.type === "stroke-erase" && ev.strokeId) {
      const idToErase = ev.strokeId
      setStrokes((prev) => prev.filter((s) => s.id !== idToErase))
    } else if (ev.type === "strokes-clear") {
      setStrokes([])
    }
  })

  const isActive = tool === "pencil" || tool === "eraser"
  const zoom = viewport.zoom || 1
  const eraserRadius = ERASER_BASE_RADIUS / zoom

  // Clean reset when tool changes (prevents any lingering capture or lag)
  useEffect(() => {
    isDrawingRef.current = false
    currentStrokeRef.current = null
    erasedIdsThisDrag.current.clear()
    if (activePathRef.current) activePathRef.current.setAttribute("d", "")
    if (eraserCircleRef.current) eraserCircleRef.current.style.display = "none"
  }, [tool])

  // High-performance erase handler — returns previous array if nothing was hit (0 re-renders!)
  const performErase = useCallback(
    (pt: Point, radius: number) => {
      setStrokes((prev) => {
        const toRemove: string[] = []
        for (let i = 0; i < prev.length; i++) {
          const s = prev[i]
          if (!erasedIdsThisDrag.current.has(s.id) && strokeNearPoint(s, pt, radius)) {
            toRemove.push(s.id)
            erasedIdsThisDrag.current.add(s.id)
          }
        }
        // If nothing was hit, return unchanged reference: React skips re-rendering entirely!
        if (toRemove.length === 0) return prev

        for (const id of toRemove) {
          try {
            broadcast({ type: "stroke-erase", strokeId: id })
          } catch {}
        }

        return prev.filter((s) => !toRemove.includes(s.id))
      })
    },
    [broadcast]
  )

  // Finish drawing safely: release capture, commit active stroke to state once
  const finishDrawing = useCallback(
    (e?: React.PointerEvent<SVGSVGElement>) => {
      if (e) {
        try {
          if (e.currentTarget.hasPointerCapture(e.pointerId)) {
            e.currentTarget.releasePointerCapture(e.pointerId)
          }
        } catch {}
      }

      erasedIdsThisDrag.current.clear()

      if (!isDrawingRef.current) return
      isDrawingRef.current = false

      if (tool === "pencil" && currentStrokeRef.current && currentStrokeRef.current.points.length > 0) {
        const pts = currentStrokeRef.current.points
        const completed: Stroke = {
          id: currentStrokeRef.current.id,
          points: pts,
          path: pathFromPoints(pts),
          bounds: computeBounds(pts),
          color: currentStrokeRef.current.color,
          width: currentStrokeRef.current.width,
        }
        setStrokes((prev) => [...prev, completed])
        try {
          broadcast({ type: "stroke-add", stroke: completed })
        } catch {}
      }

      currentStrokeRef.current = null
      if (activePathRef.current) {
        activePathRef.current.setAttribute("d", "")
      }
    },
    [tool, broadcast]
  )

  const onPointerDown = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (!isActive) return
      if (e.button !== 0) return // Left click only

      try {
        e.currentTarget.setPointerCapture(e.pointerId)
      } catch {}

      const pt = screenToFlowPosition({ x: e.clientX, y: e.clientY })
      isDrawingRef.current = true

      if (tool === "pencil") {
        const strokeId = `stroke-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
        currentStrokeRef.current = {
          id: strokeId,
          points: [pt],
          color,
          width: strokeWidth,
        }
        if (activePathRef.current) {
          activePathRef.current.setAttribute("stroke", color)
          activePathRef.current.setAttribute("stroke-width", String(strokeWidth))
          activePathRef.current.setAttribute("d", pathFromPoints([pt]))
        }
      } else if (tool === "eraser") {
        performErase(pt, eraserRadius)
      }
    },
    [isActive, tool, color, strokeWidth, screenToFlowPosition, eraserRadius, performErase]
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (!isActive) return
      const pt = screenToFlowPosition({ x: e.clientX, y: e.clientY })

      if (tool === "eraser") {
        // Direct DOM update of eraser circle — 0 React re-renders!
        if (eraserCircleRef.current) {
          eraserCircleRef.current.style.display = "block"
          eraserCircleRef.current.setAttribute("cx", String(pt.x))
          eraserCircleRef.current.setAttribute("cy", String(pt.y))
          eraserCircleRef.current.setAttribute("r", String(eraserRadius))
          eraserCircleRef.current.setAttribute("stroke-width", String(1.5 / zoom))
          eraserCircleRef.current.setAttribute("stroke-dasharray", `${3 / zoom} ${3 / zoom}`)
        }
        if (isDrawingRef.current) {
          performErase(pt, eraserRadius)
        }
        return
      }

      if (tool === "pencil" && isDrawingRef.current && currentStrokeRef.current) {
        const points = currentStrokeRef.current.points
        const last = points[points.length - 1]
        // Filter out microscopic movements (< 1.5 flow units)
        if (!last || Math.hypot(pt.x - last.x, pt.y - last.y) >= 1.5) {
          points.push(pt)
          // Direct DOM path update — 0 React re-renders while drawing!
          if (activePathRef.current) {
            activePathRef.current.setAttribute("d", pathFromPoints(points))
          }
        }
      }
    },
    [isActive, tool, screenToFlowPosition, eraserRadius, zoom, performErase]
  )

  const onPointerUp = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      finishDrawing(e)
    },
    [finishDrawing]
  )

  const onPointerCancel = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      finishDrawing(e)
    },
    [finishDrawing]
  )

  const onPointerLeave = useCallback(() => {
    if (eraserCircleRef.current) {
      eraserCircleRef.current.style.display = "none"
    }
  }, [])

  // Window-level safety: if mouse button is released outside window, cleanly commit and finish
  useEffect(() => {
    const handleGlobalUp = () => {
      if (isDrawingRef.current) {
        finishDrawing()
      }
    }
    window.addEventListener("pointerup", handleGlobalUp)
    window.addEventListener("pointercancel", handleGlobalUp)
    return () => {
      window.removeEventListener("pointerup", handleGlobalUp)
      window.removeEventListener("pointercancel", handleGlobalUp)
    }
  }, [finishDrawing])

  // Escape key exits drawing mode
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isActive) {
        finishDrawing()
        onDone?.()
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [isActive, finishDrawing, onDone])

  const undoLastStroke = useCallback(() => {
    setStrokes((prev) => {
      if (prev.length === 0) return prev
      const last = prev[prev.length - 1]
      try {
        broadcast({ type: "stroke-erase", strokeId: last.id })
      } catch {}
      return prev.slice(0, -1)
    })
  }, [broadcast])

  const clearAllStrokes = useCallback(() => {
    setStrokes([])
    try {
      broadcast({ type: "strokes-clear" })
    } catch {}
  }, [broadcast])

  return (
    <>
      {/* Top Floating Helper Bar when drawing/erasing */}
      {isActive && (
        <div className="pointer-events-auto absolute top-4 left-1/2 -translate-x-1/2 z-40 flex items-center gap-2 rounded-full border border-border-default bg-bg-surface/95 px-3 py-1.5 shadow-2xl backdrop-blur-xl">
          <span className="flex items-center gap-1.5 text-xs font-semibold text-text-primary">
            {tool === "pencil" ? (
              <>
                <Pencil className="h-3.5 w-3.5 text-orange-400" />
                Pencil Mode
              </>
            ) : (
              <>
                <Eraser className="h-3.5 w-3.5 text-pink-400" />
                Eraser Mode
              </>
            )}
          </span>

          <div className="mx-1 h-3.5 w-px bg-white/10" />

          <button
            onClick={undoLastStroke}
            disabled={strokes.length === 0}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-text-muted transition-colors hover:bg-white/10 hover:text-text-primary disabled:opacity-30 disabled:pointer-events-none"
            title="Undo last stroke"
          >
            <RotateCcw className="h-3 w-3" />
            Undo
          </button>

          <button
            onClick={clearAllStrokes}
            disabled={strokes.length === 0}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-text-muted transition-colors hover:bg-white/10 hover:text-red-400 disabled:opacity-30 disabled:pointer-events-none"
            title="Clear all drawings"
          >
            <Trash2 className="h-3 w-3" />
            Clear
          </button>

          <div className="mx-1 h-3.5 w-px bg-white/10" />

          <button
            onClick={() => {
              finishDrawing()
              onDone?.()
            }}
            className="flex items-center gap-1 rounded-full bg-white/15 px-3 py-1 text-xs font-medium text-white shadow-sm transition-all hover:bg-white/25 active:scale-95"
            title="Done drawing (Esc or click Select)"
          >
            <Check className="h-3 w-3" />
            Done
          </button>
        </div>
      )}

      {/* SVG Canvas Layer */}
      <svg
        ref={svgRef}
        className={isActive ? "absolute inset-0 z-10" : "pointer-events-none absolute inset-0 z-10"}
        style={{
          width: "100%",
          height: "100%",
          cursor: isActive ? (tool === "eraser" ? "none" : "crosshair") : "default",
          touchAction: "none",
        }}
        onPointerDown={isActive ? onPointerDown : undefined}
        onPointerMove={isActive ? onPointerMove : undefined}
        onPointerUp={isActive ? onPointerUp : undefined}
        onPointerCancel={isActive ? onPointerCancel : undefined}
        onPointerLeave={isActive ? onPointerLeave : undefined}
      >
        {/* Transform group aligns drawing with ReactFlow viewport */}
        <g transform={`translate(${viewport.x}, ${viewport.y}) scale(${zoom})`}>
          {/* Committed strokes — render instantaneous pre-computed SVG path strings */}
          {strokes.map((s) => (
            <path
              key={s.id}
              d={s.path}
              stroke={s.color}
              strokeWidth={s.width}
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}

          {/* Active stroke being drawn — updated directly via DOM for 120fps native performance */}
          <path
            ref={activePathRef}
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={0.88}
          />

          {/* Eraser cursor ring in canvas flow space — updated directly via DOM */}
          <circle
            ref={eraserCircleRef}
            fill="rgba(255,255,255,0.08)"
            stroke="rgba(255,255,255,0.6)"
            style={{ display: "none", pointerEvents: "none" }}
          />
        </g>
      </svg>
    </>
  )
}
