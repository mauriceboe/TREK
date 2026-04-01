import ReactDOM from 'react-dom'
import { useState } from 'react'
import DOM from 'react-dom'
import { Search, Plus, X, CalendarDays, Pencil, Trash2, ExternalLink, Navigation, Upload, ChevronDown, Check, MapPin, Eye } from 'lucide-react'
import PlaceAvatar from '../shared/PlaceAvatar'
import { getCategoryIcon } from '../shared/categoryIcons'
import { useTranslation } from '../../i18n'
import CustomSelect from '../shared/CustomSelect'
import { useContextMenu, ContextMenu } from '../shared/ContextMenu'
import { placesApi } from '../../api/client'
import { useTripStore } from '../../store/tripStore'
import { useCanDo } from '../../store/permissionsStore'
import type { Place, Category, Day, AssignmentsMap } from '../../types'

interface PlacesSidebarProps {
  places: Place[]
  categories: Category[]
  assignments: AssignmentsMap
  selectedDayId: number | null
  selectedPlaceId: number | null
  onPlaceClick: (placeId: number | null) => void
  onAddPlace: () => void
  onAssignToDay: (placeId: number, dayId: number) => void
  onEditPlace: (place: Place) => void
  onDeletePlace: (placeId: number) => void
  days: Day[]
  isMobile: boolean
  onCategoryFilterChange?: (categoryId: string) => void
}

