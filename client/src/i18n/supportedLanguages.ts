export const SUPPORTED_LANGUAGES = [
  { value: 'de',    label: 'Deutsch',             locale: 'de-DE' },
  { value: 'en',    label: 'English',              locale: 'en-US' },
  { value: 'es',    label: 'Español',              locale: 'es-ES' },
  { value: 'fr',    label: 'Français',             locale: 'fr-FR' },
  { value: 'hu',    label: 'Magyar',               locale: 'hu-HU' },
  { value: 'nl',    label: 'Nederlands',           locale: 'nl-NL' },
  { value: 'br',    label: 'Português (Brasil)',   locale: 'pt-BR' },
  { value: 'cs',    label: 'Česky',                locale: 'cs-CZ' },
  { value: 'pl',    label: 'Polski',               locale: 'pl-PL' },
  { value: 'ru',    label: 'Русский',              locale: 'ru-RU' },
  { value: 'zh',    label: '简体中文',              locale: 'zh-CN' },
  { value: 'zh-TW', label: '繁體中文',              locale: 'zh-TW' },
  { value: 'it',    label: 'Italiano',             locale: 'it-IT' },
  { value: 'ar',    label: 'العربية',              locale: 'ar-SA' },
  { value: 'id',    label: 'Bahasa Indonesia',     locale: 'id-ID' },
  { value: 'ua',    label: 'Українська',           locale: 'uk-UA' },
] as const

export type SupportedLanguageCode = typeof SUPPORTED_LANGUAGES[number]['value']

export const SUPPORTED_LANGUAGE_CODES: string[] = SUPPORTED_LANGUAGES.map(l => l.value)
