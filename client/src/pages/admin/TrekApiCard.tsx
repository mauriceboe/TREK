import React from 'react'
import { Check, ChevronRight, Globe2, KeyRound, Library, ShieldOff, WifiOff, X } from 'lucide-react'
import TrekMark from '../../components/shared/TrekMark'
import type { TranslationFn } from '../../types'

interface TrekApiCardProps {
  t: TranslationFn
  /**
   * Whether this instance can actually use it yet. False until the client is
   * wired to the service; the card then says so instead of offering a switch
   * that would do nothing.
   */
  available?: boolean
}

/**
 * The TREK Places API, above the Google key because it is the alternative to it.
 *
 * Given real weight on the page on purpose: it is what makes a key optional
 * instead of expected. The weight comes from the mark, one line of type and a
 * ring — not from a tinted panel, which is what the weather block used to do
 * and what made it shout over the settings it sat next to.
 *
 * Everything a reader can check is a measured number, not a claim: 73.6 million
 * is the row count of the current index, and "no queries logged" is enforced in
 * three places on the server rather than promised here.
 */
/**
 * Proper nouns, so they are not translated. Naming them is also a licence
 * obligation, not decoration: ODbL and CC BY-SA both require attribution
 * wherever their content is shown.
 */
const SOURCES = ['Overture Maps Foundation', 'OpenStreetMap', 'Wikivoyage', 'Wikimedia']

export default function TrekApiCard({ t, available = false }: TrekApiCardProps): React.ReactElement {
  // Reuses the words TREK already has for these fields wherever it has them,
  // so the chip row costs two new strings instead of ten.
  const fields = [
    t('places.formName'),
    t('collections.coordinates'),
    t('places.formCategory'),
    t('places.formAddress'),
    t('admin.trekApi.fieldPhone'),
    t('common.email'),
    t('places.formWebsite'),
    t('places.formDescription'),
    t('inspector.openingHours'),
    t('admin.trekApi.fieldStableId'),
  ]

  const facts = [
    { Icon: Globe2, text: t('admin.trekApi.factPlaces') },
    { Icon: KeyRound, text: t('admin.trekApi.factNoKey') },
    { Icon: WifiOff, text: t('admin.trekApi.factOffline') },
    { Icon: ShieldOff, text: t('admin.trekApi.factPrivacy') },
  ]

  return (
    /* Relative wrapper without overflow so the ribbon may sit ON the edge; the
       clipping the rounded corners need happens one level in. */
    <div className="relative">
      {/* The recommendation, moved here from the Google field. It is the whole
          point of the block: a key should be the exception, not the default.
          Vertical and small on purpose — a wide coloured banner would shout
          over the settings around it, which is what the weather panel used to
          do and what this card is trying not to repeat. */}
      <span
        className="pointer-events-none absolute -top-2 z-10 select-none rounded-md
                   bg-accent px-2 py-0.5 text-[10px] font-medium uppercase
                   tracking-[0.14em] text-accent-text shadow-sm
                   ltr:left-4 rtl:right-4"
      >
        {t('admin.trekApi.badgeDefault')}
      </span>

      <div className="overflow-hidden rounded-xl border border-accent/40 bg-surface-secondary/50 shadow-sm">
      <div className="px-5 pt-6 pb-4">
        <div className="flex items-start justify-between gap-4">
          <TrekMark className="h-8 w-auto text-content" aria-label="TREK Places API" />
          {available && (
            <span className="flex-shrink-0 rounded-full border border-edge-secondary px-2 py-0.5 text-[11px] font-medium text-content-faint">
              {t('admin.trekApi.badgeActive')}
            </span>
          )}
        </div>

        <p className="mt-3 text-sm leading-relaxed text-content-secondary">
          {t('admin.trekApi.tagline')}
        </p>

        <ul className="mt-4 grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
          {facts.map(({ Icon, text }) => (
            <li key={text} className="flex items-center gap-2 text-xs text-content-secondary">
              <Icon className="h-3.5 w-3.5 flex-shrink-0 text-content-faint" aria-hidden="true" />
              {text}
            </li>
          ))}
        </ul>
      </div>

      <details className="group border-t border-edge-faint">
        <summary
          className="flex cursor-pointer list-none items-center gap-2 px-5 py-2.5
                     hover:bg-surface-hover focus-visible:outline-none
                     focus-visible:ring-2 focus-visible:ring-accent
                     [&::-webkit-details-marker]:hidden"
        >
          <ChevronRight
            className="h-4 w-4 flex-shrink-0 text-content-faint transition-transform group-open:rotate-90"
            aria-hidden="true"
          />
          <span className="text-sm font-medium text-content-secondary">{t('admin.trekApi.more')}</span>
        </summary>
        <div className="space-y-2.5 bg-surface-secondary/30 px-5 pb-5 pt-3">
          {/* The fields as chips rather than a paragraph. A list of what you
              get is something you scan, not something you read, and a sentence
              forces the reader to parse commas to answer "is the phone number
              in there". */}
          <div className="rounded-lg border border-edge-faint bg-surface-card/60 p-3">
            <p className="flex items-center gap-1.5 text-xs font-medium text-content-secondary">
              <Check className="h-3.5 w-3.5 text-success" aria-hidden="true" />
              {t('admin.trekApi.included')}
            </p>
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {fields.map(field => (
                <li
                  key={field}
                  className="rounded-full border border-edge-secondary bg-surface-card px-2 py-0.5 text-[11px] text-content-secondary"
                >
                  {field}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs leading-relaxed text-content-faint">
              {t('admin.trekApi.includedNote')}
            </p>
          </div>

          {/* Named as plainly as what IS included. An admin who switches the
              source expecting ratings and a photograph of every restaurant
              should find that out here and not three weeks later. */}
          <div className="rounded-lg border border-edge-faint bg-surface-card/60 p-3">
            <p className="flex items-center gap-1.5 text-xs font-medium text-content-secondary">
              <X className="h-3.5 w-3.5 text-content-faint" aria-hidden="true" />
              {t('admin.trekApi.notIncluded')}
            </p>
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {[t('admin.trekApi.notRatings'), t('admin.trekApi.notPhotos')].map(item => (
                <li
                  key={item}
                  className="rounded-full border border-dashed border-edge-secondary px-2 py-0.5 text-[11px] text-content-faint"
                >
                  {item}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs leading-relaxed text-content-faint">
              {t('admin.trekApi.notIncludedNote')}
            </p>
          </div>

          {/* Attribution, and not in the small print: the licences require the
              sources to be named, and naming them is also the answer to "where
              does this actually come from". */}
          <div className="rounded-lg border border-edge-faint bg-surface-card/60 p-3">
            <p className="flex items-center gap-1.5 text-xs font-medium text-content-secondary">
              <Library className="h-3.5 w-3.5 text-content-faint" aria-hidden="true" />
              {t('admin.trekApi.sourcesLabel')}
            </p>
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {SOURCES.map(source => (
                <li
                  key={source}
                  className="rounded-full border border-edge-secondary px-2 py-0.5 text-[11px] text-content-secondary"
                >
                  {source}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs leading-relaxed text-content-faint">
              {t('admin.trekApi.sourcesNote')}
            </p>
          </div>
        </div>
      </details>
      </div>
    </div>
  )
}
