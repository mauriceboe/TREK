import React, { useState, useEffect } from 'react'
import { Info, Github, Shield, Key, Users, Database, Upload, Clock, Puzzle, CalendarDays, Globe, ArrowRightLeft, Map, Briefcase, ListChecks, Wallet, FileText, Plane } from 'lucide-react'
import { useTranslation } from '../../i18n'

interface DemoTexts {
  titleBefore: string
  titleAfter: string
  title: string
  description: string
  resetIn: string
  minutes: string
  uploadNote: string
  fullVersionTitle: string
  features: string[]
  addonsTitle: string
  addons: [string, string][]
  whatIs: string
  whatIsDesc: string
  selfHost: string
  selfHostLink: string
  close: string
}

const texts: Record<string, DemoTexts> = {
  de: {
    titleBefore: 'Willkommen bei ',
    titleAfter: '',
    title: 'Willkommen zur TREK Demo',
    description: 'Du kannst Reisen ansehen, bearbeiten und eigene erstellen. Alle Aenderungen werden jede Stunde automatisch zurueckgesetzt.',
    resetIn: 'Naechster Reset in',
    minutes: 'Minuten',
    uploadNote: 'Datei-Uploads (Fotos, Dokumente, Cover) sind in der Demo deaktiviert.',
    fullVersionTitle: 'In der Vollversion zusaetzlich:',
    features: [
      'Datei-Uploads (Fotos, Dokumente, Cover)',
      'API-Schluessel (Google Maps, Wetter)',
      'Benutzer- & Rechteverwaltung',
      'Automatische Backups',
      'Addon-Verwaltung (aktivieren/deaktivieren)',
      'OIDC / SSO Single Sign-On',
    ],
    addonsTitle: 'Modulare Addons (in der Vollversion deaktivierbar)',
    addons: [
      ['Vacay', 'Urlaubsplaner mit Kalender, Feiertagen & Fusion'],
      ['Atlas', 'Weltkarte mit besuchten Laendern & Reisestatistiken'],
      ['Packliste', 'Checklisten pro Reise'],
      ['Budget', 'Kostenplanung mit Splitting'],
      ['Dokumente', 'Dateien an Reisen anhaengen'],
      ['Widgets', 'Waehrungsrechner & Zeitzonen'],
    ],
    whatIs: 'Was ist TREK?',
    whatIsDesc: 'Ein selbst-gehosteter Reiseplaner mit Echtzeit-Kollaboration, interaktiver Karte, OIDC Login und Dark Mode.',
    selfHost: 'Open Source — ',
    selfHostLink: 'selbst hosten',
    close: 'Verstanden',
  },
  en: {
    titleBefore: 'Welcome to ',
    titleAfter: '',
    title: 'Welcome to the TREK Demo',
    description: 'You can view, edit and create trips. All changes are automatically reset every hour.',
    resetIn: 'Next reset in',
    minutes: 'minutes',
    uploadNote: 'File uploads (photos, documents, covers) are disabled in demo mode.',
    fullVersionTitle: 'Additionally in the full version:',
    features: [
      'File uploads (photos, documents, covers)',
      'API key management (Google Maps, Weather)',
      'User & permission management',
      'Automatic backups',
      'Addon management (enable/disable)',
      'OIDC / SSO single sign-on',
    ],
    addonsTitle: 'Modular Addons (can be deactivated in full version)',
    addons: [
      ['Vacay', 'Vacation planner with calendar, holidays & user fusion'],
      ['Atlas', 'World map with visited countries & travel stats'],
      ['Packing', 'Checklists per trip'],
      ['Budget', 'Expense tracking with splitting'],
      ['Documents', 'Attach files to trips'],
      ['Widgets', 'Currency converter & timezones'],
    ],
    whatIs: 'What is TREK?',
    whatIsDesc: 'A self-hosted travel planner with real-time collaboration, interactive maps, OIDC login and dark mode.',
    selfHost: 'Open source — ',
    selfHostLink: 'self-host it',
    close: 'Got it',
  },
  es: {
    titleBefore: 'Bienvenido a ',
    titleAfter: '',
    title: 'Bienvenido a la demo de TREK',
    description: 'Puedes ver, editar y crear viajes. Todos los cambios se restablecen automáticamente cada hora.',
    resetIn: 'Próximo reinicio en',
    minutes: 'minutos',
    uploadNote: 'Las subidas de archivos (fotos, documentos, portadas) están desactivadas en el modo demo.',
    fullVersionTitle: 'Además, en la versión completa:',
    features: [
      'Subida de archivos (fotos, documentos, portadas)',
      'Gestión de claves API (Google Maps, tiempo)',
      'Gestión de usuarios y permisos',
      'Copias de seguridad automáticas',
      'Gestión de addons (activar/desactivar)',
      'Inicio de sesión único OIDC / SSO',
    ],
    addonsTitle: 'Complementos modulares (se pueden desactivar en la versión completa)',
    addons: [
      ['Vacaciones', 'Planificador de vacaciones con calendario, festivos y fusión de usuarios'],
      ['Atlas', 'Mapa del mundo con países visitados y estadísticas de viaje'],
      ['Equipaje', 'Listas de comprobación para cada viaje'],
      ['Presupuesto', 'Control de gastos con reparto'],
      ['Documentos', 'Adjunta archivos a los viajes'],
      ['Widgets', 'Conversor de divisas y zonas horarias'],
    ],
    whatIs: '¿Qué es TREK?',
    whatIsDesc: 'Un planificador de viajes autohospedado con colaboración en tiempo real, mapas interactivos, inicio de sesión OIDC y modo oscuro.',
    selfHost: 'Código abierto — ',
    selfHostLink: 'alójalo tú mismo',
    close: 'Entendido',
  },
  ar: {
    titleBefore: 'مرحبًا بك في ',
    titleAfter: '',
    title: 'مرحبًا بك في النسخة التجريبية من TREK',
    description: 'يمكنك عرض الرحلات وتعديلها وإنشاء رحلات جديدة. تتم إعادة ضبط جميع التغييرات تلقائيًا كل ساعة.',
    resetIn: 'إعادة الضبط التالية خلال',
    minutes: 'دقيقة',
    uploadNote: 'رفع الملفات (الصور والمستندات وصور الغلاف) معطّل في وضع العرض التجريبي.',
    fullVersionTitle: 'وفي النسخة الكاملة أيضًا:',
    features: [
      'رفع الملفات (الصور والمستندات وصور الغلاف)',
      'إدارة مفاتيح API (خرائط Google والطقس)',
      'إدارة المستخدمين والصلاحيات',
      'نسخ احتياطية تلقائية',
      'إدارة الإضافات (تفعيل/تعطيل)',
      'تسجيل دخول موحد OIDC / SSO',
    ],
    addonsTitle: 'إضافات مرنة (يمكن تعطيلها في النسخة الكاملة)',
    addons: [
      ['Vacay', 'مخطط إجازات مع تقويم وعطل ودمج مستخدمين'],
      ['Atlas', 'خريطة عالمية مع الدول التي تمت زيارتها وإحصاءات السفر'],
      ['Packing', 'قوائم تجهيز لكل رحلة'],
      ['Budget', 'تتبع المصروفات مع التقسيم'],
      ['Documents', 'إرفاق الملفات بالرحلات'],
      ['Widgets', 'محول عملات ومناطق زمنية'],
    ],
    whatIs: 'ما هو TREK؟',
    whatIsDesc: 'مخطط رحلات مستضاف ذاتيًا مع تعاون لحظي وخرائط تفاعلية وتسجيل دخول OIDC ووضع داكن.',
    selfHost: 'مفتوح المصدر — ',
    selfHostLink: 'استضفه بنفسك',
    close: 'فهمت',
  },
}

