import { useState, useEffect, useRef, useCallback, type ClipboardEvent, type DragEvent } from 'react'
import { collabApi } from '../../api/client'
import { useSettingsStore } from '../../store/settingsStore'
import { useCanDo } from '../../store/permissionsStore'
import { useTripStore } from '../../store/tripStore'
import { addListener, removeListener } from '../../api/websocket'
import { useTranslation } from '../../i18n'
import { useToast } from '../shared/Toast'

export function useCollabChat(tripId: any, currentUser: any) {
  const { t } = useTranslation()
  const toast = useToast()
  const is12h = useSettingsStore(s => s.settings.time_format) === '12h'
  const can = useCanDo()
  const trip = useTripStore((s) => s.trip)
  const canEdit = can('collab_edit', trip)

  const [messages, setMessages] = useState([])
  const [loading, setLoading] = useState(true)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [text, setText] = useState('')
  const [replyTo, setReplyTo] = useState(null)
  const [hoveredId, setHoveredId] = useState(null)
  const [sending, setSending] = useState(false)
  const [imageFiles, setImageFiles] = useState<File[]>([])
  const [imagePreviews, setImagePreviews] = useState<string[]>([])
  const [uploadProgress, setUploadProgress] = useState(0)
  const [showEmoji, setShowEmoji] = useState(false)
  const [reactMenu, setReactMenu] = useState(null) // { msgId, x, y }
  const [deletingIds, setDeletingIds] = useState(new Set())
  const deleteTimersRef = useRef<ReturnType<typeof setTimeout>[]>([])

  useEffect(() => {
    return () => { deleteTimersRef.current.forEach(clearTimeout) }
  }, [])

  const containerRef = useRef(null)
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const scrollRef = useRef(null)
  const textareaRef = useRef(null)
  const emojiBtnRef = useRef(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const isAtBottom = useRef(true)

  const scrollToBottom = useCallback((behavior = 'auto') => {
    const el = scrollRef.current
    if (!el) return
    requestAnimationFrame(() => el.scrollTo({ top: el.scrollHeight, behavior }))
  }, [])

  const checkAtBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    isAtBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
  }, [])

  /* ── load messages ── */
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    collabApi.getMessages(tripId).then(data => {
      if (cancelled) return
      const msgs = (Array.isArray(data) ? data : data.messages || []).map(m => m.deleted ? { ...m, _deleted: true } : m)
      setMessages(msgs)
      setHasMore(msgs.length >= 100)
      setLoading(false)
      setTimeout(() => scrollToBottom(), 30)
    }).catch(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [tripId, scrollToBottom])

  /* ── load more ── */
  const handleLoadMore = useCallback(async () => {
    if (loadingMore || messages.length === 0) return
    setLoadingMore(true)
    const el = scrollRef.current
    const prevHeight = el ? el.scrollHeight : 0
    try {
      const data = await collabApi.getMessages(tripId, messages[0]?.id)
      const older = (Array.isArray(data) ? data : data.messages || []).map(m => m.deleted ? { ...m, _deleted: true } : m)
      if (older.length === 0) { setHasMore(false) }
      else {
        setMessages(prev => [...older, ...prev])
        setHasMore(older.length >= 100)
        requestAnimationFrame(() => { if (el) el.scrollTop = el.scrollHeight - prevHeight })
      }
    } catch {} finally { setLoadingMore(false) }
  }, [tripId, loadingMore, messages])

  /* ── websocket ── */
  useEffect(() => {
    const handler = (event) => {
      if (event.type === 'collab:message:created' && String(event.tripId) === String(tripId)) {
        setMessages(prev => prev.some(m => m.id === event.message.id) ? prev : [...prev, event.message])
        if (isAtBottom.current) setTimeout(() => scrollToBottom('smooth'), 30)
      }
      if (event.type === 'collab:message:deleted' && String(event.tripId) === String(tripId)) {
        setMessages(prev => prev.map(m => m.id === event.messageId ? { ...m, _deleted: true } : m))
        if (isAtBottom.current) setTimeout(() => scrollToBottom('smooth'), 50)
      }
      if (event.type === 'collab:message:reacted' && String(event.tripId) === String(tripId)) {
        setMessages(prev => prev.map(m => m.id === event.messageId ? { ...m, reactions: event.reactions } : m))
      }
    }
    addListener(handler)
    return () => removeListener(handler)
  }, [tripId, scrollToBottom])

  /* ── auto-resize textarea ── */
  const handleTextChange = useCallback((e) => {
    setText(e.target.value)
    const ta = textareaRef.current
    if (ta) {
      ta.style.height = 'auto'
      const h = Math.min(ta.scrollHeight, 100)
      ta.style.height = h + 'px'
      ta.style.overflowY = ta.scrollHeight > 100 ? 'auto' : 'hidden'
    }
  }, [])

  /* ── send ── */
  const addImageFiles = useCallback((incoming: File[] | FileList) => {
    const valid = Array.from(incoming).filter(f => ['image/jpeg','image/png','image/gif','image/webp'].includes(f.type) && f.size <= 10 * 1024 * 1024)
    if (valid.length !== Array.from(incoming).length) toast.error('Only JPEG, PNG, GIF, and WebP images up to 10 MB are allowed')
    setImageFiles(prev => {
      const next = [...prev, ...valid].slice(0, 4)
      setImagePreviews(next.map(f => URL.createObjectURL(f)))
      return next
    })
  }, [toast])
  const removeImage = useCallback((index: number) => {
    setImageFiles(prev => { const next = prev.filter((_, i) => i !== index); setImagePreviews(urls => { if (urls[index]) URL.revokeObjectURL(urls[index]); return next.map(f => URL.createObjectURL(f)) }); return next })
  }, [])
  const handlePaste = useCallback((e: ClipboardEvent) => { if (e.clipboardData.files.length) addImageFiles(e.clipboardData.files) }, [addImageFiles])
  const handleDrop = useCallback((e: DragEvent) => { e.preventDefault(); addImageFiles(e.dataTransfer.files) }, [addImageFiles])

  const handleSend = useCallback(async () => {
    const body = text.trim()
    if ((!body && !imageFiles.length) || sending) return
    setSending(true)
    try {
      let data
      if (imageFiles.length) {
        const form = new FormData(); if (body) form.append('text', body); if (replyTo) form.append('reply_to', String(replyTo.id)); imageFiles.forEach(file => form.append('images', file))
        data = await collabApi.sendMessage(tripId, form, { onUploadProgress: e => setUploadProgress(e.total ? Math.round((e.loaded / e.total) * 100) : 0) })
      } else {
        const payload: { text: string; reply_to?: number } = { text: body }; if (replyTo) payload.reply_to = replyTo.id
        data = await collabApi.sendMessage(tripId, payload)
      }
      if (data?.message) {
        setMessages(prev => prev.some(m => m.id === data.message.id) ? prev : [...prev, data.message])
      }
      setText(''); setReplyTo(null); setShowEmoji(false); imagePreviews.forEach(URL.revokeObjectURL); setImageFiles([]); setImagePreviews([]); setUploadProgress(0)
      if (textareaRef.current) textareaRef.current.style.height = 'auto'
      isAtBottom.current = true
      setTimeout(() => scrollToBottom('smooth'), 50)
    } catch { toast.error(t('common.error')) } finally { setSending(false) }
  }, [text, sending, replyTo, tripId, scrollToBottom, toast, t, imageFiles, imagePreviews])

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() }
  }, [handleSend])

  const handleDelete = useCallback(async (msgId) => {
    const msg = messages.find(m => m.id === msgId)
    requestAnimationFrame(() => {
      setDeletingIds(prev => new Set(prev).add(msgId))
    })
    const timer = setTimeout(async () => {
      try {
        await collabApi.deleteMessage(tripId, msgId)
        setMessages(prev => prev.map(m => m.id === msgId ? { ...m, _deleted: true } : m))
      } catch { toast.error(t('common.error')) }
      setDeletingIds(prev => { const s = new Set(prev); s.delete(msgId); return s })
    }, 400)
    deleteTimersRef.current.push(timer)
  }, [tripId, toast, t])

  const handleReact = useCallback(async (msgId, emoji) => {
    setReactMenu(null)
    try {
      const data = await collabApi.reactMessage(tripId, msgId, emoji)
      setMessages(prev => prev.map(m => m.id === msgId ? { ...m, reactions: data.reactions } : m))
    } catch { toast.error(t('common.error')) }
  }, [tripId, toast, t])

  const handleEmojiSelect = useCallback((emoji) => {
    setText(prev => prev + emoji)
    textareaRef.current?.focus()
  }, [])

  const isOwn = (msg) => String(msg.user_id) === String(currentUser.id)

  // Check if message is only emoji (1-3 emojis, no other text)
  const isEmojiOnly = (text) => {
    const emojiRegex = /^(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}[️]?(?:‍\p{Extended_Pictographic}[️]?)*){1,3}$/u
    return emojiRegex.test(text.trim())
  }

  return { currentUser, tripId, t, is12h, can, trip, canEdit, messages, setMessages, loading, setLoading, hasMore, setHasMore, loadingMore, setLoadingMore, text, setText, replyTo, setReplyTo, hoveredId, setHoveredId, sending, setSending, showEmoji, setShowEmoji, reactMenu, setReactMenu, deletingIds, setDeletingIds, deleteTimersRef, containerRef, messagesRef, scrollRef, textareaRef, emojiBtnRef, imageInputRef, imageFiles, imagePreviews, uploadProgress, addImageFiles, removeImage, handlePaste, handleDrop, isAtBottom, scrollToBottom, checkAtBottom, handleLoadMore, handleTextChange, handleSend, handleKeyDown, handleDelete, handleReact, handleEmojiSelect, isOwn, isEmojiOnly }
}
