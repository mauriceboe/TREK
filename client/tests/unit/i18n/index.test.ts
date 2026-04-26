import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render } from '@testing-library/react'
import React from 'react'
import {
  TranslationProvider,
  useTranslation,
  getLocaleForLanguage,
  getIntlLanguage,
  isRtlLanguage,
  SUPPORTED_LANGUAGES,
  detectBrowserLanguage,
} from '../../../src/i18n'
import { resetAllStores, seedStore } from '../../helpers/store'
import { useSettingsStore } from '../../../src/store/settingsStore'
import { buildSettings } from '../../helpers/factories'

beforeEach(() => {
  resetAllStores()
  vi.clearAllMocks()
})

// ── FE-COMP-I18N-001: Barrel re-exports ───────────────────────────────────────

describe('barrel re-exports', () => {
  it('FE-COMP-I18N-001: all named exports are defined with expected types', () => {
    expect(TranslationProvider).toBeDefined()
    expect(typeof TranslationProvider).toBe('function')
    expect(useTranslation).toBeDefined()
    expect(typeof useTranslation).toBe('function')
    expect(getLocaleForLanguage).toBeDefined()
    expect(typeof getLocaleForLanguage).toBe('function')
    expect(getIntlLanguage).toBeDefined()
    expect(typeof getIntlLanguage).toBe('function')
    expect(isRtlLanguage).toBeDefined()
    expect(typeof isRtlLanguage).toBe('function')
    expect(SUPPORTED_LANGUAGES).toBeDefined()
    expect(Array.isArray(SUPPORTED_LANGUAGES)).toBe(true)
  })
})

// ── FE-COMP-I18N-002/003: getLocaleForLanguage ────────────────────────────────

describe('getLocaleForLanguage', () => {
  it('FE-COMP-I18N-002: returns correct locale for known languages', () => {
    expect(getLocaleForLanguage('en')).toBe('en-US')
    expect(getLocaleForLanguage('de')).toBe('de-DE')
    expect(getLocaleForLanguage('zh-TW')).toBe('zh-TW')
    expect(getLocaleForLanguage('ar')).toBe('ar-SA')
    expect(getLocaleForLanguage('br')).toBe('pt-BR')
  })

  it('FE-COMP-I18N-003: falls back to en-US for unknown language codes', () => {
    expect(getLocaleForLanguage('xx')).toBe('en-US')
  })
})

// ── FE-COMP-I18N-004/005/006: getIntlLanguage ─────────────────────────────────

describe('getIntlLanguage', () => {
  it('FE-COMP-I18N-004: returns language code for known supported languages', () => {
    expect(getIntlLanguage('de')).toBe('de')
    expect(getIntlLanguage('fr')).toBe('fr')
    expect(getIntlLanguage('zh-TW')).toBe('zh-TW')
  })

  it('FE-COMP-I18N-005: maps br to pt-BR', () => {
    expect(getIntlLanguage('br')).toBe('pt-BR')
  })

  it('FE-COMP-I18N-006: falls back to en for unknown codes', () => {
    expect(getIntlLanguage('xx')).toBe('en')
  })
})

// ── FE-COMP-I18N-007/008: isRtlLanguage ──────────────────────────────────────

describe('isRtlLanguage', () => {
  it('FE-COMP-I18N-007: returns true only for Arabic', () => {
    expect(isRtlLanguage('ar')).toBe(true)
  })

  it('FE-COMP-I18N-008: returns false for all other supported languages', () => {
    expect(isRtlLanguage('en')).toBe(false)
    expect(isRtlLanguage('de')).toBe(false)
    expect(isRtlLanguage('zh-TW')).toBe(false)
  })
})

// ── FE-COMP-I18N-009: SUPPORTED_LANGUAGES ────────────────────────────────────

describe('SUPPORTED_LANGUAGES', () => {
  it('FE-COMP-I18N-009: contains expected entries with value/label shape', () => {
    expect(Array.isArray(SUPPORTED_LANGUAGES)).toBe(true)
    expect(SUPPORTED_LANGUAGES).toHaveLength(16)
    expect(SUPPORTED_LANGUAGES).toContainEqual(expect.objectContaining({ value: 'en', label: 'English' }))
    expect(SUPPORTED_LANGUAGES).toContainEqual(expect.objectContaining({ value: 'ar', label: 'العربية' }))
  })
})

// ── FE-COMP-I18N-016 to 023: detectBrowserLanguage ───────────────────────────