const PlacesSidebar = React.memo(function PlacesSidebar({
  tripId, places, categories, assignments, selectedDayId, selectedPlaceId,
  onPlaceClick, onAddPlace, onAssignToDay, onEditPlace, onDeletePlace, days, isMobile, onCategoryFilterChange,
}: PlacesSidebarProps) {
  const { t } = useTranslation()
  const ctxMenu = useContextMenu()
  const gpxInputRef = useRef<HTMLInputElement>(null)
  const trip = useTripStore((s) => s.trip)
  const loadTrip = useTripStore((s) => s.loadTrip)
  const can = useCanDo()
  const canEditPlaces = can('place_edit', trip)

  const handleGpxImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    try {
      const result = await placesApi.importGpx(tripId, file)
      await loadTrip(tripId)
      toast.success(t('places.gpxImported', { count: result.count }))
    } catch (err: any) {
      toast.error(err?.response?.data?.error || t('places.gpxError'))
    }
  }

  const [googleListOpen, setGoogleListOpen] = useState(false)
  const [googleListUrl, setGoogleListUrl] = useState('')
  const [googleListLoading, setGoogleListLoading] = useState(false)

  const handleGoogleListImport = async () => {
    if (!googleListUrl.trim()) return
    setGoogleListLoading(true)
    try {
      const result = await placesApi.importGoogleList(tripId, googleListUrl.trim())
      await loadTrip(tripId)
      toast.success(t('places.googleListImported', { count: result.count, list: result.listName }))
      setGoogleListOpen(false)
      setGoogleListUrl('')
    } catch (err: any) {
      toast.error(err?.response?.data?.error || t('places.googleListError'))
    } finally {
      setGoogleListLoading(false)
    }
  }

  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')
  const [categoryFilter, setCategoryFilterLocal] = useState('')

  const setCategoryFilter = (val: string) => {
    setCategoryFilterLocal(val)
    onCategoryFilterChange?.(val)
  }
  const [dayPickerPlace, setDayPickerPlace] = useState(null)
  const [catDropOpen, setCatDropOpen] = useState(false)
  const [mobileShowDays, setMobileShowDays] = useState(false)

  // Alle geplanten Ort-IDs abrufen (einem Tag zugewiesen)
  const plannedIds = useMemo(() => new Set(
    Object.values(assignments).flatMap(da => da.map(a => a.place?.id).filter(Boolean))
  ), [assignments])

  const filtered = places.filter(p => {
    if (filter === 'unplanned' && plannedIds.has(p.id)) return false
    if (categoryFilter && String(p.category_id) !== String(categoryFilter)) return false
    if (search && !p.name.toLowerCase().includes(search.toLowerCase()) &&
        !(p.address || '').toLowerCase().includes(search.toLowerCase())) return false
    return true
  }), [places, filter, categoryFilters, search, plannedIds])

  const isAssignedToSelectedDay = (placeId) =>
    selectedDayId && (assignments[String(selectedDayId)] || []).some(a => a.place?.id === placeId)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif" }}>
      {/* Kopfbereich */}
      <div style={{ padding: '14px 16px 10px', borderBottom: '1px solid var(--border-faint)', flexShrink: 0 }}>
        {canEditPlaces && <button
          onClick={onAddPlace}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            width: '100%', padding: '8px 12px', borderRadius: 12, border: 'none',
            background: 'var(--accent)', color: 'var(--accent-text)', fontSize: 13, fontWeight: 500,
            cursor: 'pointer', fontFamily: 'inherit', marginBottom: 10,
          }}
        >
          <Plus size={14} strokeWidth={2} /> {t('places.addPlace')}
        </button>}
        {canEditPlaces && <>
        <input ref={gpxInputRef} type="file" accept=".gpx" style={{ display: 'none' }} onChange={handleGpxImport} />
        <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
          <button
            onClick={() => gpxInputRef.current?.click()}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
              flex: 1, padding: '5px 12px', borderRadius: 8,
              border: '1px dashed var(--border-primary)', background: 'none',
              color: 'var(--text-faint)', fontSize: 11, fontWeight: 500,
              cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            <Upload size={11} strokeWidth={2} /> {t('places.importGpx')}
          </button>
          <button
            onClick={() => setGoogleListOpen(true)}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
              flex: 1, padding: '5px 12px', borderRadius: 8,
              border: '1px dashed var(--border-primary)', background: 'none',
              color: 'var(--text-faint)', fontSize: 11, fontWeight: 500,
              cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            <MapPin size={11} strokeWidth={2} /> {t('places.importGoogleList')}
          </button>
        </div>
        </>}

        {/* Filter-Tabs */}
        <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
          {[{ id: 'all', label: t('places.all') }, { id: 'unplanned', label: t('places.unplanned') }].map(f => (
            <button key={f.id} onClick={() => setFilter(f.id)} style={{
              padding: '4px 10px', borderRadius: 20, border: 'none', cursor: 'pointer',
              fontSize: 11, fontWeight: 500, fontFamily: 'inherit',
              background: filter === f.id ? 'var(--accent)' : 'var(--bg-tertiary)',
              color: filter === f.id ? 'var(--accent-text)' : 'var(--text-muted)',
            }}>{f.label}</button>
          ))}
        </div>

        {/* Suchfeld */}
        <div style={{ position: 'relative' }}>
          <Search size={13} strokeWidth={1.8} color="var(--text-faint)" style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }} />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={t('places.search')}
            style={{
              width: '100%', padding: '7px 30px 7px 30px', borderRadius: 10,
              border: 'none', background: 'var(--bg-tertiary)', fontSize: 12, color: 'var(--text-primary)',
              outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box',
            }}
          />
          {search && (
            <button onClick={() => setSearch('')} style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex' }}>
              <X size={12} strokeWidth={2} color="var(--text-faint)" />
            </button>
          )}
        </div>

        {/* Kategoriefilter */}
        {categories.length > 0 && (
          <div style={{ marginTop: 6 }}>
            <CustomSelect
              value={categoryFilter}
              onChange={setCategoryFilter}
              placeholder={t('places.allCategories')}
              size="sm"
              options={[
                { value: '', label: t('places.allCategories') },
                ...categories.map(c => {
                  const CatIcon = getCategoryIcon(c.icon)
                  return { value: String(c.id), label: c.name, icon: <CatIcon size={13} strokeWidth={2} color={(c as any).color || '#6366f1'} /> }
                })
              ]}
            />
          </div>
        )}
      </div>

      {/* Anzahl */}
      <div style={{ padding: '6px 16px', flexShrink: 0 }}>
        <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{filtered.length === 1 ? t('places.countSingular') : t('places.count', { count: filtered.length })}</span>
      </div>

      {/* Liste */}
      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        {filtered.length === 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '40px 16px', gap: 8 }}>
            <span style={{ fontSize: 13, color: 'var(--text-faint)' }}>
              {filter === 'unplanned' ? t('places.allPlanned') : t('places.noneFound')}
            </span>
            {canEditPlaces && <button onClick={onAddPlace} style={{ fontSize: 12, color: 'var(--text-primary)', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline', fontFamily: 'inherit' }}>
              {t('places.addPlace')}
            </button>}
          </div>
        ) : (
          filtered.map(place => {
            const cat = categories.find(c => c.id === place.category_id)
            const isSelected = place.id === selectedPlaceId
            const inDay = isAssignedToSelectedDay(place.id)
            const isPlanned = plannedIds.has(place.id)

            return (
              <div
                key={place.id}
                draggable
                onDragStart={e => {
                  e.dataTransfer.setData('placeId', String(place.id))
                  e.dataTransfer.effectAllowed = 'copy'
                  // Backup in window für Cross-Component Drag (dataTransfer geht bei Re-Render verloren)
                  window.__dragData = { placeId: String(place.id) }
                }}
                onClick={() => {
                  if (isMobile) {
                    setDayPickerPlace(place)
                  } else {
                    onPlaceClick(isSelected ? null : place.id)
                  }
                }}
                onContextMenu={e => ctxMenu.open(e, [
                  canEditPlaces && { label: t('common.edit'), icon: Pencil, onClick: () => onEditPlace(place) },
                  selectedDayId && { label: t('planner.addToDay'), icon: CalendarDays, onClick: () => onAssignToDay(place.id, selectedDayId) },
                  place.website && { label: t('inspector.website'), icon: ExternalLink, onClick: () => window.open(place.website, '_blank') },
                  (place.lat && place.lng) && { label: 'Google Maps', icon: Navigation, onClick: () => window.open(`https://www.google.com/maps/search/?api=1&query=${place.lat},${place.lng}`, '_blank') },
                  { divider: true },
                  canEditPlaces && { label: t('common.delete'), icon: Trash2, danger: true, onClick: () => onDeletePlace(place.id) },
                ])}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '9px 14px 9px 16px',
                  cursor: 'grab',
                  background: isSelected ? 'var(--border-faint)' : 'transparent',
                  borderBottom: '1px solid var(--border-faint)',
                  transition: 'background 0.1s',
                }}
                onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = 'var(--bg-hover)' }}
                onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = 'transparent' }}
              >
                <PlaceAvatar place={place} category={cat} size={34} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, overflow: 'hidden' }}>
                    {cat && (() => {
                      const CatIcon = getCategoryIcon(cat.icon)
                      return <CatIcon size={11} strokeWidth={2} color={cat.color || '#6366f1'} style={{ flexShrink: 0 }} title={cat.name} />
                    })()}
                    <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', lineHeight: 1.2 }}>
                      {place.name}
                    </span>
                  </div>
                  {(place.description || place.address || cat?.name) && (
                    <div style={{ marginTop: 2 }}>
                      <span style={{ fontSize: 11, color: 'var(--text-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block', lineHeight: 1.2 }}>
                        {place.description || place.address || cat?.name}
                      </span>
                    </div>
                  )}
                </div>
                <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center' }}>
                  {!inDay && selectedDayId && (
                    <button
                      onClick={e => { e.stopPropagation(); onAssignToDay(place.id) }}
                      style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        width: 20, height: 20, borderRadius: 6,
                        background: 'var(--bg-hover)', border: 'none', cursor: 'pointer',
                        color: 'var(--text-faint)', padding: 0, transition: 'background 0.15s, color 0.15s',
                      }}
                      onMouseEnter={e => { e.currentTarget.style.background = 'var(--accent)'; e.currentTarget.style.color = 'var(--accent-text)' }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'var(--bg-hover)'; e.currentTarget.style.color = 'var(--text-faint)' }}
                    ><Plus size={12} strokeWidth={2.5} /></button>
                  )}
                </div>
              </div>
            )
          })
        )}
      </div>

      {dayPickerPlace && ReactDOM.createPortal(
        <div
          onClick={() => { setDayPickerPlace(null); setMobileShowDays(false) }}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 99999, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{ background: 'var(--bg-card)', borderRadius: '20px 20px 0 0', width: '100%', maxWidth: 500, maxHeight: '70vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', paddingBottom: 'env(safe-area-inset-bottom)' }}
          >
            <div style={{ padding: '16px 20px 12px', borderBottom: '1px solid var(--border-secondary)' }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>{dayPickerPlace.name}</div>
              {dayPickerPlace.address && <div style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 2 }}>{dayPickerPlace.address}</div>}
            </div>
            <div style={{ overflowY: 'auto', padding: '8px 12px' }}>
              {/* View details */}
              <button
                onClick={() => { onPlaceClick(dayPickerPlace.id); setDayPickerPlace(null); setMobileShowDays(false) }}
                style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', padding: '12px 14px', borderRadius: 12, border: 'none', cursor: 'pointer', background: 'transparent', fontFamily: 'inherit', textAlign: 'left', fontSize: 14, color: 'var(--text-primary)' }}
              >
                <Eye size={18} color="var(--text-muted)" /> {t('places.viewDetails')}
              </button>
              {/* Edit */}
              {canEditPlaces && (
                <button
                  onClick={() => { onEditPlace(dayPickerPlace); setDayPickerPlace(null); setMobileShowDays(false) }}
                  style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', padding: '12px 14px', borderRadius: 12, border: 'none', cursor: 'pointer', background: 'transparent', fontFamily: 'inherit', textAlign: 'left', fontSize: 14, color: 'var(--text-primary)' }}
                >
                  <Pencil size={18} color="var(--text-muted)" /> {t('common.edit')}
                </button>
              )}
              {/* Assign to day */}
              {days?.length > 0 && (
                <>
                  <button
                    onClick={() => setMobileShowDays(v => !v)}
                    style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', padding: '12px 14px', borderRadius: 12, border: 'none', cursor: 'pointer', background: 'transparent', fontFamily: 'inherit', textAlign: 'left', fontSize: 14, color: 'var(--text-primary)' }}
                  >
                    <CalendarDays size={18} color="var(--text-muted)" /> {t('places.assignToDay')}
                    <ChevronDown size={14} style={{ marginLeft: 'auto', color: 'var(--text-faint)', transform: mobileShowDays ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }} />
                  </button>
                  {mobileShowDays && (
                    <div style={{ paddingLeft: 20 }}>
                      {days.map((day, i) => (
                        <button
                          key={day.id}
                          onClick={() => { onAssignToDay(dayPickerPlace.id, day.id); setDayPickerPlace(null); setMobileShowDays(false) }}
                          style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '10px 14px', borderRadius: 10, border: 'none', cursor: 'pointer', background: 'transparent', fontFamily: 'inherit', textAlign: 'left' }}
                        >
                          <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'var(--bg-tertiary)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, color: 'var(--text-primary)', flexShrink: 0 }}>{i + 1}</div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>{day.title || t('dayplan.dayN', { n: i + 1 })}</div>
                            {day.date && <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>{new Date(day.date + 'T00:00:00').toLocaleDateString()}</div>}
                          </div>
                          {(assignments[String(day.id)] || []).some(a => a.place?.id === dayPickerPlace.id) && <Check size={14} color="var(--text-faint)" />}
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
              {/* Delete */}
              {canEditPlaces && (
                <button
                  onClick={() => { onDeletePlace(dayPickerPlace.id); setDayPickerPlace(null); setMobileShowDays(false) }}
                  style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', padding: '12px 14px', borderRadius: 12, border: 'none', cursor: 'pointer', background: 'transparent', fontFamily: 'inherit', textAlign: 'left', fontSize: 14, color: '#ef4444' }}
                >
                  <Trash2 size={18} /> {t('common.delete')}
                </button>
              )}
            </div>
          </div>
        </div>,
        document.body
      )}
      {googleListOpen && ReactDOM.createPortal(
        <div
          onClick={() => { setGoogleListOpen(false); setGoogleListUrl('') }}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 99999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{ background: 'var(--bg-card)', borderRadius: 16, width: '100%', maxWidth: 440, padding: 24, boxShadow: '0 8px 32px rgba(0,0,0,0.2)' }}
          >
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4 }}>
              {t('places.importGoogleList')}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-faint)', marginBottom: 16 }}>
              {t('places.googleListHint')}
            </div>
            <input
              type="text"
              value={googleListUrl}
              onChange={e => setGoogleListUrl(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !googleListLoading) handleGoogleListImport() }}
              placeholder="https://maps.app.goo.gl/..."
              autoFocus
              style={{
                width: '100%', padding: '10px 14px', borderRadius: 10,
                border: '1px solid var(--border-primary)', background: 'var(--bg-tertiary)',
                fontSize: 13, color: 'var(--text-primary)', outline: 'none',
                fontFamily: 'inherit', boxSizing: 'border-box',
              }}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
              <button
                onClick={() => { setGoogleListOpen(false); setGoogleListUrl('') }}
                style={{
                  padding: '8px 16px', borderRadius: 10, border: '1px solid var(--border-primary)',
                  background: 'none', color: 'var(--text-primary)', fontSize: 13, fontWeight: 500,
                  cursor: 'pointer', fontFamily: 'inherit',
                }}
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={handleGoogleListImport}
                disabled={!googleListUrl.trim() || googleListLoading}
                style={{
                  padding: '8px 16px', borderRadius: 10, border: 'none',
                  background: !googleListUrl.trim() || googleListLoading ? 'var(--bg-tertiary)' : 'var(--accent)',
                  color: !googleListUrl.trim() || googleListLoading ? 'var(--text-faint)' : 'var(--accent-text)',
                  fontSize: 13, fontWeight: 500, cursor: !googleListUrl.trim() || googleListLoading ? 'default' : 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                {googleListLoading ? t('common.loading') : t('common.import')}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
      <ContextMenu menu={ctxMenu.menu} onClose={ctxMenu.close} />
    </div>
  )
})

export default PlacesSidebar
