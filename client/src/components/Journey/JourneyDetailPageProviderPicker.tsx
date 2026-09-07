import { Calendar, Camera, Check, ChevronRight, Play, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { memoriesApi } from '../../api/client';
import { useTranslation } from '../../i18n';
import {
  groupPhotosByDate,
  sortProviderPhotos,
  type GeoPoint,
} from '../../pages/journeyDetail/JourneyDetailPage.helpers';
import type { JourneyEntry, JourneyTrip } from '../../store/journeyStore';
import { DatePicker } from './JourneyDetailPageDatePicker';
import { ScrollTrigger } from './JourneyDetailPageScrollTrigger';

export type ProviderPhotoGroup = { assetIds: string[]; passphrase?: string; mediaTypes?: string[] };

export function ProviderPicker({
  provider,
  userId,
  entries,
  trips,
  existingAssetIds,
  onClose,
  onAdd,
  initialDate,
  contextLocation,
  initialEntryId,
  embedded = false,
}: {
  provider: string;
  userId: number;
  entries: JourneyEntry[];
  trips: JourneyTrip[];
  existingAssetIds: Set<string>;
  onClose: () => void;
  onAdd: (groups: ProviderPhotoGroup[], entryId: number | null) => Promise<void>;
  initialDate?: string;
  contextLocation?: (GeoPoint & { name?: string }) | null;
  initialEntryId?: number | null;
  embedded?: boolean;
}) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<'day' | 'trip' | 'custom' | 'all' | 'album'>(initialDate ? 'day' : 'trip');
  const [photos, setPhotos] = useState<any[]>([]);
  const [albums, setAlbums] = useState<
    Array<{ id: string; albumName: string; assetCount: number; passphrase?: string }>
  >([]);
  const [selectedAlbum, setSelectedAlbum] = useState<string | null>(null);
  const [selectedAlbumPassphrase, setSelectedAlbumPassphrase] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [searchPage, setSearchPage] = useState(1);
  const [searchFrom, setSearchFrom] = useState('');
  const [searchTo, setSearchTo] = useState('');
  const [selected, setSelected] = useState<Map<string, { albumId?: string; passphrase?: string; mediaType?: string }>>(
    new Map()
  );
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [targetEntryId, setTargetEntryId] = useState<number | null>(initialEntryId ?? null);
  const [addToOpen, setAddToOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  // compute trip range
  const tripRange = useMemo(() => {
    let from = '',
      to = '';
    for (const t of trips) {
      if (t.start_date && (!from || t.start_date < from)) from = t.start_date;
      if (t.end_date && (!to || t.end_date > to)) to = t.end_date;
    }
    return { from, to };
  }, [trips]);

  const cancelPending = () => {
    if (abortRef.current) {
      abortRef.current.abort();
    }
    abortRef.current = new AbortController();
    return abortRef.current.signal;
  };

  const searchPhotos = async (from: string, to: string, page: number = 1, append: boolean = false) => {
    const signal = cancelPending();
    if (page === 1) {
      setLoading(true);
      setPhotos([]);
    } else {
      setLoadingMore(true);
    }
    setSearchFrom(from);
    setSearchTo(to);
    setSearchPage(page);
    try {
      const data = await memoriesApi.search(provider, { from, to, page, size: 50 }, signal);
      const assets = sortProviderPhotos(data.assets || [], contextLocation);
      setPhotos((prev) => (append ? [...prev, ...assets] : assets));
      setHasMore(!!data.hasMore);
    } catch {
      // A cancelled request is about to be replaced by the next one, so leave
      // its paging state alone.
      if (!signal.aborted) setHasMore(false);
    }
    if (!signal.aborted) {
      setLoading(false);
      setLoadingMore(false);
    }
  };

  const loadMorePhotos = () => {
    if (loadingMore || !hasMore) return;
    searchPhotos(searchFrom, searchTo, searchPage + 1, true);
  };

  const loadAlbumPhotos = async (album: { id: string; passphrase?: string }) => {
    const signal = cancelPending();
    setLoading(true);
    setPhotos([]);
    setHasMore(false);
    try {
      const assets = (await memoriesApi.albumPhotos(provider, album.id, album.passphrase, signal)).assets || [];
      setPhotos(sortProviderPhotos(assets, contextLocation));
    } catch {
      /* ignore */
    }
    if (!signal.aborted) setLoading(false);
  };

  const loadAlbums = async () => {
    try {
      setAlbums((await memoriesApi.albums(provider)).albums || []);
    } catch {}
  };

  // load on mount / filter change
  useEffect(() => {
    if (filter === 'day' && initialDate) {
      searchPhotos(initialDate, initialDate);
    } else if (filter === 'trip' && tripRange.from && tripRange.to) {
      searchPhotos(tripRange.from, tripRange.to);
    } else if (filter === 'all') {
      searchPhotos('', '');
    } else if (filter === 'album' && albums.length === 0) {
      loadAlbums();
    }
  }, [filter]);

  const handleCustomSearch = () => {
    if (customFrom && customTo) searchPhotos(customFrom, customTo);
  };

  const toggleAsset = (id: string) => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        const mediaType = (photos as any[]).find((p) => p.id === id)?.mediaType;
        next.set(id, { albumId: selectedAlbum ?? undefined, passphrase: selectedAlbumPassphrase, mediaType });
      }
      return next;
    });
  };

  const targetLabel = targetEntryId
    ? entries.find((e) => e.id === targetEntryId)?.title ||
      entries.find((e) => e.id === targetEntryId)?.entry_date ||
      t('journey.stats.entries')
    : t('journey.picker.newGallery');

  return (
    <div
      data-testid={embedded ? 'journey-provider-picker-embedded' : undefined}
      className={
        embedded
          ? 'flex h-full min-h-0 w-full flex-col overflow-hidden'
          : 'fixed inset-0 z-[9999] flex items-end justify-center overscroll-none bg-[rgba(9,9,11,0.75)] md:items-center md:p-5'
      }
      role="presentation"
      onClick={embedded ? undefined : onClose}
      onTouchMove={(e) => {
        if (!embedded && e.target === e.currentTarget) e.preventDefault();
      }}
    >
      <div
        className={
          embedded
            ? 'flex h-full w-full flex-col overflow-hidden bg-white dark:bg-zinc-900'
            : 'flex max-h-[calc(100dvh-var(--bottom-nav-h)-20px)] w-full max-w-[720px] flex-col overflow-hidden rounded-t-2xl bg-white shadow-[0_20px_40px_rgba(0,0,0,0.2)] md:max-h-[85vh] md:max-w-[960px] md:rounded-2xl dark:bg-zinc-900'
        }
        style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
        role="presentation"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        {!embedded && (
          <div className="flex flex-shrink-0 items-center justify-between border-b border-zinc-200 px-6 py-4 dark:border-zinc-700">
            <h2 className="text-[16px] font-bold text-zinc-900 dark:text-white">
              {provider === 'immich' ? 'Immich' : provider === 'synologyphotos' ? 'Synology Photos' : provider}
            </h2>
            <button
              type="button"
              onClick={onClose}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              <X size={16} />
            </button>
          </div>
        )}

        {/* Filter bar */}
        <div className="flex-shrink-0 border-b border-zinc-200 px-6 py-3 dark:border-zinc-700">
          {/* Tabs */}
          <div className="mb-3 flex gap-1.5">
            {[
              ...(initialDate ? [{ id: 'day' as const, label: t('journey.picker.day') || 'This day' }] : []),
              { id: 'trip' as const, label: t('journey.picker.tripPeriod') },
              { id: 'custom' as const, label: t('journey.picker.dateRange') },
              { id: 'all' as const, label: t('journey.picker.allPhotos'), short: t('common.all') },
              { id: 'album' as const, label: t('journey.picker.albums') },
            ].map((f) => (
              <button
                type="button"
                key={f.id}
                onClick={() => setFilter(f.id)}
                className={`rounded-lg px-3 py-1.5 text-[12px] font-medium transition-colors ${
                  filter === f.id
                    ? 'bg-zinc-900 text-white dark:bg-white dark:text-zinc-900'
                    : 'text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800'
                }`}
              >
                {f.short ? (
                  <>
                    <span className="hidden sm:inline">{f.label}</span>
                    <span className="sm:hidden">{f.short}</span>
                  </>
                ) : (
                  f.label
                )}
              </button>
            ))}
          </div>

          {/* Filter content — always visible row */}
          {(!embedded || filter !== 'day') && (
            <div className="flex min-h-[36px] items-center">
              {filter === 'day' && initialDate && (
                <div className="flex items-center gap-2 text-[12px] text-zinc-500">
                  <Calendar size={13} className="text-zinc-400" />
                  <span className="font-medium text-zinc-900 dark:text-white">
                    {new Date(initialDate + 'T00:00:00').toLocaleDateString(undefined, {
                      weekday: 'long',
                      day: 'numeric',
                      month: 'long',
                      year: 'numeric',
                    })}
                  </span>
                  {contextLocation?.name && <span className="text-zinc-400">· near {contextLocation.name}</span>}
                </div>
              )}
              {filter === 'trip' && (
                <div className="flex items-center gap-2 text-[12px] text-zinc-500">
                  {tripRange.from && tripRange.to ? (
                    <>
                      <Calendar size={13} className="text-zinc-400" />
                      <span className="font-medium text-zinc-900 dark:text-white">
                        {new Date(tripRange.from + 'T00:00:00').toLocaleDateString(undefined, {
                          month: 'short',
                          day: 'numeric',
                        })}
                      </span>
                      <span className="text-zinc-400">&mdash;</span>
                      <span className="font-medium text-zinc-900 dark:text-white">
                        {new Date(tripRange.to + 'T00:00:00').toLocaleDateString(undefined, {
                          month: 'short',
                          day: 'numeric',
                          year: 'numeric',
                        })}
                      </span>
                      <span className="ml-1 text-zinc-400">
                        (
                        {Math.ceil((new Date(tripRange.to).getTime() - new Date(tripRange.from).getTime()) / 86400000) +
                          1}{' '}
                        days)
                      </span>
                    </>
                  ) : (
                    <span className="text-zinc-400">{t('journey.trips.noTripsLinkedSettings')}</span>
                  )}
                </div>
              )}

              {filter === 'custom' && (
                <div className="flex flex-1 items-center gap-2">
                  <div className="flex-1">
                    <DatePicker value={customFrom} onChange={setCustomFrom} />
                  </div>
                  <span className="text-[12px] text-zinc-400">&mdash;</span>
                  <div className="flex-1">
                    <DatePicker value={customTo} onChange={setCustomTo} />
                  </div>
                  <button
                    type="button"
                    onClick={handleCustomSearch}
                    className="flex-shrink-0 rounded-lg bg-zinc-900 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-zinc-800 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-100"
                  >
                    {t('journey.picker.search')}
                  </button>
                </div>
              )}

              {filter === 'album' && (
                <div className="flex flex-1 gap-2 overflow-x-auto">
                  {albums.map((a: any) => (
                    <button
                      type="button"
                      key={a.id}
                      onClick={() => {
                        setSelectedAlbum(a.id);
                        setSelectedAlbumPassphrase(a.passphrase);
                        loadAlbumPhotos(a);
                      }}
                      className={`flex-shrink-0 rounded-lg border px-2.5 py-1 text-[11px] font-medium whitespace-nowrap ${
                        selectedAlbum === a.id
                          ? 'border-zinc-900 bg-zinc-900 text-white dark:border-white dark:bg-white dark:text-zinc-900'
                          : 'border-zinc-200 text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800'
                      }`}
                    >
                      {a.albumName || a.name || 'Album'}
                      {a.assetCount != null ? ` (${a.assetCount})` : ''}
                    </button>
                  ))}
                  {albums.length === 0 && !loading && (
                    <span className="text-[12px] text-zinc-400">{t('journey.picker.noAlbums')}</span>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Add-to entry selector */}
        {!embedded && (
          <div className="flex-shrink-0 border-b border-zinc-200 bg-zinc-50 px-6 py-2.5 dark:border-zinc-700 dark:bg-zinc-800/50">
            <div className="relative flex items-center gap-2">
              <span className="text-[10px] font-semibold tracking-[0.12em] text-zinc-500 uppercase">
                {t('journey.picker.addTo')}
              </span>
              <button
                type="button"
                onClick={() => setAddToOpen(!addToOpen)}
                className="flex items-center gap-1.5 rounded-lg border border-zinc-200 px-3 py-1.5 text-[12px] font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                <span className={targetEntryId ? '' : 'font-semibold'}>{targetLabel}</span>
                <ChevronRight size={12} className="rotate-90 text-zinc-400" />
              </button>
              {addToOpen && (
                <>
                  <div className="fixed inset-0 z-[9]" role="presentation" onClick={() => setAddToOpen(false)} />
                  <div className="absolute top-full left-12 z-10 mt-1 max-h-[240px] min-w-[200px] overflow-y-auto rounded-xl border border-zinc-200 bg-white py-1.5 shadow-lg dark:border-zinc-700 dark:bg-zinc-800">
                    <button
                      type="button"
                      onClick={() => {
                        setTargetEntryId(null);
                        setAddToOpen(false);
                      }}
                      className={`flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] ${
                        !targetEntryId
                          ? 'bg-zinc-100 font-semibold text-zinc-900 dark:bg-zinc-700 dark:text-white'
                          : 'text-zinc-700 hover:bg-zinc-50 dark:text-zinc-300 dark:hover:bg-zinc-700'
                      }`}
                    >
                      <Camera size={12} />
                      {t('journey.picker.newGallery')}
                    </button>
                    {entries.filter(
                      (e) => e.type !== 'skeleton' && e.title !== 'Gallery' && e.title !== '[Trip Photos]'
                    ).length > 0 && <div className="my-1 h-px bg-zinc-200 dark:bg-zinc-700" />}
                    {entries
                      .filter((e) => e.type !== 'skeleton' && e.title !== 'Gallery' && e.title !== '[Trip Photos]')
                      .map((e) => (
                        <button
                          type="button"
                          key={e.id}
                          onClick={() => {
                            setTargetEntryId(e.id);
                            setAddToOpen(false);
                          }}
                          className={`w-full truncate px-3 py-2 text-left text-[12px] ${
                            targetEntryId === e.id
                              ? 'bg-zinc-100 font-semibold text-zinc-900 dark:bg-zinc-700 dark:text-white'
                              : 'text-zinc-700 hover:bg-zinc-50 dark:text-zinc-300 dark:hover:bg-zinc-700'
                          }`}
                        >
                          {e.title ||
                            e.location_name ||
                            new Date(e.entry_date + 'T12:00:00').toLocaleDateString(undefined, {
                              day: 'numeric',
                              month: 'short',
                            })}
                        </button>
                      ))}
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {/* Select all bar — sticky above grid */}
        {!loading &&
          photos.length > 0 &&
          (() => {
            const selectable = photos.filter((a: any) => !existingAssetIds.has(a.id));
            const allSelected = selectable.length > 0 && selectable.every((a: any) => selected.has(a.id));
            if (selectable.length === 0) return null;
            return (
              <div className="flex-shrink-0 border-b border-zinc-200 bg-white px-4 py-2 dark:border-zinc-700 dark:bg-zinc-900">
                <button
                  type="button"
                  onClick={() => {
                    if (allSelected) {
                      setSelected(new Map());
                    } else {
                      setSelected(
                        new Map(
                          selectable.map((a: any) => [
                            a.id,
                            {
                              albumId: selectedAlbum ?? undefined,
                              passphrase: selectedAlbumPassphrase,
                              mediaType: a.mediaType,
                            },
                          ])
                        )
                      );
                    }
                  }}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 px-2.5 py-1 text-[11px] font-medium text-zinc-500 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
                >
                  <div
                    className={`flex h-3.5 w-3.5 items-center justify-center rounded border ${
                      allSelected
                        ? 'border-zinc-900 bg-zinc-900 dark:border-white dark:bg-white'
                        : 'border-zinc-300 dark:border-zinc-600'
                    }`}
                  >
                    {allSelected && <Check size={9} className="text-white dark:text-zinc-900" strokeWidth={3} />}
                  </div>
                  {allSelected ? t('journey.picker.deselectAll') : t('journey.picker.selectAll')} ({selectable.length})
                </button>
              </div>
            );
          })()}

        {/* Photo grid */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
          {loading ? (
            <div className="flex justify-center py-12">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-zinc-300 border-t-zinc-900" />
            </div>
          ) : photos.length === 0 ? (
            <div className="py-12 text-center">
              <p className="text-[13px] text-zinc-500">
                {filter === 'trip' && !tripRange.from
                  ? t('journey.trips.noTripsLinkedSettings')
                  : t('journey.detail.noPhotos')}
              </p>
            </div>
          ) : (
            <div>
              {groupPhotosByDate(photos).map((group) => (
                <div key={group.date}>
                  {(!embedded || filter !== 'day') && (
                    <p className="mt-4 mb-2 text-[11px] font-medium text-zinc-500 first:mt-0 dark:text-zinc-400">
                      {group.label}
                    </p>
                  )}
                  <div className="mb-1 grid grid-cols-3 gap-1.5 sm:grid-cols-4 md:grid-cols-5">
                    {group.assets.map((asset: any) => {
                      const isSelected = selected.has(asset.id);
                      const alreadyAdded = existingAssetIds.has(asset.id);
                      return (
                        <button
                          type="button"
                          key={asset.id}
                          disabled={alreadyAdded}
                          aria-pressed={isSelected}
                          aria-label={asset.city || group.label}
                          onClick={() => !alreadyAdded && toggleAsset(asset.id)}
                          className={`relative block aspect-square w-full overflow-hidden rounded-lg ${
                            alreadyAdded
                              ? 'cursor-not-allowed opacity-40'
                              : isSelected
                                ? 'cursor-pointer ring-2 ring-zinc-900 ring-offset-2 dark:ring-white dark:ring-offset-zinc-900'
                                : 'cursor-pointer'
                          }`}
                        >
                          <img
                            src={`/api/integrations/memories/${provider}/assets/0/${asset.id}/${userId}/thumbnail${selectedAlbumPassphrase ? `?passphrase=${encodeURIComponent(selectedAlbumPassphrase)}` : ''}`}
                            alt=""
                            className="h-full w-full object-cover"
                            loading="lazy"
                            onError={(e) => {
                              const img = e.currentTarget;
                              const original = `/api/integrations/memories/${provider}/assets/0/${asset.id}/${userId}/original${selectedAlbumPassphrase ? `?passphrase=${encodeURIComponent(selectedAlbumPassphrase)}` : ''}`;
                              if (!img.src.includes('/original')) img.src = original;
                            }}
                          />
                          {alreadyAdded && (
                            <div className="absolute top-1.5 right-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-zinc-500 text-white">
                              <Check size={12} />
                            </div>
                          )}
                          {isSelected && !alreadyAdded && (
                            <div className="absolute top-1.5 right-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-zinc-900 text-white dark:bg-white dark:text-zinc-900">
                              <Check size={12} />
                            </div>
                          )}
                          {asset.mediaType === 'video' && (
                            <div className="absolute bottom-1.5 left-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-black/60">
                              <Play size={8} className="ml-px text-white" fill="currentColor" />
                            </div>
                          )}
                          {asset.city && (
                            <div className="absolute right-0 bottom-0 left-0 bg-gradient-to-t from-black/50 to-transparent p-1">
                              <p className="truncate text-[8px] text-white">{asset.city}</p>
                            </div>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
              {/* Infinite scroll trigger */}
              {hasMore && !selectedAlbum && <ScrollTrigger onVisible={loadMorePhotos} loading={loadingMore} />}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex flex-shrink-0 items-center justify-between border-t border-zinc-200 bg-zinc-50 px-6 py-4 dark:border-zinc-700 dark:bg-zinc-800/50">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-zinc-200/60 px-2.5 py-1 text-[11px] leading-none text-zinc-500 dark:bg-zinc-700/60 dark:text-zinc-400">
            <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-zinc-900 px-1 text-[10px] leading-none font-bold text-white dark:bg-white dark:text-zinc-900">
              {selected.size}
            </span>
            <span className="leading-[18px]">{t('journey.picker.selected')}</span>
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-zinc-200 px-3.5 py-2 text-[13px] font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-700"
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              onClick={() => {
                const groupMap = new Map<string | undefined, { assetIds: string[]; mediaTypes: string[] }>();
                for (const [assetId, { passphrase, mediaType }] of selected.entries()) {
                  const g = groupMap.get(passphrase) || { assetIds: [], mediaTypes: [] };
                  g.assetIds.push(assetId);
                  g.mediaTypes.push(mediaType === 'video' ? 'video' : 'image');
                  groupMap.set(passphrase, g);
                }
                const groups = [...groupMap.entries()].map(([passphrase, g]) => ({
                  assetIds: g.assetIds,
                  mediaTypes: g.mediaTypes,
                  passphrase,
                }));
                onAdd(groups, targetEntryId);
              }}
              disabled={selected.size === 0}
              className="rounded-lg bg-zinc-900 px-3.5 py-2 text-[13px] font-medium text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-100"
            >
              {t('common.add')} {selected.size > 0 ? `(${selected.size})` : ''}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
