import { stubbedFilesApi as filesApi } from '../../api/convexApiStub'
import type { StoreApi } from 'zustand'
import type { TripStoreState } from '../tripStore'
import type { TripFile } from '../../types'
import { getApiErrorMessage } from '../../types'

type SetState = StoreApi<TripStoreState>['setState']
type GetState = StoreApi<TripStoreState>['getState']

// Files still use Express API for upload (Convex file storage TODO)
// This is a temporary bridge until file storage is migrated

export interface FilesSlice {
  loadFiles: (tripId: number | string) => Promise<void>
  addFile: (tripId: number | string, formData: FormData) => Promise<TripFile>
  deleteFile: (tripId: number | string, id: number) => Promise<void>
}

export const createFilesSlice = (set: SetState, get: GetState): FilesSlice => ({
  loadFiles: async (tripId) => {
    try {
      const data = await filesApi.list(tripId)
      set({ files: data.files })
    } catch {
      // Files API may not be available yet
      set({ files: [] })
    }
  },

  addFile: async (tripId, formData) => {
    try {
      const data = await filesApi.upload(tripId, formData)
      set(state => ({ files: [data.file, ...state.files] }))
      return data.file
    } catch (err: unknown) {
      throw new Error(getApiErrorMessage(err, 'Error uploading file'))
    }
  },

  deleteFile: async (tripId, id) => {
    try {
      await filesApi.delete(tripId, id)
      set(state => ({ files: state.files.filter(f => f.id !== id) }))
    } catch (err: unknown) {
      throw new Error(getApiErrorMessage(err, 'Error deleting file'))
    }
  },
})
