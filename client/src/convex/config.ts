export const convexUrl = String(import.meta.env.VITE_CONVEX_URL || '').trim()

export function isConvexConfigured(): boolean {
  return convexUrl.length > 0
}
