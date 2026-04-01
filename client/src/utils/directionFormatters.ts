import type { RouteDirection } from '../types'

export function parseDirections(routeMetadata: string | null): RouteDirection[] {
  if (!routeMetadata) return []
  try {
    const meta = JSON.parse(routeMetadata)
    return meta.directions || []
  } catch {
    return []
  }
}

export function dirSymbol(maneuver: string, instruction: string): string {
  if (maneuver === 'depart') return '→'
  if (maneuver === 'arrive') return '●'
  if (maneuver === 'roundabout' || maneuver === 'rotary') return '↻'
  if (maneuver === 'merge') return '⇢'
  if (maneuver === 'on ramp') return '↗'
  if (maneuver === 'off ramp') return '↳'
  if (maneuver === 'new name') return '↑'
  if (maneuver === 'fork') return instruction.includes('left') ? '⤵' : '⤴'
  if (instruction.includes('left')) return '↰'
  if (instruction.includes('right')) return '↱'
  return '↑'
}
