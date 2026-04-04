import React, { useEffect, useMemo, useState } from 'react'
import { MapPin, Pencil, Plus, Trash2 } from 'lucide-react'
import Modal from '../shared/Modal'
import PlaceSearchBox from '../Places/PlaceSearchBox'
import { useToast } from '../shared/Toast'
import { useTranslation } from '../../i18n'
import { useAuthStore } from '../../store/authStore'
import type { TripLeg, Trip, Day, TranslationFn } from '../../types'

interface LegFormData {
  destination_name: string
  destination_address: string
  destination_lat: number | string
  destination_lng: number | string
  destination_viewport_south: number | string
  destination_viewport_west: number | string
  destination_viewport_north: number | string
  destination_viewport_east: number | string
  start_day_number: number
  end_day_number: number
}

interface PlaceSelection {
  name?: string
  address?: string
  lat?: number | null
  lng?: number | null
  viewport?: {
    south?: number | null
    west?: number | null
    north?: number | null
    east?: number | null
  }
}

interface LegPayload {
  destination_name: string
  destination_address: string
  destination_lat: number | string
  destination_lng: number | string
  destination_viewport_south: number | string
  destination_viewport_west: number | string
  destination_viewport_north: number | string
  destination_viewport_east: number | string
  start_day_number: number
  end_day_number: number
}

interface TripLegsModalProps {
  isOpen: boolean
  onClose: () => void
  legs: TripLeg[]
  days: Day[]
  trip?: Trip | null
  onAdd: (payload: LegPayload) => Promise<void>
  onUpdate: (legId: number, payload: LegPayload) => Promise<void>
  onDelete: (legId: number) => Promise<void>
  hasMapsKey?: boolean
  language?: string
  t?: TranslationFn
}

function createEmptyForm(days: Day[]): LegFormData {
  return {
    destination_name: '',
    destination_address: '',
    destination_lat: '',
    destination_lng: '',
    destination_viewport_south: '',
    destination_viewport_west: '',
    destination_viewport_north: '',
    destination_viewport_east: '',
    start_day_number: 1,
    end_day_number: days.length || 1,
  }
}

function createFormFromLeg(leg: TripLeg): LegFormData {
  return {
    destination_name: leg.destination_name || '',
    destination_address: leg.destination_address || '',
    destination_lat: leg.destination_lat ?? '',
    destination_lng: leg.destination_lng ?? '',
    destination_viewport_south: leg.destination_viewport_south ?? '',
    destination_viewport_west: leg.destination_viewport_west ?? '',
    destination_viewport_north: leg.destination_viewport_north ?? '',
    destination_viewport_east: leg.destination_viewport_east ?? '',
    start_day_number: leg.start_day_number,
    end_day_number: leg.end_day_number,
  }
}

