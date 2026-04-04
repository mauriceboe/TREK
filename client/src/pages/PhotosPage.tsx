import React, { useEffect, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { tripsApi, daysApi, placesApi, photosApi } from '../api/client'
import Navbar from '../components/Layout/Navbar'
import PhotoGallery from '../components/Photos/PhotoGallery'
import { ArrowLeft } from 'lucide-react'
import { useTranslation } from '../i18n'
import type { Trip, Day, Place, Photo } from '../types'

export default function PhotosPage(): React.ReactElement {
  const { t } = useTranslation()
  const { id: tripId } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const [trip, setTrip] = useState<Trip | null>(null)
  const [days, setDays] = useState<Day[]>([])
  const [places, setPlaces] = useState<Place[]>([])
  const [photos, setPhotos] = useState<Photo[]>([])
  const [isLoading, setIsLoading] = useState<boolean>(true)

  useEffect(() => {
    loadData()
  }, [tripId])

  const loadData = async (): Promise<void> => {
    setIsLoading(true)
    try {
      const [tripData, daysData, placesData, photosData] = await Promise.all([
        tripsApi.get(tripId),
        daysApi.list(tripId),
        placesApi.list(tripId),
        photosApi.list(tripId),
      ])
      setTrip(tripData.trip)
      setDays(daysData.days)
      setPlaces(placesData.places)
      setPhotos(photosData.photos || [])
    } catch (err: unknown) {
      navigate('/dashboard')
    } finally {
      setIsLoading(false)
    }
  }

  const handleUpload = async (formData: FormData): Promise<void> => {
    const data = await photosApi.upload(tripId!, formData)
    if (data.photo) setPhotos(prev => [...prev, data.photo])
  }

  const handleDelete = async (photoId: number): Promise<void> => {
    await photosApi.delete(tripId!, photoId)
    setPhotos(prev => prev.filter(p => p.id !== photoId))
  }

  const handleUpdate = async (photoId: number, data: Record<string, string | number | null>): Promise<void> => {
    const result = await photosApi.update(tripId!, photoId, data)
    setPhotos(prev => prev.map(p => p.id === photoId ? { ...p, ...result.photo } : p))
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
        <div className="max-w-7xl mx-auto px-4 py-6">
          {/* Header */}
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
              <h1 className="text-2xl font-bold text-gray-900">Fotos</h1>
              <p className="text-gray-500 text-sm">{photos.length} Fotos für {trip?.name}</p>
            </div>
          </div>

          <PhotoGallery
            photos={photos}
            onUpload={handleUpload}
            onDelete={handleDelete}
            onUpdate={handleUpdate}
            places={places}
            days={days}
            tripId={Number(tripId)}
          />
        </div>
      </div>
    </div>
  )
}
