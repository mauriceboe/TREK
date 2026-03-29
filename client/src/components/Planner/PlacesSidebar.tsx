import ReactDOM from 'react-dom'
import { useState } from 'react'
import DOM from 'react-dom'
import { Search, Plus, X, CalendarDays, Pencil, Trash2, ExternalLink, Navigation } from 'lucide-react'
import PlaceAvatar from '../shared/PlaceAvatar'
import { getCategoryIcon } from '../shared/categoryIcons'
import { useTranslation } from '../../i18n'
import CustomSelect from '../shared/CustomSelect'
import { useContextMenu, ContextMenu } from '../shared/ContextMenu'
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

export default function PlacesSidebar({
  places, categories, assignments, selectedDayId, selectedPlaceId,
  onPlaceClick, onAddPlace, onAssignToDay, onEditPlace, onDeletePlace, days, isMobile, onCategoryFilterChange,
}: PlacesSidebarProps) {
  const { t } = useTranslation()
  const ctxMenu = useContextMenu()
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')
  const [categoryFilter, setCategoryFilterLocal] = useState('')

  const setCategoryFilter = (val: string) => {
    setCategoryFilterLocal(val)
    onCategoryFilterChange?.(val)
  }
  const [dayPickerPlace, setDayPickerPlace] = useState(null)

  // Alle geplanten Ort-IDs abrufen (einem Tag zugewiesen)
  const plannedIds = new Set(
    Object.values(assignments).flatMap(da => da.map(a => a.place?.id).filter(Boolean))
  )

  const filtered = places.filter(p => {
    if (filter === 'unplanned' && plannedIds.has(p.id)) return false
    if (categoryFilter && String(p.category_id) !== String(categoryFilter)) return false
    if (search && !p.name.toLowerCase().includes(search.toLowerCase()) &&
        !(p.address || '').toLowerCase().includes(search.toLowerCase())) return false
    return true
  })

  const isAssignedToSelectedDay = (placeId) =>
    selectedDayId && (assignments[String(selectedDayId)] || []).some(a => a.place?.id === placeId)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif" }}>
      {/* Kopfbereich */}
      <div style={{ padding: '14px 16px 10px', borderBottom: '1px solid var(--border-faint)', flexShrink: 0 }}>
        <button
          onClick={onAddPlace}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            width: '100%', padding: '8px 12px', borderRadius: 12, border: 'none',
            background: 'var(--accent)', color: 'var(--accent-text)', fontSize: 13, fontWeight: 500,
            cursor: 'pointer', fontFamily: 'inherit', marginBottom: 10,
          }}
        >
          <Plus size={14} strokeWidth={2} /> {t('places.addPlace')}
        </button>

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
                ...categories.map(c => ({ value: String(c.id), label: c.name }))
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
            <button onClick={onAddPlace} style={{ fontSize: 12, color: 'var(--text-primary)', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline', fontFamily: 'inherit' }}>
              {t('places.addPlace')}
            </button>
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
                  if (isMobile && days?.length > 0) {
                    setDayPickerPlace(place)
                  } else {
                    onPlaceClick(isSelected ? null : place.id)
                  }
                }}
                onContextMenu={e => ctxMenu.open(e, [
                  onEditPlace && { label: t('common.edit'), icon: Pencil, onClick: () => onEditPlace(place) },
                  selectedDayId && { label: t('planner.addToDay'), icon: CalendarDays, onClick: () => onAssignToDay(place.id, selectedDayId) },
                  place.website && { label: t('inspector.website'), icon: ExternalLink, onClick: () => window.open(place.website, '_blank') },
                  (place.lat && place.lng) && { label: 'Google Maps', icon: Navigation, onClick: () => window.open(`https://www.google.com/maps/search/?api=1&query=${place.lat},${place.lng}`, '_blank') },
                  { divider: true },
                  onDeletePlace && { label: t('common.delete'), icon: Trash2, danger: true, onClick: () => onDeletePlace(place.id) },
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

      {dayPickerPlace && days?.length > 0 && ReactDOM.createPortal(
        <div
          onClick={() => setDayPickerPlace(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 99999, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{ background: 'var(--bg-card)', borderRadius: '20px 20px 0 0', width: '100%', maxWidth: 500, maxHeight: '60vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', paddingBottom: 'env(safe-area-inset-bottom)' }}
          >
            <div style={{ padding: '16px 20px 12px', borderBottom: '1px solid var(--border-secondary)' }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>{dayPickerPlace.name}</div>
              <div style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 2 }}>{t('places.assignToDay')}</div>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '8px 12px 16px' }}>
              {days.map((day, i) => {
                return (
                  <button
                    key={day.id}
                    onClick={() => { onAssignToDay(dayPickerPlace.id, day.id); setDayPickerPlace(null) }}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10, width: '100%',
                      padding: '12px 14px', borderRadius: 12, border: 'none', cursor: 'pointer',
                      background: 'transparent', fontFamily: 'inherit', textAlign: 'left',
                      transition: 'background 0.1s',
                    }}
                    onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                  >
                    <div style={{
                      width: 32, height: 32, borderRadius: '50%', background: 'var(--bg-tertiary)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', flexShrink: 0,
                    }}>{i + 1}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
                        {day.title || `${t('dayplan.dayN', { n: i + 1 })}`}
                      </div>
                      {day.date && <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>{new Date(day.date + 'T00:00:00').toLocaleDateString()}</div>}
                    </div>
                    {(assignments[String(day.id)] || []).some(a => a.place?.id === dayPickerPlace.id) && <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>✓</span>}
                  </button>
                )
              })}
            </div>
          </div>
        </div>,
        document.body
      )}
      <ContextMenu menu={ctxMenu.menu} onClose={ctxMenu.close} />
    </div>
  )
}
