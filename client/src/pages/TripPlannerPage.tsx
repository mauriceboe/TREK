import React, { useState, Suspense } from 'react'
import { createPortal } from 'react-dom'
import { useParams, useNavigate, useSearchParams } from 'react-router'
import { useTripStore } from '../store/tripStore'
import { useCanDo } from '../store/permissionsStore'
import { useSettingsStore } from '../store/settingsStore'
import { MapViewAuto as MapView } from '../components/Map/MapViewAuto'
import { MapCompassPill, type CompassMap } from '../components/Map/MapCompassPill'
import { getCached, fetchPhoto } from '../services/photoService'
import DayPlanSidebar from '../components/Planner/DayPlanSidebar'
import TripLoadingSplash from '../components/shared/TripLoadingSplash'
import PlacesSidebar from '../components/Planner/PlacesSidebar'
import PlaceInspector from '../components/Planner/PlaceInspector'
import DayDetailPanel from '../components/Planner/DayDetailPanel'
import PlaceFormModal from '../components/Planner/PlaceFormModal'
import TripFormModal from '../components/Trips/TripFormModal'
import SlidingTabs from '../components/shared/SlidingTabs'
import TripMembersModal from '../components/Trips/TripMembersModal'
import { ReservationModal } from '../components/Planner/ReservationModal'
import TransitJourneyModal from '../components/Planner/TransitJourneyModal'
import BookingImportModal from '../components/Planner/BookingImportModal'
import AirTrailImportModal from '../components/Planner/AirTrailImportModal'
// MemoriesPanel moved to Journey addon
import ApplyTemplateButton from '../components/Packing/ApplyTemplateButton'
import type { ExpensePrefill } from '../components/Budget/CostsPanel'
import type { BookingExpenseRequest } from '../components/Planner/BookingCostsSection.types'
import type { BudgetItem } from '../types'
import PluginFrame from '../components/Plugins/PluginFrame'
import ErrorBoundary from '../components/shared/ErrorBoundary'
import { lazyWithRetry } from '../utils/lazyWithRetry'
import { getDayBookendHotels } from '../utils/dayOrder'
import TripWarningsBanner from '../components/Planner/TripWarningsBanner'
import Navbar from '../components/Layout/Navbar'
import { useToast } from '../components/shared/Toast'
import { Map, X, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Ticket, PackageCheck, Wallet, FolderOpen, Users, Train } from 'lucide-react'
import { useTranslation } from '../i18n'
import { addonsApi, accommodationsApi, authApi, tripsApi, assignmentsApi, mapsApi } from '../api/client'
import { accommodationRepo } from '../repo/accommodationRepo'
import { useAuthStore } from '../store/authStore'
import ConfirmDialog from '../components/shared/ConfirmDialog'
import { useTripWebSocket } from '../hooks/useTripWebSocket'
import { useRouteCalculation } from '../hooks/useRouteCalculation'
import { usePlaceSelection } from '../hooks/usePlaceSelection'
import { usePlannerHistory } from '../hooks/usePlannerHistory'
import type { Accommodation, TripMember, Day, Place, Reservation, PackingItem, TodoItem } from '../types'
import { ListTodo, Download, Plus, Trash2, FolderPlus } from 'lucide-react'
import { useTripPlanner } from './tripPlanner/useTripPlanner'
import { usePoiExplore } from '../components/Map/usePoiExplore'
import PoiCategoryPill from '../components/Map/PoiCategoryPill'
import { useTouchDragBridge } from '../hooks/useTouchDragBridge'

// The tab panels are the planner's dead weight: each one mounts only while its
// own tab is active, so the page chunk carried code most sessions never run. They
// load on demand now, through the same lazyWithRetry the route chunks use.
//
// PluginFrame stays static on purpose: DayDetailPanel and PlaceInspector import it
// too and both belong to the plan tab, so splitting it here would move nothing.
const ReservationsPanel = lazyWithRetry(() => import('../components/Planner/ReservationsPanel'))
const PackingListPanel = lazyWithRetry(() => import('../components/Packing/PackingListPanel'))
const TodoListPanel = lazyWithRetry(() => import('../components/Todo/TodoListPanel'))
const FileManager = lazyWithRetry(() => import('../components/Files/FileManager'))
const CostsPanel = lazyWithRetry(() => import('../components/Budget/CostsPanel'))
// Named export, so it needs the extra hop. Importing it statically would keep the
// whole CostsPanel module in the page chunk and undo the split above.
const ExpenseModal = lazyWithRetry(() =>
  import('../components/Budget/CostsPanel').then(m => ({ default: m.ExpenseModal }))
)
const CollabPanel = lazyWithRetry(() => import('../components/Collab/CollabPanel'))
// Already rendered conditionally, so lazy bites immediately. Worth it beyond its
// own 63 kB: it is the only path to TransitSearchPanel, which drags in tz-lookup
// — about 200 kB of packed zone geometry that every trip used to load.
const TransportModal = lazyWithRetry(() =>
  import('../components/Planner/TransportModal').then(m => ({ default: m.TransportModal }))
)

/**
 * One tab panel, with its own net.
 *
 * The boundary sits outside the Suspense, not inside: Suspense owns the pending
 * promise, a rejected one throws straight past it. And it has to be per panel —
 * a single boundary around the whole content area would already be mounted with
 * the visible tab, so switching tabs would swap the entire planner for the
 * placeholder instead of just the part that is still loading.
 *
 * No label: ErrorBoundary lets label win over the panel level and would title a
 * broken packing list "This plugin could not be shown".
 */
function LazyPanel({ id, children }: { id: string; children: React.ReactNode }): React.ReactElement {
  return (
    <ErrorBoundary boundaryId={`planner-panel:${id}`}>
      <Suspense fallback={<div className="h-full w-full min-h-[180px] rounded-xl bg-surface-secondary animate-pulse" />}>
        {children}
      </Suspense>
    </ErrorBoundary>
  )
}

