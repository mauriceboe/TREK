import { useState, useEffect, useRef } from 'react'
import { categoriesApi } from '../../api/client'
import { useToast } from '../shared/Toast'
import { Plus, Edit2, Trash2, Pipette } from 'lucide-react'
import { CATEGORY_ICON_MAP, ICON_LABELS, getCategoryIcon } from '../shared/categoryIcons'
import { useTranslation } from '../../i18n'
import { getApiErrorMessage } from '../../types'

const PRESET_COLORS = [
  '#6366f1', '#8b5cf6', '#ec4899', '#ef4444', '#f97316',
  '#f59e0b', '#10b981', '#06b6d4', '#3b82f6', '#84cc16',
  '#6b7280', '#1f2937',
]

const ICON_NAMES = Object.keys(CATEGORY_ICON_MAP)

export default function CategoryManager() {
  const [categories, setCategories] = useState([])
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [form, setForm] = useState({ name: '', color: '#6366f1', icon: 'MapPin' })
  const [isSaving, setIsSaving] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const colorInputRef = useRef(null)
  const toast = useToast()
  const { t } = useTranslation()

  useEffect(() => { loadCategories() }, [])

  const loadCategories = async () => {
    setIsLoading(true)
    try {
      const data = await categoriesApi.list()
      setCategories(data.categories || [])
    } catch (err: unknown) {
      toast.error(t('categories.toast.loadError'))
    } finally {
      setIsLoading(false)
    }
  }

  const handleStartEdit = (cat) => {
    setEditingId(cat.id)
    setForm({ name: cat.name, color: cat.color || '#6366f1', icon: cat.icon || 'MapPin' })
    setShowForm(false)
  }

  const handleStartCreate = () => {
    setEditingId(null)
    setForm({ name: '', color: '#6366f1', icon: 'MapPin' })
    setShowForm(true)
  }

  const handleCancel = () => {
    setShowForm(false)
    setEditingId(null)
  }

  const handleSave = async () => {
    if (!form.name.trim()) { toast.error(t('categories.toast.nameRequired')); return }
    setIsSaving(true)
    try {
      if (editingId) {
        const result = await categoriesApi.update(editingId, form)
        setCategories(prev => prev.map(c => c.id === editingId ? result.category : c))
        setEditingId(null)
        toast.success(t('categories.toast.updated'))
      } else {
        const result = await categoriesApi.create(form)
        setCategories(prev => [...prev, result.category])
        setShowForm(false)
        toast.success(t('categories.toast.created'))
      }
      setForm({ name: '', color: '#6366f1', icon: 'MapPin' })
    } catch (err: unknown) {
      toast.error(getApiErrorMessage(err, t('categories.toast.saveError')))
    } finally {
      setIsSaving(false)
    }
  }

  const handleDelete = async (id) => {
    if (!confirm(t('categories.confirm.delete'))) return
    try {
      await categoriesApi.delete(id)
      setCategories(prev => prev.filter(c => c.id !== id))
      toast.success(t('categories.toast.deleted'))
    } catch (err: unknown) {
      toast.error(getApiErrorMessage(err, t('categories.toast.deleteError')))
    }
  }

  const isPresetColor = PRESET_COLORS.includes(form.color)
  const PreviewIcon = getCategoryIcon(form.icon)

  const categoryForm = (
    <div className="bg-gray-50 rounded-xl p-4 space-y-3 border border-gray-200">
      <input
        type="text"
        value={form.name}
        onChange={e => setForm(prev => ({ ...prev, name: e.target.value }))}
        placeholder={t('categories.namePlaceholder')}
        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400 bg-white"
        autoFocus
      />

      <div>
        <label className="block text-xs font-medium text-gray-600 mb-2">{t('categories.icon')}</label>
        <div className="max-h-48 overflow-y-auto">
          <div className="flex flex-wrap gap-1.5 px-1.5 py-1.5">
            {ICON_NAMES.map(name => {
              const Icon = CATEGORY_ICON_MAP[name]
              const isSelected = form.icon === name
              return (
                <button
                  key={name}
                  type="button"
                  title={ICON_LABELS[name] || name}
                  onClick={() => setForm(prev => ({ ...prev, icon: name }))}
                  className={`w-9 h-9 flex items-center justify-center rounded-lg transition-all ${
                    isSelected
                      ? 'ring-2 ring-offset-1 ring-slate-700'
                      : 'hover:bg-gray-200'
                  }`}
                  style={{ background: isSelected ? `${form.color}18` : undefined }}
                >
                  <Icon size={17} strokeWidth={1.8} color={isSelected ? form.color : '#374151'} />
                </button>
              )
            })}
          </div>
        </div>
      </div>

      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1.5">{t('categories.color')}</label>
        <div className="flex items-center gap-2 flex-wrap">
          {PRESET_COLORS.map(color => (
            <button key={color} type="button" onClick={() => setForm(prev => ({ ...prev, color }))}
              className={`w-7 h-7 rounded-full transition-transform hover:scale-110 ${form.color === color ? 'ring-2 ring-offset-2 ring-gray-400 scale-110' : ''}`}
              style={{ backgroundColor: color }} />
          ))}

          {/* Custom color button */}
          <input
            ref={colorInputRef}
            type="color"
            value={form.color}
            onChange={e => setForm(prev => ({ ...prev, color: e.target.value }))}
            className="sr-only"
          />
          <button
            type="button"
            title={t('categories.customColor')}
            onClick={() => colorInputRef.current?.click()}
            className={`w-7 h-7 rounded-full flex items-center justify-center border-2 transition-transform hover:scale-110 ${
              !isPresetColor
                ? 'ring-2 ring-offset-2 ring-gray-400 scale-110 border-transparent'
                : 'border-dashed border-gray-300 hover:border-gray-400'
            }`}
            style={!isPresetColor ? { backgroundColor: form.color } : undefined}
          >
            {isPresetColor && <Pipette className="w-3 h-3 text-gray-400" />}
          </button>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-xs text-gray-500">{t('categories.preview')}:</span>
        <span className="inline-flex items-center gap-1.5 text-sm px-2.5 py-1 rounded-full font-medium"
          style={{ backgroundColor: `${form.color}20`, color: form.color }}>
          <PreviewIcon size={14} strokeWidth={1.8} />
          {form.name || t('categories.defaultName')}
        </span>
      </div>

      <div className="flex justify-end gap-2">
        <button type="button" onClick={handleCancel}
          className="px-3 py-1.5 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50">
          {t('common.cancel')}
        </button>
        <button type="button" onClick={handleSave} disabled={isSaving || !form.name.trim()}
          className="px-4 py-1.5 text-sm bg-slate-900 text-white rounded-lg hover:bg-slate-700 disabled:opacity-60 font-medium">
          {isSaving ? t('common.saving') : editingId ? t('categories.update') : t('categories.create')}
        </button>
      </div>
    </div>
  )

  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="font-semibold" style={{ color: 'var(--text-primary)' }}>{t('categories.title')}</h2>
          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>{t('categories.subtitle')}</p>
        </div>
        <button onClick={handleStartCreate}
          className="flex items-center gap-2 bg-slate-900 text-white px-3 sm:px-4 py-2 rounded-lg hover:bg-slate-700 text-sm font-medium">
          <Plus className="w-4 h-4" />
          <span className="hidden sm:inline">{t('categories.new')}</span>
        </button>
      </div>

      {showForm && <div className="mb-4">{categoryForm}</div>}

      {isLoading ? (
        <div className="flex items-center justify-center py-8 text-gray-400">
          <div className="w-6 h-6 border-2 border-gray-300 border-t-slate-600 rounded-full animate-spin" />
        </div>
      ) : categories.length === 0 ? (
        <div className="text-center py-8 text-gray-400">
          <p className="text-sm">{t('categories.empty')}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {categories.map(cat => {
            const Icon = getCategoryIcon(cat.icon)
            return (
              <div key={cat.id}>
                {editingId === cat.id ? (
                  <div className="mb-2">{categoryForm}</div>
                ) : (
                  <div className="flex items-center gap-3 p-3 border border-gray-100 rounded-xl hover:border-gray-200 group">
                    <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
                      style={{ backgroundColor: `${cat.color}20` }}>
                      <Icon size={18} strokeWidth={1.8} color={cat.color} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-gray-900 text-sm">{cat.name}</span>
                        <span className="text-xs px-2 py-0.5 rounded-full"
                          style={{ backgroundColor: `${cat.color}20`, color: cat.color }}>
                          {cat.color}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button onClick={() => handleStartEdit(cat)}
                        className="p-1.5 text-gray-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg">
                        <Edit2 className="w-4 h-4" />
                      </button>
                      <button onClick={() => handleDelete(cat.id)}
                        className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