export default function TripLegsModal({
  isOpen,
  onClose,
  legs,
  days,
  onAdd,
  onUpdate,
  onDelete,
}: TripLegsModalProps) {
  const toast = useToast()
  const { t, language } = useTranslation()
  const hasMapsKey = useAuthStore(state => state.hasMapsKey)
  const [selectedLegId, setSelectedLegId] = useState<number | null>(null)
  const [isCreatingNew, setIsCreatingNew] = useState(false)
  const [formData, setFormData] = useState<LegFormData>(() => createEmptyForm(days))
  const [isSaving, setIsSaving] = useState(false)

  const sortedLegs = useMemo(
    () => [...(legs || [])].sort((a, b) => a.start_day_number - b.start_day_number || a.end_day_number - b.end_day_number || Number(a.id) - Number(b.id)),
    [legs]
  )

  useEffect(() => {
    if (isOpen) return
    setIsCreatingNew(false)
    setSelectedLegId(null)
    setFormData(createEmptyForm(days))
  }, [days, isOpen])

  useEffect(() => {
    if (!isOpen) return

    if (isCreatingNew) {
      setFormData(createEmptyForm(days))
      return
    }

    if (selectedLegId != null) {
      const selectedLeg = sortedLegs.find(leg => leg.id === selectedLegId)
      if (selectedLeg) {
        setFormData(createFormFromLeg(selectedLeg))
        return
      }
    }

    if (sortedLegs.length > 0) {
      setSelectedLegId(sortedLegs[0].id as number)
      setFormData(createFormFromLeg(sortedLegs[0]))
      return
    }

    setSelectedLegId(null)
    setFormData(createEmptyForm(days))
  }, [days, isCreatingNew, isOpen, selectedLegId, sortedLegs])

  const isEditing = !isCreatingNew && selectedLegId != null

  const selectLeg = (leg: TripLeg): void => {
    setIsCreatingNew(false)
    setSelectedLegId(leg.id as number)
    setFormData(createFormFromLeg(leg))
  }

  const startNewLeg = (): void => {
    setIsCreatingNew(true)
    setSelectedLegId(null)
    setFormData(createEmptyForm(days))
  }

  const updateField = (field: keyof LegFormData, value: number | string): void => {
    setFormData(prev => {
      const next: LegFormData = { ...prev, [field]: value }
      if (field === 'start_day_number' && Number(next.end_day_number) < Number(value)) {
        next.end_day_number = value as number
      }
      if (field === 'end_day_number' && Number(value) < Number(next.start_day_number)) {
        next.start_day_number = value as number
      }
      return next
    })
  }

  const handleDestinationSelect = (place: PlaceSelection): void => {
    setFormData(prev => ({
      ...prev,
      destination_name: place.name || '',
      destination_address: place.address || '',
      destination_lat: place.lat ?? '',
      destination_lng: place.lng ?? '',
      destination_viewport_south: place.viewport?.south ?? '',
      destination_viewport_west: place.viewport?.west ?? '',
      destination_viewport_north: place.viewport?.north ?? '',
      destination_viewport_east: place.viewport?.east ?? '',
    }))
  }

  const clearDestination = (): void => {
    setFormData(prev => ({
      ...prev,
      destination_name: '',
      destination_address: '',
      destination_lat: '',
      destination_lng: '',
      destination_viewport_south: '',
      destination_viewport_west: '',
      destination_viewport_north: '',
      destination_viewport_east: '',
    }))
  }

  const handleSave = async (): Promise<void> => {
    if (!formData.destination_name.trim()) {
      toast.error(t('trip.legsDestinationRequired'))
      return
    }

    const payload: LegPayload = {
      ...formData,
      start_day_number: Number(formData.start_day_number),
      end_day_number: Number(formData.end_day_number),
    }

    setIsSaving(true)
    try {
      if (isEditing) {
        await onUpdate(selectedLegId as number, payload)
      } else {
        await onAdd(payload)
      }
      if (!isEditing) startNewLeg()
    } catch (err: unknown) {
      toast.error((err as Error).message)
    } finally {
      setIsSaving(false)
    }
  }

  const handleDelete = async (leg: TripLeg): Promise<void> => {
    if (!window.confirm(t('trip.legsDeleteConfirm', { destination: leg.destination_name }))) return
    try {
      await onDelete(leg.id as number)
      if (selectedLegId === leg.id) {
        if (sortedLegs.length > 1) {
          const nextLeg = sortedLegs.find(item => item.id !== leg.id)
          if (nextLeg) selectLeg(nextLeg)
        } else {
          startNewLeg()
        }
      }
    } catch (err: unknown) {
      toast.error((err as Error).message)
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t('trip.legsManage')}
      size="lg"
      footer={
        <div className="flex gap-3 justify-between">
          <button
            type="button"
            onClick={startNewLeg}
            className="px-4 py-2 text-sm border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors inline-flex items-center gap-2"
          >
            <Plus className="w-4 h-4" />
            {t('trip.legsAdd')}
          </button>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-slate-600 hover:text-slate-800 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors"
            >
              {t('common.close')}
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={isSaving}
              className="px-4 py-2 text-sm bg-slate-900 hover:bg-slate-700 disabled:bg-slate-400 text-white rounded-lg transition-colors"
            >
              {isSaving ? t('common.saving') : isEditing ? t('trip.legsUpdate') : t('trip.legsCreate')}
            </button>
          </div>
        </div>
      }
    >
      <div className="grid gap-6 md:grid-cols-[220px_minmax(0,1fr)]">
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold text-slate-900">{t('trip.legs')}</div>
            <button
              type="button"
              onClick={startNewLeg}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              <Plus className="w-3.5 h-3.5" />
              {t('trip.legsAdd')}
            </button>
          </div>

          {sortedLegs.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-5 text-sm text-slate-500">
              {t('trip.legsEmpty')}
            </div>
          ) : (
            <div className="space-y-2">
              {sortedLegs.map(leg => {
                const isActive = leg.id === selectedLegId
                return (
                  <div
                    key={leg.id}
                    className={`rounded-xl border px-3 py-3 transition-colors ${isActive ? 'border-slate-900 bg-slate-50' : 'border-slate-200 bg-white'}`}
                  >
                    <button
                      type="button"
                      onClick={() => selectLeg(leg)}
                      className="w-full text-left"
                    >
                      <div className="flex items-start gap-3">
                        <span
                          className="mt-0.5 h-3 w-3 rounded-full"
                          style={{ background: leg.color || '#0f766e' }}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-semibold text-slate-900">{leg.destination_name}</div>
                          <div className="mt-1 text-xs text-slate-500">
                            {t('trip.legsRangeCompact', { start: leg.start_day_number, end: leg.end_day_number })}
                          </div>
                        </div>
                      </div>
                    </button>
                    <div className="mt-3 flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => selectLeg(leg)}
                        className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                        {t('common.edit')}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(leg)}
                        className="inline-flex items-center gap-1 rounded-lg border border-red-200 px-2.5 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        {t('common.delete')}
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <div className="space-y-4">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-slate-700">{t('trip.legsDestination')}</label>
            <PlaceSearchBox
              hasMapsKey={hasMapsKey}
              language={language}
              t={t}
              onPlaceSelected={handleDestinationSelect}
              onSearchError={(message: string) => toast.error(message)}
              searchMode="destination"
            />
          </div>

          {formData.destination_name ? (
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-slate-900">{formData.destination_name}</div>
                  {formData.destination_address && (
                    <div className="mt-1 flex items-center gap-1 text-xs text-slate-500">
                      <MapPin className="h-3.5 w-3.5" />
                      <span className="truncate">{formData.destination_address}</span>
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={clearDestination}
                  className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-white"
                >
                  {t('dashboard.destinationClear')}
                </button>
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-4 text-sm text-slate-500">
              {t('trip.legsSelectDestination')}
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-slate-700">{t('trip.legsStartDay')}</span>
              <select
                value={formData.start_day_number}
                onChange={e => updateField('start_day_number', Number(e.target.value))}
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-slate-300"
              >
                {days.map((day, dayIdx) => (
                  <option key={day.id} value={dayIdx + 1}>
                    {t('dayplan.dayN', { n: dayIdx + 1 })}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-slate-700">{t('trip.legsEndDay')}</span>
              <select
                value={formData.end_day_number}
                onChange={e => updateField('end_day_number', Number(e.target.value))}
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-slate-300"
              >
                {days.map((day, dayIdx) => (
                  <option key={day.id} value={dayIdx + 1}>
                    {t('dayplan.dayN', { n: dayIdx + 1 })}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600">
            {t('trip.legsRangeSummary', {
              destination: formData.destination_name || t('trip.legsUntitled'),
              start: Number(formData.start_day_number) || 1,
              end: Number(formData.end_day_number) || 1,
            })}
          </div>
        </div>
      </div>
    </Modal>
  )
}