function ListsContainer({ tripId, packingItems, todoItems }: { tripId: number; packingItems: PackingItem[]; todoItems: TodoItem[] }) {
  const [subTab, setSubTab] = useState<'packing' | 'todo'>(() => {
    return (sessionStorage.getItem(`trip-lists-subtab-${tripId}`) as 'packing' | 'todo') || 'packing'
  })
  const setSubTabPersist = (tab: 'packing' | 'todo') => { setSubTab(tab); sessionStorage.setItem(`trip-lists-subtab-${tripId}`, tab) }
  const [importPackingSignal, setImportPackingSignal] = useState(0)
  const [clearCheckedSignal, setClearCheckedSignal] = useState(0)
  const [saveTemplateSignal, setSaveTemplateSignal] = useState(0)
  const [addTodoSignal, setAddTodoSignal] = useState(0)
  const [packingView, setPackingView] = useState<'common' | 'personal'>('common')
  const { t } = useTranslation()
  const isAdmin = useAuthStore(s => s.user?.role === 'admin')

  const tabs = [
    { id: 'packing' as const, label: t('todo.subtab.packing'), icon: PackageCheck, count: packingItems.length },
    { id: 'todo' as const, label: t('todo.subtab.todo'), icon: ListTodo, count: todoItems.length },
  ]

  return (
    <div>
      <div style={{ padding: '24px 28px 0' }} className="max-md:!px-4 max-md:!pt-4">
        <div className="bg-surface-tertiary" style={{
          borderRadius: 18,
          padding: '14px 16px 14px 22px',
          display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap',
        }}>
          <h2 className="text-content" style={{ margin: 0, fontSize: 'calc(18px * var(--fs-scale-subtitle, 1))', fontWeight: 600, letterSpacing: '-0.01em', flexShrink: 0 }}>
            {t('trip.tabs.lists')}
          </h2>
          <div className="hidden md:block bg-edge-faint" style={{ width: 1, height: 22, flexShrink: 0 }} />
          <div style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap', flex: 1, minWidth: 0 }}>
            {tabs.map(tab => {
              const active = subTab === tab.id
              const Icon = tab.icon
              return (
                <button type="button" key={tab.id} onClick={() => setSubTabPersist(tab.id)}
                  className={active ? 'bg-surface-card text-content' : 'bg-transparent text-content-muted'}
                  style={{
                    appearance: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    padding: '6px 12px', borderRadius: 99, fontSize: 'calc(13px * var(--fs-scale-body, 1))', whiteSpace: 'nowrap',
                    fontWeight: active ? 500 : 400,
                    boxShadow: active ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
                    transition: 'background 180ms cubic-bezier(0.23,1,0.32,1), color 180ms cubic-bezier(0.23,1,0.32,1), box-shadow 180ms cubic-bezier(0.23,1,0.32,1)',
                  }}
                >
                  <Icon size={13} className={active ? 'text-content' : 'text-content-faint'} />
                  <span className="hidden sm:inline">{tab.label}</span>
                  <span className={`text-content-faint ${active ? 'bg-surface-tertiary' : 'bg-[rgba(0,0,0,0.06)]'}`} style={{
                    fontSize: 'calc(10px * var(--fs-scale-caption, 1))', fontWeight: 600,
                    padding: '1px 6px', borderRadius: 99, minWidth: 16, textAlign: 'center',
                  }}>{tab.count}</span>
                </button>
              )
            })}
          </div>

          {subTab === 'packing' && (() => {
            const packingAbgehakt = packingItems.filter(i => i.checked).length
            const sharedBtnClass = 'inline-flex items-center gap-1.5 px-2.5 sm:px-[14px] py-[7px] sm:py-[9px] hover:opacity-[0.88]'
            const sharedBtnStyle: React.CSSProperties = {
              appearance: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
              borderRadius: 10, fontSize: 'calc(13px * var(--fs-scale-body, 1))', fontWeight: 500,
            }
            return (
              <div style={{ display: 'flex', gap: 6, flexShrink: 0, marginLeft: 'auto', flexWrap: 'wrap' }}>
                {packingAbgehakt > 0 && (
                  <button type="button" onClick={() => setClearCheckedSignal(s => s + 1)}
                    className={`hidden sm:inline-flex items-center gap-1.5 px-[14px] py-[9px] hover:opacity-[0.88] bg-[rgba(239,68,68,0.14)] text-[#ef4444]`}
                    style={sharedBtnStyle}
                  >
                    <Trash2 size={14} strokeWidth={2.5} />
                    <span>{t('packing.clearChecked', { count: packingAbgehakt })}</span>
                  </button>
                )}
                <ApplyTemplateButton
                  tripId={tripId}
                  visibility={packingView}
                  className={`${sharedBtnClass} bg-accent text-accent-text`}
                  style={sharedBtnStyle}
                />
                {isAdmin && packingItems.length > 0 && (
                  <button type="button" onClick={() => setSaveTemplateSignal(s => s + 1)}
                    className={`${sharedBtnClass} bg-accent text-accent-text`}
                    style={sharedBtnStyle}
                  >
                    <FolderPlus size={14} strokeWidth={2.5} />
                    <span className="hidden sm:inline">{t('packing.saveAsTemplate')}</span>
                  </button>
                )}
                <button type="button" onClick={() => setImportPackingSignal(s => s + 1)}
                  className={`${sharedBtnClass} bg-accent text-accent-text`}
                  style={sharedBtnStyle}
                >
                  <Download size={14} strokeWidth={2.5} />
                  <span className="hidden sm:inline">{t('packing.import')}</span>
                </button>
              </div>
            )
          })()}
          {subTab === 'todo' && (
            <button type="button" onClick={() => setAddTodoSignal(s => s + 1)}
              className="hover:opacity-[0.88] bg-accent text-accent-text"
              style={{
                appearance: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '9px 14px', borderRadius: 10, fontSize: 'calc(13px * var(--fs-scale-body, 1))', fontWeight: 500,
                flexShrink: 0,
                marginLeft: 'auto',
              }}
            >
              <Plus size={14} strokeWidth={2.5} />
              <span className="hidden sm:inline">{t('todo.addItem')}</span>
            </button>
          )}
        </div>
      </div>
      <div style={{ padding: '16px 28px 0' }} className="max-md:!px-4">
        {subTab === 'packing' && (
          <LazyPanel id="packing">
            <PackingListPanel tripId={tripId} items={packingItems} openImportSignal={importPackingSignal} clearCheckedSignal={clearCheckedSignal} saveTemplateSignal={saveTemplateSignal} inlineHeader={false} view={packingView} onViewChange={setPackingView} />
          </LazyPanel>
        )}
        {subTab === 'todo' && (
          <LazyPanel id="todo">
            <TodoListPanel tripId={tripId} items={todoItems} addItemSignal={addTodoSignal} />
          </LazyPanel>
        )}
      </div>
    </div>
  )
}

export default function TripPlannerPage(): React.ReactElement | null {
  // ViewportRoute in App.tsx picks the branch now, so the phone screen is a
  // chunk of its own instead of a dead limb in this one.
  return <TripPlannerPageDesktop />
}

