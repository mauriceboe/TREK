import React, { createContext, useContext, useEffect, useMemo, ReactNode } from 'react'
import { useSettingsStore } from '../store/settingsStore'
import de from './translations/de'
import en from './translations/en'
import es from './translations/es'
import fr from './translations/fr'
import ru from './translations/ru'
import zh from './translations/zh'
import nl from './translations/nl'
import ar from './translations/ar'

type TranslationStrings = Record<string, string | { name: string; category: string }[]>

export const SUPPORTED_LANGUAGES = [
  { value: 'de', label: 'Deutsch' },
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Español' },
  { value: 'fr', label: 'Français' },
  { value: 'nl', label: 'Nederlands' },
  { value: 'ru', label: 'Русский' },
  { value: 'zh', label: '中文' },
  { value: 'ar', label: 'العربية' },
] as const

const translations: Record<string, TranslationStrings> = { de, en, es, fr, ru, zh, nl, ar }
const LOCALES: Record<string, string> = { de: 'de-DE', en: 'en-US', es: 'es-ES', fr: 'fr-FR', ru: 'ru-RU', zh: 'zh-CN', nl: 'nl-NL', ar: 'ar-SA' }
const RTL_LANGUAGES = new Set(['ar'])

export function getLocaleForLanguage(language: string): string {
  return LOCALES[language] || LOCALES.en
}

export function getIntlLanguage(language: string): string {
  return ['de', 'es', 'fr', 'ru', 'zh', 'nl', 'ar'].includes(language) ? language : 'en'
}

export function isRtlLanguage(language: string): boolean {
  return RTL_LANGUAGES.has(language)
}

interface TranslationContextValue {
  t: (key: string, params?: Record<string, string | number>) => string
  language: string
  locale: string
}

const TranslationContext = createContext<TranslationContextValue>({ t: (k: string) => k, language: 'en', locale: 'en-US' })

interface TranslationProviderProps {
  children: ReactNode
}

export function TranslationProvider({ children }: TranslationProviderProps) {
  const language = useSettingsStore((s) => s.settings.language) || 'en'

  useEffect(() => {
    document.documentElement.lang = language
    document.documentElement.dir = isRtlLanguage(language) ? 'rtl' : 'ltr'
  }, [language])

  const value = useMemo((): TranslationContextValue => {
    const strings = translations[language] || translations.en
    const fallback = translations.en

    function t(key: string, params?: Record<string, string | number>): string {
      let val: string = (strings[key] ?? fallback[key] ?? key) as string
      if (params) {
        Object.entries(params).forEach(([k, v]) => {
          val = val.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v))
        })
      }
      return val
    }

    return { t, language, locale: getLocaleForLanguage(language) }
  }, [language])

  return <TranslationContext.Provider value={value}>{children}</TranslationContext.Provider>
}

export function useTranslation(): TranslationContextValue {
  return useContext(TranslationContext)
}
