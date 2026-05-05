import { useState, useMemo, useRef, useEffect } from 'react'
import { useTripStore } from '../../store/tripStore'
import { useCanDo } from '../../store/permissionsStore'
import { useToast } from '../shared/Toast'
import { useTranslation } from '../../i18n'
import { packingApi, tripsApi, adminApi } from '../../api/client'
import ReactDOM from 'react-dom'
import {
  CheckSquare, Square, Trash2, Plus, ChevronDown, ChevronRight,
  X, Pencil, Check, MoreHorizontal, CheckCheck, RotateCcw, Luggage, UserPlus, Package, FolderPlus, Upload,
  Lock, Users, Globe,
} from 'lucide-react'
import type { PackingItem, PackingCategory } from '../../types'
import Tooltip from '../shared/Tooltip'

const VORSCHLAEGE = [
  { name: 'Passport', category: 'Documents' },
  { name: 'Travel Insurance', category: 'Documents' },
  { name: 'Visa Documents', category: 'Documents' },
  { name: 'Flight Tickets', category: 'Documents' },
  { name: 'Hotel Bookings', category: 'Documents' },
  { name: 'Vaccination Card', category: 'Documents' },
  { name: 'T-Shirts (5x)', category: 'Clothing' },
  { name: 'Pants (2x)', category: 'Clothing' },
  { name: 'Underwear (7x)', category: 'Clothing' },
  { name: 'Socks (7x)', category: 'Clothing' },
  { name: 'Jacket', category: 'Clothing' },
  { name: 'Swimwear', category: 'Clothing' },
  { name: 'Sport Shoes', category: 'Clothing' },
  { name: 'Toothbrush', category: 'Toiletries' },
  { name: 'Toothpaste', category: 'Toiletries' },
  { name: 'Shampoo', category: 'Toiletries' },
  { name: 'Sunscreen', category: 'Toiletries' },
  { name: 'Deodorant', category: 'Toiletries' },
  { name: 'Razor', category: 'Toiletries' },
  { name: 'Phone Charger', category: 'Electronics' },
  { name: 'Travel Adapter', category: 'Electronics' },
  { name: 'Headphones', category: 'Electronics' },
  { name: 'Camera', category: 'Electronics' },
  { name: 'Power Bank', category: 'Electronics' },
  { name: 'First Aid Kit', category: 'Health' },
  { name: 'Prescription Medication', category: 'Health' },
  { name: 'Pain Medication', category: 'Health' },
  { name: 'Insect Repellent', category: 'Health' },
  { name: 'Cash', category: 'Finances' },
  { name: 'Credit Card', category: 'Finances' },
]

// Cycling color palette — works in light & dark mode
const KAT_COLORS = [
  '#3b82f6', // blue
  '#a855f7', // purple
  '#ec4899', // pink
  '#22c55e', // green
  '#f97316', // orange
  '#06b6d4', // cyan
  '#ef4444', // red
  '#eab308', // yellow
  '#8b5cf6', // violet
  '#14b8a6', // teal
]
// Stable color assignment: category name → index via simple hash
function katColor(kat, allCategories) {
  const idx = allCategories ? allCategories.indexOf(kat) : -1
  if (idx >= 0) return KAT_COLORS[idx % KAT_COLORS.length]
  // Fallback: hash-based
  let h = 0
  for (let i = 0; i < kat.length; i++) h = ((h << 5) - h + kat.charCodeAt(i)) | 0
  return KAT_COLORS[Math.abs(h) % KAT_COLORS.length]
}

interface PackingBag { id: number; trip_id: number; name: string; color: string; weight_limit_grams: number | null; user_id?: number | null; assigned_username?: string | null }

// ── Bag Card ──────────────────────────────────────────────────────────────

interface BagCardProps {
  bag: PackingBag; bagItems: PackingItem[]; totalWeight: number; pct: number; tripId: number
  tripMembers: TripMember[]; canEdit: boolean; onDelete: () => void
  onUpdate: (bagId: number, data: Record<string, any>) => void
  onSetMembers: (bagId: number, userIds: number[]) => void; t: any; compact?: boolean
}

function BagCard({ bag, bagItems, totalWeight, pct, tripId, tripMembers, canEdit, onDelete, onUpdate, onSetMembers, t, compact }: BagCardProps) {
  const [editingName, setEditingName] = useState(false)
  const [nameVal, setNameVal] = useState(bag.name)
  const [showUserPicker, setShowUserPicker] = useState(false)
  useEffect(() => setNameVal(bag.name), [bag.name])

  const saveName = () => {
    if (nameVal.trim() && nameVal.trim() !== bag.name) onUpdate(bag.id, { name: nameVal.trim() })
    setEditingName(false)
  }

  const memberIds = (bag.members || []).map(m => m.user_id)
  const toggleMember = (userId: number) => {
    const next = memberIds.includes(userId) ? memberIds.filter(id => id !== userId) : [...memberIds, userId]
    onSetMembers(bag.id, next)
  }

  const sz = compact ? { dot: 10, name: 12, weight: 11, bar: 6, count: 10, gap: 6, mb: 14, icon: 11, avatar: 18 } : { dot: 12, name: 14, weight: 13, bar: 8, count: 11, gap: 8, mb: 16, icon: 13, avatar: 22 }

  return (
    <div style={{ marginBottom: sz.mb }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: sz.gap, marginBottom: 4 }}>
        <span style={{ width: sz.dot, height: sz.dot, borderRadius: '50%', background: bag.color, flexShrink: 0 }} />
        {editingName && canEdit ? (
          <input autoFocus value={nameVal} onChange={e => setNameVal(e.target.value)}
            onBlur={saveName} onKeyDown={e => { if (e.key === 'Enter') saveName(); if (e.key === 'Escape') { setEditingName(false); setNameVal(bag.name) } }}
            style={{ flex: 1, fontSize: sz.name, fontWeight: 600, padding: '1px 4px', borderRadius: 4, border: '1px solid var(--border-primary)', outline: 'none', fontFamily: 'inherit', color: 'var(--text-primary)', background: 'transparent' }} />
        ) : (
          <span onClick={() => canEdit && setEditingName(true)} style={{ flex: 1, fontSize: sz.name, fontWeight: 600, color: compact ? 'var(--text-secondary)' : 'var(--text-primary)', cursor: canEdit ? 'text' : 'default' }}>{bag.name}</span>
        )}
        <span style={{ fontSize: sz.weight, color: 'var(--text-faint)', fontWeight: 500 }}>
          {totalWeight >= 1000 ? `${(totalWeight / 1000).toFixed(1)} kg` : `${totalWeight} g`}
        </span>
        {canEdit && <button onClick={onDelete} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: 'var(--text-faint)', display: 'flex' }}><X size={sz.icon} /></button>}
      </div>
      {/* Members */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4, flexWrap: 'wrap', position: 'relative' }}>
        {(bag.members || []).map(m => (
          <span key={m.user_id} title={m.username} onClick={() => canEdit && toggleMember(m.user_id)} style={{ cursor: canEdit ? 'pointer' : 'default', display: 'inline-flex' }}>
            {m.avatar ? (
              <img src={m.avatar} alt={m.username} style={{ width: sz.avatar, height: sz.avatar, borderRadius: '50%', objectFit: 'cover', border: `1.5px solid ${bag.color}`, boxSizing: 'border-box' }} />
            ) : (
              <span style={{ width: sz.avatar, height: sz.avatar, borderRadius: '50%', background: bag.color + '25', color: bag.color, fontSize: sz.avatar * 0.45, fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', border: `1.5px solid ${bag.color}`, boxSizing: 'border-box' }}>
                {m.username[0].toUpperCase()}
              </span>
            )}
          </span>
        ))}
        {canEdit && (
          <button onClick={() => setShowUserPicker(v => !v)} style={{ width: sz.avatar, height: sz.avatar, borderRadius: '50%', border: '1.5px dashed var(--border-primary)', background: 'none', color: 'var(--text-faint)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0, boxSizing: 'border-box' }}>
            <Plus size={sz.avatar * 0.5} />
          </button>
        )}
        {showUserPicker && (
          <div style={{ position: 'absolute', left: 0, top: '100%', marginTop: 4, zIndex: 50, background: 'var(--bg-card)', border: '1px solid var(--border-primary)', borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,0.1)', padding: 4, minWidth: 160 }}>
            {tripMembers.map(m => {
              const isSelected = memberIds.includes(m.id)
              return (
                <button key={m.id} onClick={() => { toggleMember(m.id); }}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '6px 10px', borderRadius: 6, border: 'none', background: isSelected ? 'var(--bg-tertiary)' : 'transparent', cursor: 'pointer', fontSize: 11, color: 'var(--text-primary)', fontFamily: 'inherit' }}
                  onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = 'var(--bg-secondary)' }}
                  onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = 'transparent' }}>
                  {m.avatar ? (
                    <img src={m.avatar} alt="" style={{ width: 20, height: 20, borderRadius: '50%', objectFit: 'cover' }} />
                  ) : (
                    <span style={{ width: 20, height: 20, borderRadius: '50%', background: 'var(--bg-tertiary)', fontSize: 10, fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-faint)' }}>
                      {m.username[0].toUpperCase()}
                    </span>
                  )}
                  <span style={{ flex: 1, fontWeight: isSelected ? 600 : 400 }}>{m.username}</span>
                  {isSelected && <Check size={12} style={{ color: '#10b981' }} />}
                </button>
              )
            })}
            {tripMembers.length === 0 && <div style={{ padding: '8px 10px', fontSize: 11, color: 'var(--text-faint)' }}>{t('packing.noMembers')}</div>}
            <div style={{ borderTop: '1px solid var(--border-secondary)', marginTop: 4, paddingTop: 4 }}>
              <button onClick={() => setShowUserPicker(false)} style={{ width: '100%', padding: '6px 10px', borderRadius: 6, border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 11, color: 'var(--text-faint)', fontFamily: 'inherit', textAlign: 'center' }}>
                {t('common.close')}
              </button>
            </div>
          </div>
        )}
      </div>
      <div style={{ height: sz.bar, background: 'var(--bg-tertiary)', borderRadius: 99, overflow: 'hidden' }}>
        <div style={{ height: '100%', borderRadius: 99, background: bag.color, width: `${pct}%`, transition: 'width 0.3s' }} />
      </div>
      <div style={{ fontSize: sz.count, color: 'var(--text-faint)', marginTop: 2 }}>{bagItems.length} {t('admin.packingTemplates.items')}</div>
    </div>
  )
}

