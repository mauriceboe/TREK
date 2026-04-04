import React, { useEffect, useMemo, useState } from 'react'
import { Loader2, MapPin, Sparkles, Star } from 'lucide-react'
import PlaceAvatar from '../shared/PlaceAvatar'
import { tripsApi } from '../../api/client'
import { useAuthStore } from '../../store/authStore'
import { useTranslation } from '../../i18n'
import type { RecommendedPlace, Trip, TripLeg, Place, AssignmentsMap } from '../../types'

const CATEGORY_KEYS = [
  'top_sights',
  'food',
  'coffee',
  'museums',
  'nightlife',
  'outdoors',
  'shopping',
] as const

type CategoryKey = typeof CATEGORY_KEYS[number]

const CATEGORY_LABEL_KEYS: Record<CategoryKey, string> = {
  top_sights: 'places.recommendationTopSights',
  food: 'places.recommendationFood',
  coffee: 'places.recommendationCoffee',
  museums: 'places.recommendationMuseums',
  nightlife: 'places.recommendationNightlife',
  outdoors: 'places.recommendationOutdoors',
  shopping: 'places.recommendationShopping',
}

function normalizeText(value: string | null | undefined): string {
  return String(value || '').trim().toLowerCase()
}

function humanizeType(value: string | null | undefined): string {
  if (!value) return ''
  return String(value)
    .replace(/_/g, ' ')
    .replace(/\b\w/g, match => match.toUpperCase())
}

function matchesPlace(place: Place, recommendation: RecommendedPlace): boolean {
  if (recommendation.google_place_id && place.google_place_id && recommendation.google_place_id === place.google_place_id) {
    return true
  }

  return normalizeText(place.name) === normalizeText(recommendation.name)
    && normalizeText(place.address) === normalizeText(recommendation.address)
}

interface RecommendedPlacesSectionProps {
  trip: Trip | null
  activeLeg: TripLeg | null
  places: Place[]
  assignments: AssignmentsMap
  selectedDayId: number | string | null
  onPlaceClick?: (placeId: number | string) => void
  onAssignToDay: (placeId: number | string, dayId: number | string) => void | Promise<void>
  onAddRecommendation: (recommendation: RecommendedPlace, assignToDay: boolean) => Promise<Place | null>
}

