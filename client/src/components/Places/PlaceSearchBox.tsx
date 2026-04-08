import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Loader, MapPin, Search } from 'lucide-react'
import { convexMapsApi as mapsApi } from '../../convex/mapsClient'
import type { AutocompleteSuggestion } from '../../types'

const MIN_AUTOCOMPLETE_CHARS = 2
const AUTOCOMPLETE_DEBOUNCE_MS = 300

type SearchMode = 'places' | 'destination'

interface NormalizedPrediction {
  kind: 'prediction'
  id: string
  placeId: string
  name: string
  address: string
}

interface NormalizedSearchResult {
  kind: 'result'
  id: string
  [key: string]: unknown
}

type NormalizedItem = NormalizedPrediction | NormalizedSearchResult

interface PlaceSearchBoxProps {
  hasMapsKey?: boolean
  language: string
  t: (key: string) => string
  onPlaceSelected: (place: Record<string, unknown>) => void
  onSearchError: (message: string) => void
  searchMode?: SearchMode
}

function createSessionToken(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function normalizePrediction(prediction: AutocompleteSuggestion, index: number): NormalizedPrediction {
  const primaryText = prediction.primary_text || prediction.text || ''
  const secondaryText = prediction.secondary_text || ''
  return {
    kind: 'prediction',
    id: prediction.place_id || `prediction-${index}`,
    placeId: prediction.place_id,
    name: primaryText,
    address: secondaryText,
  }
}

function normalizeSearchResult(result: Record<string, unknown>, index: number): NormalizedSearchResult {
  return {
    kind: 'result',
    id: (result.google_place_id as string) || (result.osm_id as string) || `result-${index}`,
    ...result,
  }
}

export default function PlaceSearchBox({
  hasMapsKey,
  language,
  t,
  onPlaceSelected,
  onSearchError,
  searchMode = 'places',
}: PlaceSearchBoxProps) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<NormalizedItem[]>([])
  const [activeIndex, setActiveIndex] = useState(-1)
  const [isSearching, setIsSearching] = useState(false)
  const [isResolving, setIsResolving] = useState(false)
  const requestIdRef = useRef(0)
  const sessionTokenRef = useRef(createSessionToken())
  const listboxId = useMemo(
    () => `place-search-results-${Math.random().toString(36).slice(2, 10)}`,
    []
  )

  const resetSession = (): void => {
    sessionTokenRef.current = createSessionToken()
  }

  const clearResults = (): void => {
    setResults([])
    setActiveIndex(-1)
  }

  const reportError = (err: unknown): void => {
    const axiosErr = err as { response?: { data?: { error?: string } } }
    const message = axiosErr?.response?.data?.error || t('places.mapsSearchError')
    onSearchError(message)
  }

  useEffect(() => {
    const trimmedQuery = query.trim()
    if (trimmedQuery.length < MIN_AUTOCOMPLETE_CHARS) {
      clearResults()
      setIsSearching(false)
      return
    }

    const currentRequestId = ++requestIdRef.current
    const timer = setTimeout(async () => {
      setIsSearching(true)
      try {
        const data = await mapsApi.autocomplete(trimmedQuery, language, sessionTokenRef.current, {
          mode: searchMode,
        })
        if (requestIdRef.current !== currentRequestId) return
        const suggestions = (data.suggestions || []).map(normalizePrediction)
        if (suggestions.length > 0) {
          setResults(suggestions)
        } else {
          // Autocomplete returned nothing (no API key or no matches) — fall back to text search
          const searchData = await mapsApi.search(trimmedQuery, language)
          if (requestIdRef.current !== currentRequestId) return
          setResults((searchData.places || []).map(normalizeSearchResult))
        }
        setActiveIndex(-1)
      } catch (err) {
        if (requestIdRef.current !== currentRequestId) return
        clearResults()
      } finally {
        if (requestIdRef.current === currentRequestId) {
          setIsSearching(false)
        }
      }
    }, AUTOCOMPLETE_DEBOUNCE_MS)

    return () => clearTimeout(timer)
  }, [query, language, searchMode])

  const runManualSearch = async (): Promise<void> => {
    const trimmedQuery = query.trim()
    if (!trimmedQuery) return

    const currentRequestId = ++requestIdRef.current
    setIsSearching(true)
    try {
      if (searchMode === 'destination') {
        const data = await mapsApi.autocomplete(trimmedQuery, language, sessionTokenRef.current, {
          mode: searchMode,
        })
        if (requestIdRef.current !== currentRequestId) return
        setResults((data.suggestions || []).map(normalizePrediction))
      } else {
        const data = await mapsApi.search(trimmedQuery, language)
        if (requestIdRef.current !== currentRequestId) return
        setResults((data.places || []).map(normalizeSearchResult))
      }
      setActiveIndex(-1)
    } catch (err) {
      if (requestIdRef.current !== currentRequestId) return
      reportError(err)
    } finally {
      if (requestIdRef.current === currentRequestId) {
        setIsSearching(false)
      }
    }
  }

  const selectResult = async (item: NormalizedItem): Promise<void> => {
    if (!item || isResolving) return

    setIsResolving(true)
    try {
      let place: Record<string, unknown> = item as unknown as Record<string, unknown>
      if (item.kind === 'prediction') {
        const data = await mapsApi.details(item.placeId, language, sessionTokenRef.current)
        place = data.place
      }

      onPlaceSelected(place)
      setQuery('')
      clearResults()
      resetSession()
    } catch (err) {
      reportError(err)
    } finally {
      setIsResolving(false)
    }
  }

  const handleKeyDown = async (e: React.KeyboardEvent<HTMLInputElement>): Promise<void> => {
    if (e.key === 'ArrowDown') {
      if (!results.length) return
      e.preventDefault()
      setActiveIndex(prev => (prev + 1) % results.length)
      return
    }

    if (e.key === 'ArrowUp') {
      if (!results.length) return
      e.preventDefault()
      setActiveIndex(prev => (prev <= 0 ? results.length - 1 : prev - 1))
      return
    }

    if (e.key === 'Escape') {
      clearResults()
      return
    }

    if (e.key === 'Enter') {
      e.preventDefault()
      if (activeIndex >= 0 && results[activeIndex]) {
        await selectResult(results[activeIndex])
      } else if (searchMode === 'destination' && results[0]) {
        await selectResult(results[0])
      } else {
        await runManualSearch()
      }
    }
  }

  return (
    <div className="bg-slate-50 rounded-xl p-3 border border-slate-200">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            type="text"
            value={query}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('places.mapsSearchPlaceholder')}
            className="w-full pl-8 pr-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-slate-400 focus:border-transparent bg-white"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={results.length > 0}
            aria-controls={results.length > 0 ? listboxId : undefined}
            aria-activedescendant={activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined}
          />
        </div>
        <button
          type="button"
          onClick={runManualSearch}
          disabled={isSearching || isResolving}
          className="px-3 py-2 bg-slate-900 text-white rounded-lg hover:bg-slate-700 disabled:opacity-50"
          aria-label={t('common.search')}
          title={t('common.search')}
        >
          {isSearching || isResolving ? <Loader className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
        </button>
      </div>

      {results.length > 0 && (
        <div
          id={listboxId}
          role="listbox"
          className="bg-white rounded-lg border border-slate-200 max-h-48 overflow-y-auto mt-2"
        >
          {results.map((item, index) => (
            <button
              key={item.id}
              id={`${listboxId}-option-${index}`}
              type="button"
              role="option"
              aria-selected={activeIndex === index}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => selectResult(item)}
              className={`w-full text-left px-3 py-2.5 transition-colors border-b border-slate-100 last:border-0 ${
                activeIndex === index ? 'bg-slate-100' : 'hover:bg-slate-50'
              }`}
            >
              <p className="text-sm font-medium text-slate-900">
                {item.kind === 'prediction' ? item.name : (item.name as string)}
              </p>
              {item.kind === 'prediction' && item.address && (
                <p className="text-xs text-slate-500 truncate flex items-center gap-1 mt-0.5">
                  <MapPin className="w-3 h-3" />
                  {item.address}
                </p>
              )}
              {item.kind === 'result' && (item.address as string) && (
                <p className="text-xs text-slate-500 truncate flex items-center gap-1 mt-0.5">
                  <MapPin className="w-3 h-3" />
                  {item.address as string}
                </p>
              )}
              {item.kind === 'result' && (item.rating as number) && (
                <p className="text-xs text-amber-600 mt-0.5">★ {item.rating as number}</p>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
