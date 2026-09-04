import { describe, expect, it, vi } from 'vitest'
import { registerRtlTextPlugin } from './rtlText'

describe('registerRtlTextPlugin', () => {
  it('runs the engine-supplied registration', () => {
    const register = vi.fn()

    expect(registerRtlTextPlugin(register)).toBe(true)
    expect(register).toHaveBeenCalledTimes(1)
  })

  // Registering twice is how the engines report it: Mapbox throws.
  it('never lets a refused registration break map creation', () => {
    const register = vi.fn(() => {
      throw new Error('setRTLTextPlugin cannot be called multiple times.')
    })

    expect(() => registerRtlTextPlugin(register)).not.toThrow()
    expect(registerRtlTextPlugin(register)).toBe(false)
  })

  // MapLibre reports the same by rejecting, and an unhandled rejection would
  // reach the console for something the user cannot act on.
  it('swallows a rejected registration promise', async () => {
    const onUnhandled = vi.fn()
    process.on('unhandledRejection', onUnhandled)

    expect(registerRtlTextPlugin(() => Promise.reject(new Error('404')))).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 0))
    process.off('unhandledRejection', onUnhandled)

    expect(onUnhandled).not.toHaveBeenCalled()
  })

  it('leaves a resolved promise alone', async () => {
    expect(registerRtlTextPlugin(() => Promise.resolve())).toBe(true)
  })
})
