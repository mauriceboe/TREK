import React, { useState, useEffect } from 'react'
import { ChevronDown, ChevronRight, Car, Fuel, RotateCcw, AlertTriangle, Loader2, Pencil } from 'lucide-react'
import { useRoadtripStore } from '../../store/roadtripStore'
import { useSettingsStore } from '../../store/settingsStore'
import { useAddonStore } from '../../store/addonStore'
import { useTripStore } from '../../store/tripStore'
import { useTranslation } from '../../i18n'
import { formatDistance, formatDuration, formatFuelCost, calculateVehicleRange } from '../../utils/roadtripFormatters'
import { calculateSunriseSunset } from '../../utils/solarCalculation'
import type { Day, AssignmentsMap, Trip } from '../../types'

interface RoadTripSummaryProps {
  tripId: string | number
  trip?: Trip
  days: Day[]
  assignments?: AssignmentsMap
}

export default function RoadTripSummary({ tripId, trip, days, assignments }: RoadTripSummaryProps) {
  const { t } = useTranslation()
  const roadtripEnabled = useAddonStore(s => s.isEnabled('roadtrip'))
  const roadtripStore = useRoadtripStore()
  const tripStore = useTripStore()
  const batchProgress = useRoadtripStore(s => s.batchProgress)
  const unitSystem = useSettingsStore(s => s.settings.roadtrip_unit_system) || 'metric'
  const fuelCurrency = useSettingsStore(s => s.settings.roadtrip_fuel_currency) || useSettingsStore(s => s.settings.default_currency) || 'USD'
  const tankSize = useSettingsStore(s => s.settings.roadtrip_tank_size)
  const fuelConsumption = useSettingsStore(s => s.settings.roadtrip_fuel_consumption)
  const vehicleRangeMeters = (() => {
    if (!tankSize || !fuelConsumption) return null
    const tank = parseFloat(tankSize)
    const consumption = parseFloat(fuelConsumption)
    if (!tank || !consumption) return null
    const us = unitSystem as 'metric' | 'imperial'
    return calculateVehicleRange(tank, consumption, us) * (us === 'imperial' ? 1609.344 : 1000)
  })()
  const rtRestIntervalHours = useSettingsStore(s => s.settings.roadtrip_rest_interval_hours)
  const rtRestDurationMinutes = useSettingsStore(s => s.settings.roadtrip_rest_duration_minutes)
  const restInterval = rtRestIntervalHours ? parseFloat(rtRestIntervalHours) : null
  const restDuration = rtRestDurationMinutes ? parseFloat(rtRestDurationMinutes) : null
  const maxSpeed = useSettingsStore(s => s.settings.roadtrip_max_speed)
  const daylightOnly = useSettingsStore(s => s.settings.roadtrip_daylight_only) === 'true'

  const [expanded, setExpanded] = useState(true)
  const [recalculating, setRecalculating] = useState(false)
  const [editingFuelPrice, setEditingFuelPrice] = useState(false)
  const [fuelPriceInput, setFuelPriceInput] = useState('')
  const userFuelPrice = useSettingsStore(s => s.settings.roadtrip_fuel_price) || ''
  const tripFuelPrice = trip?.roadtrip_fuel_price || ''

  // Cancel batch on unmount (user navigates away)
  useEffect(() => {
    return () => { roadtripStore.cancelBatch() }
  }, [])

  if (!roadtripEnabled) return null

  const tripIdStr = String(tripId)
  const allLegs = (roadtripStore.routeLegs[tripIdStr] || []).filter(l => l.is_road_trip)

  // Build day data for toggleAllTrip
  const dayData = days.map(d => ({
    id: d.id,
    assignments: (assignments?.[String(d.id)] || []).map(a => ({
      id: a.id,
      place: a.place ? { id: a.place.id, lat: a.place.lat, lng: a.place.lng } : null,
    })),
  }))

  // Count total possible pairs to determine on/off state
  const totalPossiblePairs = dayData.reduce((sum, d) => {
    const places = d.assignments.filter(a => a.place?.lat && a.place?.lng)
    return sum + Math.max(0, places.length - 1)
  }, 0)
  const allActive = totalPossiblePairs > 0 && allLegs.length >= totalPossiblePairs
  const isBatching = batchProgress !== null

  const handleToggleAll = async () => {
    if (isBatching) {
      roadtripStore.cancelBatch()
      return
    }
    await roadtripStore.toggleAllTrip(tripIdStr, dayData)
  }

  if (allLegs.length === 0 && !isBatching && totalPossiblePairs === 0) return null

  const hasActiveLegs = allLegs.length > 0
  const totals = hasActiveLegs ? roadtripStore.getTripTotals(tripIdStr, restInterval, restDuration) : null
  const hasFuelCost = hasActiveLegs && allLegs.some(l => l.fuel_cost != null && l.fuel_cost > 0)
  const hasRestBreaks = totals != null && totals.totalRestBreaks > 0

  // Per-day breakdown: only days that have road trip legs
  const dayBreakdown = days
    .map((day, idx) => {
      const dayTotals = roadtripStore.getDayTotals(tripIdStr, idx)
      if (dayTotals.distanceMeters === 0) return null

      // Daylight hours for this day
      let daylightHours: number | null = null
      if (daylightOnly && day.date && assignments) {
        const da = assignments[String(day.id)] || []
        const firstGeo = da.find(a => a.place?.lat && a.place?.lng)
        if (firstGeo?.place) {
          const solar = calculateSunriseSunset(firstGeo.place.lat!, firstGeo.place.lng!, new Date(day.date + 'T12:00:00'))
          daylightHours = solar.daylightHours
        }
      }

      return { dayIndex: idx, day, ...dayTotals, daylightHours }
    })
    .filter(Boolean) as { dayIndex: number; day: Day; distanceMeters: number; durationSeconds: number; fuelCost: number; daylightHours: number | null }[]

  // Fuel stops estimate
  let totalFuelStops = 0
  if (vehicleRangeMeters) {
    for (const leg of allLegs) {
      if (leg.distance_meters && leg.distance_meters > vehicleRangeMeters) {
        totalFuelStops += Math.ceil(leg.distance_meters / vehicleRangeMeters) - 1
      }
    }
  }

  const handleRecalculate = async () => {
    setRecalculating(true)
    try {
      await roadtripStore.recalculate(tripIdStr)
    } finally {
      setRecalculating(false)
    }
  }

  return (
    <div style={{
      margin: '8px 8px 0', padding: 0, borderRadius: 10,
      background: 'var(--bg-card)', border: '1px solid var(--border-faint)',
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', padding: '6px 8px 6px 0' }}>
        <button
          onClick={() => setExpanded(e => !e)}
          style={{
            flex: 1, display: 'flex', alignItems: 'center', gap: 8,
            padding: '4px 12px', border: 'none', background: 'none',
            cursor: 'pointer', fontFamily: 'inherit',
            color: 'var(--text-primary)',
          }}
        >
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <Car size={14} strokeWidth={2} style={{ color: '#3b82f6' }} />
          <span style={{ fontSize: 12, fontWeight: 600 }}>{t('roadtrip.summary')}</span>
        </button>

        {/* Global toggle */}
        {totalPossiblePairs > 0 && (
          <button
            onClick={handleToggleAll}
            disabled={isBatching && false}
            title={isBatching ? t('roadtrip.calculatingRoutes') : t('roadtrip.toggleAllTrip')}
            style={{
              display: 'flex', alignItems: 'center', gap: 4,
              padding: '4px 8px', fontSize: 10, fontWeight: 500, borderRadius: 6,
              border: allActive ? '1px solid #3b82f6' : '1px solid var(--border-faint)',
              background: allActive ? 'rgba(59,130,246,0.1)' : 'transparent',
              color: isBatching ? '#3b82f6' : allActive ? '#3b82f6' : 'var(--text-faint)',
              cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0,
            }}
          >
            {isBatching ? (
              <>
                <Loader2 size={11} strokeWidth={2} style={{ animation: 'spin 0.8s linear infinite' }} />
                <span>{batchProgress!.current}/{batchProgress!.total}</span>
              </>
            ) : (
              <>
                <Car size={11} strokeWidth={2} />
                <span>{allActive ? 'ON' : 'OFF'}</span>
              </>
            )}
          </button>
        )}
      </div>

      {expanded && hasActiveLegs && totals && (
        <div style={{ padding: '0 12px 12px' }}>
          {/* Daylight mode indicator */}
          {daylightOnly && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 5, fontSize: 10,
              color: 'var(--text-faint)', marginBottom: 8,
            }}>
              <span>🌅</span>
              <span>{t('roadtrip.daylightMode')}</span>
            </div>
          )}

          {/* Summary totals */}
          <div style={{
            display: 'grid', gridTemplateColumns: hasFuelCost ? '1fr 1fr 1fr' : '1fr 1fr',
            gap: 8, marginBottom: 10,
          }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>
                {formatDistance(totals.totalDistanceMeters, unitSystem)}
              </div>
              <div style={{ fontSize: 9, color: 'var(--text-faint)', fontWeight: 500 }}>{t('roadtrip.totalDistance')}</div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>
                {formatDuration(totals.totalDurationSeconds)}
              </div>
              <div style={{ fontSize: 9, color: 'var(--text-faint)', fontWeight: 500 }}>{t('roadtrip.totalTime')}</div>
            </div>
            {hasFuelCost && (
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>
                  {formatFuelCost(totals.totalFuelCost, fuelCurrency)}
                </div>
                <div style={{ fontSize: 9, color: 'var(--text-faint)', fontWeight: 500 }}>{t('roadtrip.totalFuel')}</div>
              </div>
            )}
          </div>

          {/* Fuel price — inline editable */}
          {hasFuelCost && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, color: 'var(--text-faint)', marginBottom: 6, padding: '0 2px' }}>
              <Fuel size={10} strokeWidth={2} />
              {editingFuelPrice ? (
                <form onSubmit={async (e) => {
                  e.preventDefault()
                  try {
                    await tripStore.updateTrip(String(tripId), { roadtrip_fuel_price: fuelPriceInput || '' })
                    await roadtripStore.recalculate(String(tripId))
                  } catch (err) { console.error('Failed to update fuel price:', err) }
                  setEditingFuelPrice(false)
                }} style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                  <span>{t('roadtrip.tripFuelPrice')}:</span>
                  <input
                    autoFocus
                    type="number"
                    step="0.01"
                    min="0"
                    value={fuelPriceInput}
                    onChange={e => setFuelPriceInput(e.target.value)}
                    placeholder={userFuelPrice || '0.00'}
                    onBlur={() => setEditingFuelPrice(false)}
                    style={{ width: 60, padding: '1px 4px', fontSize: 10, border: '1px solid var(--border-faint)', borderRadius: 4, background: 'var(--bg-card)', color: 'var(--text-primary)', fontFamily: 'inherit' }}
                  />
                  <span>{fuelCurrency}/{unitSystem === 'imperial' ? 'gal' : 'L'}</span>
                </form>
              ) : (
                <>
                  <span>{t('roadtrip.tripFuelPrice')}: {tripFuelPrice || userFuelPrice || '—'} {fuelCurrency}/{unitSystem === 'imperial' ? 'gal' : 'L'}</span>
                  {tripFuelPrice && <span style={{ color: 'var(--text-faint)', fontSize: 9 }}>({t('roadtrip.tripOverride')})</span>}
                  <button onClick={() => { setFuelPriceInput(tripFuelPrice || ''); setEditingFuelPrice(true) }}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex', color: 'var(--text-faint)' }}>
                    <Pencil size={9} strokeWidth={2} />
                  </button>
                </>
              )}
            </div>
          )}

          {/* Total with breaks */}
          {hasRestBreaks && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 5, fontSize: 10,
              color: 'var(--text-secondary)', padding: '4px 8px', borderRadius: 6,
              background: 'var(--bg-hover)', marginBottom: 8,
            }}>
              <span>☕</span>
              <span>{t('roadtrip.totalWithBreaks')}: {formatDuration(totals.totalTravelTimeWithBreaks)}</span>
              <span style={{ opacity: 0.4 }}>({totals.totalRestBreaks} {t('roadtrip.restBreaks', { count: String(totals.totalRestBreaks), minutes: String(totals.totalRestBreaks * (restDuration || 0)) }).split('(')[0].trim()})</span>
            </div>
          )}

          {/* Fuel stops estimate */}
          {vehicleRangeMeters && totalFuelStops > 0 && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 5, fontSize: 10,
              color: '#d97706', padding: '4px 8px', borderRadius: 6,
              background: 'rgba(217,119,6,0.08)', marginBottom: 8,
            }}>
              <Fuel size={11} strokeWidth={2} />
              <span>{t('roadtrip.fuelStopsEstimate', { count: String(totalFuelStops) })}</span>
            </div>
          )}

          {/* Per-day breakdown */}
          {dayBreakdown.length > 1 && (
            <div style={{ borderTop: '1px solid var(--border-faint)', paddingTop: 8 }}>
              <table style={{ width: '100%', fontSize: 10, borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ color: 'var(--text-faint)', fontWeight: 600 }}>
                    <th style={{ textAlign: 'left', padding: '2px 4px' }}>{t('roadtrip.day')}</th>
                    <th style={{ textAlign: 'right', padding: '2px 4px' }}>{t('roadtrip.distance')}</th>
                    <th style={{ textAlign: 'right', padding: '2px 4px' }}>{t('roadtrip.driveTime')}</th>
                    {hasFuelCost && <th style={{ textAlign: 'right', padding: '2px 4px' }}>{t('roadtrip.fuelCost')}</th>}
                    {daylightOnly && <th style={{ textAlign: 'right', padding: '2px 4px' }}>☀️</th>}
                  </tr>
                </thead>
                <tbody>
                  {dayBreakdown.map(row => {
                    const drivingHours = row.durationSeconds / 3600
                    const exceedsDaylight = row.daylightHours != null && row.daylightHours > 0 && drivingHours > row.daylightHours
                    return (
                      <tr key={row.dayIndex} style={{
                        color: exceedsDaylight ? '#b45309' : 'var(--text-secondary)',
                        background: exceedsDaylight ? 'rgba(217,119,6,0.05)' : undefined,
                      }}>
                        <td style={{ padding: '3px 4px', fontWeight: 500 }}>
                          {row.day.title || `${t('roadtrip.day')} ${row.dayIndex + 1}`}
                        </td>
                        <td style={{ textAlign: 'right', padding: '3px 4px' }}>
                          {formatDistance(row.distanceMeters, unitSystem)}
                        </td>
                        <td style={{ textAlign: 'right', padding: '3px 4px' }}>
                          {formatDuration(row.durationSeconds)}
                        </td>
                        {hasFuelCost && (
                          <td style={{ textAlign: 'right', padding: '3px 4px' }}>
                            {row.fuelCost > 0 ? formatFuelCost(row.fuelCost, fuelCurrency) : '—'}
                          </td>
                        )}
                        {daylightOnly && (
                          <td style={{ textAlign: 'right', padding: '3px 4px' }}>
                            {row.daylightHours != null ? `${row.daylightHours.toFixed(1)}h` : '—'}
                          </td>
                        )}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Speed adjustment note */}
          {maxSpeed && parseFloat(maxSpeed) > 0 && (
            <div style={{
              fontSize: 10, color: 'var(--text-faint)', fontStyle: 'italic',
              marginTop: 6, textAlign: 'center',
            }}>
              {t('roadtrip.speedAdjusted', {
                speed: `${maxSpeed} ${unitSystem === 'imperial' ? 'mph' : 'km/h'}`,
              })}
            </div>
          )}

          {/* Recalculate button */}
          <button
            onClick={handleRecalculate}
            disabled={recalculating}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
              width: '100%', marginTop: 8, padding: '6px 0',
              fontSize: 11, fontWeight: 500, borderRadius: 8, border: '1px solid var(--border-faint)',
              background: 'transparent', color: 'var(--text-secondary)',
              cursor: recalculating ? 'wait' : 'pointer', fontFamily: 'inherit',
              opacity: recalculating ? 0.6 : 1,
            }}
          >
            <RotateCcw size={11} strokeWidth={2} style={recalculating ? { animation: 'spin 0.8s linear infinite' } : {}} />
            {t('roadtrip.recalculate')}
          </button>
        </div>
      )}
    </div>
  )
}
