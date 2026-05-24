import { useRef, useEffect } from 'react'

const NODE_COUNT = 30
const CONNECT_DIST = 140
const MAX_VEL = 0.3
const PULSE_MS = 400
const PULSE_INTERVAL_MS = 1500

function mkNodes(w, h) {
  return Array.from({ length: NODE_COUNT }, () => {
    const isPurple = Math.random() < 0.7
    return {
      x:  Math.random() * w,
      y:  Math.random() * h,
      vx: (Math.random() - 0.5) * MAX_VEL * 2,
      vy: (Math.random() - 0.5) * MAX_VEL * 2,
      purple: isPurple,
      pulseStart: -Infinity,
    }
  })
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

      // Trigger pulse burst when entities are present
      const cnt = countRef.current
      if (cnt > 0 && ts - lastPulseRef.current > PULSE_INTERVAL_MS) {
        lastPulseRef.current = ts
        const picked = new Set()
        const limit  = Math.min(cnt, nodes.length)
        while (picked.size < limit) {
          picked.add(Math.floor(Math.random() * nodes.length))
        }
        for (const i of picked) nodes[i].pulseStart = ts
      }

      // Update positions (bounce off edges)
      for (const n of nodes) {
        n.x += n.vx; n.y += n.vy
        if (n.x < 0)  { n.x = 0;  n.vx = Math.abs(n.vx) }
        if (n.x > w)  { n.x = w;  n.vx = -Math.abs(n.vx) }
        if (n.y < 0)  { n.y = 0;  n.vy = Math.abs(n.vy) }
        if (n.y > h)  { n.y = h;  n.vy = -Math.abs(n.vy) }
      }

      // Draw connections
      ctx.strokeStyle = 'rgba(232,162,58,0.15)'
      ctx.lineWidth   = 0.5
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const dx = nodes[i].x - nodes[j].x
          const dy = nodes[i].y - nodes[j].y
          if (dx * dx + dy * dy < CONNECT_DIST * CONNECT_DIST) {
            ctx.beginPath()
            ctx.moveTo(nodes[i].x, nodes[i].y)
            ctx.lineTo(nodes[j].x, nodes[j].y)
            ctx.stroke()
          }
        }
      }

      // Draw nodes
      for (const n of nodes) {
        const elapsed  = ts - n.pulseStart
        const pulsing  = elapsed >= 0 && elapsed < PULSE_MS
        const t        = pulsing ? elapsed / PULSE_MS : 0
        const wave     = pulsing ? Math.sin(Math.PI * t) : 0  // 0→1→0

        const r = 3 + wave * 4   // 3→7→3
        let fill
        if (pulsing) {
          fill = `rgba(255,255,255,${(0.4 + 0.4 * wave).toFixed(2)})`
        } else if (n.purple) {
          fill = 'rgba(107,63,160,0.7)'
        } else {
          fill = 'rgba(232,162,58,0.6)'
        }

        ctx.beginPath()
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2)
        ctx.fillStyle = fill
        ctx.fill()
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
