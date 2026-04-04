// Singleton WebSocket manager for real-time collaboration

type WebSocketListener = (event: Record<string, unknown>) => void
type RefetchCallback = (tripId: string) => void

let socket: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectDelay = 1000
const MAX_RECONNECT_DELAY = 30000
const listeners = new Set<WebSocketListener>()
const activeTrips = new Set<string>()
let currentToken: string | null = null
let refetchCallback: RefetchCallback | null = null
let mySocketId: string | null = null

export function getSocketId(): string | null {
  return mySocketId
}

export function setRefetchCallback(fn: RefetchCallback | null): void {
  refetchCallback = fn
}

function getWsUrl(): string {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws'
  const baseUrl = `${protocol}://${location.host}/ws`
  if (!currentToken || currentToken === '__session__') return baseUrl
  const url = new URL(baseUrl)
  url.searchParams.set('token', currentToken)
  return url.toString()
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
    if (currentToken) {
      connectInternal(currentToken, true)
    }
  }, reconnectDelay)
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY)
}

function connectInternal(_token: string, _isReconnect = false): void {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return
  }

  const url = getWsUrl()
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
    if (currentToken) {
      scheduleReconnect()
    }
  }

  socket.onerror = () => {
    // onclose will fire after onerror, reconnect handled there
  }
}

export function connect(token?: string | null): void {
  currentToken = token || '__session__'
  reconnectDelay = 1000
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  connectInternal(currentToken, false)
}

export function disconnect(): void {
  currentToken = null
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
