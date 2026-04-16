// Journey Photo Book PDF — Polarsteps-inspired, magazine-density
import { marked } from 'marked'
import type { JourneyDetail, JourneyEntry, JourneyPhoto } from '../../store/journeyStore'

function esc(str: string | null | undefined): string {
  if (!str) return ''
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function md(str: string | null | undefined): string {
  if (!str) return ''
  return marked.parse(str, { async: false, breaks: true }) as string
}

function abs(url: string | null | undefined): string {
  if (!url) return ''
  if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('data:')) return url
  return window.location.origin + (url.startsWith('/') ? '' : '/') + url
}

function pSrc(p: JourneyPhoto): string {
  return abs(`/api/photos/${p.photo_id}/original`)
}

function fmtDate(d: string): string {
  const date = new Date(d + 'T00:00:00')
  return date.toLocaleDateString('en', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
}

function fmtShort(d: string): string {
  return new Date(d + 'T00:00:00').toLocaleDateString('en', { month: 'short', day: 'numeric' })
}

function groupByDate(entries: JourneyEntry[]): Map<string, JourneyEntry[]> {
  const groups = new Map<string, JourneyEntry[]>()
  for (const e of entries) {
    if (!e.entry_date) continue
    if (!groups.has(e.entry_date)) groups.set(e.entry_date, [])
    groups.get(e.entry_date)!.push(e)
  }
  return groups
}

function renderProscons(entry: JourneyEntry): string {
  const pc = entry.pros_cons
  if (!pc) return ''
  const pros = pc.pros?.filter(p => p.trim()) || []
  const cons = pc.cons?.filter(c => c.trim()) || []
  if (pros.length === 0 && cons.length === 0) return ''

  return `<div class="verdict-wrap"><div class="verdict-row">
    ${pros.length > 0 ? `<div class="verdict-card pros"><div class="verdict-label">Loved it</div><ul>${pros.map(p => `<li>${esc(p)}</li>`).join('')}</ul></div>` : ''}
    ${cons.length > 0 ? `<div class="verdict-card cons"><div class="verdict-label">Could be better</div><ul>${cons.map(c => `<li>${esc(c)}</li>`).join('')}</ul></div>` : ''}
  </div></div>`
}

function renderPhotoBlock(photos: JourneyPhoto[]): string {
  if (photos.length === 0) return ''
  if (photos.length === 1) {
    return `<div class="entry-photo-single"><img src="${pSrc(photos[0])}" /></div>`
  }
  if (photos.length === 2) {
    return `<div class="entry-photo-duo">${photos.map(p => `<div class="photo-cell"><img src="${pSrc(p)}" /></div>`).join('')}</div>`
  }
  // 3+ photos: hero left + stack right
  return `<div class="entry-photo-trio">
    <div class="photo-hero"><img src="${pSrc(photos[0])}" /></div>
    <div class="photo-stack">
      <div class="photo-cell"><img src="${pSrc(photos[1])}" /></div>
      <div class="photo-cell"><img src="${pSrc(photos[2])}" /></div>
    </div>
  </div>`
}

export async function downloadJourneyBookPDF(journey: JourneyDetail) {
  const entries = (journey.entries || []).filter(e => e.type !== 'skeleton' && e.type !== 'gallery')
  const allPhotos = entries.flatMap(e => e.photos || [])
  const coverUrl = journey.cover_image ? abs(`/uploads/${journey.cover_image}`) : (allPhotos[0] ? pSrc(allPhotos[0]) : '')

  const grouped = groupByDate(entries)
  const dates = [...grouped.keys()].sort()

  // Build entry pages — one per entry, day header inline on first entry of day
  const entryPages: string[] = []
  let pageNum = 1 // cover=1
  dates.forEach((date, di) => {
    const dayEntries = grouped.get(date)!
    dayEntries.forEach((entry, ei) => {
      pageNum++
      const isFirstOfDay = ei === 0
      const photos = entry.photos || []
      const meta = [entry.entry_time, entry.location_name].filter(Boolean).join(' · ')

      // Day header (inline, only on first entry of day)
      const dayHeaderHtml = isFirstOfDay
        ? `<div class="day-header">Day ${di + 1} · ${fmtDate(date)}</div>`
        : ''

      // Photo block
      const photoHtml = renderPhotoBlock(photos)

      // Pros/cons
      const prosconsHtml = renderProscons(entry)

      // Story (markdown)
      const storyHtml = entry.story ? `<div class="entry-story">${md(entry.story)}</div>` : ''

      entryPages.push(`
        <div class="entry-page">
          ${dayHeaderHtml}
          ${photoHtml}
          <div class="entry-content">
            ${meta ? `<div class="entry-meta">${esc(meta)}</div>` : ''}
            ${entry.title ? `<h2 class="entry-title">${esc(entry.title)}</h2>` : ''}
            ${storyHtml}
            ${prosconsHtml}
          </div>
        </div>
      `)
    })
  })

  const totalPages = pageNum + 1 // +1 for closing page

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<base href="${window.location.origin}/">
<title>${esc(journey.title)} — Journey Book</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Inter', -apple-system, sans-serif; color: #1A1A1A; font-size: 11pt; line-height: 1.55; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  img { -webkit-print-color-adjust: exact; print-color-adjust: exact; }

  @page { size: A4 landscape; margin: 0; }

  /* ── Cover ─── */
  .cover-page {
    width: 100%; height: 100vh; position: relative; overflow: hidden;
    background: #0a0a0f; color: white; display: flex; align-items: center; justify-content: center;
    page-break-after: always;
  }
  .cover-bg { position: absolute; inset: 0; background-size: cover; background-position: center; }
  .cover-dim { position: absolute; inset: 0; background: rgba(0,0,0,0.5); }
  .cover-mesh { position: absolute; inset: 0; background: radial-gradient(circle at 20% 30%, rgba(99,102,241,0.2), transparent 50%), radial-gradient(circle at 80% 70%, rgba(236,72,153,0.15), transparent 50%); }
  .cover-content { position: relative; z-index: 2; text-align: center; padding: 60pt; }
  .cover-label { font-size: 9pt; font-weight: 700; letter-spacing: 6pt; text-transform: uppercase; opacity: 0.35; margin-bottom: 24pt; }
  .cover-content h1 { font-size: 56pt; font-weight: 800; letter-spacing: -0.03em; line-height: 0.9; margin-bottom: 10pt; }
  .cover-content .sub { font-size: 14pt; font-weight: 400; opacity: 0.7; margin-bottom: 36pt; }
  .cover-stats { display: flex; gap: 48pt; justify-content: center; }
  .cover-stat-val { font-size: 32pt; font-weight: 800; letter-spacing: -0.02em; }
  .cover-stat-label { font-size: 10pt; text-transform: uppercase; letter-spacing: 2pt; opacity: 0.4; margin-top: 3pt; }
  .cover-footer { position: absolute; bottom: 20pt; left: 0; right: 0; text-align: center; font-size: 9pt; opacity: 0.2; letter-spacing: 3pt; text-transform: uppercase; }

  /* ── TOC ─── */
  .toc-page {
    width: 100%; height: 100vh; padding: 48pt 64pt; display: flex; flex-direction: column;
    background: white; page-break-after: always;
  }
  .toc-top-label { font-size: 9pt; font-weight: 700; letter-spacing: 5pt; text-transform: uppercase; color: #94a3b8; margin-bottom: 16pt; }
  .toc-title-block h2 { font-size: 36pt; font-weight: 800; letter-spacing: -1pt; color: #0a0a0f; margin-bottom: 4pt; }
  .toc-title-block .sub { font-size: 13pt; color: #71717a; margin-bottom: 24pt; }
  .toc-divider { height: 1pt; background: #e4e4e7; margin: 16pt 0; }
  .toc-body { flex: 1; columns: 2; column-gap: 40pt; }
  .toc-day { break-inside: avoid; margin-bottom: 14pt; }
  .toc-day-label { font-size: 9pt; font-weight: 600; letter-spacing: 0.16em; text-transform: uppercase; color: #71717a; margin-bottom: 4pt; }
  .toc-entry { display: flex; align-items: baseline; gap: 4pt; font-size: 11pt; color: #3f3f46; margin-bottom: 2pt; }
  .toc-entry .toc-title { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 200pt; }
  .toc-entry .toc-dots { flex: 1; border-bottom: 1pt dotted #d4d4d8; margin: 0 4pt; min-width: 20pt; }
  .toc-entry .toc-page { font-size: 10pt; color: #a1a1aa; font-weight: 500; flex-shrink: 0; }
  .toc-stats { display: flex; gap: 32pt; margin-top: auto; padding-top: 16pt; border-top: 1pt solid #e4e4e7; }
  .toc-stat-val { font-size: 18pt; font-weight: 800; color: #0a0a0f; }
  .toc-stat-label { font-size: 9pt; text-transform: uppercase; letter-spacing: 1pt; color: #94a3b8; }

  /* ── Entry Page ─── */
  .entry-page {
    width: 100%; min-height: 100vh; padding: 56pt 48pt 48pt;
    page-break-after: always;
    display: flex; flex-direction: column;
  }

  /* Day header — inline */
  .day-header {
    font-size: 9pt; font-weight: 600; letter-spacing: 0.16em; text-transform: uppercase;
    color: #71717a; text-align: center; margin-bottom: 16pt; position: relative;
    display: flex; align-items: center; gap: 12pt;
  }
  .day-header::before, .day-header::after { content: ''; flex: 1; height: 0.5pt; background: #d4d4d8; }

  /* Photos */
  .entry-photo-single { border-radius: 8pt; overflow: hidden; margin-bottom: 16pt; height: 55vh; }
  .entry-photo-single img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .entry-photo-duo { display: grid; grid-template-columns: 1fr 1fr; gap: 6pt; border-radius: 8pt; overflow: hidden; margin-bottom: 16pt; height: 45vh; }
  .entry-photo-trio { display: grid; grid-template-columns: 3fr 2fr; gap: 6pt; border-radius: 8pt; overflow: hidden; margin-bottom: 16pt; height: 50vh; }
  .photo-cell { overflow: hidden; }
  .photo-cell img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .photo-hero { overflow: hidden; }
  .photo-hero img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .photo-stack { display: flex; flex-direction: column; gap: 6pt; }
  .photo-stack .photo-cell { flex: 1; }

  /* Entry content */
  .entry-content { flex: 1; }
  .entry-meta { font-size: 10pt; letter-spacing: 0.04em; text-transform: uppercase; color: #71717a; font-weight: 500; margin-bottom: 6pt; }
  h2.entry-title { font-size: 28pt; font-weight: 700; letter-spacing: -0.02em; line-height: 1.1; margin: 0 0 10pt; color: #0a0a0f; }
  .entry-story { font-size: 11pt; line-height: 1.65; color: #3f3f46; }
  .entry-story p { margin: 0 0 8pt; }
  .entry-story strong { font-weight: 600; color: #0a0a0f; }
  .entry-story em { font-style: italic; }
  .entry-story blockquote { margin: 12pt 0; padding-left: 12pt; border-left: 2pt solid #d4d4d8; font-style: italic; color: #52525b; }
  .entry-story ul, .entry-story ol { margin: 8pt 0; padding-left: 16pt; }
  .entry-story li { margin-bottom: 4pt; }
  .entry-story a { color: #2563eb; text-decoration: none; }

  /* Verdict */
  .verdict-wrap { break-inside: avoid; padding-top: 14pt; }
  .verdict-row { display: flex; gap: 10pt; }
  .verdict-card { flex: 1; padding: 10pt 12pt; border-radius: 6pt; font-size: 9.5pt; }
  .verdict-card.pros { background: #f0fdf4; border: 0.5pt solid #bbf7d0; }
  .verdict-card.cons { background: #fef2f2; border: 0.5pt solid #fecaca; }
  .verdict-label { font-size: 8pt; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; margin-bottom: 6pt; }
  .verdict-card.pros .verdict-label { color: #15803d; }
  .verdict-card.cons .verdict-label { color: #b91c1c; }
  .verdict-card ul { margin: 0; padding: 0; list-style: none; }
  .verdict-card li { padding: 2pt 0; position: relative; padding-left: 10pt; }
  .verdict-card li::before { content: '•'; position: absolute; left: 0; }
  .verdict-card.pros li { color: #14532d; }
  .verdict-card.pros li::before { color: #22c55e; }
  .verdict-card.cons li { color: #7f1d1d; }
  .verdict-card.cons li::before { color: #ef4444; }

  /* ── Closing ─── */
  .closing-page {
    width: 100%; height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #0a0a0f; color: white; text-align: center; page-break-after: auto;
  }
  .closing-title { font-size: 32pt; font-weight: 300; letter-spacing: -1pt; opacity: 0.6; margin-bottom: 8pt; }
  .closing-sub { font-size: 10pt; opacity: 0.25; letter-spacing: 3pt; text-transform: uppercase; }

  /* ── Print ─── */
  @media print {
    .print-bar { display: none !important; }
    body { margin: 0; }
    .entry-page { orphans: 3; widows: 3; }
    h2.entry-title { page-break-after: avoid; }
    .verdict-row { page-break-inside: avoid; }
    .entry-photo-single, .entry-photo-duo, .entry-photo-trio { page-break-after: avoid; }
  }

</style>
</head>
<body>

  <!-- Page 1: Cover -->
  <div class="cover-page">
    ${coverUrl ? `<div class="cover-bg" style="background-image:url('${coverUrl}')"></div>` : ''}
    <div class="cover-dim"></div>
    <div class="cover-mesh"></div>
    <div class="cover-content">
      <div class="cover-label">Journey Book</div>
      <h1>${esc(journey.title)}</h1>
      ${journey.subtitle ? `<div class="sub">${esc(journey.subtitle)}</div>` : ''}
      <div class="cover-stats">
        <div><div class="cover-stat-val">${dates.length}</div><div class="cover-stat-label">Days</div></div>
        <div><div class="cover-stat-val">${entries.length}</div><div class="cover-stat-label">Entries</div></div>
        <div><div class="cover-stat-val">${allPhotos.length}</div><div class="cover-stat-label">Photos</div></div>
      </div>
    </div>
    <div class="cover-footer">Made with TREK</div>
  </div>

  <!-- Entry Pages -->
  ${entryPages.join('\n')}

  <!-- Closing Page -->
  <div class="closing-page">
    <div>
      <div class="closing-title">The End</div>
      <div class="closing-sub">Made with TREK · ${new Date().getFullYear()}</div>
    </div>
  </div>

</body>
</html>`

  // Render in a fixed overlay + srcdoc iframe — same pattern as TripPDF.
  // This avoids window.open() which Safari iOS blocks in async callbacks
  // and window.close() which doesn't work reliably in standalone PWA mode.
  const overlay = document.createElement('div')
  overlay.id = 'journey-pdf-overlay'
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:9999;display:flex;align-items:center;justify-content:center;padding:8px;'
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove() }

  const card = document.createElement('div')
  card.style.cssText = 'width:100%;max-width:1100px;height:95vh;background:#fff;border-radius:12px;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,0.35);'

  const header = document.createElement('div')
  header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:8px 16px;border-bottom:1px solid #e4e4e7;flex-shrink:0;background:#0f172a;'
  header.innerHTML = `
    <span style="font-size:12px;color:rgba(255,255,255,0.45);font-weight:500;letter-spacing:0.03em">${esc(journey.title)} &middot; ${totalPages} pages</span>
    <div style="display:flex;align-items:center;gap:8px">
      <button id="journey-pdf-save" style="min-height:44px;padding:10px 20px;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;border:none;background:#fff;color:#0f172a;">Save as PDF</button>
      <button id="journey-pdf-close" style="min-height:44px;padding:10px 16px;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.1);color:rgba(255,255,255,0.7);">Close</button>
    </div>
  `

  const iframe = document.createElement('iframe')
  iframe.style.cssText = 'flex:1;width:100%;border:none;'
  iframe.sandbox = 'allow-same-origin allow-modals'
  iframe.srcdoc = html

  card.appendChild(header)
  card.appendChild(iframe)
  overlay.appendChild(card)
  document.body.appendChild(overlay)

  header.querySelector<HTMLButtonElement>('#journey-pdf-close')!.onclick = () => overlay.remove()
  header.querySelector<HTMLButtonElement>('#journey-pdf-save')!.onclick = () => { iframe.contentWindow?.print() }
}
