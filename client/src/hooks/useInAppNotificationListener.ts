import { useEffect } from 'react'
import { addListener, removeListener } from '../api/websocket'
import { useInAppNotificationStore } from '../store/inAppNotificationStore.ts'

export function useInAppNotificationListener(): void {
  const handleNew = useInAppNotificationStore(s => s.handleNewNotification)
  const handleUpdated = useInAppNotificationStore(s => s.handleUpdatedNotification)

  useEffect(() => {
    const listener = (event: Record<string, unknown>) => {
      if (event.type === 'notification:new') {
        handleNew(event.notification as any)
      } else if (event.type === 'notification:updated') {
        handleUpdated(event.notification as any)
      }
    }
    addListener(listener)
    return () => removeListener(listener)
  }, [handleNew, handleUpdated])
}
