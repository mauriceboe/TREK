import React, { createContext, useContext, useEffect, useMemo, ReactNode } from 'react'
import { useSettingsStore } from '../store/settingsStore'
import de from './translations/de'
import en from './translations/en'
import es from './translations/es'
import fr from './translations/fr'
import hu from './translations/hu'
import it from './translations/it'
import ru from './translations/ru'
import zh from './translations/zh'
import zhTw from './translations/zhTw'
import nl from './translations/nl'
import id from './translations/id'
import ar from './translations/ar'
import br from './translations/br'
import cs from './translations/cs'
import pl from './translations/pl'
import ua from './translations/ua'
import { SUPPORTED_LANGUAGES, SupportedLanguageCode } from './supportedLanguages'

export { SUPPORTED_LANGUAGES }

type TranslationStrings = Record<string, string | { name: string; category: string }[]>

// Keyed by SupportedLanguageCode so TypeScript enforces all languages have a translation.
const translations: Record<SupportedLanguageCode, TranslationStrings> = {
  de, en, es, fr, hu, it, ru, zh, 'zh-TW': zhTw, nl, id, ar, br, cs, pl, ua,
}

// Derived from SUPPORTED_LANGUAGES — add new languages there, not here.
const LOCALES: Record<string, string> = Object.fromEntries(
  SUPPORTED_LANGUAGES.map(l => [l.value, l.locale])
)
const RTL_LANGUAGES = new Set(['ar'])

export function getLocaleForLanguage(language: string): string {
  return LOCALES[language] || LOCALES.en
}

export function getIntlLanguage(language: string): string {
  if (language === 'br') return 'pt-BR'
  return ['de', 'es', 'fr', 'hu', 'it', 'ru', 'zh', 'zh-TW', 'nl', 'ar', 'cs', 'pl', 'id', 'ua'].includes(language) ? language : 'en'
}

export function isRtlLanguage(language: string): boolean {
  return RTL_LANGUAGES.has(language)
}

// Detects the user's preferred language from the browser/OS settings and maps
// it to one of the supported language codes. Returns null if no match is found.
export function detectBrowserLanguage(): string | null {
  if (typeof navigator === 'undefined') return null
  const browserLangs = navigator.languages?.length
    ? navigator.languages
    : navigator.language ? [navigator.language] : []
  const supported = SUPPORTED_LANGUAGES.map(l => l.value)

  for (const lang of browserLangs) {
    // Exact match (e.g. 'de', 'zh-TW') — case-insensitive
    const exactMatch = supported.find(s => s.toLowerCase() === lang.toLowerCase())
    if (exactMatch) return exactMatch

    // pt-BR has no exact match (our code is 'br', not 'pt-BR'), so map it explicitly.
    // pt-PT and bare 'pt' are NOT mapped — they fall through to null and let the
    // server default or 'en' fallback apply instead.
    if (lang.toLowerCase() === 'pt-br') return 'br'

    // Prefix match (e.g. 'de-AT' → 'de', 'zh-CN' → 'zh') — case-insensitive
    const prefix = lang.split('-')[0].toLowerCase()
    const prefixMatch = supported.find(s => s.toLowerCase() === prefix)
    if (prefixMatch) return prefixMatch
  }

  return null
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
