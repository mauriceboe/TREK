import { useRef, useReducer } from 'react'

export interface UndoEntry {
  label: string
  undo: () => Promise<void> | void
}

export function usePlannerHistory(maxEntries = 30) {
  const historyRef = useRef<UndoEntry[]>([])
  const [, forceUpdate] = useReducer((x: number) => x + 1, 0)

  const pushUndo = (label: string, undoFn: () => Promise<void> | void) => {
    historyRef.current = [{ label, undo: undoFn }, ...historyRef.current].slice(0, maxEntries)
    forceUpdate()
  }

  const undo = async () => {
    if (historyRef.current.length === 0) return
    const [first, ...rest] = historyRef.current
    historyRef.current = rest
    forceUpdate()
    try { await first.undo() } catch (e) { console.error('Undo failed:', e) }
  }

  const canUndo = historyRef.current.length > 0
  const lastActionLabel = historyRef.current[0]?.label ?? null

  return { pushUndo, undo, canUndo, lastActionLabel }
}
