import apiClient, { postMultipart } from './client'
import type { AxiosResponse } from 'axios'
import type {
  CollectionListResponse,
  CollectionDetailResponse,
  CollectionSaveResult,
  CollectionMembership,
  CollectionCreateRequest,
  CollectionUpdateRequest,
  CollectionSavePlaceRequest,
  CollectionSaveFromTripRequest,
  CollectionImportablesResponse,
  CollectionPlaceUpdateRequest,
  CollectionCopyToTripRequest,
  CollectionInviteRequest,
  CollectionRole,
  CollectionInviteActionRequest,
  CollectionInviteCancelRequest,
  CollectionStatus,
  CollectionSetStatusManyResponse,
  Collection,
  CollectionPlace,
  CollectionLabel,
  CollectionLabelCreateRequest,
  CollectionLabelUpdateRequest,
} from '@trek/shared'

const ax = apiClient
const base = '/addons/collections'

/** Query for the library-wide "is this place already saved?" lookup. */
export interface MembershipQuery {
  google_place_id?: string
  google_ftid?: string
  name?: string
  lat?: number
  lng?: number
}

export interface CopyToTripResult {
  copied: number
  skipped: { id: number; name: string }[]
}

/**
 * Axios calls for the Collections addon (/api/addons/collections). Mirrors the
 * vacayStore api shape — each method returns the unwrapped response body and
 * uses `satisfies` on the request payloads so the shared Zod request types stay
 * the single source of truth.
 */