export default function RecommendedPlacesSection({
  trip,
  activeLeg,
  places,
  assignments,
  selectedDayId,
  onPlaceClick,
  onAssignToDay,
  onAddRecommendation,
}: RecommendedPlacesSectionProps): React.ReactElement | null {
  const { t, language } = useTranslation()
  const hasMapsKey = useAuthStore(state => state.hasMapsKey)
  const [activeCategory, setActiveCategory] = useState<CategoryKey>('top_sights')
  const [recommendations, setRecommendations] = useState<RecommendedPlace[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState('')
  const [pendingPlaceId, setPendingPlaceId] = useState<string | null>(null)
  const destinationContext = activeLeg || trip

  const hasDestination = Boolean(
    destinationContext?.destination_name || (destinationContext?.destination_lat != null && destinationContext?.destination_lng != null)
  )

  useEffect(() => {
    if (!trip?.id || !hasMapsKey || !hasDestination) {
      setRecommendations([])
      setError('')
      setIsLoading(false)
      return
    }

    let cancelled = false
    setIsLoading(true)
    setError('')

    tripsApi.recommendations(trip.id, { category: activeCategory, lang: language, ...(activeLeg?.id ? { leg_id: activeLeg.id } : {}) })
      .then((data: { places?: RecommendedPlace[] }) => {
        if (cancelled) return
        setRecommendations(data.places || [])
      })
      .catch((err: { response?: { data?: { error?: string } } }) => {
        if (cancelled) return
        setRecommendations([])
        setError(err?.response?.data?.error || t('places.recommendationError'))
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [activeCategory, activeLeg?.id, hasDestination, hasMapsKey, language, t, trip?.id])

  const assignedPlaceIds = useMemo(() => {
    if (!selectedDayId) return new Set<number>()
    return new Set(
      (assignments[String(selectedDayId)] || []).map(a => a.place?.id).filter((id): id is number => Boolean(id))
    )
  }, [assignments, selectedDayId])

  if (!trip?.id || !hasMapsKey || !hasDestination) return null

  const title = destinationContext?.destination_name
    ? t('places.recommendedTitle', { destination: destinationContext.destination_name })
    : t('places.recommendedNearby')

  const handleAction = async (recommendation: RecommendedPlace, existingPlace: Place | null): Promise<void> => {
    const actionId = recommendation.google_place_id || recommendation.name
    setPendingPlaceId(actionId)

    try {
      if (existingPlace) {
        if (selectedDayId && !assignedPlaceIds.has(existingPlace.id as number)) {
          await onAssignToDay(existingPlace.id as number, selectedDayId)
        }
        onPlaceClick?.(existingPlace.id as number)
        return
      }

      const createdPlace = await onAddRecommendation(recommendation, Boolean(selectedDayId))
      if (createdPlace?.id) onPlaceClick?.(createdPlace.id as number)
    } finally {
      setPendingPlaceId(null)
    }
  }

  return (
    <div style={{ padding: '0 16px 12px' }}>
      <div style={{ padding: '12px 12px 10px', borderRadius: 16, background: 'var(--bg-tertiary)', border: '1px solid var(--border-faint)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <Sparkles size={14} strokeWidth={2} color="var(--text-primary)" />
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
            {title}
          </span>
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-faint)', marginBottom: 10 }}>
          {t('places.recommendationSubtitle')}
        </div>

        <div style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 4, marginBottom: 10, scrollbarWidth: 'none' }}>
          {CATEGORY_KEYS.map(categoryKey => {
            const isActive = categoryKey === activeCategory
            return (
              <button
                key={categoryKey}
                type="button"
                onClick={() => setActiveCategory(categoryKey)}
                style={{
                  flexShrink: 0,
                  border: 'none',
                  borderRadius: 999,
                  padding: '6px 10px',
                  cursor: 'pointer',
                  fontSize: 11,
                  fontWeight: 600,
                  fontFamily: 'inherit',
                  background: isActive ? 'var(--accent)' : 'var(--bg-card)',
                  color: isActive ? 'var(--accent-text)' : 'var(--text-muted)',
                }}
              >
                {t(CATEGORY_LABEL_KEYS[categoryKey])}
              </button>
            )
          })}
        </div>

        {isLoading && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '16px 0', color: 'var(--text-faint)', fontSize: 12 }}>
            <Loader2 size={14} className="animate-spin" />
            <span>{t('places.recommendationLoading')}</span>
          </div>
        )}

        {!isLoading && error && (
          <div style={{ fontSize: 12, color: '#b91c1c', padding: '4px 2px' }}>
            {error}
          </div>
        )}

        {!isLoading && !error && recommendations.length === 0 && (
          <div style={{ fontSize: 12, color: 'var(--text-faint)', padding: '4px 2px' }}>
            {t('places.recommendationEmpty')}
          </div>
        )}

        {!isLoading && !error && recommendations.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {recommendations.map(recommendation => {
              const existingPlace = places.find(place => matchesPlace(place, recommendation)) || null
              const isAssigned = existingPlace ? assignedPlaceIds.has(existingPlace.id as number) : false
              const actionId = recommendation.google_place_id || recommendation.name
              const isPending = pendingPlaceId === actionId
              const actionLabel = isAssigned
                ? t('places.recommendationOpen')
                : selectedDayId
                  ? t('planner.addToDay')
                  : existingPlace
                    ? t('places.recommendationOpen')
                    : t('common.add')

              return (
                <div
                  key={actionId}
                  draggable
                  onDragStart={(e: React.DragEvent<HTMLDivElement>) => {
                    if (existingPlace) {
                      e.dataTransfer.setData('placeId', String(existingPlace.id))
                      window.__dragData = { placeId: String(existingPlace.id) }
                    } else {
                      const serialized = JSON.stringify(recommendation)
                      e.dataTransfer.setData('recommendedPlace', serialized)
                      window.__dragData = { recommendedPlace: serialized } as unknown as typeof window.__dragData
                    }
                    e.dataTransfer.effectAllowed = 'copy'
                  }}
                  onDragEnd={() => { window.__dragData = null }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '10px 12px',
                    borderRadius: 14,
                    background: 'var(--bg-card)',
                    border: '1px solid var(--border-faint)',
                  }}
                >
                  <PlaceAvatar place={{ ...recommendation, id: 0, image_url: null, osm_id: null } as Pick<Place, 'id' | 'name' | 'lat' | 'lng' | 'image_url' | 'google_place_id' | 'osm_id'>} size={40} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.2 }}>
                      {recommendation.name}
                    </div>
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 4, flexWrap: 'wrap' }}>
                      {recommendation.rating ? (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#b45309' }}>
                          <Star size={11} fill="currentColor" strokeWidth={1.8} />
                          {recommendation.rating.toFixed(1)}
                          {recommendation.rating_count ? ` (${recommendation.rating_count})` : ''}
                        </span>
                      ) : null}
                      {(recommendation.primary_type_label || recommendation.primary_type || recommendation.types?.[0]) && (
                        <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>
                          {recommendation.primary_type_label || humanizeType(recommendation.primary_type || recommendation.types?.[0])}
                        </span>
                      )}
                    </div>
                    {recommendation.address && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 4, fontSize: 11, color: 'var(--text-faint)' }}>
                        <MapPin size={11} strokeWidth={2} />
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{recommendation.address}</span>
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => handleAction(recommendation, existingPlace)}
                    onDragStart={(e: React.DragEvent<HTMLButtonElement>) => e.stopPropagation()}
                    disabled={isPending}
                    style={{
                      border: 'none',
                      borderRadius: 10,
                      padding: '8px 10px',
                      minWidth: 70,
                      cursor: isPending ? 'default' : 'pointer',
                      fontSize: 11,
                      fontWeight: 600,
                      fontFamily: 'inherit',
                      background: existingPlace ? 'var(--bg-hover)' : 'var(--accent)',
                      color: existingPlace ? 'var(--text-primary)' : 'var(--accent-text)',
                      opacity: isPending ? 0.7 : 1,
                    }}
                  >
                    {isPending ? t('common.saving') : actionLabel}
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
