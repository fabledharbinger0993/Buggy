import { useRef, useEffect } from 'react'

// Vibrant palette matching the logo
const PURPLE = { r: 130, g: 60,  b: 255 }  // electric #823cff
const AMBER  = { r: 255, g: 140, b: 0   }  // deep orange #ff8c00

const NODE_COUNT      = 30
const CONNECT_DIST    = 140
const MAX_VEL         = 0.3
const PULSE_MS        = 400
const PULSE_INTERVAL  = 1500

function rgba(c, a) {
  return `rgba(${c.r},${c.g},${c.b},${a})`
}

function mkNodes(w, h) {
  return Array.from({ length: NODE_COUNT }, () => {
    const purple = Math.random() < 0.7
    return {
      x:  Math.random() * w,
      y:  Math.random() * h,
      vx: (Math.random() - 0.5) * MAX_VEL * 2,
      vy: (Math.random() - 0.5) * MAX_VEL * 2,
      purple,
      pulseStart: -Infinity,
    }
  })
}

// Connection line color: match dominant node pair
function lineStyle(a, b) {
  if (a.purple && b.purple)  return { color: rgba(PURPLE, 0.28), width: 0.6 }
  if (!a.purple && !b.purple) return { color: rgba(AMBER,  0.25), width: 0.6 }
  return { color: 'rgba(200,120,200,0.12)', width: 0.4 }
}

export default function MyceliumCanvas({ activeEntityCount = 0 }) {
  const canvasRef    = useRef(null)
  const nodesRef     = useRef([])
  const lastPulseRef = useRef(0)
  const countRef     = useRef(activeEntityCount)
  const animRef      = useRef(null)

  useEffect(() => { countRef.current = activeEntityCount }, [activeEntityCount])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')

    function resize() {
      const parent = canvas.parentElement
      if (!parent) return
      const { width, height } = parent.getBoundingClientRect()
      canvas.width  = Math.max(width,  1)
      canvas.height = Math.max(height, 1)
      if (!nodesRef.current.length) {
        nodesRef.current = mkNodes(canvas.width, canvas.height)
      }
    }

    const ro = new ResizeObserver(resize)
    ro.observe(canvas.parentElement)
    resize()

    function loop(ts) {
      const w = canvas.width
      const h = canvas.height
      const nodes = nodesRef.current
      ctx.clearRect(0, 0, w, h)

      // Pulse burst when entities are active
      const cnt = countRef.current
      if (cnt > 0 && ts - lastPulseRef.current > PULSE_INTERVAL) {
        lastPulseRef.current = ts
        const picked = new Set()
        while (picked.size < Math.min(cnt, nodes.length)) {
          picked.add(Math.floor(Math.random() * nodes.length))
        }
        for (const i of picked) nodes[i].pulseStart = ts
      }

      // Update positions
      for (const n of nodes) {
        n.x += n.vx; n.y += n.vy
        if (n.x < 0)  { n.x = 0;  n.vx = Math.abs(n.vx) }
        if (n.x > w)  { n.x = w;  n.vx = -Math.abs(n.vx) }
        if (n.y < 0)  { n.y = 0;  n.vy = Math.abs(n.vy) }
        if (n.y > h)  { n.y = h;  n.vy = -Math.abs(n.vy) }
      }

      // Draw connections (colored by node pair type)
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const dx = nodes[i].x - nodes[j].x
          const dy = nodes[i].y - nodes[j].y
          if (dx * dx + dy * dy < CONNECT_DIST * CONNECT_DIST) {
            const { color, width } = lineStyle(nodes[i], nodes[j])
            ctx.beginPath()
            ctx.moveTo(nodes[i].x, nodes[i].y)
            ctx.lineTo(nodes[j].x, nodes[j].y)
            ctx.strokeStyle = color
            ctx.lineWidth = width
            ctx.stroke()
          }
        }
      }

      // Draw nodes (with glow)
      for (const n of nodes) {
        const elapsed = ts - n.pulseStart
        const pulsing = elapsed >= 0 && elapsed < PULSE_MS
        const t       = pulsing ? elapsed / PULSE_MS : 0
        const wave    = pulsing ? Math.sin(Math.PI * t) : 0

        const r    = 3.5 + wave * 4.5
        const base = n.purple ? PURPLE : AMBER

        // Glow
        ctx.shadowColor = rgba(base, 0.9)
        ctx.shadowBlur  = pulsing ? 14 + wave * 10 : 6

        // Fill
        let fill
        if (pulsing) {
          fill = `rgba(255,255,255,${(0.5 + 0.4 * wave).toFixed(2)})`
        } else {
          fill = rgba(base, n.purple ? 0.85 : 0.75)
        }

        ctx.beginPath()
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2)
        ctx.fillStyle = fill
        ctx.fill()
        ctx.shadowBlur = 0
      }

      animRef.current = requestAnimationFrame(loop)
    }

    animRef.current = requestAnimationFrame(loop)
    return () => {
      cancelAnimationFrame(animRef.current)
      ro.disconnect()
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      style={{ display: 'block', width: '100%', height: '100%' }}
    />
  )
}