describe('detectBrowserLanguage', () => {
  afterEach(() => {
    Object.defineProperty(navigator, 'languages', { value: [], configurable: true })
    Object.defineProperty(navigator, 'language', { value: '', configurable: true })
  })

  it('FE-COMP-I18N-016: exact match returns the matched code', () => {
    Object.defineProperty(navigator, 'languages', { value: ['de'], configurable: true })
    expect(detectBrowserLanguage()).toBe('de')
  })

  it('FE-COMP-I18N-017: region-tagged exact match (zh-TW) returns zh-TW', () => {
    Object.defineProperty(navigator, 'languages', { value: ['zh-TW'], configurable: true })
    expect(detectBrowserLanguage()).toBe('zh-TW')
  })

  it('FE-COMP-I18N-018: prefix match (de-AT → de)', () => {
    Object.defineProperty(navigator, 'languages', { value: ['de-AT'], configurable: true })
    expect(detectBrowserLanguage()).toBe('de')
  })

  it('FE-COMP-I18N-019: pt-PT returns null (European Portuguese is a distinct language)', () => {
    Object.defineProperty(navigator, 'languages', { value: ['pt-PT'], configurable: true })
    expect(detectBrowserLanguage()).toBeNull()
  })

  it('FE-COMP-I18N-020: pt-BR maps to br', () => {
    Object.defineProperty(navigator, 'languages', { value: ['pt-BR'], configurable: true })
    expect(detectBrowserLanguage()).toBe('br')
  })

  it('FE-COMP-I18N-021: first-match-wins across multiple entries', () => {
    Object.defineProperty(navigator, 'languages', { value: ['xx-XX', 'fr'], configurable: true })
    expect(detectBrowserLanguage()).toBe('fr')
  })

  it('FE-COMP-I18N-022: unknown language returns null', () => {
    Object.defineProperty(navigator, 'languages', { value: ['xx'], configurable: true })
    expect(detectBrowserLanguage()).toBeNull()
  })

  it('FE-COMP-I18N-023: falls back to navigator.language when navigator.languages is empty', () => {
    Object.defineProperty(navigator, 'languages', { value: [], configurable: true })
    Object.defineProperty(navigator, 'language', { value: 'es', configurable: true })
    expect(detectBrowserLanguage()).toBe('es')
  })
})

// ── FE-COMP-I18N-010 to 015: TranslationProvider + useTranslation ─────────────

describe('TranslationProvider + useTranslation integration', () => {
  it('FE-COMP-I18N-010: useTranslation returns t, language, and locale', () => {
    seedStore(useSettingsStore, { settings: buildSettings({ language: 'en' }) })

    let result: { language: string; locale: string; tResult: string } | null = null

    function TestComponent() {
      const { t, language, locale } = useTranslation()
      result = { language, locale, tResult: t('common.loading') }
      return null
    }

    render(
      React.createElement(TranslationProvider, null, React.createElement(TestComponent))
    )

    expect(result).not.toBeNull()
    expect(result!.language).toBe('en')
    expect(result!.locale).toBe('en-US')
    expect(result!.tResult).toBeTruthy()
    expect(typeof result!.tResult).toBe('string')
  })

  it('FE-COMP-I18N-011: t() with params substitutes {count} placeholders', () => {
    seedStore(useSettingsStore, { settings: buildSettings({ language: 'en' }) })

    let translated = ''

    function TestComponent() {
      const { t } = useTranslation()
      translated = t('dashboard.subtitle.trips', { count: 5, archived: 2 })
      return null
    }

    render(
      React.createElement(TranslationProvider, null, React.createElement(TestComponent))
    )

    expect(translated).toContain('5')
    expect(translated).toContain('2')
    expect(translated).not.toContain('{count}')
    expect(translated).not.toContain('{archived}')
  })

  it('FE-COMP-I18N-012: TranslationProvider sets document.documentElement.lang', () => {
    seedStore(useSettingsStore, { settings: buildSettings({ language: 'de' }) })

    function TestComponent() {
      useTranslation()
      return null
    }

    render(
      React.createElement(TranslationProvider, null, React.createElement(TestComponent))
    )

    expect(document.documentElement.lang).toBe('de')
  })

  it('FE-COMP-I18N-013: TranslationProvider sets dir=rtl for Arabic', () => {
    seedStore(useSettingsStore, { settings: buildSettings({ language: 'ar' }) })

    function TestComponent() {
      useTranslation()
      return null
    }

    render(
      React.createElement(TranslationProvider, null, React.createElement(TestComponent))
    )

    expect(document.documentElement.dir).toBe('rtl')
  })

  it('FE-COMP-I18N-014: TranslationProvider sets dir=ltr for non-RTL language', () => {
    seedStore(useSettingsStore, { settings: buildSettings({ language: 'en' }) })

    function TestComponent() {
      useTranslation()
      return null
    }

    render(
      React.createElement(TranslationProvider, null, React.createElement(TestComponent))
    )

    expect(document.documentElement.dir).toBe('ltr')
  })

  it('FE-COMP-I18N-015: t() falls back to English for unknown language', () => {
    // Seed with a non-existent language to trigger fallback to English translations
    seedStore(useSettingsStore, { settings: buildSettings({ language: 'xx' as any }) })

    let translated = ''

    function TestComponent() {
      const { t } = useTranslation()
      translated = t('common.loading')
      return null
    }

    render(
      React.createElement(TranslationProvider, null, React.createElement(TestComponent))
    )

    // Should fall back to English translation (non-empty, not the key itself if key exists in en)
    expect(typeof translated).toBe('string')
    expect(translated.length).toBeGreaterThan(0)
  })
})
