import { useState, useEffect, useRef } from 'react'
import { backupApi } from '../../api/client'
import { useToast } from '../shared/Toast'
import { Download, Trash2, Plus, RefreshCw, RotateCcw, Upload, Clock, Check, HardDrive, AlertTriangle } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { useSettingsStore } from '../../store/settingsStore'
import CustomSelect from '../shared/CustomSelect'
import { getApiErrorMessage } from '../../types'

const INTERVAL_OPTIONS = [
  { value: 'hourly',  labelKey: 'backup.interval.hourly' },
  { value: 'daily',   labelKey: 'backup.interval.daily' },
  { value: 'weekly',  labelKey: 'backup.interval.weekly' },
  { value: 'monthly', labelKey: 'backup.interval.monthly' },
]

const KEEP_OPTIONS = [
  { value: 1,  labelKey: 'backup.keep.1day' },
  { value: 3,  labelKey: 'backup.keep.3days' },
  { value: 7,  labelKey: 'backup.keep.7days' },
  { value: 14, labelKey: 'backup.keep.14days' },
  { value: 30, labelKey: 'backup.keep.30days' },
  { value: 0,  labelKey: 'backup.keep.forever' },
]

const DAYS_OF_WEEK = [
  { value: 0, labelKey: 'backup.dow.sunday' },
  { value: 1, labelKey: 'backup.dow.monday' },
  { value: 2, labelKey: 'backup.dow.tuesday' },
  { value: 3, labelKey: 'backup.dow.wednesday' },
  { value: 4, labelKey: 'backup.dow.thursday' },
  { value: 5, labelKey: 'backup.dow.friday' },
  { value: 6, labelKey: 'backup.dow.saturday' },
]

const HOURS = Array.from({ length: 24 }, (_, i) => i)

const DAYS_OF_MONTH = Array.from({ length: 28 }, (_, i) => i + 1)

