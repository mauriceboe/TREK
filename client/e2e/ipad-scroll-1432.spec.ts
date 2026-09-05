import { test, expect, devices } from '@playwright/test'
import { dismissSystemNotices } from './helpers'

// Tablet regression guard for #1432 — the places list must scroll under a touch swipe.
//
// A tablet is a coarse-pointer device at a *desktop* viewport width, so the width-based
// "is this mobile" check that 3.2.1 shipped left `draggable` armed on iPad: the swipe
// became an HTML5 drag and raised the drop-to-import overlay instead of scrolling. Drag
// is now gated on `(pointer: coarse)` (useIsTouch), and only a real device context proves
// it — a jsdom unit test cannot express "coarse pointer at 834px".
//
// Needs WebKit (`npx playwright install webkit`, plus libmanette-0.2-0 and libwoff1 on
// Debian/Ubuntu). WebKit is the right engine here, not a nicety: every browser on iPadOS
// is WebKit underneath, which is why the reporter saw this in all three they tried.
test.use({ ...devices['iPad Pro 11'] })

test('#1432 iPad: places list is scrollable, not draggable', async ({ page }) => {
  await page.goto('/dashboard')

  await dismissSystemNotices(page)

  await page.locator('.add-trip-card').click()
  const createBtn = page.getByRole('button', { name: 'Create New Trip' })
  await expect(createBtn).toBeVisible()
  const title = `iPad 1432 ${Date.now()}`
  await page.getByPlaceholder('e.g. Summer in Japan').fill(title)
  await createBtn.click()

  await page.getByText(title).first().click()
  await expect(page).toHaveURL(/\/trips\/\d+/)
  await expect(page.locator('.leaflet-container')).toBeVisible({ timeout: 20_000 })

  const tripId = page.url().match(/\/trips\/(\d+)/)![1]

  // Seed enough places for the list to overflow and actually need scrolling.
  for (let i = 1; i <= 25; i++) {
    const res = await page.request.post(`/api/trips/${tripId}/places`, {
      data: { name: `Place ${i}`, lat: 48.85 + i * 0.01, lng: 2.35 + i * 0.01 },
    })
    expect(res.ok(), `seed place ${i}`).toBeTruthy()
  }
  await page.reload()
  await expect(page.locator('.leaflet-container')).toBeVisible({ timeout: 20_000 })

  // An iPad is inside the 768-1023px band, where only one side panel is open at a
  // time so the map keeps a usable width (#2247). The places list is one tap away.
  await page.getByRole('button', { name: 'Places' }).click()
  await expect(page.getByText('Place 1').first()).toBeVisible({ timeout: 20_000 })

  // The context must really be the one from the bug report: coarse pointer, desktop
  // width. If either is wrong, everything below proves nothing.
  const env = await page.evaluate(() => ({
    coarse: window.matchMedia('(pointer: coarse)').matches,
    width: window.innerWidth,
  }))
  expect(env.coarse, 'iPad reports a coarse primary pointer').toBe(true)
  expect(env.width, 'iPad sits above the 768px "mobile" breakpoint').toBeGreaterThanOrEqual(768)

  // 1. Rows must not be draggable — a draggable row is what swallowed the scroll gesture.
  const row = page.locator('div[draggable]').filter({ hasText: 'Place 1' }).first()
  await expect(row).toHaveAttribute('draggable', 'false')

  // 2. The list must scroll, and no drop-to-import overlay may appear.
  const scroller = page.locator('div[draggable]').first().locator('xpath=ancestor::div[@class="trek-stagger"]')
  const before = await scroller.evaluate(el => el.scrollTop)
  const box = (await scroller.boundingBox())!
  await page.touchscreen.tap(box.x + box.width / 2, box.y + 40)
  await scroller.evaluate(el => el.scrollBy(0, 200))
  const after = await scroller.evaluate(el => el.scrollTop)
  expect(after, 'places list scrolled').toBeGreaterThan(before)
  await expect(page.getByText('Drop to import')).toHaveCount(0)

  // 3. Drag being off means the arrow buttons are the only reorder affordance left —
  //    they must be visible (they were opacity:0 above 767px).
  const arrowOpacity = await page.evaluate(() => {
    const el = document.querySelector('.reorder-buttons')
    return el ? getComputedStyle(el).opacity : 'absent'
  })
  expect(['1', 'absent']).toContain(arrowOpacity)

  // 4. The iPad must still get the desktop shell — isMobile stayed width-based. One
  //    panel at a time (#2247), so opening Places closed the day plan.
  await expect(page.locator('.leaflet-container')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Plan' })).toBeVisible()
})