// ── Quantity Input ─────────────────────────────────────────────────────────

function QuantityInput({ value, onSave }: { value: number; onSave: (qty: number) => void }) {
  const [local, setLocal] = useState(String(value))
  useEffect(() => setLocal(String(value)), [value])

  const commit = () => {
    const qty = Math.max(1, Math.min(999, Number(local) || 1))
    setLocal(String(qty))
    if (qty !== value) onSave(qty)
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 2, border: '1px solid var(--border-primary)', borderRadius: 8, padding: '3px 6px', background: 'transparent', flexShrink: 0 }}>
      <input
        type="text" inputMode="numeric"
        value={local}
        onChange={e => setLocal(e.target.value.replace(/\D/g, ''))}
        onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') { commit(); (e.target as HTMLInputElement).blur() } }}
        style={{ width: 24, border: 'none', outline: 'none', background: 'transparent', fontSize: 12, textAlign: 'right', fontFamily: 'inherit', color: 'var(--text-secondary)', padding: 0 }}
      />
      <span style={{ fontSize: 10, color: 'var(--text-faint)', fontWeight: 500 }}>x</span>
    </div>
  )
}

// ── Artikel-Zeile ──────────────────────────────────────────────────────────
interface ArtikelZeileProps {
  item: PackingItem
  tripId: number
  categories: PackingCategory[]
  onCategoryChange: () => void
  bagTrackingEnabled?: boolean
  bags?: PackingBag[]
  onCreateBag: (name: string) => Promise<PackingBag | undefined>
  canEdit?: boolean
}

function ArtikelZeile({ item, tripId, categories, onCategoryChange, bagTrackingEnabled, bags = [], onCreateBag, canEdit = true }: ArtikelZeileProps) {
  const [editing, setEditing] = useState(false)
  const [editName, setEditName] = useState(item.name)
  const [hovered, setHovered] = useState(false)
  const [showCatPicker, setShowCatPicker] = useState(false)
  const [showBagPicker, setShowBagPicker] = useState(false)
  const [bagInlineCreate, setBagInlineCreate] = useState(false)
  const [bagInlineName, setBagInlineName] = useState('')
  const { togglePackingItem, updatePackingItem, deletePackingItem } = useTripStore()
  const toast = useToast()
  const { t } = useTranslation()

  const handleToggle = () => togglePackingItem(tripId, item.id, !item.checked)

  const handleSaveName = async () => {
    if (!editName.trim()) { setEditing(false); setEditName(item.name); return }
    try { await updatePackingItem(tripId, item.id, { name: editName.trim() }); setEditing(false) }
    catch { toast.error(t('packing.toast.saveError')) }
  }

  const handleDelete = async () => {
    try { await deletePackingItem(tripId, item.id) }
    catch { toast.error(t('packing.toast.deleteError')) }
  }

  const handleCatChange = async (catId: number) => {
    setShowCatPicker(false)
    if (catId === item.category_id) return
    try { await updatePackingItem(tripId, item.id, { category_id: catId }) }
    catch { toast.error(t('common.error')) }
  }

  return (
    <div
      className="group"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); setShowCatPicker(false); setShowBagPicker(false) }}
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '6px 10px', borderRadius: 10, position: 'relative',
        background: hovered ? 'var(--bg-secondary)' : 'transparent',
        transition: 'background 0.1s',
      }}
    >
      <button onClick={handleToggle} style={{
        flexShrink: 0, background: 'none', border: 'none', cursor: 'pointer', padding: 0, position: 'relative',
        width: 18, height: 18,
        color: item.checked ? '#10b981' : 'var(--text-faint)',
        transition: 'color 200ms cubic-bezier(0.23,1,0.32,1)',
      }}>
        <Square size={18} style={{
          position: 'absolute', inset: 0,
          opacity: item.checked ? 0 : 1,
          transform: item.checked ? 'scale(0.7)' : 'scale(1)',
          transition: 'opacity 180ms cubic-bezier(0.23,1,0.32,1), transform 180ms cubic-bezier(0.23,1,0.32,1)',
        }} />
        <CheckSquare size={18} style={{
          position: 'absolute', inset: 0,
          opacity: item.checked ? 1 : 0,
          transform: item.checked ? 'scale(1)' : 'scale(0.5)',
          transition: 'opacity 200ms cubic-bezier(0.23,1,0.32,1), transform 220ms cubic-bezier(0.34,1.56,0.64,1)',
        }} />
      </button>

      {editing && canEdit ? (
        <input
          type="text" value={editName} autoFocus
          onChange={e => setEditName(e.target.value)}
          onBlur={handleSaveName}
          onKeyDown={e => { if (e.key === 'Enter') handleSaveName(); if (e.key === 'Escape') { setEditing(false); setEditName(item.name) } }}
          style={{ flex: 1, fontSize: 13.5, padding: '2px 8px', borderRadius: 6, border: '1px solid var(--border-primary)', outline: 'none', fontFamily: 'inherit' }}
        />
      ) : (
        <span
          onClick={() => canEdit && !item.checked && setEditing(true)}
          style={{
            flex: 1, fontSize: 13.5,
            cursor: !canEdit || item.checked ? 'default' : 'text',
            color: item.checked ? 'var(--text-faint)' : 'var(--text-primary)',
            transition: 'color 200ms cubic-bezier(0.23,1,0.32,1)',
            textDecoration: item.checked ? 'line-through' : 'none',
          }}
        >
          {item.name}
        </span>
      )}

      {/* Quantity */}
      {canEdit && <QuantityInput value={item.quantity || 1} onSave={qty => updatePackingItem(tripId, item.id, { quantity: qty })} />}

      {/* Weight + Bag (when enabled) */}
      {bagTrackingEnabled && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 2, border: '1px solid var(--border-primary)', borderRadius: 8, padding: '3px 6px', background: 'transparent' }}>
            <input
              type="text" inputMode="numeric"
              value={item.weight_grams ?? ''}
              readOnly={!canEdit}
              onChange={async e => {
                if (!canEdit) return
                const raw = e.target.value.replace(/[^0-9]/g, '')
                const v = raw === '' ? null : parseInt(raw)
                try { await updatePackingItem(tripId, item.id, { weight_grams: v }) } catch {}
              }}
              placeholder="—"
              style={{ width: 36, border: 'none', fontSize: 12, textAlign: 'right', fontFamily: 'inherit', outline: 'none', color: 'var(--text-secondary)', background: 'transparent', padding: 0 }}
            />
            <span style={{ fontSize: 10, color: 'var(--text-faint)', userSelect: 'none' }}>g</span>
          </div>
          <div style={{ position: 'relative' }}>
            <button
              onClick={() => canEdit && setShowBagPicker(p => !p)}
              style={{
                width: 22, height: 22, borderRadius: '50%', cursor: canEdit ? 'pointer' : 'default', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                border: item.bag_id ? `2.5px solid ${bags.find(b => b.id === item.bag_id)?.color || 'var(--border-primary)'}` : '2px dashed var(--border-primary)',
                background: item.bag_id ? `${bags.find(b => b.id === item.bag_id)?.color || 'var(--border-primary)'}30` : 'transparent',
              }}
            >
              {!item.bag_id && <Package size={9} style={{ color: 'var(--text-faint)' }} />}
            </button>
            {showBagPicker && (
              <div style={{
                position: 'absolute', right: 0, top: '100%', marginTop: 4, zIndex: 50,
                background: 'var(--bg-card)', border: '1px solid var(--border-primary)', borderRadius: 10,
                boxShadow: '0 4px 16px rgba(0,0,0,0.12)', padding: 4, minWidth: 160,
              }}>
                {item.bag_id && (
                  <button onClick={async () => { setShowBagPicker(false); try { await updatePackingItem(tripId, item.id, { bag_id: null }) } catch {} }}
                    style={{ display: 'flex', alignItems: 'center', gap: 7, width: '100%', padding: '6px 10px', background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, fontFamily: 'inherit', color: 'var(--text-faint)', borderRadius: 7 }}>
                    <span style={{ width: 10, height: 10, borderRadius: '50%', border: '2px dashed var(--border-primary)' }} />
                    {t('packing.noBag')}
                  </button>
                )}
                {bags.map(b => (
                  <button key={b.id} onClick={async () => { setShowBagPicker(false); try { await updatePackingItem(tripId, item.id, { bag_id: b.id }) } catch {} }}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 7, width: '100%', padding: '6px 10px',
                      background: item.bag_id === b.id ? 'var(--bg-tertiary)' : 'none',
                      border: 'none', cursor: 'pointer', fontSize: 12, fontFamily: 'inherit', color: 'var(--text-secondary)', borderRadius: 7,
                    }}
                    onMouseEnter={e => { if (item.bag_id !== b.id) e.currentTarget.style.background = 'var(--bg-tertiary)' }}
                    onMouseLeave={e => { if (item.bag_id !== b.id) e.currentTarget.style.background = 'none' }}>
                    <span style={{ width: 10, height: 10, borderRadius: '50%', background: b.color, flexShrink: 0 }} />
                    {b.name}
                  </button>
                ))}
                {bags.length > 0 && <div style={{ height: 1, background: 'var(--bg-tertiary)', margin: '4px 0' }} />}
                <div style={{ padding: '4px 6px' }}>
                  {bagInlineCreate ? (
                    <div style={{ display: 'flex', gap: 4 }}>
                      <input autoFocus value={bagInlineName} onChange={e => setBagInlineName(e.target.value)}
                        onKeyDown={async e => {
                          if (e.key === 'Enter' && bagInlineName.trim()) {
                            const newBag = await onCreateBag(bagInlineName.trim())
                            if (newBag) { try { await updatePackingItem(tripId, item.id, { bag_id: newBag.id }) } catch {} }
                            setBagInlineName(''); setBagInlineCreate(false); setShowBagPicker(false)
                          }
                          if (e.key === 'Escape') { setBagInlineCreate(false); setBagInlineName('') }
                        }}
                        placeholder={t('packing.bagName')}
                        style={{ flex: 1, padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border-primary)', fontSize: 11, fontFamily: 'inherit', outline: 'none' }} />
                      <button onClick={async () => {
                        if (bagInlineName.trim()) {
                          const newBag = await onCreateBag(bagInlineName.trim())
                          if (newBag) { try { await updatePackingItem(tripId, item.id, { bag_id: newBag.id }) } catch {} }
                          setBagInlineName(''); setBagInlineCreate(false); setShowBagPicker(false)
                        }
                      }}
                        style={{ padding: '3px 6px', borderRadius: 6, border: 'none', background: 'var(--text-primary)', color: 'var(--bg-primary)', cursor: 'pointer', display: 'flex', alignItems: 'center' }}>
                        <Plus size={11} />
                      </button>
                    </div>
                  ) : (
                    <button onClick={() => setBagInlineCreate(true)}
                      style={{ display: 'flex', alignItems: 'center', gap: 5, width: '100%', padding: '5px 6px', background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, fontFamily: 'inherit', color: 'var(--text-faint)', borderRadius: 7 }}
                      onMouseEnter={e => e.currentTarget.style.color = 'var(--text-secondary)'}
                      onMouseLeave={e => e.currentTarget.style.color = 'var(--text-faint)'}>
                      <Plus size={11} /> {t('packing.addBag')}
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {canEdit && (
      <div className="sm:opacity-0 sm:group-hover:opacity-100" style={{ display: 'flex', gap: 2, alignItems: 'center', transition: 'opacity 0.12s', flexShrink: 0 }}>
        <div style={{ position: 'relative' }}>
          <button
            onClick={() => setShowCatPicker(p => !p)}
            title={t('packing.changeCategory')}
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '3px 5px', borderRadius: 6, display: 'flex', alignItems: 'center', color: 'var(--text-faint)', fontSize: 10, gap: 2 }}
          >
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: katColor(item.category || t('packing.defaultCategory'), categories.map(c => c.name)), display: 'inline-block' }} />
          </button>
          {showCatPicker && (
            <div style={{
              position: 'absolute', right: 0, top: '100%', zIndex: 50, background: 'var(--bg-card)',
              border: '1px solid var(--border-primary)', borderRadius: 10, boxShadow: '0 4px 16px rgba(0,0,0,0.1)',
              padding: 4, minWidth: 160,
            }}>
              {categories.map(cat => (
                <button key={cat.id} onClick={() => handleCatChange(cat.id)} style={{
                  display: 'flex', alignItems: 'center', gap: 7, width: '100%',
                  padding: '6px 10px', background: cat.id === item.category_id ? 'var(--bg-tertiary)' : 'none',
                  border: 'none', cursor: 'pointer', fontSize: 12.5, fontFamily: 'inherit',
                  color: 'var(--text-secondary)', borderRadius: 7, textAlign: 'left',
                }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: katColor(cat.name, categories.map(c => c.name)), flexShrink: 0 }} />
                  {cat.name}
                  {cat.type === 'personal' && <Users size={10} style={{ color: 'var(--text-faint)', marginLeft: 'auto' }} />}
                  {cat.type === 'private' && <Lock size={10} style={{ color: 'var(--text-faint)', marginLeft: 'auto' }} />}
                </button>
              ))}
            </div>
          )}
        </div>

        <button onClick={() => setEditing(true)} title={t('common.rename')} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '3px 4px', borderRadius: 6, display: 'flex', color: 'var(--text-faint)' }}
          onMouseEnter={e => e.currentTarget.style.color = 'var(--text-secondary)'} onMouseLeave={e => e.currentTarget.style.color = 'var(--text-faint)'}>
          <Pencil size={13} />
        </button>

        <button onClick={handleDelete} title={t('common.delete')} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '3px 4px', borderRadius: 6, display: 'flex', color: 'var(--text-faint)' }}
          onMouseEnter={e => e.currentTarget.style.color = '#ef4444'} onMouseLeave={e => e.currentTarget.style.color = 'var(--text-faint)'}>
          <Trash2 size={13} />
        </button>
      </div>
      )}
    </div>
  )
}

