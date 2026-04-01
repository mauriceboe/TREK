import React, { useEffect, useState, useMemo } from 'react'
import { adminApi } from '../../api/client'
import { useTranslation } from '../../i18n'
import { usePermissionsStore, PermissionLevel } from '../../store/permissionsStore'
import { useToast } from '../shared/Toast'
import { Save, Loader2, RotateCcw } from 'lucide-react'
import CustomSelect from '../shared/CustomSelect'

interface PermissionEntry {
  key: string
  level: PermissionLevel
  defaultLevel: PermissionLevel
  allowedLevels: PermissionLevel[]
}

const LEVEL_LABELS: Record<string, string> = {
  admin: 'perm.level.admin',
  trip_owner: 'perm.level.tripOwner',
  trip_member: 'perm.level.tripMember',
  everybody: 'perm.level.everybody',
}

const CATEGORIES = [
  { id: 'trip', keys: ['trip_create', 'trip_edit', 'trip_delete', 'trip_archive', 'trip_cover_upload'] },
  { id: 'members', keys: ['member_manage'] },
  { id: 'files', keys: ['file_upload', 'file_edit', 'file_delete'] },
  { id: 'content', keys: ['place_edit', 'day_edit', 'reservation_edit'] },
  { id: 'extras', keys: ['budget_edit', 'packing_edit', 'collab_edit', 'share_manage'] },
]

export default function PermissionsPanel(): React.ReactElement {
  const { t } = useTranslation()
  const toast = useToast()
  const [entries, setEntries] = useState<PermissionEntry[]>([])
  const [values, setValues] = useState<Record<string, PermissionLevel>>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    loadPermissions()
  }, [])

  const loadPermissions = async () => {
    setLoading(true)
    try {
      const data = await adminApi.getPermissions()
      setEntries(data.permissions)
      const vals: Record<string, PermissionLevel> = {}
      for (const p of data.permissions) vals[p.key] = p.level
      setValues(vals)
      setDirty(false)
    } catch {
      toast.error(t('common.error'))
    } finally {
      setLoading(false)
    }
  }

  const handleChange = (key: string, level: PermissionLevel) => {
    setValues(prev => ({ ...prev, [key]: level }))
    setDirty(true)
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      const data = await adminApi.updatePermissions(values)
      if (data.permissions) {
        usePermissionsStore.getState().setPermissions(data.permissions)
      }
      setDirty(false)
      toast.success(t('perm.saved'))
    } catch {
      toast.error(t('common.error'))
    } finally {
      setSaving(false)
    }
  }

  const handleReset = () => {
    const defaults: Record<string, PermissionLevel> = {}
    for (const p of entries) defaults[p.key] = p.defaultLevel
    setValues(defaults)
    setDirty(true)
  }

  const entryMap = useMemo(() => new Map(entries.map(e => [e.key, e])), [entries])

  if (loading) {
    return (
      <div className="p-8 text-center">
        <div className="w-8 h-8 border-2 border-slate-200 border-t-slate-900 rounded-full animate-spin mx-auto" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
          <div>
            <h2 className="font-semibold text-slate-900">{t('perm.title')}</h2>
            <p className="text-xs text-slate-400 mt-0.5">{t('perm.subtitle')}</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleReset}
              disabled={saving}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-40 transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              {t('perm.resetDefaults')}
            </button>
            <button
              onClick={handleSave}
              disabled={saving || !dirty}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-slate-900 text-white rounded-lg hover:bg-slate-700 disabled:bg-slate-400 transition-colors"
            >
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
              {t('common.save')}
            </button>
          </div>
        </div>

        <div className="divide-y divide-slate-100">
          {CATEGORIES.map(cat => (
            <div key={cat.id} className="px-6 py-4">
              <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">
                {t(`perm.cat.${cat.id}`)}
              </h3>
              <div className="space-y-3">
                {cat.keys.map(key => {
                  const entry = entryMap.get(key)
                  if (!entry) return null
                  const currentLevel = values[key] || entry.defaultLevel
                  const isDefault = currentLevel === entry.defaultLevel
                  return (
                    <div key={key} className="flex items-center justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-slate-700">{t(`perm.action.${key}`)}</p>
                        <p className="text-xs text-slate-400 mt-0.5">{t(`perm.actionHint.${key}`)}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        {!isDefault && (
                          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700">
                            {t('perm.customized')}
                          </span>
                        )}
                        <CustomSelect
                          value={currentLevel}
                          onChange={(val) => handleChange(key, val as PermissionLevel)}
                          options={entry.allowedLevels.map(l => ({
                            value: l,
                            label: t(LEVEL_LABELS[l] || l),
                          }))}
                          style={{ minWidth: 160 }}
                        />
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