export const collectionsApi = {
  list: (): Promise<CollectionListResponse> =>
    ax.get(base).then((r: AxiosResponse) => r.data),
  get: (id: number): Promise<CollectionDetailResponse> =>
    ax.get(`${base}/${id}`).then((r: AxiosResponse) => r.data),
  // Both answer with the bare collection, not a { collection } envelope — the
  // controller returns the service's `Collection` straight through, and the e2e
  // suite pins that shape. Declaring the envelope made createCollection() resolve
  // undefined for every caller.
  create: (body: CollectionCreateRequest): Promise<Collection> =>
    ax.post(base, body satisfies CollectionCreateRequest).then((r: AxiosResponse) => r.data),
  update: (id: number, body: CollectionUpdateRequest): Promise<Collection> =>
    ax.patch(`${base}/${id}`, body satisfies CollectionUpdateRequest).then((r: AxiosResponse) => r.data),
  uploadCover: (id: number, formData: FormData): Promise<Collection> =>
    postMultipart(`${base}/${id}/cover`, formData),
  remove: (id: number): Promise<unknown> =>
    ax.delete(`${base}/${id}`).then((r: AxiosResponse) => r.data),
  reorder: (orderedIds: number[]): Promise<unknown> =>
    ax.post(`${base}/reorder`, { orderedIds }).then((r: AxiosResponse) => r.data),

  savePlace: (body: CollectionSavePlaceRequest): Promise<CollectionSaveResult> =>
    ax.post(`${base}/places`, body satisfies CollectionSavePlaceRequest).then((r: AxiosResponse) => r.data),
  saveFromTrip: (body: CollectionSaveFromTripRequest): Promise<CollectionSaveResult> =>
    ax.post(`${base}/places/from-trip`, body satisfies CollectionSaveFromTripRequest).then((r: AxiosResponse) => r.data),
  saveFromTripMany: (collectionId: number, tripId: number, placeIds: number[], force?: boolean): Promise<{ copied: number; skipped: { id: number; name: string }[] }> =>
    ax.post(`${base}/places/from-trip-many`, { collection_id: collectionId, source_trip_id: tripId, source_place_ids: placeIds, force }).then((r: AxiosResponse) => r.data),
  importable: (collectionId: number, tripId: number): Promise<CollectionImportablesResponse> =>
    ax.get(`${base}/${collectionId}/importable/${tripId}`).then((r: AxiosResponse) => r.data),
  updatePlace: (pid: number, body: CollectionPlaceUpdateRequest): Promise<CollectionPlace> =>
    ax.patch(`${base}/places/${pid}`, body satisfies CollectionPlaceUpdateRequest).then((r: AxiosResponse) => r.data),
  uploadPlaceImage: (pid: number, formData: FormData): Promise<CollectionPlace> =>
    postMultipart(`${base}/places/${pid}/image`, formData),
  setStatus: (pid: number, status: CollectionStatus): Promise<CollectionPlace> =>
    ax.post(`${base}/places/${pid}/status`, { status }).then((r: AxiosResponse) => r.data),
  setStatusMany: (ids: number[], status: CollectionStatus): Promise<CollectionSetStatusManyResponse> =>
    ax.post(`${base}/places/status-many`, { ids, status }).then((r: AxiosResponse) => r.data),
  setStatusFromTrip: (tripId: number, placeIds: number[], status: CollectionStatus): Promise<CollectionSetStatusManyResponse> =>
    ax.post(`${base}/places/status-from-trip`, { trip_id: tripId, place_ids: placeIds, status }).then((r: AxiosResponse) => r.data),
  ratePlace: (pid: number, rating: number | null): Promise<CollectionPlace> =>
    rating === null
      ? ax.delete(`${base}/places/${pid}/rating`).then((r: AxiosResponse) => r.data)
      : ax.put(`${base}/places/${pid}/rating`, { rating }).then((r: AxiosResponse) => r.data),
  deletePlace: (pid: number): Promise<unknown> =>
    ax.delete(`${base}/places/${pid}`).then((r: AxiosResponse) => r.data),
  deleteMany: (ids: number[]): Promise<unknown> =>
    ax.post(`${base}/places/delete-many`, { ids }).then((r: AxiosResponse) => r.data),

  copyToTrip: (body: CollectionCopyToTripRequest): Promise<CopyToTripResult> =>
    ax.post(`${base}/copy-to-trip`, body satisfies CollectionCopyToTripRequest).then((r: AxiosResponse) => r.data),
  membership: (params: MembershipQuery): Promise<CollectionMembership> =>
    ax.get(`${base}/membership`, { params }).then((r: AxiosResponse) => r.data),

  invite: (collectionId: number, userId: number, role?: CollectionRole): Promise<unknown> =>
    ax.post(`${base}/invite`, { collection_id: collectionId, user_id: userId, role } satisfies CollectionInviteRequest).then((r: AxiosResponse) => r.data),
  setMemberRole: (collectionId: number, userId: number, role: CollectionRole): Promise<unknown> =>
    ax.post(`${base}/members/role`, { collection_id: collectionId, user_id: userId, role }).then((r: AxiosResponse) => r.data),
  acceptInvite: (collectionId: number): Promise<unknown> =>
    ax.post(`${base}/invite/accept`, { collection_id: collectionId } satisfies CollectionInviteActionRequest).then((r: AxiosResponse) => r.data),
  declineInvite: (collectionId: number): Promise<unknown> =>
    ax.post(`${base}/invite/decline`, { collection_id: collectionId } satisfies CollectionInviteActionRequest).then((r: AxiosResponse) => r.data),
  cancelInvite: (collectionId: number, userId: number): Promise<unknown> =>
    ax.post(`${base}/invite/cancel`, { collection_id: collectionId, user_id: userId } satisfies CollectionInviteCancelRequest).then((r: AxiosResponse) => r.data),
  leave: (collectionId: number): Promise<unknown> =>
    ax.post(`${base}/leave`, { collection_id: collectionId }).then((r: AxiosResponse) => r.data),
  removeMember: (collectionId: number, userId: number): Promise<unknown> =>
    ax.post(`${base}/members/remove`, { collection_id: collectionId, user_id: userId }).then((r: AxiosResponse) => r.data),
  availableUsers: (id: number): Promise<{ users: { id: number; username: string }[] }> =>
    ax.get(`${base}/${id}/available-users`).then((r: AxiosResponse) => r.data),

  createLabel: (collectionId: number, name: string, color?: string): Promise<CollectionLabel> =>
    ax.post(`${base}/labels`, { collection_id: collectionId, name, color } satisfies CollectionLabelCreateRequest).then((r: AxiosResponse) => r.data),
  updateLabel: (labelId: number, body: CollectionLabelUpdateRequest): Promise<CollectionLabel> =>
    ax.patch(`${base}/labels/${labelId}`, body satisfies CollectionLabelUpdateRequest).then((r: AxiosResponse) => r.data),
  deleteLabel: (labelId: number): Promise<unknown> =>
    ax.delete(`${base}/labels/${labelId}`).then((r: AxiosResponse) => r.data),
  assignLabels: (labelIds: number[], placeIds: number[]): Promise<{ changed: number }> =>
    ax.post(`${base}/labels/assign`, { label_ids: labelIds, place_ids: placeIds }).then((r: AxiosResponse) => r.data),
  unassignLabels: (labelIds: number[], placeIds: number[]): Promise<{ changed: number }> =>
    ax.post(`${base}/labels/unassign`, { label_ids: labelIds, place_ids: placeIds }).then((r: AxiosResponse) => r.data),
}