const featureIcons = [Upload, Key, Users, Database, Puzzle, Shield]
const addonIcons = [CalendarDays, Globe, ListChecks, Wallet, FileText, ArrowRightLeft]

export default function DemoBanner(): React.ReactElement | null {
  const [dismissed, setDismissed] = useState<boolean>(false)
  const [minutesLeft, setMinutesLeft] = useState<number>(59 - new Date().getMinutes())
  const { language } = useTranslation()
  const t = texts[language] || texts.en

  useEffect(() => {
    const interval = setInterval(() => setMinutesLeft(59 - new Date().getMinutes()), 10000)
    return () => clearInterval(interval)
  }, [])

  if (dismissed) return null

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(8px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 16, overflow: 'auto',
      fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif",
    }} onClick={() => setDismissed(true)}>
      <div style={{
        background: 'white', borderRadius: 20, padding: '28px 24px 20px',
        maxWidth: 480, width: '100%',
        boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
        maxHeight: '90vh', overflow: 'auto',
      }} onClick={(e: React.MouseEvent<HTMLDivElement>) => e.stopPropagation()}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <img src="/icons/icon-dark.svg" alt="" style={{ width: 36, height: 36, borderRadius: 10 }} />
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: '#111827', display: 'flex', alignItems: 'center', gap: 5 }}>
            {t.titleBefore}<img src="/text-dark.svg" alt="TREK" style={{ height: 18 }} />{t.titleAfter}
          </h2>
        </div>

        <p style={{ fontSize: 13, color: '#6b7280', lineHeight: 1.6, margin: '0 0 12px' }}>
          {t.description}
        </p>

        {/* Timer + Upload note */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          <div style={{
            flex: 1, display: 'flex', alignItems: 'center', gap: 6,
            background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 10, padding: '8px 10px',
          }}>
            <Clock size={13} style={{ flexShrink: 0, color: '#0284c7' }} />
            <span style={{ fontSize: 11, color: '#0369a1', fontWeight: 600 }}>
              {t.resetIn} {minutesLeft} {t.minutes}
            </span>
          </div>
          <div style={{
            flex: 1, display: 'flex', alignItems: 'center', gap: 6,
            background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 10, padding: '8px 10px',
          }}>
            <Upload size={13} style={{ flexShrink: 0, color: '#b45309' }} />
            <span style={{ fontSize: 11, color: '#b45309' }}>{t.uploadNote}</span>
          </div>
        </div>

        {/* What is TREK */}
        <div style={{
          background: '#f8fafc', borderRadius: 12, padding: '12px 14px', marginBottom: 16,
          border: '1px solid #e2e8f0',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <Map size={14} style={{ color: '#111827' }} />
            <span style={{ fontSize: 12, fontWeight: 700, color: '#111827', display: 'flex', alignItems: 'center', gap: 4 }}>
              {t.whatIs}
            </span>
          </div>
          <p style={{ fontSize: 12, color: '#64748b', lineHeight: 1.5, margin: 0 }}>{t.whatIsDesc}</p>
        </div>

        {/* Addons */}
        <p style={{ fontSize: 10, fontWeight: 700, color: '#374151', margin: '0 0 8px', textTransform: 'uppercase', letterSpacing: '0.08em', display: 'flex', alignItems: 'center', gap: 6 }}>
          <Puzzle size={12} />
          {t.addonsTitle}
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 16 }}>
          {t.addons.map(([name, desc], i) => {
            const Icon = addonIcons[i]
            return (
              <div key={name} style={{
                background: '#f8fafc', borderRadius: 10, padding: '8px 10px',
                border: '1px solid #f1f5f9',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                  <Icon size={12} style={{ flexShrink: 0, color: '#111827' }} />
                  <span style={{ fontSize: 11, fontWeight: 700, color: '#111827' }}>{name}</span>
                </div>
                <p style={{ fontSize: 10, color: '#94a3b8', margin: 0, lineHeight: 1.3, paddingLeft: 18 }}>{desc}</p>
              </div>
            )
          })}
        </div>

        {/* Full version features */}
        <p style={{ fontSize: 10, fontWeight: 700, color: '#374151', margin: '0 0 8px', textTransform: 'uppercase', letterSpacing: '0.08em', display: 'flex', alignItems: 'center', gap: 6 }}>
          <Shield size={12} />
          {t.fullVersionTitle}
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 16 }}>
          {t.features.map((text, i) => {
            const Icon = featureIcons[i]
            return (
              <div key={text} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: '#4b5563', padding: '4px 0' }}>
                <Icon size={13} style={{ flexShrink: 0, color: '#9ca3af' }} />
                <span>{text}</span>
              </div>
            )
          })}
        </div>

        {/* Footer */}
        <div style={{
          paddingTop: 14, borderTop: '1px solid #e5e7eb',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#9ca3af' }}>
            <Github size={13} />
            <span>{t.selfHost}</span>
            <a href="https://github.com/mauriceboe/TREK" target="_blank" rel="noopener noreferrer"
              style={{ color: '#111827', fontWeight: 600, textDecoration: 'none' }}>
              {t.selfHostLink}
            </a>
          </div>
          <button onClick={() => setDismissed(true)} style={{
            background: '#111827', color: 'white', border: 'none',
            borderRadius: 10, padding: '8px 20px', fontSize: 12,
            fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
          }}>
            {t.close}
          </button>
        </div>
      </div>
    </div>
  )
}
