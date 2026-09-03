import { describe, it, expect } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { bypassChip, bypassOffer, rangeWarningCopy, useRangeBypass } from './useRangeBypass'

const t = (k: string, p?: Record<string, unknown>) => (p ? `${k}:${JSON.stringify(p)}` : k)

/**
 * The ONE logic path behind the TREK_PLUGINS_IGNORE_TREK_RANGE warning in both admin
 * shells — the desktop panel and the phone panel render their own markup over this.
 */
describe('rangeBypass helpers', () => {
  it('bypassChip: a warning chip (not a blocker) only for a bypassed row', () => {
    expect(bypassChip(null, t)).toBeNull()
    expect(bypassChip(undefined, t)).toBeNull()
    expect(bypassChip({ trekRange: '>=3.2.0 <4.0.0', hostVersion: '4.0.0' }, t)).toMatchObject({
      blocked: false, warn: true, label: 'admin.plugins.dep.trekBypassed:{"range":">=3.2.0 <4.0.0","host":"4.0.0"}',
    })
    expect(bypassChip({ trekRange: null, hostVersion: '4.0.0' }, t)).toMatchObject({ label: 'admin.plugins.dep.trekBypassedUnknown' })
  })

  it('bypassOffer: an enabled "Install anyway" carrying what the dialog must say', () => {
    const offer = bypassOffer({ name: 'Gotify', trek: '>=4.0.0', hostVersion: '3.3.0' }, t, 'why')
    expect(offer).toEqual({
      blocked: false, label: 'admin.plugins.installAnyway', title: 'why',
      warn: { name: 'Gotify', trekRange: '>=4.0.0', hostVersion: '3.3.0', onConfirm: null },
    })
    expect(bypassOffer({ name: 'X' }, t, 'why').warn).toMatchObject({ trekRange: null, hostVersion: '?' })
  })

  it('rangeWarningCopy: confirm vs notice title, ranged vs rangeless body', () => {
    const ranged = { name: 'G', trekRange: '>=4.0.0', hostVersion: '3.3.0' }
    expect(rangeWarningCopy({ ...ranged, onConfirm: () => {} }, t)).toEqual({
      confirm: true, title: 'admin.plugins.rangeBypass.title',
      body: 'admin.plugins.rangeBypass.body:{"name":"G","range":">=4.0.0","host":"3.3.0"}',
    })
    expect(rangeWarningCopy({ name: 'G', trekRange: null, hostVersion: '3.3.0', onConfirm: null }, t)).toEqual({
      confirm: false, title: 'admin.plugins.rangeBypass.noticeTitle',
      body: 'admin.plugins.rangeBypass.bodyUnknown:{"name":"G","host":"3.3.0"}',
    })
  })
})

describe('useRangeBypass', () => {
  it('guard runs straight through without a warning, and parks the run behind one otherwise', () => {
    const { result } = renderHook(() => useRangeBypass())
    let ran = 0
    act(() => result.current.guard(undefined, () => { ran++ }))
    expect(ran).toBe(1)
    expect(result.current.warning).toBeNull()

    act(() => result.current.guard({ name: 'G', trekRange: '>=4.0.0', hostVersion: '3.3.0', onConfirm: null }, () => { ran++ }))
    expect(ran).toBe(1) // nothing sent until the admin accepts
    expect(result.current.copy?.confirm).toBe(true)

    act(() => result.current.confirm())
    expect(ran).toBe(2)
    expect(result.current.warning).toBeNull()
  })

  it('dismiss drops a parked run; notice opens a plain notice only for a real marker', () => {
    const { result } = renderHook(() => useRangeBypass())
    let ran = 0
    act(() => result.current.guard({ name: 'G', trekRange: null, hostVersion: '3.3.0', onConfirm: null }, () => { ran++ }))
    act(() => result.current.dismiss())
    expect(ran).toBe(0)
    expect(result.current.warning).toBeNull()

    act(() => result.current.notice('trek-new', null))
    expect(result.current.warning).toBeNull()
    act(() => result.current.notice('trek-new', { trekRange: null, hostVersion: '3.3.0' }))
    expect(result.current.warning).toMatchObject({ name: 'trek-new', onConfirm: null })
    expect(result.current.copy?.confirm).toBe(false)
    act(() => result.current.confirm()) // a notice's confirm is just a close
    expect(result.current.warning).toBeNull()
  })
})
