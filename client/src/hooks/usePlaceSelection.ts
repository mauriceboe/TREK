import { useState, useCallback } from 'react'

export function usePlaceSelection() {
  const [selectedPlaceId, _setSelectedPlaceId] = useState<number | null>(null)
  const [selectedAssignmentId, setSelectedAssignmentId] = useState<number | null>(null)

  const setSelectedPlaceId = useCallback((placeId: number | null) => {
    _setSelectedPlaceId(placeId)
    setSelectedAssignmentId(null)
  }, [])

  const selectAssignment = useCallback((assignmentId: number | string | null, placeId?: number | string | null) => {
    setSelectedAssignmentId(assignmentId as number | null)
    if (placeId !== undefined) _setSelectedPlaceId(placeId as number | null)
  }, [])

  return { selectedPlaceId, selectedAssignmentId, setSelectedPlaceId, selectAssignment }
}
