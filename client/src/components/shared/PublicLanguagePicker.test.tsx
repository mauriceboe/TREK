import { render, screen, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SUPPORTED_LANGUAGES } from '../../i18n'
import { useSettingsStore } from '../../store/settingsStore'
import PublicLanguagePicker from './PublicLanguagePicker'

describe('PublicLanguagePicker', () => {
  beforeEach(() => {
    useSettingsStore.setState(s => ({ settings: { ...s.settings, language: 'en' } }))
  })

  it('FE-PUBLANG-001: the trigger keeps the current language as its accessible name', () => {
    render(<PublicLanguagePicker locale="de-DE" open={false} onOpenChange={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Deutsch' })).toBeInTheDocument()
  })

  // `br` and `zh-TW` are whole values, not prefixes: matching the prefix first
  // labelled Brazilian Portuguese "Language" and zh-TW "简体中文".
  it('FE-PUBLANG-001b: a hyphenated or non-ISO stored value labels itself correctly', () => {
    const { unmount } = render(<PublicLanguagePicker locale="br" open={false} onOpenChange={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Português (Brasil)' })).toBeInTheDocument()
    unmount()
    render(<PublicLanguagePicker locale="zh-TW" open={false} onOpenChange={vi.fn()} />)
    expect(screen.getByRole('button', { name: '繁體中文' })).toBeInTheDocument()
  })

  it('FE-PUBLANG-002: an unknown locale falls back to the generic label', () => {
    render(<PublicLanguagePicker locale="xx" open={false} onOpenChange={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Language' })).toBeInTheDocument()
  })

  it('FE-PUBLANG-003: closed renders no options at all', () => {
    render(<PublicLanguagePicker locale="en" open={false} onOpenChange={vi.fn()} />)
    expect(screen.queryByTestId('public-language-menu')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Deutsch' })).toBeNull()
  })

  it('FE-PUBLANG-004: open lists every supported language', () => {
    render(<PublicLanguagePicker locale="en" open onOpenChange={vi.fn()} />)
    const menu = within(screen.getByTestId('public-language-menu'))
    for (const lang of SUPPORTED_LANGUAGES) {
      expect(menu.getByRole('button', { name: lang.label })).toBeInTheDocument()
    }
  })

  // The regression guard for #2248: the journey hero clips its own overflow, so a
  // menu rendered inside the page tree is amputated at the hero's bottom edge.
  it('FE-PUBLANG-005: the menu is portalled straight to the document body', () => {
    const { container } = render(<PublicLanguagePicker locale="en" open onOpenChange={vi.fn()} />)
    const menu = screen.getByTestId('public-language-menu')
    expect(menu.parentElement).toBe(document.body)
    expect(container.contains(menu)).toBe(false)
  })

  it('FE-PUBLANG-006: the menu is fixed, capped in height and scrolls its own overflow', () => {
    render(<PublicLanguagePicker locale="en" open onOpenChange={vi.fn()} />)
    const menu = screen.getByTestId('public-language-menu')
    expect(menu.style.position).toBe('fixed')
    expect(menu.style.overflowY).toBe('auto')
    expect(menu.style.overscrollBehavior).toBe('contain')
    expect(Number.parseInt(menu.style.maxHeight, 10)).toBeLessThanOrEqual(320)
  })

  it('FE-PUBLANG-007: the trigger toggles through an updater so a controlled parent stays in sync', () => {
    const onOpenChange = vi.fn()
    render(<PublicLanguagePicker locale="en" open={false} onOpenChange={onOpenChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'English' }))
    const toggle = onOpenChange.mock.calls[0][0] as (v: boolean) => boolean
    expect(toggle(false)).toBe(true)
    expect(toggle(true)).toBe(false)
  })

  it('FE-PUBLANG-008: picking a language stores it locally and closes the menu', () => {
    const onOpenChange = vi.fn()
    render(<PublicLanguagePicker locale="en" open onOpenChange={onOpenChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Deutsch' }))
    expect(useSettingsStore.getState().settings.language).toBe('de')
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('FE-PUBLANG-009: Escape closes the menu', () => {
    const onOpenChange = vi.fn()
    render(<PublicLanguagePicker locale="en" open onOpenChange={onOpenChange} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('FE-PUBLANG-010: a pointer press outside closes it, one on the trigger or the menu does not', () => {
    const onOpenChange = vi.fn()
    const { container } = render(<PublicLanguagePicker locale="en" open onOpenChange={onOpenChange} />)
    fireEvent.mouseDown(within(container).getByRole('button', { name: 'English' }))
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Deutsch' }))
    expect(onOpenChange).not.toHaveBeenCalled()
    fireEvent.mouseDown(document.body)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('FE-PUBLANG-011: hovering an option paints and clears its background', () => {
    render(<PublicLanguagePicker locale="en" open onOpenChange={vi.fn()} />)
    const option = screen.getByRole('button', { name: 'Deutsch' })
    fireEvent.mouseEnter(option)
    expect(option.style.background).toBe('var(--bg-hover)')
    fireEvent.mouseLeave(option)
    expect(option.style.background).toBe('none')
  })

  it('FE-PUBLANG-012: the current language is marked for assistive tech', () => {
    render(<PublicLanguagePicker locale="de" open onOpenChange={vi.fn()} />)
    const menu = within(screen.getByTestId('public-language-menu'))
    expect(menu.getByRole('button', { name: 'Deutsch' })).toHaveAttribute('aria-current', 'true')
    expect(menu.getByRole('button', { name: 'English' })).toHaveAttribute('aria-current', 'false')
  })
})