// ── Kategorie-Gruppe ───────────────────────────────────────────────────────
interface TripMember {
  id: number
  username: string
  avatar?: string | null
  avatar_url?: string | null
}

interface CategoryAssignee {
  user_id: number
  username: string
  avatar?: string | null
}

interface KategorieGruppeProps {
  category: PackingCategory
  items: PackingItem[]
  tripId: number
  allCategories: PackingCategory[]
  onRename: (categoryId: number, newName: string) => Promise<void>
  onDeleteAll: (categoryId: number) => Promise<void>
  onChangeType: (categoryId: number, type: 'shared' | 'personal' | 'private') => Promise<void>
  onAddItem: (categoryId: number, name: string) => Promise<void>
  assignees: CategoryAssignee[]
  tripMembers: TripMember[]
  onSetAssignees: (categoryId: number, userIds: number[]) => Promise<void>
  bagTrackingEnabled?: boolean
  bags?: PackingBag[]
  onCreateBag: (name: string) => Promise<PackingBag | undefined>
  canEdit?: boolean
}

function KategorieGruppe({ category, items, tripId, allCategories, onRename, onDeleteAll, onChangeType, onAddItem, assignees, tripMembers, onSetAssignees, bagTrackingEnabled, bags, onCreateBag, canEdit = true }: KategorieGruppeProps) {
  const kategorie = category.name
  const [offen, setOffen] = useState(true)
  const [editingName, setEditingName] = useState(false)
  const [editKatName, setEditKatName] = useState(kategorie)
  const [showMenu, setShowMenu] = useState(false)
  const [showAssigneeDropdown, setShowAssigneeDropdown] = useState(false)
  const [showAddItem, setShowAddItem] = useState(false)
  const [newItemName, setNewItemName] = useState('')
  const addItemRef = useRef<HTMLInputElement>(null)
  const menuBtnRef = useRef<HTMLButtonElement>(null)
  const assigneeDropdownRef = useRef<HTMLDivElement>(null)
  const { togglePackingItem } = useTripStore()
  const toast = useToast()
  const { t } = useTranslation()
  useEffect(() => {
    if (!showAssigneeDropdown) return
    const handleClickOutside = (e: MouseEvent) => {
      if (assigneeDropdownRef.current && !assigneeDropdownRef.current.contains(e.target as Node)) {
        setShowAssigneeDropdown(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showAssigneeDropdown])

  const abgehakt = items.filter(i => i.checked).length
  const alleAbgehakt = abgehakt === items.length
  const dot = katColor(kategorie, allCategories.map(c => c.name))

  const handleSaveKatName = async () => {
    const neu = editKatName.trim()
    if (!neu || neu === kategorie) { setEditingName(false); setEditKatName(kategorie); return }
    try { await onRename(category.id, neu); setEditingName(false) }
    catch { toast.error(t('packing.toast.renameError')) }
  }

  const handleCheckAll = async () => {
    for (const item of Array.from(items)) {
      if (!item.checked) await togglePackingItem(tripId, item.id, true)
    }
  }
  const handleUncheckAll = async () => {
    for (const item of Array.from(items)) {
      if (item.checked) await togglePackingItem(tripId, item.id, false)
    }
  }
  const handleDeleteAll = async () => {
    await onDeleteAll(category.id)
    setShowMenu(false)
  }

  return (
    <div style={{ marginBottom: 6, background: 'var(--bg-card)', borderRadius: 14, border: '1px solid var(--border-secondary)', overflow: 'visible' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderBottom: offen ? '1px solid var(--border-secondary)' : 'none' }}>
        <button onClick={() => setOffen(o => !o)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex', color: 'var(--text-faint)', flexShrink: 0 }}>
          {offen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        </button>

        <span style={{ width: 10, height: 10, borderRadius: '50%', background: dot, flexShrink: 0 }} />

        {editingName && canEdit ? (
          <input
            autoFocus value={editKatName}
            onChange={e => setEditKatName(e.target.value)}
            onBlur={handleSaveKatName}
            onKeyDown={e => { if (e.key === 'Enter') handleSaveKatName(); if (e.key === 'Escape') { setEditingName(false); setEditKatName(kategorie) } }}
            style={{ flex: 1, fontSize: 12.5, fontWeight: 600, border: 'none', borderBottom: '2px solid var(--text-primary)', outline: 'none', background: 'transparent', fontFamily: 'inherit', color: 'var(--text-primary)', padding: '0 2px' }}
          />
        ) : (
          <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            {kategorie}
          </span>
        )}

        {/* Type pill */}
        <Tooltip label={t(`packing.type.${category.type}.hint`)} placement="top" align="start">
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 3,
            padding: '1px 6px', borderRadius: 99, fontSize: 10, fontWeight: 600, flexShrink: 0,
            background: category.type === 'shared' ? 'rgba(59,130,246,0.1)' : category.type === 'personal' ? 'rgba(168,85,247,0.1)' : 'rgba(239,68,68,0.1)',
            color: category.type === 'shared' ? '#3b82f6' : category.type === 'personal' ? '#a855f7' : '#ef4444',
          }}>
            {category.type === 'shared' && <Globe size={9} />}
            {category.type === 'personal' && <Users size={9} />}
            {category.type === 'private' && <Lock size={9} />}
            {t(`packing.type.${category.type}`).charAt(0).toUpperCase() + t(`packing.type.${category.type}`).slice(1)}
          </span>
        </Tooltip>

        {/* Assignee chips */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 3, flex: 1, minWidth: 0, marginLeft: 4 }}>
          {assignees.map(a => (
            <div key={a.user_id} style={{ position: 'relative' }}
              onClick={e => { e.stopPropagation(); if (canEdit) onSetAssignees(category.id, assignees.filter(x => x.user_id !== a.user_id).map(x => x.user_id)) }}
            >
              <div className="assignee-chip"
                style={{
                  width: 22, height: 22, borderRadius: '50%', flexShrink: 0, cursor: canEdit ? 'pointer' : 'default',
                  background: `hsl(${a.username.charCodeAt(0) * 37 % 360}, 55%, 55%)`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 10, fontWeight: 700, color: 'white', textTransform: 'uppercase',
                  border: '2px solid var(--bg-card)', transition: 'opacity 0.15s',
                }}
              >
                {a.username[0]}
              </div>
              <div className="assignee-tooltip" style={{
                position: 'absolute', top: '100%', left: '50%', transform: 'translateX(-50%)',
                marginTop: 6, padding: '3px 8px', borderRadius: 6, zIndex: 60,
                background: 'var(--text-primary)', color: 'var(--bg-primary)',
                fontSize: 10, fontWeight: 600, whiteSpace: 'nowrap',
                pointerEvents: 'none', opacity: 0, transition: 'opacity 0.15s',
              }}>
                {a.username}
              </div>
            </div>
          ))}
          {canEdit && (
          <div ref={assigneeDropdownRef} style={{ position: 'relative' }}>
            <button onClick={e => { e.stopPropagation(); setShowAssigneeDropdown(v => !v) }}
              style={{
                width: 20, height: 20, borderRadius: '50%', border: '1.5px dashed var(--border-primary)',
                background: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: 'var(--text-faint)', flexShrink: 0, padding: 0, transition: 'all 0.15s',
              }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--text-muted)'; e.currentTarget.style.color = 'var(--text-muted)' }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border-primary)'; e.currentTarget.style.color = 'var(--text-faint)' }}
            >
              <UserPlus size={10} />
            </button>
            {showAssigneeDropdown && (
              <div style={{
                position: 'absolute', left: 0, top: '100%', marginTop: 4, zIndex: 50,
                background: 'var(--bg-card)', border: '1px solid var(--border-primary)', borderRadius: 10,
                boxShadow: '0 4px 16px rgba(0,0,0,0.12)', padding: 4, minWidth: 160,
              }}>
                {tripMembers.map(m => {
                  const isAssigned = assignees.some(a => a.user_id === m.id)
                  return (
                    <button key={m.id} onClick={e => {
                      e.stopPropagation()
                      const newIds = isAssigned
                        ? assignees.filter(a => a.user_id !== m.id).map(a => a.user_id)
                        : [...assignees.map(a => a.user_id), m.id]
                      onSetAssignees(category.id, newIds)
                    }}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                        padding: '6px 10px', borderRadius: 8, border: 'none', cursor: 'pointer',
                        background: isAssigned ? 'var(--bg-hover)' : 'transparent',
                        fontFamily: 'inherit', fontSize: 12, color: 'var(--text-primary)',
                        transition: 'background 0.1s',
                      }}
                      onMouseEnter={e => { if (!isAssigned) e.currentTarget.style.background = 'var(--bg-tertiary)' }}
                      onMouseLeave={e => { if (!isAssigned) e.currentTarget.style.background = 'transparent' }}
                    >
                      <div style={{
                        width: 20, height: 20, borderRadius: '50%', flexShrink: 0,
                        background: `hsl(${m.username.charCodeAt(0) * 37 % 360}, 55%, 55%)`,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 10, fontWeight: 700, color: 'white', textTransform: 'uppercase',
                      }}>
                        {m.username[0]}
                      </div>
                      <span style={{ flex: 1 }}>{m.username}</span>
                      {isAssigned && <Check size={12} style={{ color: 'var(--text-muted)' }} />}
                    </button>
                  )
                })}
                {tripMembers.length === 0 && (
                  <div style={{ padding: '8px 10px', fontSize: 11, color: 'var(--text-faint)' }}>{t('packing.noMembers')}</div>
                )}
              </div>
            )}
          </div>
          )}
        </div>

        <span style={{
          fontSize: 11, fontWeight: 600, padding: '1px 8px', borderRadius: 99,
          background: alleAbgehakt ? 'rgba(22,163,74,0.12)' : 'var(--bg-tertiary)',
          color: alleAbgehakt ? '#16a34a' : 'var(--text-muted)',
        }}>
          {abgehakt}/{items.length}
        </span>

        <div style={{ position: 'relative' }}>
          <button ref={menuBtnRef} onClick={() => setShowMenu(m => !m)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px', borderRadius: 6, display: 'flex', color: 'var(--text-faint)' }}
            onMouseEnter={e => e.currentTarget.style.color = 'var(--text-secondary)'} onMouseLeave={e => e.currentTarget.style.color = 'var(--text-faint)'}>
            <MoreHorizontal size={15} />
          </button>
          {showMenu && (() => {
            const rect = menuBtnRef.current?.getBoundingClientRect();
            return (
            <>
              <div style={{ position: 'fixed', inset: 0, zIndex: 99 }} onClick={() => setShowMenu(false)} />
              <div style={{ position: 'fixed', right: rect ? window.innerWidth - rect.right : 0, top: rect ? rect.bottom + 4 : 0, zIndex: 100, background: 'var(--bg-card)', border: '1px solid var(--border-primary)', borderRadius: 10, boxShadow: '0 4px 16px rgba(0,0,0,0.1)', padding: 4, minWidth: 170 }}>
                {canEdit && <MenuItem icon={<Pencil size={13} />} label={t('packing.menuRename')} onClick={() => { setEditingName(true); setShowMenu(false) }} />}
                <MenuItem icon={<CheckCheck size={13} />} label={t('packing.menuCheckAll')} onClick={() => { handleCheckAll(); setShowMenu(false) }} />
                <MenuItem icon={<RotateCcw size={13} />} label={t('packing.menuUncheckAll')} onClick={() => { handleUncheckAll(); setShowMenu(false) }} />
                {canEdit && <>
                <div style={{ height: 1, background: 'var(--bg-tertiary)', margin: '4px 0' }} />
                {category.type !== 'shared' && <MenuItem icon={<Globe size={13} />} label={t('packing.type.makeShared')} onClick={() => { onChangeType(category.id, 'shared'); setShowMenu(false) }} />}
                {category.type !== 'personal' && <MenuItem icon={<Users size={13} />} label={t('packing.type.makePersonal')} onClick={() => { onChangeType(category.id, 'personal'); setShowMenu(false) }} />}
                {category.type !== 'private' && <MenuItem icon={<Lock size={13} />} label={t('packing.type.makePrivate')} onClick={() => { onChangeType(category.id, 'private'); setShowMenu(false) }} />}
                <div style={{ height: 1, background: 'var(--bg-tertiary)', margin: '4px 0' }} />
                <MenuItem icon={<Trash2 size={13} />} label={t('packing.menuDeleteCat')} danger onClick={handleDeleteAll} />
                </>}
              </div>
            </>
            );
          })()}
        </div>
      </div>

      {offen && (
        <div style={{ padding: '4px 4px 6px' }}>
          {items.map(item => (
            <ArtikelZeile key={item.id} item={item} tripId={tripId} categories={allCategories} onCategoryChange={() => {}} bagTrackingEnabled={bagTrackingEnabled} bags={bags} onCreateBag={onCreateBag} canEdit={canEdit} />
          ))}
          {/* Inline add item */}
          {canEdit && (showAddItem ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px' }}>
              <input
                ref={addItemRef}
                autoFocus
                value={newItemName}
                onChange={e => setNewItemName(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && newItemName.trim()) {
                    onAddItem(category.id, newItemName.trim())
                    setNewItemName('')
                    setTimeout(() => addItemRef.current?.focus(), 30)
                  }
                  if (e.key === 'Escape') { setShowAddItem(false); setNewItemName('') }
                }}
                placeholder={t('packing.addItemPlaceholder')}
                style={{ flex: 1, padding: '6px 10px', borderRadius: 8, border: '1px solid var(--border-primary)', fontSize: 12.5, fontFamily: 'inherit', outline: 'none', color: 'var(--text-primary)', background: 'var(--bg-input)' }}
              />
              <button onClick={() => { if (newItemName.trim()) { onAddItem(category.id, newItemName.trim()); setNewItemName(''); setTimeout(() => addItemRef.current?.focus(), 30) } }}
                disabled={!newItemName.trim()}
                style={{ padding: '5px 8px', borderRadius: 8, border: 'none', background: newItemName.trim() ? 'var(--text-primary)' : 'var(--border-primary)', color: 'var(--bg-primary)', cursor: newItemName.trim() ? 'pointer' : 'default', display: 'flex' }}>
                <Plus size={14} />
              </button>
              <button onClick={() => { setShowAddItem(false); setNewItemName('') }}
                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, display: 'flex', color: 'var(--text-faint)' }}>
                <X size={14} />
              </button>
            </div>
          ) : (
            <button onClick={() => { setShowAddItem(true); setTimeout(() => addItemRef.current?.focus(), 30) }}
              style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 10px', margin: '2px 4px', borderRadius: 8, border: 'none', background: 'none', cursor: 'pointer', fontSize: 12, color: 'var(--text-faint)', fontFamily: 'inherit' }}
              onMouseEnter={e => e.currentTarget.style.color = 'var(--text-secondary)'}
              onMouseLeave={e => e.currentTarget.style.color = 'var(--text-faint)'}>
              <Plus size={12} /> {t('packing.addItem')}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

interface MenuItemProps {
  icon: React.ReactNode
  label: string
  onClick: () => void
  danger?: boolean
}

function MenuItem({ icon, label, onClick, danger }: MenuItemProps) {
  return (
    <button onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: 8, width: '100%',
      padding: '7px 10px', background: 'none', border: 'none', cursor: 'pointer',
      fontSize: 12.5, fontFamily: 'inherit', borderRadius: 7, textAlign: 'left',
      color: danger ? '#ef4444' : 'var(--text-secondary)',
    }}
      onMouseEnter={e => e.currentTarget.style.background = danger ? '#fef2f2' : 'var(--bg-tertiary)'}
      onMouseLeave={e => e.currentTarget.style.background = 'none'}
    >
      {icon}{label}
    </button>
  )
}