export default function BackupPanel() {
  const [backups, setBackups] = useState([])
  const [isLoading, setIsLoading] = useState(false)
  const [isCreating, setIsCreating] = useState(false)
  const [restoringFile, setRestoringFile] = useState(null)
  const [isUploading, setIsUploading] = useState(false)
  const [autoSettings, setAutoSettings] = useState({ enabled: false, interval: 'daily', keep_days: 7, hour: 2, day_of_week: 0, day_of_month: 1 })
  const [autoSettingsSaving, setAutoSettingsSaving] = useState(false)
  const [autoSettingsDirty, setAutoSettingsDirty] = useState(false)
  const [serverTimezone, setServerTimezone] = useState('')
  const [restoreConfirm, setRestoreConfirm] = useState(null) // { type: 'file'|'upload', filename, file? }
  const fileInputRef = useRef(null)
  const toast = useToast()
  const { t, language, locale } = useTranslation()
  const is12h = useSettingsStore(s => s.settings.time_format) === '12h'

  const loadBackups = async () => {
    setIsLoading(true)
    try {
      const data = await backupApi.list()
      setBackups(data.backups || [])
    } catch {
      toast.error(t('backup.toast.loadError'))
    } finally {
      setIsLoading(false)
    }
  }

  const loadAutoSettings = async () => {
    try {
      const data = await backupApi.getAutoSettings()
      setAutoSettings(data.settings)
      if (data.timezone) setServerTimezone(data.timezone)
    } catch {}
  }

  useEffect(() => { loadBackups(); loadAutoSettings() }, [])

  const handleCreate = async () => {
    setIsCreating(true)
    try {
      await backupApi.create()
      toast.success(t('backup.toast.created'))
      await loadBackups()
    } catch {
      toast.error(t('backup.toast.createError'))
    } finally {
      setIsCreating(false)
    }
  }

  const handleRestore = (filename) => {
    setRestoreConfirm({ type: 'file', filename })
  }

  const handleUploadRestore = (e) => {
    const file = (e.target as HTMLInputElement).files?.[0]
    if (!file) return
    e.target.value = ''
    setRestoreConfirm({ type: 'upload', filename: file.name, file })
  }

  const executeRestore = async () => {
    if (!restoreConfirm) return
    const { type, filename, file } = restoreConfirm
    setRestoreConfirm(null)

    if (type === 'file') {
      setRestoringFile(filename)
      try {
        await backupApi.restore(filename)
        toast.success(t('backup.toast.restored'))
        setTimeout(() => window.location.reload(), 1500)
      } catch (err: unknown) {
        toast.error(getApiErrorMessage(err, t('backup.toast.restoreError')))
        setRestoringFile(null)
      }
    } else {
      setIsUploading(true)
      try {
        await backupApi.uploadRestore(file)
        toast.success(t('backup.toast.restored'))
        setTimeout(() => window.location.reload(), 1500)
      } catch (err: unknown) {
        toast.error(getApiErrorMessage(err, t('backup.toast.uploadError')))
        setIsUploading(false)
      }
    }
  }

  const handleDelete = async (filename) => {
    if (!confirm(t('backup.confirm.delete', { name: filename }))) return
    try {
      await backupApi.delete(filename)
      toast.success(t('backup.toast.deleted'))
      setBackups(prev => prev.filter(b => b.filename !== filename))
    } catch {
      toast.error(t('backup.toast.deleteError'))
    }
  }

  const handleAutoSettingsChange = (key, value) => {
    setAutoSettings(prev => ({ ...prev, [key]: value }))
    setAutoSettingsDirty(true)
  }

  const handleSaveAutoSettings = async () => {
    setAutoSettingsSaving(true)
    try {
      const data = await backupApi.setAutoSettings(autoSettings)
      setAutoSettings(data.settings)
      setAutoSettingsDirty(false)
      toast.success(t('backup.toast.settingsSaved'))
    } catch {
      toast.error(t('backup.toast.settingsError'))
    } finally {
      setAutoSettingsSaving(false)
    }
  }

  const formatSize = (bytes) => {
    if (!bytes) return '-'
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  }

  const formatDate = (dateStr) => {
    if (!dateStr) return '-'
    try {
      const opts: Intl.DateTimeFormatOptions = {
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
      }
      if (serverTimezone) opts.timeZone = serverTimezone
      return new Date(dateStr).toLocaleString(locale, opts)
    } catch { return dateStr }
  }

  const isAuto = (filename) => filename.startsWith('auto-backup-')

  return (
    <div className="flex flex-col gap-6">

      {/* Manual Backups */}
      <div className="bg-white rounded-2xl border border-gray-200 p-6">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <HardDrive className="w-5 h-5 text-gray-400" />
            <div>
              <h2 className="font-semibold" style={{ color: 'var(--text-primary)' }}>{t('backup.title')}</h2>
              <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>{t('backup.subtitle')}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={loadBackups}
              disabled={isLoading}
              className="p-2 text-gray-500 hover:bg-gray-100 rounded-lg transition-colors"
              title={t('backup.refresh')}
            >
              <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
            </button>

            {/* Upload & Restore */}
            <input
              ref={fileInputRef}
              type="file"
              accept=".zip"
              className="hidden"
              onChange={handleUploadRestore}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={isUploading}
              className="flex items-center gap-2 border border-gray-200 text-gray-700 px-3 py-2 rounded-lg hover:bg-gray-50 text-sm font-medium disabled:opacity-60"
              title={isUploading ? t('backup.uploading') : t('backup.upload')}
            >
              {isUploading ? (
                <div className="w-4 h-4 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" />
              ) : (
                <Upload className="w-4 h-4" />
              )}
              <span className="hidden sm:inline">{isUploading ? t('backup.uploading') : t('backup.upload')}</span>
            </button>

            <button
              onClick={handleCreate}
              disabled={isCreating}
              className="flex items-center gap-2 bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 px-3 sm:px-4 py-2 rounded-lg hover:bg-slate-900 text-sm font-medium disabled:opacity-60"
              title={isCreating ? t('backup.creating') : t('backup.create')}
            >
              {isCreating ? (
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              ) : (
                <Plus className="w-4 h-4" />
              )}
              <span className="hidden sm:inline">{isCreating ? t('backup.creating') : t('backup.create')}</span>
            </button>
          </div>
        </div>

        {isLoading && backups.length === 0 ? (
          <div className="flex items-center justify-center py-12 text-gray-400">
            <div className="w-6 h-6 border-2 border-gray-300 border-t-slate-700 rounded-full animate-spin mr-2" />
            {t('common.loading')}
          </div>
        ) : backups.length === 0 ? (
          <div className="text-center py-12 text-gray-400">
            <HardDrive className="w-10 h-10 mb-3 mx-auto opacity-40" />
            <p className="text-sm">{t('backup.empty')}</p>
            <button onClick={handleCreate} className="mt-4 text-slate-700 text-sm hover:underline">
              {t('backup.createFirst')}
            </button>
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {backups.map(backup => (
              <div key={backup.filename} className="flex items-center gap-4 py-3">
                <div className="w-8 h-8 rounded-lg bg-gray-100 flex items-center justify-center flex-shrink-0">
                  {isAuto(backup.filename)
                    ? <RefreshCw className="w-4 h-4 text-blue-500" />
                    : <HardDrive className="w-4 h-4 text-gray-500" />
                  }
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="font-medium text-sm text-gray-900 truncate">{backup.filename}</p>
                    {isAuto(backup.filename) && (
                      <span className="text-xs bg-blue-50 text-blue-600 border border-blue-100 rounded-full px-2 py-0.5 whitespace-nowrap">Auto</span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 mt-0.5">
                    <span className="text-xs text-gray-400">{formatDate(backup.created_at)}</span>
                    <span className="text-xs text-gray-400">{formatSize(backup.size)}</span>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  <button
                    onClick={() => backupApi.download(backup.filename).catch(() => toast.error(t('backup.toast.downloadError')))}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-slate-700 border border-slate-200 rounded-lg hover:bg-slate-50"
                  >
                    <Download className="w-3.5 h-3.5" />
                    {t('backup.download')}
                  </button>
                  <button
                    onClick={() => handleRestore(backup.filename)}
                    disabled={restoringFile === backup.filename}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-amber-700 border border-amber-200 rounded-lg hover:bg-amber-50 disabled:opacity-60"
                  >
                    {restoringFile === backup.filename
                      ? <div className="w-3.5 h-3.5 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
                      : <RotateCcw className="w-3.5 h-3.5" />
                    }
                    {t('backup.restore')}
                  </button>
                  <button
                    onClick={() => handleDelete(backup.filename)}
                    className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Auto-Backup Settings */}
      <div className="bg-white rounded-2xl border border-gray-200 p-6">
        <div className="flex items-center gap-3 mb-6">
          <Clock className="w-5 h-5 text-gray-400" />
          <div>
            <h2 className="font-semibold" style={{ color: 'var(--text-primary)' }}>{t('backup.auto.title')}</h2>
            <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>{t('backup.auto.subtitle')}</p>
          </div>
        </div>

        <div className="flex flex-col gap-5">
          {/* Enable toggle */}
          <label className="flex items-center justify-between gap-4 cursor-pointer">
            <div className="min-w-0">
              <span className="text-sm font-medium text-gray-900">{t('backup.auto.enable')}</span>
              <p className="text-xs text-gray-500 mt-0.5">{t('backup.auto.enableHint')}</p>
            </div>
            <button
              onClick={() => handleAutoSettingsChange('enabled', !autoSettings.enabled)}
              className="relative shrink-0 inline-flex h-6 w-11 items-center rounded-full transition-colors"
              style={{ background: autoSettings.enabled ? 'var(--text-primary)' : 'var(--border-primary)' }}
            >
              <span className="absolute left-0.5 h-5 w-5 rounded-full bg-white transition-transform duration-200"
                style={{ transform: autoSettings.enabled ? 'translateX(20px)' : 'translateX(0)' }} />
            </button>
          </label>

          {autoSettings.enabled && (
            <>
              {/* Interval */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">{t('backup.auto.interval')}</label>
                <div className="flex flex-wrap gap-2">
                  {INTERVAL_OPTIONS.map(opt => (
                    <button
                      key={opt.value}
                      onClick={() => handleAutoSettingsChange('interval', opt.value)}
                      className={`px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${
                        autoSettings.interval === opt.value
                          ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 border-slate-700'
                          : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300'
                      }`}
                    >
                      {t(opt.labelKey)}
                    </button>
                  ))}
                </div>
              </div>

              {/* Hour picker (for daily, weekly, monthly) */}
              {autoSettings.interval !== 'hourly' && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">{t('backup.auto.hour')}</label>
                  <CustomSelect
                    value={String(autoSettings.hour)}
                    onChange={v => handleAutoSettingsChange('hour', parseInt(v, 10))}
                    size="sm"
                    options={HOURS.map(h => {
                      let label: string
                      if (is12h) {
                        const period = h >= 12 ? 'PM' : 'AM'
                        const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h
                        label = `${h12}:00 ${period}`
                      } else {
                        label = `${String(h).padStart(2, '0')}:00`
                      }
                      return { value: String(h), label }
                    })}
                  />
                  <p className="text-xs text-gray-400 mt-1">
                    {t('backup.auto.hourHint', { format: is12h ? '12h' : '24h' })}{serverTimezone ? ` (Timezone: ${serverTimezone})` : ''}
                  </p>
                </div>
              )}

              {/* Day of week (for weekly) */}
              {autoSettings.interval === 'weekly' && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">{t('backup.auto.dayOfWeek')}</label>
                  <div className="flex flex-wrap gap-2">
                    {DAYS_OF_WEEK.map(opt => (
                      <button
                        key={opt.value}
                        onClick={() => handleAutoSettingsChange('day_of_week', opt.value)}
                        className={`px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
                          autoSettings.day_of_week === opt.value
                            ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 border-slate-700'
                            : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300'
                        }`}
                      >
                        {t(opt.labelKey)}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Day of month (for monthly) */}
              {autoSettings.interval === 'monthly' && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">{t('backup.auto.dayOfMonth')}</label>
                  <CustomSelect
                    value={String(autoSettings.day_of_month)}
                    onChange={v => handleAutoSettingsChange('day_of_month', parseInt(v, 10))}
                    size="sm"
                    options={DAYS_OF_MONTH.map(d => ({ value: String(d), label: String(d) }))}
                  />
                  <p className="text-xs text-gray-400 mt-1">{t('backup.auto.dayOfMonthHint')}</p>
                </div>
              )}

              {/* Keep duration */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">{t('backup.auto.keepLabel')}</label>
                <div className="flex flex-wrap gap-2">
                  {KEEP_OPTIONS.map(opt => (
                    <button
                      key={opt.value}
                      onClick={() => handleAutoSettingsChange('keep_days', opt.value)}
                      className={`px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${
                        autoSettings.keep_days === opt.value
                          ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 border-slate-700'
                          : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300'
                      }`}
                    >
                      {t(opt.labelKey)}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}

          {/* Save button */}
          <div className="flex justify-end pt-2 border-t border-gray-100">
            <button
              onClick={handleSaveAutoSettings}
              disabled={autoSettingsSaving || !autoSettingsDirty}
              className="flex items-center gap-2 bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 px-5 py-2 rounded-lg hover:bg-slate-900 text-sm font-medium disabled:opacity-50 transition-colors"
            >
              {autoSettingsSaving
                ? <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                : <Check className="w-4 h-4" />
              }
              {autoSettingsSaving ? t('common.saving') : t('common.save')}
            </button>
          </div>
        </div>
      </div>

      {/* Restore Warning Modal */}
      {restoreConfirm && (
        <div
          style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
          onClick={() => setRestoreConfirm(null)}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{ width: '100%', maxWidth: 440, borderRadius: 16, overflow: 'hidden' }}
            className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700"
          >
            {/* Red header */}
            <div style={{ background: 'linear-gradient(135deg, #dc2626, #b91c1c)', padding: '20px 24px', display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ width: 40, height: 40, borderRadius: 10, background: 'rgba(255,255,255,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <AlertTriangle size={20} style={{ color: 'white' }} />
              </div>
              <div>
                <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: 'white' }}>
                  {t('backup.restoreConfirmTitle')}
                </h3>
                <p style={{ margin: '2px 0 0', fontSize: 12, color: 'rgba(255,255,255,0.8)' }}>
                  {restoreConfirm.filename}
                </p>
              </div>
            </div>

            {/* Body */}
            <div style={{ padding: '20px 24px' }}>
              <p className="text-gray-700 dark:text-gray-300" style={{ fontSize: 13, lineHeight: 1.6, margin: 0 }}>
                {t('backup.restoreWarning')}
              </p>

              <div style={{ marginTop: 14, padding: '10px 12px', borderRadius: 10, fontSize: 12, lineHeight: 1.5 }}
                className="bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-800"
              >
                {t('backup.restoreTip')}
              </div>
            </div>

            {/* Footer */}
            <div style={{ padding: '0 24px 20px', display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button
                onClick={() => setRestoreConfirm(null)}
                className="text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
                style={{ padding: '9px 20px', borderRadius: 10, fontSize: 13, fontWeight: 600, border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={executeRestore}
                style={{ padding: '9px 20px', borderRadius: 10, fontSize: 13, fontWeight: 600, border: 'none', cursor: 'pointer', fontFamily: 'inherit', background: '#dc2626', color: 'white' }}
                onMouseEnter={e => e.currentTarget.style.background = '#b91c1c'}
                onMouseLeave={e => e.currentTarget.style.background = '#dc2626'}
              >
                {t('backup.restoreConfirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
