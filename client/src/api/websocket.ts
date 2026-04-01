// Singleton WebSocket manager for real-time collaboration

type WebSocketListener = (event: Record<string, unknown>) => void
type RefetchCallback = (tripId: string) => void

let socket: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectDelay = 1000
const MAX_RECONNECT_DELAY = 30000
const listeners = new Set<WebSocketListener>()
const activeTrips = new Set<string>()
let shouldReconnect = false
let refetchCallback: RefetchCallback | null = null
let mySocketId: string | null = null
let connecting = false

export function getSocketId(): string | null {
  return mySocketId
}

export function setRefetchCallback(fn: RefetchCallback | null): void {
  refetchCallback = fn
}

function getWsUrl(wsToken: string): string {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${protocol}://${location.host}/ws?token=${wsToken}`
}

async function fetchWsToken(): Promise<string | null> {
  try {
    const resp = await fetch('/api/auth/ws-token', {
      method: 'POST',
      credentials: 'include',
    })
    if (resp.status === 401) {
      // Session expired — stop reconnecting
      shouldReconnect = false
      return null
    }
    if (!resp.ok) return null
    const { token } = await resp.json()
    return token as string
  } catch {
    return null
  }
}

function handleMessage(event: MessageEvent): void {
  try {
    const parsed = JSON.parse(event.data)
    if (parsed.type === 'welcome') {
      mySocketId = parsed.socketId
      return
    }
    listeners.forEach(fn => {
      try { fn(parsed) } catch (err: unknown) { console.error('WebSocket listener error:', err) }
    })
  } catch (err: unknown) {
    console.error('WebSocket message parse error:', err)
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    if (shouldReconnect) {
      connectInternal(true)
    }
  }, reconnectDelay)
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY)
}

async function connectInternal(_isReconnect = false): Promise<void> {
  if (connecting) return
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return
  }

  connecting = true
  const wsToken = await fetchWsToken()
  connecting = false

  if (!wsToken) {
    if (shouldReconnect) scheduleReconnect()
    return
  }

  const url = getWsUrl(wsToken)
  socket = new WebSocket(url)

  socket.onopen = () => {
    reconnectDelay = 1000
    if (activeTrips.size > 0) {
      activeTrips.forEach(tripId => {
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'join', tripId }))
        }
      })
      if (refetchCallback) {
        activeTrips.forEach(tripId => {
          try { refetchCallback!(tripId) } catch (err: unknown) {
            console.error('Failed to refetch trip data on reconnect:', err)
          }
        })
      }
    }
  }

  socket.onmessage = handleMessage

  socket.onclose = () => {
    socket = null
    if (shouldReconnect) {
      scheduleReconnect()
    }
  }

  socket.onerror = () => {
    // onclose will fire after onerror, reconnect handled there
  }
}

export function connect(): void {
  shouldReconnect = true
  reconnectDelay = 1000
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  connectInternal(false)
}

export function disconnect(): void {
  shouldReconnect = false
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  activeTrips.clear()
  if (socket) {
    socket.onclose = null
    socket.close()
    socket = null
  }
}

export function joinTrip(tripId: number | string): void {
  activeTrips.add(String(tripId))
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'join', tripId: String(tripId) }))
  }
}

export function leaveTrip(tripId: number | string): void {
  activeTrips.delete(String(tripId))
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'leave', tripId: String(tripId) }))
  }
}

export function addListener(fn: WebSocketListener): void {
  listeners.add(fn)
}

export function removeListener(fn: WebSocketListener): void {
  listeners.delete(fn)
}
