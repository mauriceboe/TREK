import { Jimp } from 'jimp'
import path from 'path'
import fs from 'fs/promises'
import crypto from 'crypto'
import { isAddonEnabled } from '../adminService'
import { ADDON_IDS } from '../../addons'

const THUMB_MAX = 800
const THUMB_QUALITY = 80

export async function ensureLocalThumbnail(
  uploadsRoot: string,
  originalRelPath: string,
): Promise<{ thumbnailRelPath: string; width: number; height: number } | null> {
  if (!isAddonEnabled(ADDON_IDS.JOURNEY)) return null

  const originalAbs = path.join(uploadsRoot, originalRelPath)
  try { await fs.access(originalAbs) } catch { return null }

  // Deterministic name so concurrent requests don't race on the same photo.
  const hash = crypto.createHash('sha1').update(originalRelPath).digest('hex').slice(0, 16)
  const thumbRel = `journey/thumbs/${hash}.jpg`
  const thumbAbs = path.join(uploadsRoot, thumbRel)

  try {
    const [srcStat, dstStat] = await Promise.all([
      fs.stat(originalAbs),
      fs.stat(thumbAbs).catch(() => null),
    ])
    if (dstStat && dstStat.mtimeMs >= srcStat.mtimeMs) {
      const img = await Jimp.read(thumbAbs)
      return { thumbnailRelPath: thumbRel, width: img.bitmap.width, height: img.bitmap.height }
    }

    await fs.mkdir(path.dirname(thumbAbs), { recursive: true })

    // Jimp auto-applies EXIF orientation on read, matching sharp's .rotate() behavior.
    const img = await Jimp.read(originalAbs)
    const { width: w, height: h } = img.bitmap
    if (w > THUMB_MAX || h > THUMB_MAX) {
      img.scaleToFit({ w: THUMB_MAX, h: THUMB_MAX })
    }
    await img.write(thumbAbs as `${string}.jpg`, { quality: THUMB_QUALITY })

    return { thumbnailRelPath: thumbRel, width: img.bitmap.width, height: img.bitmap.height }
  } catch {
    // Unsupported format, corrupt file, etc. — fall back to original in caller.
    return null
  }
}
