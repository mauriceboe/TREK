import React, { useEffect, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { useTripStore } from '../store/tripStore'
import { tripsApi, placesApi } from '../api/client'
import Navbar from '../components/Layout/Navbar'
import FileManager from '../components/Files/FileManager'
import { ArrowLeft } from 'lucide-react'
import { useTranslation } from '../i18n'
import type { Trip, Place, TripFile } from '../types'

export default function FilesPage(): React.ReactElement {
  const { t } = useTranslation()
  const { id: tripId } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const tripStore = useTripStore()

  const [trip, setTrip] = useState<Trip | null>(null)
  const [places, setPlaces] = useState<Place[]>([])
  const [files, setFiles] = useState<TripFile[]>([])
  const [isLoading, setIsLoading] = useState<boolean>(true)

  useEffect(() => {
    loadData()
  }, [tripId])

  const loadData = async (): Promise<void> => {
    setIsLoading(true)
    try {
      const [tripData, placesData] = await Promise.all([
        tripsApi.get(tripId),
        placesApi.list(tripId),
      ])
      setTrip(tripData.trip)
      setPlaces(placesData.places)
      await tripStore.loadFiles(tripId)
    } catch (err: unknown) {
      navigate('/dashboard')
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    setFiles(tripStore.files)
  }, [tripStore.files])

  const handleUpload = async (formData: FormData): Promise<TripFile> => {
    return await tripStore.addFile(tripId as string, formData)
  }

  const handleDelete = async (fileId: number): Promise<void> => {
    await tripStore.deleteFile(tripId, fileId)
  }

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="w-10 h-10 border-4 border-slate-200 border-t-slate-700 rounded-full animate-spin"></div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <Navbar tripTitle={trip?.name} tripId={tripId} showBack onBack={() => navigate(`/trips/${tripId}`)} />

      <div style={{ paddingTop: 'var(--nav-h)' }}>
        <div className="max-w-5xl mx-auto px-4 py-6">
          <div className="flex items-center gap-3 mb-6">
            <Link
              to={`/trips/${tripId}`}
              className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700"
            >
              <ArrowLeft className="w-4 h-4" />
              {t('common.backToPlanning')}
            </Link>
          </div>

          <div className="flex items-center justify-between mb-6">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Dateien & Dokumente</h1>
              <p className="text-gray-500 text-sm">{files.length} Dateien für {trip?.name}</p>
            </div>
          </div>

          <FileManager
            files={files}
            onUpload={handleUpload}
            onDelete={handleDelete}
            places={places}
            tripId={tripId}
          />
        </div>
      </div>
    </div>
  )
}
