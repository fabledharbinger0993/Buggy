import { useState, useEffect } from 'react'

// Shows a password form until the server confirms a valid session cookie.
export default function LoginGate({ children }) {
  const [status,   setStatus]   = useState('checking') // checking | out | in
  const [password, setPassword] = useState('')
  const [error,    setError]    = useState('')
  const [busy,     setBusy]     = useState(false)

  useEffect(() => {
    fetch('/auth/session')
      .then(r => r.json())
      .then(d => setStatus(d.ok ? 'in' : 'out'))
      .catch(() => setStatus('out'))
  }, [])

  async function submit(e) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const resp = await fetch('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      const data = await resp.json().catch(() => ({}))
      if (resp.ok && data.ok) {
        setStatus('in')
      } else {
        setError(data.error || `Login failed (${resp.status})`)
      }
    } catch {
      setError('Could not reach the server')
    } finally {
      setBusy(false)
      setPassword('')
    }
  }

  if (status === 'in') return children
  if (status === 'checking') return null

  return (
    <div style={{
      minHeight: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: '#08080f', fontFamily: '"Space Mono", monospace',
    }}>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12, width: 280 }}>
        <div style={{ fontFamily: '"Orbitron", sans-serif', color: '#e8e4d8', letterSpacing: 2, textAlign: 'center' }}>
          FUNGAI P.I.
        </div>
        <label htmlFor="site-password" style={{ color: '#6ab88a', fontSize: 12 }}>Password</label>
        <input
          id="site-password"
          type="password"
          autoFocus
          autoComplete="current-password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          style={{
            padding: '8px 10px', background: '#0f0f1a', color: '#e8e4d8',
            border: '1px solid #1e2e1e', borderRadius: 4, fontFamily: 'inherit',
          }}
        />
        <button
          type="submit"
          disabled={busy || !password}
          style={{
            padding: '8px 10px', background: '#1e2e1e', color: '#6ab88a',
            border: '1px solid #6ab88a', borderRadius: 4, fontFamily: 'inherit',
            cursor: busy || !password ? 'default' : 'pointer',
          }}
        >
          {busy ? 'Checking…' : 'Enter'}
        </button>
        <div role="alert" style={{ color: '#d88', fontSize: 12, minHeight: 16 }}>{error}</div>
      </form>
    </div>
  )
}