function TripPlannerPageDesktop(): React.ReactElement | null {
  // Page = wiring container: the entire planner state machine (store, tabs,
  // selection, CRUD handlers with undo, map filters, splash) lives in the hook.
  const {
    tripId, navigate, toast, t, language, placesPhotosEnabled,
    trip, days, places, assignments, packingItems, todoItems, categories, reservations, budgetItems, files,
    selectedDayId, isLoading, tripActions, can, canUploadFiles,
    pushUndo, undo, canUndo, lastActionLabel, handleUndo,
    enabledAddons, collabFeatures, tripAccommodations, setTripAccommodations,
    allowedFileTypes, tripMembers, setTripMembers, refreshMembers, loadAccommodations,
    TRANSPORT_TYPES, TRIP_TABS, activeTab, setActiveTab, handleTabChange,
    leftWidth, rightWidth,
    leftHidden, rightHidden, toggleLeft, toggleRight, narrowPanels,
    startResizeLeft, startResizeRight,
    selectedPlaceId, selectedAssignmentId, setSelectedPlaceId, selectAssignment,
    showDayDetail, setShowDayDetail, dayDetailCollapsed, setDayDetailCollapsed,
    showPlaceForm, setShowPlaceForm, editingPlace, setEditingPlace,
    prefillCoords, setPrefillCoords, editingAssignmentId, setEditingAssignmentId,
    showTripForm, setShowTripForm, showMembersModal, setShowMembersModal,
    showReservationModal, setShowReservationModal, editingReservation, setEditingReservation,
    showBookingImport, setShowBookingImport, bookingImportKind, setBookingImportKind, bookingImportAvailable,
    airTrailAvailable, showAirTrailImport, setShowAirTrailImport,
    bookingForAssignmentId, setBookingForAssignmentId,
    showTransportModal, setShowTransportModal, editingTransport, setEditingTransport,
    transportModalDayId, setTransportModalDayId,
    transportModalAutomated, setTransportModalAutomated, transitPrefill, setTransitPrefill, transitJourney, setTransitJourney,
    reservationPrefill, transportPrefill, importReviewActive, advanceImportReview,
    routeShown, setRouteShown, transitRoutesShown, routeProfile, setRouteProfile, routeVias, fitKey, setFitKey,
    mobileSidebarOpen, setMobileSidebarOpen, mobilePlanScrollTopRef, mobilePlacesScrollTopRef,
    deletePlaceId, setDeletePlaceId, deletePlaceIds, setDeletePlaceIds,
    visibleConnections, toggleConnection, allConnectionsShown, toggleAllConnections, mapTransportDetail, setMapTransportDetail,
    isMobile, isTouch,
    expandedDayIds, setExpandedDayIds, mapPlaces,
    route, routeSegments, routeInfo, setRoute, setRouteInfo, updateRouteForDay,
    handleSelectDay, handlePlaceClick, handleMarkerClick, handleMapClick, handleMapContextMenu, openAddPlaceFromPoi,
    handleSavePlace, openPlaceEditor, handleDeletePlace, confirmDeletePlace, confirmDeletePlaces, confirmChangeCategory,
    handleAssignToDay, handleRemoveAssignment, handleReorder, handleReorderDays, handleAddDay, handleUpdateDayTitle,
    handleSaveReservation, handleSaveTransport, handleDeleteReservation,
    selectedPlace, dayOrderMap, dayPlaces,
    mapTileUrl, fontStyle, splashDone,
  } = useTripPlanner()

  // Tablets run this very layout but cannot start an HTML5 drag with a finger,
  // so a long press stands in for one (#1616). Only where the pointer is
  // coarse — a hybrid laptop loads drag-drop-touch instead.
  useTouchDragBridge(isTouch && !isMobile)

  // The place inspector's booking strip opens the editor the booking belongs to.
  // Handed over as undefined when the right is missing, so the strip stays a
  // read-only summary rather than a button that does nothing (#2012).
  const openLinkedTransport = can('day_edit', trip) ? (reservation: Reservation) => {
    setEditingTransport(reservation)
    setTransportModalDayId(reservation.day_id ?? null)
    setTransportModalAutomated(false)
    setShowTransportModal(true)
    setMobileSidebarOpen(null)
  } : undefined
  const openLinkedReservation = can('reservation_edit', trip) ? (reservation: Reservation) => {
    setEditingReservation(reservation)
    setShowReservationModal(true)
    setMobileSidebarOpen(null)
  } : undefined

  const poi = usePoiExplore()
  const [glMap, setGlMap] = useState<CompassMap | null>(null)
  const poiPillEnabled = useSettingsStore(s => s.settings.map_poi_pill_enabled) !== false

  // Costs expense editor opened from a booking modal (save-then-open). Lives at the
  // page level so it has tripMembers / base currency / current user available.
  const meId = useAuthStore(s => s.user?.id ?? -1)
  const displayCurrency = useSettingsStore(s => s.settings.default_currency)
  const costsBase = (displayCurrency || trip?.currency || 'EUR').toUpperCase()
  // Transit search departs against a real date, so the whole Automated mode —
  // the day-header tram button and the modal's mode switch — is off without one.
  const tripHasDates = Boolean(trip?.start_date && trip?.end_date)
  const loadBudgetItems = useTripStore(s => s.loadBudgetItems)
  const [bookingExpense, setBookingExpense] = useState<{ editing: BudgetItem | null; prefill?: ExpensePrefill } | null>(null)
  const openBookingExpense = (req: BookingExpenseRequest) => {
    if (req.editItem) setBookingExpense({ editing: req.editItem })
    else if (req.prefill) setBookingExpense({ editing: null, prefill: req.prefill })
  }

  if (isLoading || !splashDone) {
    return (
      <div className="bg-surface" style={{
        minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        ...fontStyle,
      }}>
        <TripLoadingSplash title={trip?.title} />
      </div>
    )
  }
  if (!trip) return null

  // What each panel actually occupies right now, and where that leaves the
  // strip of map between them. The panels float 10px inside the map, so the
  // corridor starts past that margin.
  const leftPanelPx = leftHidden ? 0 : leftWidth
  const rightPanelPx = rightHidden ? 0 : rightWidth
  const mapInsetLeft = leftPanelPx ? leftPanelPx + 10 : 0
  const mapInsetRight = rightPanelPx ? rightPanelPx + 10 : 0

  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', ...fontStyle }}>
      <Navbar tripTitle={trip.title} tripId={tripId} showBack onBack={() => navigate('/dashboard')} onShare={() => setShowMembersModal(true)} />

      <div className="bg-surface-elevated border-b border-edge-faint" style={{
        position: 'fixed', top: 'var(--nav-h)', left: 0, right: 0, zIndex: 40,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '0 12px',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        height: 44,
      }}>
        <SlidingTabs
          tabs={TRIP_TABS.map(tab => ({
            id: tab.id,
            label: <span className="hidden sm:inline">{tab.shortLabel || tab.label}</span>,
            title: tab.label,
            icon: tab.icon,
          }))}
          activeTab={activeTab}
          onChange={handleTabChange}
        />
      </div>

      {/* Offset by navbar + tab bar (44px) */}
      <div style={{ position: 'fixed', top: 'calc(var(--nav-h) + 44px)', left: 0, right: 0, bottom: 0, overflow: 'hidden', overscrollBehavior: 'contain' }}>

        {/* Plugin validation/warning contributions (#1429) — navbar chips for
            plugins with a tab here, floating bottom overlay for the rest. */}
        <TripWarningsBanner tripId={tripId} onOpenPluginTab={(pid) => handleTabChange(`plugin:${pid}`)} />

        {activeTab === 'plan' && (
          <div style={{ position: 'absolute', inset: 0 }}>
            <MapView
              tripId={tripId}
              places={mapPlaces}
              dayPlaces={dayPlaces}
              route={route}
              routeVias={routeVias}
              showTransitRoutes={transitRoutesShown}
              // The route toggle belongs to one day, so the map needs that day to
              // know which automated transports may ride it (#2019).
              days={days}
              selectedDayId={selectedDayId}
              routeSegments={routeSegments}
              selectedPlaceId={selectedPlaceId}
              onMarkerClick={handleMarkerClick}
              onMapClick={handleMapClick}
              onMapContextMenu={handleMapContextMenu}
              // No center/zoom: the map frames itself on the trip's places at mount, and
              // falls back to the world view when the trip has none.
              tileUrl={mapTileUrl}
              fitKey={fitKey}
              dayOrderMap={dayOrderMap}
              leftWidth={leftPanelPx}
              rightWidth={rightPanelPx}
              hasInspector={!!selectedPlace}
              hasDayDetail={!!showDayDetail && !selectedPlace}
              reservations={reservations}
              showReservationStats={true}
              visibleConnectionIds={visibleConnections}
              onReservationClick={(rid) => {
                const r = reservations.find(x => x.id === rid)
                if (r) setMapTransportDetail(r)
              }}
              pois={poi.pois}
              onPoiClick={openAddPlaceFromPoi}
              onViewportChange={poi.onViewportChange}
              onMapReady={setGlMap}
            />

            {(poiPillEnabled || glMap) && (
              <div className="hidden md:flex" style={{
                position: 'absolute', top: 14,
                // Centred on the corridor the panels leave, not on the viewport: at
                // 860px the viewport centre sits under the Places panel, where this
                // cluster covered both collapse tabs and Add Place/Activity (#2247).
                left: `calc(${mapInsetLeft}px + (100% - ${mapInsetLeft}px - ${mapInsetRight}px) / 2)`,
                transform: 'translateX(-50%)', zIndex: 25, pointerEvents: 'none', alignItems: 'flex-start', gap: 8,
              }}>
                {poiPillEnabled && (
                  <PoiCategoryPill active={poi.active} onToggle={poi.toggle} loadingKeys={poi.loadingKeys} errorKeys={poi.errorKeys} moved={poi.moved} onSearchArea={poi.searchArea} />
                )}
                {glMap && <MapCompassPill map={glMap} />}
              </div>
            )}

            {/* Mobile: the compass/reset-orientation control lives centre-top on its own
                (the desktop cluster above is hidden below md), between the edge Plan/Places tabs. */}
            {glMap && (
              <div className="flex md:hidden" style={{ position: 'absolute', top: 14, left: '50%', transform: 'translateX(-50%)', zIndex: 25, pointerEvents: 'none' }}>
                <MapCompassPill map={glMap} />
              </div>
            )}

            {/* Mobile POI search controls live in a portal like the Plan/Places
                buttons so map touch handlers cannot swallow the tap targets. */}
            {poiPillEnabled && !mobileSidebarOpen && !showPlaceForm && !showMembersModal && !showReservationModal && createPortal(
              <div data-testid="mobile-poi-category-pill" className="flex md:hidden" style={{ position: 'fixed', left: 12, right: 12, bottom: 'calc(var(--bottom-nav-h, 0px) + 12px)', justifyContent: 'center', zIndex: 100, pointerEvents: 'none' }}>
                <PoiCategoryPill active={poi.active} onToggle={poi.toggle} loadingKeys={poi.loadingKeys} errorKeys={poi.errorKeys} moved={poi.moved} onSearchArea={poi.searchArea} />
              </div>,
              document.body
            )}

            <div className="hidden md:block" style={{ position: 'absolute', left: 10, top: 10, bottom: 10, zIndex: 20 }}>
              <button type="button" onClick={toggleLeft}
                aria-label={leftHidden ? t('trip.mobilePlan') : t('common.collapse')}
                title={leftHidden ? t('trip.mobilePlan') : t('common.collapse')}
                style={{
                  position: leftHidden ? 'fixed' : 'absolute', top: leftHidden ? 'calc(var(--nav-h) + 44px + 14px)' : 14, left: leftHidden ? 10 : undefined, right: leftHidden ? undefined : -28, zIndex: -1,
                  width: 36, height: 36, borderRadius: leftHidden ? 10 : '0 10px 10px 0',
                  background: leftHidden ? '#000' : 'var(--sidebar-bg)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
                  boxShadow: leftHidden ? '0 2px 12px rgba(0,0,0,0.2)' : 'none', border: 'none',
                  cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: leftHidden ? '#fff' : 'var(--text-faint)', transition: 'color 0.15s',
                }}
                onMouseEnter={e => { if (!leftHidden) e.currentTarget.style.color = 'var(--text-primary)' }}
                onMouseLeave={e => { if (!leftHidden) e.currentTarget.style.color = 'var(--text-faint)' }}>
                {leftHidden ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
              </button>

              <div style={{
                width: leftHidden ? 0 : leftWidth, height: '100%',
                background: 'var(--sidebar-bg)',
                backdropFilter: 'blur(24px) saturate(180%)',
                WebkitBackdropFilter: 'blur(24px) saturate(180%)',
                boxShadow: leftHidden ? 'none' : 'var(--sidebar-shadow)',
                borderRadius: 16,
                overflow: 'hidden', display: 'flex', flexDirection: 'column',
                transition: 'width 0.25s ease',
                opacity: leftHidden ? 0 : 1,
              }}>
                <DayPlanSidebar
                  isMobile={isMobile}
                  tripId={tripId}
                  trip={trip}
                  days={days}
                  places={places}
                  categories={categories}
                  assignments={assignments}
                  selectedDayId={selectedDayId}
                  selectedPlaceId={selectedPlaceId}
                  selectedAssignmentId={selectedAssignmentId}
                  onSelectDay={handleSelectDay}
                  onPlaceClick={handlePlaceClick}
                  onReorder={handleReorder}
                  onReorderDays={handleReorderDays}
                  onAddDay={handleAddDay}
                  onUpdateDayTitle={handleUpdateDayTitle}
                  onAssignToDay={handleAssignToDay}
                  onRouteCalculated={(r) => { if (r) { setRoute([r.coordinates]); setRouteInfo(r) } else { setRoute(null); setRouteInfo(null) } }}
                  reservations={reservations}
                  visibleConnectionIds={visibleConnections}
                  onToggleConnection={toggleConnection}
                  allConnectionsShown={allConnectionsShown}
                  onToggleAllConnections={toggleAllConnections}
                  externalTransportDetail={mapTransportDetail}
                  onExternalTransportDetailHandled={() => setMapTransportDetail(null)}
                  onAddReservation={(dayId) => { setEditingReservation(null); tripActions.setSelectedDay(dayId); setShowReservationModal(true) }}
                  onAddTransport={can('day_edit', trip) ? (dayId) => { setTransportModalDayId(dayId); setEditingTransport(null); setTransitPrefill(null); setTransportModalAutomated(false); setShowTransportModal(true) } : undefined}
                  onOpenTransit={(r) => setTransitJourney(r)}
                  onPlanTransit={can('day_edit', trip) && tripHasDates ? (dayId) => { setTransportModalDayId(dayId); setEditingTransport(null); setTransitPrefill(null); setTransportModalAutomated(true); setShowTransportModal(true) } : undefined}
                  onPlanTransitLeg={can('day_edit', trip) && tripHasDates ? ({ dayId, from, to, time }) => { setTransportModalDayId(dayId); setEditingTransport(null); setTransitPrefill({ from, to, time }); setTransportModalAutomated(true); setShowTransportModal(true) } : undefined}
                  onEditTransport={can('day_edit', trip) ? (reservation) => { setEditingTransport(reservation); setTransportModalDayId(reservation.day_id ?? null); setShowTransportModal(true) } : undefined}
                  onEditReservation={can('reservation_edit', trip) ? (r) => { setEditingReservation(r); setShowReservationModal(true) } : undefined}
                  onDayDetail={(day) => { setShowDayDetail(day); setSelectedPlaceId(null); selectAssignment(null) }}
                  onRemoveAssignment={handleRemoveAssignment}
                  onEditPlace={(place, assignmentId) => { setEditingPlace(place); setEditingAssignmentId(assignmentId || null); setShowPlaceForm(true) }}
                  onDeletePlace={(placeId) => handleDeletePlace(placeId)}
                  accommodations={tripAccommodations}
                  routeShown={routeShown}
                  routeProfile={routeProfile}
                  onToggleRoute={() => setRouteShown(v => !v)}
                  onSetRouteProfile={setRouteProfile}
                  onNavigateToFiles={() => handleTabChange('dateien')}
                  onExpandedDaysChange={setExpandedDayIds}
                  pushUndo={pushUndo}
                  canUndo={canUndo}
                  lastActionLabel={lastActionLabel}
                  onUndo={handleUndo}
                  onRouteRefresh={() => { if (selectedDayId) updateRouteForDay(selectedDayId) }}
                  onAddBookingToAssignment={can('day_edit', trip) ? (dayId, assignmentId) => { tripActions.setSelectedDay(dayId); setBookingForAssignmentId(assignmentId); setEditingReservation(null); setShowReservationModal(true) } : undefined}
                />
                {!leftHidden && !narrowPanels && (
                  <div
                    role="presentation"
                    onMouseDown={startResizeLeft}
                    style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 4, cursor: 'col-resize', background: 'transparent' }}
                    onMouseEnter={e => e.currentTarget.style.background = 'rgba(0,0,0,0.08)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                  />
                )}
              </div>
            </div>

            <div className="hidden md:block" style={{ position: 'absolute', right: 10, top: 10, bottom: 10, zIndex: 20 }}>
              <button type="button" onClick={toggleRight}
                aria-label={rightHidden ? t('trip.mobilePlaces') : t('common.collapse')}
                title={rightHidden ? t('trip.mobilePlaces') : t('common.collapse')}
                style={{
                  position: rightHidden ? 'fixed' : 'absolute', top: rightHidden ? 'calc(var(--nav-h) + 44px + 14px)' : 14, right: rightHidden ? 10 : undefined, left: rightHidden ? undefined : -28, zIndex: -1,
                  width: 36, height: 36, borderRadius: rightHidden ? 10 : '10px 0 0 10px',
                  background: rightHidden ? '#000' : 'var(--sidebar-bg)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
                  boxShadow: rightHidden ? '0 2px 12px rgba(0,0,0,0.2)' : 'none', border: 'none',
                  cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: rightHidden ? '#fff' : 'var(--text-faint)', transition: 'color 0.15s',
                }}
                onMouseEnter={e => { if (!rightHidden) e.currentTarget.style.color = 'var(--text-primary)' }}
                onMouseLeave={e => { if (!rightHidden) e.currentTarget.style.color = 'var(--text-faint)' }}>
                {rightHidden ? <PanelRightOpen size={16} /> : <PanelRightClose size={16} />}
              </button>

              <div style={{
                width: rightHidden ? 0 : rightWidth, height: '100%',
                background: 'var(--sidebar-bg)',
                backdropFilter: 'blur(24px) saturate(180%)',
                WebkitBackdropFilter: 'blur(24px) saturate(180%)',
                boxShadow: rightHidden ? 'none' : 'var(--sidebar-shadow)',
                borderRadius: 16,
                overflow: 'hidden', display: 'flex', flexDirection: 'column',
                transition: 'width 0.25s ease',
                opacity: rightHidden ? 0 : 1,
              }}>
                {!rightHidden && !narrowPanels && (
                  <div
                    role="presentation"
                    onMouseDown={startResizeRight}
                    style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 4, cursor: 'col-resize', background: 'transparent' }}
                    onMouseEnter={e => e.currentTarget.style.background = 'rgba(0,0,0,0.08)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                  />
                )}
                <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', paddingLeft: 4 }}>
                  <PlacesSidebar
                    tripId={tripId}
                    places={places}
                    categories={categories}
                    assignments={assignments}
                    accommodations={tripAccommodations}
                    selectedDayId={selectedDayId}
                    selectedPlaceId={selectedPlaceId}
                    onPlaceClick={handlePlaceClick}
                    onAddPlace={() => { setEditingPlace(null); setShowPlaceForm(true) }}
                    onAssignToDay={handleAssignToDay}
                    onEditPlace={(place) => openPlaceEditor(place)}
                    onDeletePlace={(placeId) => handleDeletePlace(placeId)}
                    onBulkDeletePlaces={(ids) => setDeletePlaceIds(ids)}
                    onBulkChangeCategory={(ids, catId) => confirmChangeCategory(ids, catId)}
                    pushUndo={pushUndo}
                    days={days}
                    isMobile={false}
                  />
                </div>
              </div>
            </div>

            {/* Mobile sidebar buttons — portal to body to escape Leaflet touch handling */}
            {activeTab === 'plan' && !mobileSidebarOpen && !showPlaceForm && !showMembersModal && !showReservationModal && createPortal(
              <div className="flex md:hidden" style={{ position: 'fixed', top: 'calc(var(--nav-h) + 44px + 12px)', left: 12, right: 12, justifyContent: 'space-between', zIndex: 100, pointerEvents: 'none' }}>
                <button type="button" onClick={() => setMobileSidebarOpen('left')}
                  className="bg-surface-card text-content border border-edge"
                  style={{ pointerEvents: 'auto', backdropFilter: 'blur(12px)', borderRadius: 24, padding: '11px 24px', fontSize: 'calc(15px * var(--fs-scale-subtitle, 1))', fontWeight: 600, cursor: 'pointer', boxShadow: '0 2px 12px rgba(0,0,0,0.15)', minHeight: 44, fontFamily: 'inherit', touchAction: 'manipulation' }}>
                  {t('trip.mobilePlan')}
                </button>
                <button type="button" onClick={() => setMobileSidebarOpen('right')}
                  className="bg-surface-card text-content border border-edge"
                  style={{ pointerEvents: 'auto', backdropFilter: 'blur(12px)', borderRadius: 24, padding: '11px 24px', fontSize: 'calc(15px * var(--fs-scale-subtitle, 1))', fontWeight: 600, cursor: 'pointer', boxShadow: '0 2px 12px rgba(0,0,0,0.15)', minHeight: 44, fontFamily: 'inherit', touchAction: 'manipulation' }}>
                  {t('trip.mobilePlaces')}
                </button>
              </div>,
              document.body
            )}

            {showDayDetail && !selectedPlace && (() => {
              const currentDay = days.find(d => d.id === showDayDetail.id) || showDayDetail
              const dayAssignments = assignments[String(currentDay.id)] || []
              // Day-local weather anchor only (#2167): first located stop of THIS day,
              // else the hotel you wake up in (unconditional bookend lookup, mirroring
              // useMPlanTimeline) — never a place from another day.
              const locatedPlace = dayAssignments.find(a => a.place?.lat && a.place?.lng)?.place
              const weatherHotel = locatedPlace ? undefined : getDayBookendHotels(currentDay, days, tripAccommodations).morning
              const weatherLat = locatedPlace?.lat ?? weatherHotel?.place_lat ?? null
              const weatherLng = locatedPlace?.lng ?? weatherHotel?.place_lng ?? null
              const weatherPlaceName = locatedPlace?.name ?? weatherHotel?.place_name ?? null
              return (
                <DayDetailPanel
                  day={currentDay}
                  days={days}
                  places={places}
                  categories={categories}
                  tripId={tripId}
                  assignments={assignments}
                  reservations={reservations}
                  lat={weatherLat}
                  lng={weatherLng}
                  weatherPlaceName={weatherPlaceName}
                  onClose={() => { setShowDayDetail(null); handleSelectDay(null) }}
                  onAccommodationChange={loadAccommodations}
                  leftWidth={isMobile ? 0 : leftPanelPx}
                  rightWidth={isMobile ? 0 : rightPanelPx}
                  collapsed={dayDetailCollapsed}
                  onToggleCollapse={() => setDayDetailCollapsed(c => !c)}
                  mobile={isMobile}
                  onUpdateDayTitle={handleUpdateDayTitle}
                />
              )
            })()}

            {selectedPlace && !isMobile && (
              <PlaceInspector
                onEditTransport={openLinkedTransport}
                onEditReservation={openLinkedReservation}
                place={selectedPlace}
                categories={categories}
                days={days}
                selectedDayId={selectedDayId}
                selectedAssignmentId={selectedAssignmentId}
                assignments={assignments}
                reservations={reservations}
                onClose={() => setSelectedPlaceId(null)}
                onEdit={() => openPlaceEditor(selectedPlace, selectedAssignmentId)}
                onDelete={() => handleDeletePlace(selectedPlace.id)}
                onAssignToDay={handleAssignToDay}
                onRemoveAssignment={handleRemoveAssignment}
                files={files}
                onFileUpload={canUploadFiles ? (fd) => tripActions.addFile(tripId, fd) : undefined}
                tripMembers={tripMembers}
                onSetParticipants={async (assignmentId, dayId, userIds) => {
                  try {
                    const data = await assignmentsApi.setParticipants(tripId, assignmentId, userIds)
                    useTripStore.setState(state => ({
                      assignments: {
                        ...state.assignments,
                        [String(dayId)]: (state.assignments[String(dayId)] || []).map(a =>
                          a.id === assignmentId ? { ...a, participants: data.participants } : a
                        ),
                      }
                    }))
                  } catch (err: unknown) { toast.error(err instanceof Error ? err.message : t('common.unknownError')) }
                }}
                onUpdatePlace={async (placeId, data) => { try { await tripActions.updatePlace(tripId, placeId, data) } catch (err: unknown) { toast.error(err instanceof Error ? err.message : t('common.unknownError')) } }}
                onUploadImage={async (placeId, file) => { await tripActions.uploadPlaceImage(tripId, placeId, file) }}
                onRate={async (placeId, rating) => { try { await tripActions.ratePlace(tripId, placeId, rating) } catch (err: unknown) { toast.error(err instanceof Error ? err.message : t('common.unknownError')) } }}
                leftWidth={isMobile ? 0 : leftPanelPx}
                rightWidth={isMobile ? 0 : rightPanelPx}
              />
            )}

            {selectedPlace && isMobile && createPortal(
              <div className="bg-[rgba(0,0,0,0.3)]" style={{ position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', alignItems: 'flex-end', justifyContent: 'center', paddingBottom: 'var(--bottom-nav-h)' }} role="presentation" onClick={() => setSelectedPlaceId(null)}>
                <div style={{ width: '100%', maxHeight: '85vh' }} role="presentation" onClick={e => e.stopPropagation()}>
                  <PlaceInspector
                    onEditTransport={openLinkedTransport}
                    onEditReservation={openLinkedReservation}
                    place={selectedPlace}
                    categories={categories}
                    days={days}
                    selectedDayId={selectedDayId}
                    selectedAssignmentId={selectedAssignmentId}
                    assignments={assignments}
                    reservations={reservations}
                    onClose={() => setSelectedPlaceId(null)}
                    onEdit={() => { openPlaceEditor(selectedPlace, selectedAssignmentId); setSelectedPlaceId(null) }}
                    onDelete={() => { handleDeletePlace(selectedPlace.id); setSelectedPlaceId(null) }}
                    onAssignToDay={handleAssignToDay}
                    onRemoveAssignment={handleRemoveAssignment}
                    files={files}
                    onFileUpload={canUploadFiles ? (fd) => tripActions.addFile(tripId, fd) : undefined}
                    tripMembers={tripMembers}
                    onSetParticipants={async (assignmentId, dayId, userIds) => {
                      try {
                        const data = await assignmentsApi.setParticipants(tripId, assignmentId, userIds)
                        useTripStore.setState(state => ({
                          assignments: {
                            ...state.assignments,
                            [String(dayId)]: (state.assignments[String(dayId)] || []).map(a =>
                              a.id === assignmentId ? { ...a, participants: data.participants } : a
                            ),
                          }
                        }))
                      } catch (err: unknown) { toast.error(err instanceof Error ? err.message : t('common.unknownError')) }
                    }}
                    onUpdatePlace={async (placeId, data) => { try { await tripActions.updatePlace(tripId, placeId, data) } catch (err: unknown) { toast.error(err instanceof Error ? err.message : t('common.unknownError')) } }}
                    onUploadImage={async (placeId, file) => { await tripActions.uploadPlaceImage(tripId, placeId, file) }}
                    onRate={async (placeId, rating) => { try { await tripActions.ratePlace(tripId, placeId, rating) } catch (err: unknown) { toast.error(err instanceof Error ? err.message : t('common.unknownError')) } }}
                    leftWidth={0}
                    rightWidth={0}
                  />
                </div>
              </div>,
              document.body
            )}

            {mobileSidebarOpen && createPortal(
              <div className="bg-[rgba(0,0,0,0.3)]" style={{ position: 'fixed', inset: 0, zIndex: 9999 }} role="presentation" onClick={() => setMobileSidebarOpen(null)}>
                <div className="bg-surface-card" style={{ position: 'absolute', top: 'var(--nav-h)', left: 0, right: 0, bottom: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }} role="presentation" onClick={e => e.stopPropagation()}>
                  <div className="border-b border-edge-secondary" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px' }}>
                    <span className="text-content" style={{ fontWeight: 600, fontSize: 'calc(14px * var(--fs-scale-body, 1))' }}>{mobileSidebarOpen === 'left' ? t('trip.mobilePlan') : t('trip.mobilePlaces')}</span>
                    <button type="button" onClick={() => setMobileSidebarOpen(null)} className="bg-surface-tertiary text-content" style={{ border: 'none', borderRadius: '50%', width: 28, height: 28, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <X size={14} />
                    </button>
                  </div>
                  <div style={{ flex: 1, overflow: 'auto', paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}>
                    {mobileSidebarOpen === 'left'
                      ? <DayPlanSidebar tripId={tripId} trip={trip} days={days} places={places} categories={categories} assignments={assignments} selectedDayId={selectedDayId} selectedPlaceId={selectedPlaceId} selectedAssignmentId={selectedAssignmentId} onSelectDay={(id) => { handleSelectDay(id); setMobileSidebarOpen(null) }} onPlaceClick={(placeId, assignmentId) => { handlePlaceClick(placeId, assignmentId) }} onReorder={handleReorder} onReorderDays={handleReorderDays} onAddDay={handleAddDay} onUpdateDayTitle={handleUpdateDayTitle} onAssignToDay={handleAssignToDay} onRouteCalculated={(r) => { if (r) { setRoute([r.coordinates]); setRouteInfo(r) } else { setRoute(null); setRouteInfo(null) } }} reservations={reservations} visibleConnectionIds={visibleConnections} onToggleConnection={toggleConnection} allConnectionsShown={allConnectionsShown} onToggleAllConnections={toggleAllConnections} onAddReservation={(dayId) => { setEditingReservation(null); tripActions.setSelectedDay(dayId); setShowReservationModal(true); setMobileSidebarOpen(null) }} onAddTransport={can('day_edit', trip) ? (dayId) => { setTransportModalDayId(dayId); setEditingTransport(null); setTransitPrefill(null); setTransportModalAutomated(false); setShowTransportModal(true); setMobileSidebarOpen(null) } : undefined} onOpenTransit={(r) => { setTransitJourney(r); setMobileSidebarOpen(null) }} onPlanTransit={can('day_edit', trip) && tripHasDates ? (dayId) => { setTransportModalDayId(dayId); setEditingTransport(null); setTransitPrefill(null); setTransportModalAutomated(true); setShowTransportModal(true); setMobileSidebarOpen(null) } : undefined} onPlanTransitLeg={can('day_edit', trip) && tripHasDates ? ({ dayId, from, to, time }) => { setTransportModalDayId(dayId); setEditingTransport(null); setTransitPrefill({ from, to, time }); setTransportModalAutomated(true); setShowTransportModal(true); setMobileSidebarOpen(null) } : undefined} onAddPlace={() => { setEditingPlace(null); setShowPlaceForm(true); setMobileSidebarOpen(null) }} onDayDetail={(day) => { setShowDayDetail(day); setSelectedPlaceId(null); selectAssignment(null) }} onRemoveAssignment={handleRemoveAssignment} onEditPlace={(place, assignmentId) => { setEditingPlace(place); setEditingAssignmentId(assignmentId || null); setShowPlaceForm(true); setMobileSidebarOpen(null) }} onDeletePlace={(placeId) => handleDeletePlace(placeId)} accommodations={tripAccommodations} routeShown={routeShown} routeProfile={routeProfile} onToggleRoute={() => setRouteShown(v => !v)} onSetRouteProfile={setRouteProfile} onNavigateToFiles={() => { setMobileSidebarOpen(null); handleTabChange('dateien') }} onExpandedDaysChange={setExpandedDayIds} pushUndo={pushUndo} canUndo={canUndo} lastActionLabel={lastActionLabel} onUndo={handleUndo} onEditTransport={can('day_edit', trip) ? (reservation) => { setEditingTransport(reservation); setTransportModalDayId(reservation.day_id ?? null); setShowTransportModal(true); setMobileSidebarOpen(null) } : undefined} onEditReservation={can('reservation_edit', trip) ? (r) => { setEditingReservation(r); setShowReservationModal(true); setMobileSidebarOpen(null) } : undefined} initialScrollTop={mobilePlanScrollTopRef.current} onScrollTopChange={(top) => { mobilePlanScrollTopRef.current = top }} showRouteToolsWhenExpanded isMobile />
                      : <PlacesSidebar tripId={tripId} places={places} categories={categories} assignments={assignments} accommodations={tripAccommodations} selectedDayId={selectedDayId} selectedPlaceId={selectedPlaceId} onPlaceClick={(placeId) => { handlePlaceClick(placeId); setMobileSidebarOpen(null) }} onAddPlace={() => { setEditingPlace(null); setShowPlaceForm(true); setMobileSidebarOpen(null) }} onAssignToDay={handleAssignToDay} onEditPlace={(place) => { openPlaceEditor(place); setMobileSidebarOpen(null) }} onDeletePlace={(placeId) => handleDeletePlace(placeId)} onBulkDeletePlaces={(ids) => setDeletePlaceIds(ids)} onBulkDeleteConfirm={(ids) => confirmDeletePlaces(ids)} onBulkChangeCategory={(ids, catId) => confirmChangeCategory(ids, catId)} days={days} isMobile pushUndo={pushUndo} initialScrollTop={mobilePlacesScrollTopRef.current} onScrollTopChange={(top) => { mobilePlacesScrollTopRef.current = top }} />
                    }
                  </div>
                </div>
              </div>,
              document.body
            )}
          </div>
        )}

        {activeTab === 'transports' && (
          <div style={{ height: '100%', width: '100%', display: 'flex', flexDirection: 'column', overflowY: 'auto', overscrollBehavior: 'contain', paddingBottom: 'var(--bottom-nav-h)' }}>
            <LazyPanel id="transports">
              <ReservationsPanel
                tripId={tripId}
                reservations={reservations.filter(r => TRANSPORT_TYPES.has(r.type))}
                days={days}
                assignments={assignments}
                files={files}
                onAdd={() => { setEditingTransport(null); setTransitPrefill(null); setTransportModalAutomated(false); setShowTransportModal(true) }}
                onImport={() => { setBookingImportKind('transports'); setShowBookingImport(true) }}
                bookingImportAvailable={bookingImportAvailable}
                onAirTrailImport={() => setShowAirTrailImport(true)}
                airTrailAvailable={airTrailAvailable}
                onEdit={(r) => { if (r.type === 'transit') { setTransitJourney(r) } else { setEditingTransport(r); setTransportModalAutomated(false); setShowTransportModal(true) } }}
                onDelete={handleDeleteReservation}
                onNavigateToFiles={() => handleTabChange('dateien')}
                titleKey="transport.title"
                addManualKey="transport.addManual"
                contributionView="transports"
                tripMembers={tripMembers}
              />
            </LazyPanel>
          </div>
        )}

        {activeTab === 'buchungen' && (
          <div style={{ height: '100%', width: '100%', display: 'flex', flexDirection: 'column', overflowY: 'auto', overscrollBehavior: 'contain', paddingBottom: 'var(--bottom-nav-h)' }}>
            <LazyPanel id="buchungen">
              <ReservationsPanel
                tripId={tripId}
                reservations={reservations.filter(r => !TRANSPORT_TYPES.has(r.type))}
                days={days}
                assignments={assignments}
                files={files}
                onAdd={() => { setEditingReservation(null); setShowReservationModal(true) }}
                onImport={() => { setBookingImportKind('bookings'); setShowBookingImport(true) }}
                bookingImportAvailable={bookingImportAvailable}
                onEdit={(r) => { setEditingReservation(r); setShowReservationModal(true) }}
                onDelete={handleDeleteReservation}
                onNavigateToFiles={() => handleTabChange('dateien')}
                tripMembers={tripMembers}
              />
            </LazyPanel>
          </div>
        )}

        {activeTab === 'listen' && (
          <div style={{ height: '100%', overflowY: 'auto', overscrollBehavior: 'contain', width: '100%', paddingBottom: 'var(--bottom-nav-h)' }}>
            <ListsContainer tripId={tripId} packingItems={packingItems} todoItems={todoItems} />
          </div>
        )}

        {activeTab === 'finanzplan' && (
          <div style={{ height: '100%', overflowY: 'auto', overscrollBehavior: 'contain', width: '100%', paddingBottom: 'var(--bottom-nav-h)' }}>
            <LazyPanel id="finanzplan">
              <CostsPanel tripId={tripId} tripMembers={tripMembers} />
            </LazyPanel>
          </div>
        )}

        {activeTab === 'dateien' && (
          <div style={{ height: '100%', overflow: 'hidden', overscrollBehavior: 'contain', paddingBottom: 'var(--bottom-nav-h)' }}>
            <LazyPanel id="dateien">
              <FileManager
                files={files || []}
                onUpload={(fd) => tripActions.addFile(tripId, fd)}
                onDelete={(id) => tripActions.deleteFile(tripId, id)}
                onUpdate={() => tripActions.loadFiles(tripId)}
                places={places}
                days={days}
                assignments={assignments}
                reservations={reservations}
                tripId={tripId}
                allowedFileTypes={allowedFileTypes}
              />
            </LazyPanel>
          </div>
        )}

        {activeTab === 'collab' && (
          <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 'var(--bottom-nav-h)', overflow: 'hidden' }}>
            <LazyPanel id="collab">
              <CollabPanel tripId={tripId} tripMembers={tripMembers} collabFeatures={collabFeatures} />
            </LazyPanel>
          </div>
        )}

        {activeTab.startsWith('plugin:') && (
          <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 'var(--bottom-nav-h)', overflow: 'hidden' }}>
            <PluginFrame pluginId={activeTab.slice('plugin:'.length)} tripId={String(tripId)} fill surface="trip-tab" className="w-full h-full" />
          </div>
        )}
      </div>

      <PlaceFormModal isOpen={showPlaceForm} onClose={() => { setShowPlaceForm(false); setEditingPlace(null); setEditingAssignmentId(null); setPrefillCoords(null) }} onSave={handleSavePlace} place={editingPlace} prefillCoords={prefillCoords} assignmentId={editingAssignmentId} dayAssignments={editingPlace ? Object.values(assignments).flat() : []} tripId={tripId} categories={categories} onCategoryCreated={cat => tripActions.addCategory?.(cat)} isMobile={isMobile} onOpenExpense={openBookingExpense} />
      <TripFormModal
        isOpen={showTripForm}
        onClose={() => setShowTripForm(false)}
        onSave={async (data) => { await tripActions.updateTrip(tripId, data); loadAccommodations(); toast.success(t('trip.toast.tripUpdated')) }}
        trip={trip}
        onCoverUpdate={(_, coverUrl) => useTripStore.setState(state => ({ trip: state.trip ? { ...state.trip, cover_image: coverUrl } : state.trip }))}
      />
      <TripMembersModal isOpen={showMembersModal} onClose={() => setShowMembersModal(false)} tripId={tripId} tripTitle={trip?.title} onMembersChanged={refreshMembers} />
      <ReservationModal isOpen={showReservationModal} onClose={() => { if (importReviewActive) { advanceImportReview() } else { setShowReservationModal(false); setEditingReservation(null); setBookingForAssignmentId(null) } }} onSave={async (data) => { const r = await handleSaveReservation(data); if (importReviewActive && r) advanceImportReview(); return r }} reservation={editingReservation} prefill={reservationPrefill} days={days} places={places} assignments={assignments} selectedDayId={selectedDayId} files={files} onFileUpload={canUploadFiles ? (fd) => tripActions.addFile(tripId, fd) : undefined} onFileDelete={(id) => tripActions.deleteFile(tripId, id)} accommodations={tripAccommodations} defaultAssignmentId={bookingForAssignmentId} onOpenExpense={openBookingExpense} tripMembers={tripMembers} />
      {showTransportModal && (
        <ErrorBoundary boundaryId="planner-panel:transport" fallback={null}>
          <Suspense fallback={null}>
            <TransportModal isOpen={showTransportModal} onClose={() => { if (importReviewActive) { advanceImportReview() } else { setShowTransportModal(false); setEditingTransport(null); setTransportModalDayId(null); setTransportModalAutomated(false); setTransitPrefill(null) } }} onSave={async (data) => { const r = await handleSaveTransport(data); if (importReviewActive && r) advanceImportReview(); return r }} reservation={editingTransport} prefill={transportPrefill} days={days} selectedDayId={transportModalDayId} files={files} onFileUpload={canUploadFiles ? (fd) => tripActions.addFile(tripId, fd) : undefined} onFileDelete={(id) => tripActions.deleteFile(tripId, id)} onOpenExpense={openBookingExpense} places={places} assignments={assignments} accommodations={tripAccommodations} initialAutomated={transportModalAutomated} transitPrefill={transitPrefill} tripHasDates={tripHasDates} tripMembers={tripMembers} />
          </Suspense>
        </ErrorBoundary>
      )}
      {/* Journey view for a saved public-transit entry (#1065) */}
      {transitJourney && (
        <TransitJourneyModal
          reservation={reservations.find(r => r.id === transitJourney.id) ?? transitJourney}
          canEdit={can('day_edit', trip)}
          onClose={() => setTransitJourney(null)}
          onSave={async (fields) => { await tripActions.updateReservation(tripId, transitJourney.id, fields); setTransitJourney(null) }}
          onDelete={async () => { await handleDeleteReservation(transitJourney.id); setTransitJourney(null) }}
          onChangeRoute={() => {
            // Re-enter the transit search seeded with this journey's route; the
            // existing reservation is REPLACED on save (editingTransport drives
            // handleSaveTransport's update path).
            const eps = transitJourney.endpoints || []
            const from = eps.find(e => e.role === 'from')
            const to = eps.find(e => e.role === 'to')
            setTransitPrefill({
              from: from ? { name: from.name, lat: from.lat, lng: from.lng } : null,
              to: to ? { name: to.name, lat: to.lat, lng: to.lng } : null,
            })
            setEditingTransport(transitJourney)
            setTransportModalDayId(transitJourney.day_id ?? null)
            setTransportModalAutomated(true)
            setTransitJourney(null)
            setShowTransportModal(true)
          }}
          onEditDetails={() => {
            // Hand off to the full transport editor (travelers, costs, files,
            // booking code, status) — the same modal mobile opens; an
            // unchanged-endpoints save keeps the stored itinerary (#2148).
            const current = reservations.find(r => r.id === transitJourney.id) ?? transitJourney
            setEditingTransport(current)
            setTransportModalDayId(current.day_id ?? null)
            setTransportModalAutomated(false)
            setTransitPrefill(null)
            setTransitJourney(null)
            setShowTransportModal(true)
          }}
        />
      )}
      {bookingExpense && (
        <ErrorBoundary boundaryId="planner-panel:expense" fallback={null}>
          <Suspense fallback={null}>
            <ExpenseModal
              tripId={tripId}
              base={costsBase}
              people={tripMembers}
              me={meId}
              editing={bookingExpense.editing}
              prefill={bookingExpense.prefill}
              onClose={() => setBookingExpense(null)}
              onSaved={() => { setBookingExpense(null); loadBudgetItems(tripId) }}
            />
          </Suspense>
        </ErrorBoundary>
      )}
      <BookingImportModal isOpen={showBookingImport} onClose={() => setShowBookingImport(false)} tripId={tripId} kind={bookingImportKind} />
      <AirTrailImportModal isOpen={showAirTrailImport} onClose={() => setShowAirTrailImport(false)} tripId={tripId} pushUndo={pushUndo} />
      <ConfirmDialog
        isOpen={!!deletePlaceId}
        onClose={() => setDeletePlaceId(null)}
        onConfirm={confirmDeletePlace}
        title={t('common.delete')}
        message={t('trip.confirm.deletePlace')}
      />
      <ConfirmDialog
        isOpen={!!deletePlaceIds?.length}
        onClose={() => setDeletePlaceIds(null)}
        onConfirm={confirmDeletePlaces}
        title={t('common.delete')}
        message={t('trip.confirm.deletePlaces', { count: deletePlaceIds?.length ?? 0 })}
      />
    </div>
  )
}