// ── Haupt-Panel ────────────────────────────────────────────────────────────
interface PackingListPanelProps {
  tripId: number
  items: PackingItem[]
  openImportSignal?: number
  clearCheckedSignal?: number
  saveTemplateSignal?: number
  inlineHeader?: boolean
}

export default function PackingListPanel({ tripId, items, openImportSignal = 0, clearCheckedSignal = 0, saveTemplateSignal = 0, inlineHeader = true }: PackingListPanelProps) {
  const [filter, setFilter] = useState('alle') // 'alle' | 'offen' | 'erledigt'
  const [addingCategory, setAddingCategory] = useState(false)
  const [newCatName, setNewCatName] = useState('')
  const [newCatType, setNewCatType] = useState<'shared' | 'personal' | 'private'>('shared')
  const [categories, setCategories] = useState<PackingCategory[]>([])
  const { addPackingItem, deletePackingItem } = useTripStore()
  const can = useCanDo()
  const trip = useTripStore((s) => s.trip)
  const canEdit = can('packing_edit', trip)
  const toast = useToast()
  const { t } = useTranslation()

  // Trip members & category assignees (keyed by category_id).
  const [tripMembers, setTripMembers] = useState<TripMember[]>([])
  const [categoryAssignees, setCategoryAssignees] = useState<Record<number, CategoryAssignee[]>>({})

  useEffect(() => {
    tripsApi.getMembers(tripId).then(data => {
      const all: TripMember[] = []
      if (data.owner) all.push({ id: data.owner.id, username: data.owner.username, avatar: data.owner.avatar_url })
      if (data.members) all.push(...data.members.map((m: any) => ({ id: m.id, username: m.username, avatar: m.avatar_url })))
      setTripMembers(all)
    }).catch(() => {})
    packingApi.getCategoryAssignees(tripId).then(data => {
      setCategoryAssignees(data.assignees || {})
    }).catch(() => {})
    packingApi.listCategories(tripId).then(data => {
      setCategories(data.categories || [])
    }).catch(() => {})
  }, [tripId])

  // Resync when items reference categories we haven't loaded (e.g. after applyTemplate).
  useEffect(() => {
    const knownIds = new Set(categories.map(c => c.id))
    const hasUnknown = items.some(i => i.category_id != null && !knownIds.has(i.category_id))
    if (!hasUnknown) return
    packingApi.listCategories(tripId).then(data => {
      setCategories(data.categories || [])
    }).catch(() => {})
  }, [items, categories, tripId])

  const handleSetAssignees = async (categoryId: number, userIds: number[]) => {
    try {
      const data = await packingApi.setCategoryAssignees(tripId, categoryId, userIds)
      setCategoryAssignees(prev => ({ ...prev, [categoryId]: data.assignees || [] }))
    } catch {
      toast.error(t('packing.toast.saveError'))
    }
  }

  const allCategories = useMemo(() => {
    const map = new Map<number, PackingCategory>()
    for (const c of categories) map.set(c.id, c)
    for (const item of items) {
      if (item.category_id && !map.has(item.category_id)) {
        map.set(item.category_id, {
          id: item.category_id,
          trip_id: tripId,
          name: item.category || t('packing.defaultCategory'),
          type: item.category_type || 'shared',
          owner_user_id: item.category_owner_id ?? null,
          sort_order: 0,
        })
      }
    }
    return Array.from(map.values())
  }, [categories, items, tripId, t])

  const gruppiert = useMemo(() => {
    const filtered = items.filter(i => {
      if (filter === 'offen') return !i.checked
      if (filter === 'erledigt') return i.checked
      return true
    })
    const groups: Record<number, { category: PackingCategory; items: PackingItem[] }> = {}
    for (const item of filtered) {
      const catId = item.category_id ?? 0
      if (!groups[catId]) {
        const cat = allCategories.find(c => c.id === catId) ?? {
          id: catId, trip_id: tripId, name: item.category || t('packing.defaultCategory'),
          type: (item.category_type || 'shared') as 'shared' | 'personal' | 'private',
          owner_user_id: item.category_owner_id ?? null, sort_order: 0,
        }
        groups[catId] = { category: cat, items: [] }
      }
      groups[catId].items.push(item)
    }
    // Empty categories still need a row.
    for (const cat of allCategories) {
      if (!groups[cat.id]) groups[cat.id] = { category: cat, items: [] }
    }
    return groups
  }, [items, filter, allCategories, tripId, t])

  const abgehakt = items.filter(i => i.checked).length
  const fortschritt = items.length > 0 ? Math.round((abgehakt / items.length) * 100) : 0

  const handleAddItemToCategory = async (categoryId: number, name: string) => {
    try {
      await addPackingItem(tripId, { name, category_id: categoryId })
    } catch { toast.error(t('packing.toast.addError')) }
  }



  const handleAddNewCategory = async () => {
    if (!newCatName.trim()) return
    try {
      const data = await packingApi.createCategory(tripId, { name: newCatName.trim(), type: newCatType })
      setCategories(prev => [...prev, data.category])
      setNewCatName('')
      setAddingCategory(false)
      setNewCatType('shared')
    } catch (err: any) {
      const msg = err?.response?.status === 409 ? t('packing.categoryExists') : t('packing.toast.addError')
      toast.error(msg)
    }
  }

  // Upsert because categories created server-side (e.g. via applyTemplate) may not be in local state yet.
  const upsertCategory = (cat: PackingCategory) =>
    setCategories(prev => prev.some(c => c.id === cat.id) ? prev.map(c => c.id === cat.id ? cat : c) : [...prev, cat])

  const handleRenameCategory = async (categoryId: number, newName: string) => {
    try {
      const data = await packingApi.updateCategory(tripId, categoryId, { name: newName })
      upsertCategory(data.category)
    } catch { toast.error(t('packing.toast.renameError')) }
  }

  const handleDeleteCategory = async (categoryId: number) => {
    try {
      await packingApi.deleteCategory(tripId, categoryId)
      setCategories(prev => prev.filter(c => c.id !== categoryId))
      // Mirror the server-side cascade so items vanish without a refetch.
      useTripStore.setState(s => ({ packingItems: s.packingItems.filter(i => i.category_id !== categoryId) }))
    } catch { toast.error(t('packing.toast.deleteError')) }
  }

  const handleChangeType = async (categoryId: number, type: 'shared' | 'personal' | 'private') => {
    try {
      const data = await packingApi.updateCategory(tripId, categoryId, { type })
      upsertCategory(data.category)
      // Patch denormalised category_type/owner on items so the UI reflects the change without a refetch.
      useTripStore.setState(s => ({
        packingItems: s.packingItems.map(i => i.category_id === categoryId
          ? { ...i, category_type: data.category.type, category_owner_id: data.category.owner_user_id }
          : i),
      }))
    } catch { toast.error(t('common.error')) }
  }
  const handleClearChecked = async () => {
    if (!confirm(t('packing.confirm.clearChecked', { count: abgehakt }))) return
    for (const item of items.filter(i => i.checked)) {
      try { await deletePackingItem(tripId, item.id) } catch {}
    }
  }

  // Bag tracking
  const [bagTrackingEnabled, setBagTrackingEnabled] = useState(false)
  const [bags, setBags] = useState<PackingBag[]>([])
  const [newBagName, setNewBagName] = useState('')
  const [showAddBag, setShowAddBag] = useState(false)
  const [showBagModal, setShowBagModal] = useState(false)

  useEffect(() => {
    adminApi.getBagTracking().then(d => {
      setBagTrackingEnabled(d.enabled)
      if (d.enabled) packingApi.listBags(tripId).then(r => setBags(r.bags || [])).catch(() => {})
    }).catch(() => {})
  }, [tripId])

  const BAG_COLORS = ['#6366f1', '#ec4899', '#f97316', '#10b981', '#06b6d4', '#8b5cf6', '#ef4444', '#f59e0b']

  const handleCreateBag = async () => {
    if (!newBagName.trim()) return
    try {
      const data = await packingApi.createBag(tripId, { name: newBagName.trim(), color: BAG_COLORS[bags.length % BAG_COLORS.length] })
      setBags(prev => [...prev, data.bag])
      setNewBagName(''); setShowAddBag(false)
    } catch { toast.error(t('packing.toast.saveError')) }
  }

  const handleCreateBagByName = async (name: string): Promise<PackingBag | undefined> => {
    try {
      const data = await packingApi.createBag(tripId, { name, color: BAG_COLORS[bags.length % BAG_COLORS.length] })
      setBags(prev => [...prev, data.bag])
      return data.bag
    } catch { toast.error(t('packing.toast.saveError')); return undefined }
  }

  const handleDeleteBag = async (bagId: number) => {
    try {
      await packingApi.deleteBag(tripId, bagId)
      setBags(prev => prev.filter(b => b.id !== bagId))
    } catch { toast.error(t('packing.toast.deleteError')) }
  }

  const handleUpdateBag = async (bagId: number, data: Record<string, any>) => {
    try {
      const result = await packingApi.updateBag(tripId, bagId, data)
      setBags(prev => prev.map(b => b.id === bagId ? { ...b, ...result.bag } : b))
    } catch { toast.error(t('common.error')) }
  }

  const handleSetBagMembers = async (bagId: number, userIds: number[]) => {
    try {
      const result = await packingApi.setBagMembers(tripId, bagId, userIds)
      setBags(prev => prev.map(b => b.id === bagId ? { ...b, members: result.members } : b))
    } catch { toast.error(t('common.error')) }
  }

  // Templates
  const [availableTemplates, setAvailableTemplates] = useState<{ id: number; name: string; item_count: number }[]>([])
  const [showTemplateDropdown, setShowTemplateDropdown] = useState(false)
  const [applyingTemplate, setApplyingTemplate] = useState(false)
  const [showSaveTemplate, setShowSaveTemplate] = useState(false)
  const [saveTemplateName, setSaveTemplateName] = useState('')
  const [showImportModal, setShowImportModal] = useState(false)
  const [importText, setImportText] = useState('')
  const lastHandledImportSignal = useRef(openImportSignal)
  const lastHandledClearSignal = useRef(clearCheckedSignal)
  const lastHandledSaveSignal = useRef(saveTemplateSignal)

  useEffect(() => {
    if (openImportSignal !== lastHandledImportSignal.current && openImportSignal > 0) {
      setShowImportModal(true)
    }
    lastHandledImportSignal.current = openImportSignal
  }, [openImportSignal])

  useEffect(() => {
    if (clearCheckedSignal !== lastHandledClearSignal.current && clearCheckedSignal > 0) {
      handleClearChecked()
    }
    lastHandledClearSignal.current = clearCheckedSignal
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearCheckedSignal])

  useEffect(() => {
    if (saveTemplateSignal !== lastHandledSaveSignal.current && saveTemplateSignal > 0) {
      setShowSaveTemplate(true)
    }
    lastHandledSaveSignal.current = saveTemplateSignal
  }, [saveTemplateSignal])
  const csvInputRef = useRef<HTMLInputElement>(null)
  const templateDropdownRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    adminApi.packingTemplates().then(d => setAvailableTemplates(d.templates || [])).catch(() => {})
  }, [tripId])

  useEffect(() => {
    if (!showTemplateDropdown) return
    const handler = (e: MouseEvent) => {
      if (templateDropdownRef.current && !templateDropdownRef.current.contains(e.target as Node)) setShowTemplateDropdown(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showTemplateDropdown])

  const handleApplyTemplate = async (templateId: number) => {
    setApplyingTemplate(true)
    try {
      const data = await packingApi.applyTemplate(tripId, templateId)
      useTripStore.setState(s => ({ packingItems: [...s.packingItems, ...(data.items || [])] }))
      toast.success(t('packing.templateApplied', { count: data.count }))
      setShowTemplateDropdown(false)
    } catch {
      toast.error(t('packing.templateError'))
    } finally {
      setApplyingTemplate(false)
    }
  }

  const handleSaveAsTemplate = async () => {
    if (!saveTemplateName.trim()) return
    try {
      await packingApi.saveAsTemplate(tripId, saveTemplateName.trim())
      toast.success(t('packing.templateSaved'))
      setShowSaveTemplate(false)
      setSaveTemplateName('')
      adminApi.packingTemplates().then(d => setAvailableTemplates(d.templates || [])).catch(() => {})
    } catch {
      toast.error(t('common.error'))
    }
  }

  // Parse CSV line respecting quoted values (e.g. "Shirt, blue" stays as one field)
  const parseCsvLine = (line: string): string[] => {
    const parts: string[] = []
    let current = ''
    let inQuotes = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (ch === '"') { inQuotes = !inQuotes; continue }
      if (!inQuotes && (ch === ',' || ch === ';' || ch === '\t')) { parts.push(current.trim()); current = ''; continue }
      current += ch
    }
    parts.push(current.trim())
    return parts
  }

  const parseImportLines = (text: string) => {
    return text.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
      // Format: Category, Name, Weight (optional), Bag (optional), checked/unchecked (optional)
      const parts = parseCsvLine(line)
      if (parts.length >= 2) {
        const category = parts[0]
        const name = parts[1]
        const weight_grams = parts[2] || undefined
        const bag = parts[3] || undefined
        const checked = parts[4]?.toLowerCase() === 'checked' || parts[4] === '1'
        return { name, category, weight_grams, bag, checked }
      }
      // Single value = just a name
      return { name: parts[0], category: undefined, weight_grams: undefined, bag: undefined, checked: false }
    }).filter(i => i.name)
  }

  const handleBulkImport = async () => {
    const parsed = parseImportLines(importText)
    if (parsed.length === 0) { toast.error(t('packing.importEmpty')); return }
    try {
      const result = await packingApi.bulkImport(tripId, parsed)
      useTripStore.setState(s => ({ packingItems: [...s.packingItems, ...(result.items || [])] }))
      toast.success(t('packing.importSuccess', { count: result.count }))
      setImportText('')
      setShowImportModal(false)
    } catch { toast.error(t('packing.importError')) }
  }

  const handleCsvFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    const reader = new FileReader()
    reader.onload = () => { if (typeof reader.result === 'string') setImportText(reader.result) }
    reader.readAsText(file)
  }

  const font = { fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif" }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', ...font }}>

      {/* ── Header ── */}
      <div style={{ padding: inlineHeader ? '20px 24px 16px' : '0 0 16px', flexShrink: 0, borderBottom: inlineHeader ? '1px solid rgba(0,0,0,0.06)' : undefined }}>
        <div style={{ display: 'flex', alignItems: inlineHeader ? 'flex-start' : 'center', justifyContent: 'space-between', gap: 14 }}>
          {inlineHeader ? (
            <div>
              <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }}>{t('packing.title')}</h2>
              {items.length > 0 && (
                <p style={{ margin: '2px 0 0', fontSize: 12.5, color: 'var(--text-faint)' }}>
                  {t('packing.progress', { packed: abgehakt, total: items.length, percent: fortschritt })}
                </p>
              )}
            </div>
          ) : <span />}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            {canEdit && items.length > 0 && showSaveTemplate && (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <input
                    type="text" autoFocus
                    value={saveTemplateName}
                    onChange={e => setSaveTemplateName(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleSaveAsTemplate(); if (e.key === 'Escape') { setShowSaveTemplate(false); setSaveTemplateName('') } }}
                    placeholder={t('packing.templateName')}
                    style={{ fontSize: 12, padding: '5px 10px', borderRadius: 99, border: '1px solid var(--border-primary)', outline: 'none', fontFamily: 'inherit', width: 140, background: 'var(--bg-card)', color: 'var(--text-primary)' }}
                  />
                  <button onClick={handleSaveAsTemplate} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: '#10b981' }}><Check size={14} /></button>
                  <button onClick={() => { setShowSaveTemplate(false); setSaveTemplateName('') }} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: 'var(--text-faint)' }}><X size={14} /></button>
                </div>
                <span style={{ fontSize: 10.5, color: 'var(--text-faint)', paddingRight: 4 }}>
                  {t('packing.saveAsTemplate.hint')}
                </span>
              </div>
            )}
            {inlineHeader && canEdit && (
              <button onClick={() => setShowImportModal(true)} style={{
                display: 'flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: 99,
                border: '1px solid var(--border-primary)', fontSize: 12, fontWeight: 500, cursor: 'pointer',
                fontFamily: 'inherit', background: 'var(--bg-card)', color: 'var(--text-muted)',
              }}>
                <Upload size={12} /> <span className="hidden sm:inline">{t('packing.import')}</span>
              </button>
            )}
            {inlineHeader && canEdit && abgehakt > 0 && (
              <button onClick={handleClearChecked} style={{
                fontSize: 11.5, padding: '5px 10px', borderRadius: 99, border: '1px solid rgba(239,68,68,0.3)',
                background: 'rgba(239,68,68,0.1)', color: '#ef4444', cursor: 'pointer', fontFamily: 'inherit',
              }}>
                <span className="hidden sm:inline">{t('packing.clearChecked', { count: abgehakt })}</span>
                <span className="sm:hidden">{t('packing.clearCheckedShort', { count: abgehakt })}</span>
              </button>
            )}
            {inlineHeader && canEdit && availableTemplates.length > 0 && (
              <div ref={templateDropdownRef} style={{ position: 'relative' }}>
                <button onClick={() => setShowTemplateDropdown(v => !v)} disabled={applyingTemplate} style={{
                  display: 'flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: 99,
                  border: '1px solid', fontSize: 12, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit',
                  background: showTemplateDropdown ? 'var(--text-primary)' : 'var(--bg-card)',
                  borderColor: showTemplateDropdown ? 'var(--text-primary)' : 'var(--border-primary)',
                  color: showTemplateDropdown ? 'var(--bg-primary)' : 'var(--text-muted)',
                }}>
                  <Package size={12} /> <span className="hidden sm:inline">{t('packing.applyTemplate')}</span><span className="sm:hidden">{t('packing.template')}</span>
                </button>
                {showTemplateDropdown && (
                  <div style={{
                    position: 'absolute', right: 0, top: '100%', marginTop: 6, zIndex: 50,
                    background: 'var(--bg-card)', border: '1px solid var(--border-primary)', borderRadius: 10,
                    boxShadow: '0 4px 16px rgba(0,0,0,0.12)', padding: 4, minWidth: 200,
                  }}>
                    {availableTemplates.map(tmpl => (
                      <button key={tmpl.id} onClick={() => handleApplyTemplate(tmpl.id)}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                          padding: '8px 12px', borderRadius: 8, border: 'none', cursor: 'pointer',
                          background: 'transparent', fontFamily: 'inherit', fontSize: 12, color: 'var(--text-primary)',
                          transition: 'background 0.1s',
                        }}
                        onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-tertiary)'}
                        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                      >
                        <Package size={13} style={{ color: 'var(--text-faint)' }} />
                        <div style={{ flex: 1, textAlign: 'left' }}>
                          <div style={{ fontWeight: 600 }}>{tmpl.name}</div>
                          <div style={{ fontSize: 10, color: 'var(--text-faint)' }}>{tmpl.item_count} {t('admin.packingTemplates.items')}</div>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {inlineHeader && canEdit && items.length > 0 && !showSaveTemplate && (
              <button onClick={() => setShowSaveTemplate(true)} style={{
                display: 'flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: 99,
                border: '1px solid var(--border-primary)', fontSize: 12, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit',
                background: 'var(--bg-card)', color: 'var(--text-muted)',
              }}>
                <FolderPlus size={12} /> <span className="hidden sm:inline">{t('packing.saveAsTemplate')}</span>
              </button>
            )}
            {bagTrackingEnabled && (
              <button onClick={() => setShowBagModal(true)} className="xl:!hidden"
                style={{
                  display: 'flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: 99,
                  border: '1px solid', fontSize: 12, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit',
                  background: showBagModal ? 'var(--text-primary)' : 'var(--bg-card)',
                  borderColor: showBagModal ? 'var(--text-primary)' : 'var(--border-primary)',
                  color: showBagModal ? 'var(--bg-primary)' : 'var(--text-muted)',
                }}>
                <Luggage size={12} /> {t('packing.bags')}
              </button>
            )}
          </div>
        </div>

          {items.length > 0 && (
          <div className="hidden sm:block" style={{ marginTop: 14, marginBottom: 14 }}>
            <div className="flex items-center" style={{ gap: 14 }}>
              {fortschritt === 100 ? (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  fontSize: 16, fontWeight: 700, color: '#10b981',
                  letterSpacing: '-0.01em', flexShrink: 0,
                }}>
                  <CheckCheck size={18} strokeWidth={2.5} />
                  <span>{t('packing.allPacked')}</span>
                </div>
              ) : (
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexShrink: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline' }}>
                    <span style={{
                      fontSize: 22, fontWeight: 700, color: 'var(--text-primary)',
                      fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.02em',
                      lineHeight: 1,
                    }}>{abgehakt}</span>
                    <span style={{
                      fontSize: 14, fontWeight: 500, color: 'var(--text-faint)',
                      fontVariantNumeric: 'tabular-nums', lineHeight: 1, marginLeft: 1,
                    }}>/{items.length}</span>
                  </div>
                  <span style={{
                    fontSize: 11, fontWeight: 600, padding: '2px 7px',
                    borderRadius: 99, background: 'var(--bg-tertiary)',
                    color: 'var(--text-muted)',
                    fontVariantNumeric: 'tabular-nums',
                    lineHeight: 1.4,
                  }}>{fortschritt}%</span>
                </div>
              )}

              <div style={{
                flex: 1,
                height: 8,
                background: 'var(--bg-tertiary)',
                borderRadius: 99,
                overflow: 'hidden',
                position: 'relative',
                width: '100%',
              }}>
                <div style={{
                  height: '100%',
                  borderRadius: 99,
                  transition: 'width 600ms cubic-bezier(0.23, 1, 0.32, 1), background 400ms ease, box-shadow 400ms ease',
                  background: fortschritt === 100
                    ? 'linear-gradient(90deg, #10b981 0%, #34d399 100%)'
                    : 'var(--accent)',
                  width: `${fortschritt}%`,
                  boxShadow: fortschritt === 100 ? '0 0 14px rgba(16,185,129,0.45)' : 'none',
                  position: 'relative',
                }}>
                  <div style={{
                    position: 'absolute', inset: 0,
                    background: 'linear-gradient(180deg, rgba(255,255,255,0.22) 0%, rgba(255,255,255,0) 55%)',
                    borderRadius: 99,
                    pointerEvents: 'none',
                  }} />
                </div>
              </div>
            </div>
          </div>
        )}

        {canEdit && (addingCategory ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                autoFocus
                type="text" value={newCatName} onChange={e => setNewCatName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleAddNewCategory(); if (e.key === 'Escape') { setAddingCategory(false); setNewCatName(''); setNewCatType('shared') } }}
                placeholder={t('packing.newCategoryPlaceholder')}
                style={{ flex: 1, padding: '8px 12px', borderRadius: 10, border: '1px solid var(--border-primary)', fontSize: 13.5, fontFamily: 'inherit', outline: 'none', color: 'var(--text-primary)' }}
              />
              <button onClick={handleAddNewCategory} disabled={!newCatName.trim()}
                style={{ padding: '8px 12px', borderRadius: 10, border: 'none', background: newCatName.trim() ? 'var(--text-primary)' : 'var(--border-primary)', color: 'var(--bg-primary)', cursor: newCatName.trim() ? 'pointer' : 'default', display: 'flex', alignItems: 'center' }}>
                <Check size={16} />
              </button>
              <button onClick={() => { setAddingCategory(false); setNewCatName(''); setNewCatType('shared') }}
                style={{ padding: '8px 12px', borderRadius: 10, border: '1px solid var(--border-primary)', background: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', color: 'var(--text-faint)' }}>
                <X size={16} />
              </button>
            </div>
            <div style={{ display: 'flex', gap: 4 }}>
              {(['shared', 'personal', 'private'] as const).map(type => (
                <Tooltip key={type} label={t(`packing.type.${type}.hint`)} placement="bottom" align="start">
                  <button onClick={() => setNewCatType(type)} style={{
                    display: 'flex', alignItems: 'center', gap: 5, padding: '4px 10px', borderRadius: 8,
                    border: `1px solid ${newCatType === type ? 'var(--text-primary)' : 'var(--border-primary)'}`,
                    background: newCatType === type ? 'var(--text-primary)' : 'none',
                    color: newCatType === type ? 'var(--bg-primary)' : 'var(--text-faint)',
                    cursor: 'pointer', fontSize: 11.5, fontFamily: 'inherit', fontWeight: newCatType === type ? 600 : 400,
                  }}>
                    {type === 'shared' && <Globe size={11} />}
                    {type === 'personal' && <Users size={11} />}
                    {type === 'private' && <Lock size={11} />}
                    {t(`packing.type.${type}`).charAt(0).toUpperCase() + t(`packing.type.${type}`).slice(1)}
                  </button>
                </Tooltip>
              ))}
            </div>
          </div>
        ) : (
          <button onClick={() => setAddingCategory(true)}
            style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', padding: '9px 14px', borderRadius: 10, border: '1px dashed var(--border-primary)', background: 'none', cursor: 'pointer', fontSize: 13, color: 'var(--text-faint)', fontFamily: 'inherit', transition: 'all 0.15s' }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--text-muted)'; e.currentTarget.style.color = 'var(--text-secondary)' }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border-primary)'; e.currentTarget.style.color = 'var(--text-faint)' }}>
            <FolderPlus size={14} /> {t('packing.addCategory')}
          </button>
        ))}
      </div>

      {/* ── Filter-Tabs ── */}
      {items.length > 0 && (
        <div style={{ display: 'flex', gap: 4, padding: '10px 0 0', flexShrink: 0 }}>
          {[['alle', t('packing.filterAll')], ['offen', t('packing.filterOpen')], ['erledigt', t('packing.filterDone')]].map(([id, label]) => (
            <button key={id} onClick={() => setFilter(id)} style={{
              padding: '4px 12px', borderRadius: 99, border: 'none', cursor: 'pointer',
              fontSize: 12, fontFamily: 'inherit', fontWeight: filter === id ? 600 : 400,
              background: filter === id ? 'var(--text-primary)' : 'transparent',
              color: filter === id ? 'var(--bg-primary)' : 'var(--text-muted)',
            }}>{label}</button>
          ))}
        </div>
      )}

      {/* ── Liste + Bags Sidebar ── */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
      <div style={{ flex: 1, overflowY: 'auto', padding: '10px 0 16px' }}>
        {items.length === 0 && Object.keys(gruppiert).length === 0 ? (
          <div style={{ textAlign: 'center', padding: '60px 20px' }}>
            <Luggage size={40} style={{ color: 'var(--text-faint)', display: 'block', margin: '0 auto 10px' }} />
            <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-secondary)', margin: '0 0 4px' }}>{t('packing.emptyTitle')}</p>
            <p style={{ fontSize: 13, color: 'var(--text-faint)', margin: 0 }}>{t('packing.emptyHint')}</p>
          </div>
        ) : Object.values(gruppiert).every(g => g.items.length === 0) && filter !== 'alle' ? (
          <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--text-faint)' }}>
            <p style={{ fontSize: 13, margin: 0 }}>{t('packing.emptyFiltered')}</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {Object.values(gruppiert).map(({ category: cat, items: katItems }) => (
              <KategorieGruppe
                key={cat.id}
                category={cat}
                items={katItems}
                tripId={tripId}
                allCategories={allCategories}
                onRename={handleRenameCategory}
                onDeleteAll={handleDeleteCategory}
                onChangeType={handleChangeType}
                onAddItem={handleAddItemToCategory}
                assignees={categoryAssignees[cat.id] || []}
                tripMembers={tripMembers}
                onSetAssignees={handleSetAssignees}
                bagTrackingEnabled={bagTrackingEnabled}
                bags={bags}
                onCreateBag={handleCreateBagByName}
                canEdit={canEdit}
              />
            ))}
          </div>
        )}
      </div>

      {/* ── Bag Weight Sidebar ── */}
      {bagTrackingEnabled && bags.length > 0 && (
        <div className="hidden xl:block" style={{ width: 260, borderLeft: '1px solid var(--border-secondary)', overflowY: 'auto', padding: 16, flexShrink: 0 }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-faint)', marginBottom: 12 }}>
            {t('packing.bags')}
          </div>

          {bags.map(bag => {
            const bagItems = items.filter(i => i.bag_id === bag.id)
            const totalWeight = bagItems.reduce((sum, i) => sum + (i.weight_grams || 0), 0)
            const maxWeight = bag.weight_limit_grams || Math.max(...bags.map(b => items.filter(i => i.bag_id === b.id).reduce((s, i) => s + (i.weight_grams || 0), 0)), 1)
            const pct = Math.min(100, Math.round((totalWeight / maxWeight) * 100))
            return (
              <BagCard key={bag.id} bag={bag} bagItems={bagItems} totalWeight={totalWeight} pct={pct} tripId={tripId} tripMembers={tripMembers} canEdit={canEdit} onDelete={() => handleDeleteBag(bag.id)} onUpdate={handleUpdateBag} onSetMembers={handleSetBagMembers} t={t} compact />
            )
          })}

          {/* Unassigned */}
          {(() => {
            const unassigned = items.filter(i => !i.bag_id)
            const unassignedWeight = unassigned.reduce((s, i) => s + (i.weight_grams || 0), 0)
            if (unassigned.length === 0) return null
            return (
              <div style={{ marginBottom: 14, opacity: 0.6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  <span style={{ width: 10, height: 10, borderRadius: '50%', border: '2px dashed var(--border-primary)', flexShrink: 0 }} />
                  <span style={{ flex: 1, fontSize: 12, fontWeight: 600, color: 'var(--text-faint)' }}>{t('packing.noBag')}</span>
                  <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>
                    {unassignedWeight >= 1000 ? `${(unassignedWeight / 1000).toFixed(1)} kg` : `${unassignedWeight} g`}
                  </span>
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-faint)' }}>{unassigned.length} {t('admin.packingTemplates.items')}</div>
              </div>
            )
          })()}

          {/* Total */}
          <div style={{ borderTop: '1px solid var(--border-secondary)', paddingTop: 10, marginTop: 6 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' }}>
              <span>{t('packing.totalWeight')}</span>
              <span>{(() => { const w = items.reduce((s, i) => s + (i.weight_grams || 0), 0); return w >= 1000 ? `${(w / 1000).toFixed(1)} kg` : `${w} g` })()}</span>
            </div>
          </div>

          {/* Add bag */}
          {canEdit && (showAddBag ? (
            <div style={{ display: 'flex', gap: 4, marginTop: 12 }}>
              <input autoFocus value={newBagName} onChange={e => setNewBagName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleCreateBag(); if (e.key === 'Escape') { setShowAddBag(false); setNewBagName('') } }}
                placeholder={t('packing.bagName')}
                style={{ flex: 1, padding: '5px 8px', borderRadius: 8, border: '1px solid var(--border-primary)', fontSize: 11, fontFamily: 'inherit', outline: 'none' }} />
              <button onClick={handleCreateBag} style={{ padding: '4px 8px', borderRadius: 8, border: 'none', background: 'var(--text-primary)', color: 'var(--bg-primary)', cursor: 'pointer', display: 'flex', alignItems: 'center' }}>
                <Plus size={12} />
              </button>
            </div>
          ) : (
            <button onClick={() => setShowAddBag(true)}
              style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 12, padding: '5px 8px', borderRadius: 8, border: '1px dashed var(--border-primary)', background: 'none', cursor: 'pointer', fontSize: 11, color: 'var(--text-faint)', fontFamily: 'inherit', width: '100%' }}>
              <Plus size={11} /> {t('packing.addBag')}
            </button>
          ))}
        </div>
      )}
      </div>

      {/* ── Bag Modal (mobile + click) ── */}
      {showBagModal && bagTrackingEnabled && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(0,0,0,0.3)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: 20, paddingTop: 140, paddingBottom: 'calc(20px + var(--bottom-nav-h))', overflowY: 'auto' }}
          onClick={() => setShowBagModal(false)}>
          <div style={{ background: 'var(--bg-card)', borderRadius: 16, width: '100%', maxWidth: 360, maxHeight: 'calc(100vh - 80px)', overflow: 'auto', padding: 20, boxShadow: '0 16px 48px rgba(0,0,0,0.15)', flexShrink: 0 }}
            onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>{t('packing.bags')}</h3>
              <button onClick={() => setShowBagModal(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-faint)', display: 'flex' }}><X size={18} /></button>
            </div>

            {bags.map(bag => {
              const bagItems = items.filter(i => i.bag_id === bag.id)
              const totalWeight = bagItems.reduce((sum, i) => sum + (i.weight_grams || 0), 0)
              const maxWeight = Math.max(...bags.map(b => items.filter(i => i.bag_id === b.id).reduce((s, i) => s + (i.weight_grams || 0), 0)), 1)
              const pct = Math.min(100, Math.round((totalWeight / maxWeight) * 100))
              return (
                <BagCard key={bag.id} bag={bag} bagItems={bagItems} totalWeight={totalWeight} pct={pct} tripId={tripId} tripMembers={tripMembers} canEdit={canEdit} onDelete={() => handleDeleteBag(bag.id)} onUpdate={handleUpdateBag} onSetMembers={handleSetBagMembers} t={t} />
              )
            })}

            {/* Unassigned */}
            {(() => {
              const unassigned = items.filter(i => !i.bag_id)
              const unassignedWeight = unassigned.reduce((s, i) => s + (i.weight_grams || 0), 0)
              if (unassigned.length === 0) return null
              return (
                <div style={{ marginBottom: 16, opacity: 0.6 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <span style={{ width: 12, height: 12, borderRadius: '50%', border: '2px dashed var(--border-primary)', flexShrink: 0 }} />
                    <span style={{ flex: 1, fontSize: 14, fontWeight: 600, color: 'var(--text-faint)' }}>{t('packing.noBag')}</span>
                    <span style={{ fontSize: 13, color: 'var(--text-faint)' }}>
                      {unassignedWeight >= 1000 ? `${(unassignedWeight / 1000).toFixed(1)} kg` : `${unassignedWeight} g`}
                    </span>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>{unassigned.length} {t('admin.packingTemplates.items')}</div>
                </div>
              )
            })()}

            {/* Total */}
            <div style={{ borderTop: '1px solid var(--border-secondary)', paddingTop: 12, marginTop: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>
                <span>{t('packing.totalWeight')}</span>
                <span>{(() => { const w = items.reduce((s, i) => s + (i.weight_grams || 0), 0); return w >= 1000 ? `${(w / 1000).toFixed(1)} kg` : `${w} g` })()}</span>
              </div>
            </div>

            {/* Add bag */}
            {canEdit && (showAddBag ? (
              <div style={{ display: 'flex', gap: 6, marginTop: 14 }}>
                <input autoFocus value={newBagName} onChange={e => setNewBagName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleCreateBag(); if (e.key === 'Escape') { setShowAddBag(false); setNewBagName('') } }}
                  placeholder={t('packing.bagName')}
                  style={{ flex: 1, padding: '8px 12px', borderRadius: 10, border: '1px solid var(--border-primary)', fontSize: 13, fontFamily: 'inherit', outline: 'none' }} />
                <button onClick={handleCreateBag} disabled={!newBagName.trim()}
                  style={{ padding: '8px 12px', borderRadius: 10, border: 'none', background: newBagName.trim() ? 'var(--text-primary)' : 'var(--border-primary)', color: 'var(--bg-primary)', cursor: newBagName.trim() ? 'pointer' : 'default', display: 'flex', alignItems: 'center' }}>
                  <Plus size={14} />
                </button>
              </div>
            ) : (
              <button onClick={() => setShowAddBag(true)}
                style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 14, padding: '9px 14px', borderRadius: 10, border: '1px dashed var(--border-primary)', background: 'none', cursor: 'pointer', fontSize: 13, color: 'var(--text-faint)', fontFamily: 'inherit', width: '100%', transition: 'all 0.15s' }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--text-muted)'; e.currentTarget.style.color = 'var(--text-secondary)' }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border-primary)'; e.currentTarget.style.color = 'var(--text-faint)' }}>
                <Plus size={14} /> {t('packing.addBag')}
              </button>
            ))}
          </div>
        </div>
      )}

      <style>{`
        .assignee-chip:hover + .assignee-tooltip { opacity: 1 !important; }
        .assignee-chip:hover { opacity: 0.7; }
      `}</style>

      {/* Bulk Import Modal */}
      {showImportModal && ReactDOM.createPortal(
        <div style={{
          position: 'fixed', inset: 0, zIndex: 1000,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(0,0,0,0.3)', backdropFilter: 'blur(3px)',
        }} onClick={() => setShowImportModal(false)}>
          <div style={{
            width: 420, maxHeight: '80vh', background: 'var(--bg-card)', borderRadius: 16,
            boxShadow: '0 16px 48px rgba(0,0,0,0.22)', padding: '22px 22px 18px',
            display: 'flex', flexDirection: 'column', gap: 14,
          }} onClick={e => e.stopPropagation()}>
            <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>{t('packing.importTitle')}</div>
            <div style={{ fontSize: 12, color: 'var(--text-faint)', lineHeight: 1.5 }}>{t('packing.importHint')}</div>
            <div style={{ display: 'flex', border: '1px solid var(--border-primary)', borderRadius: 10, overflow: 'hidden', background: 'var(--bg-input)' }}>
              <div style={{
                padding: '10px 0', fontSize: 13, fontFamily: 'monospace', lineHeight: 1.5,
                color: 'var(--text-faint)', textAlign: 'right', userSelect: 'none',
                background: 'var(--bg-hover)', borderRight: '1px solid var(--border-faint)',
                minWidth: 32, flexShrink: 0,
              }}>
                {(importText || ' ').split('\n').map((_, i) => (
                  <div key={i} style={{ padding: '0 6px' }}>{i + 1}</div>
                ))}
              </div>
              <textarea
                value={importText}
                onChange={e => setImportText(e.target.value)}
                rows={10}
                placeholder={t('packing.importPlaceholder')}
                style={{
                  flex: 1, border: 'none', padding: '10px 12px', fontSize: 13, fontFamily: 'monospace',
                  outline: 'none', boxSizing: 'border-box', color: 'var(--text-primary)',
                  background: 'transparent', resize: 'vertical', lineHeight: 1.5,
                }}
              />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <input ref={csvInputRef} type="file" accept=".csv,.txt" style={{ display: 'none' }} onChange={handleCsvFile} />
                <button onClick={() => csvInputRef.current?.click()} style={{
                  display: 'flex', alignItems: 'center', gap: 5, padding: '5px 10px',
                  border: '1px dashed var(--border-primary)', borderRadius: 8, background: 'none',
                  fontSize: 11, color: 'var(--text-faint)', cursor: 'pointer', fontFamily: 'inherit',
                }}>
                  <Upload size={11} /> {t('packing.importCsv')}
                </button>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => setShowImportModal(false)} style={{
                  fontSize: 12, background: 'none', border: '1px solid var(--border-primary)',
                  borderRadius: 8, padding: '6px 14px', cursor: 'pointer', color: 'var(--text-muted)', fontFamily: 'inherit',
                }}>{t('common.cancel')}</button>
                <button onClick={handleBulkImport} disabled={!importText.trim()} style={{
                  fontSize: 12, background: 'var(--accent)', color: 'var(--accent-text)',
                  border: 'none', borderRadius: 8, padding: '6px 16px', cursor: 'pointer', fontWeight: 600,
                  fontFamily: 'inherit', opacity: importText.trim() ? 1 : 0.5,
                }}>{t('packing.importAction', { count: parseImportLines(importText).length })}</button>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
