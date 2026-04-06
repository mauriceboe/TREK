import type { ReactNode } from 'react'
import { ProviderTabs } from './ProviderTabs'
import type { PhotoProvider } from '../types'

interface PickerTemplateProps {
  title: string
  cancelLabel: string
  availableProviders: PhotoProvider[]
  selectedProvider: string
  onSelectProvider: (providerId: string) => void
  onClose: () => void
  primaryAction?: ReactNode
  controls?: ReactNode
  children: ReactNode
}

export function PickerTemplate({
  title,
  cancelLabel,
  availableProviders,
  selectedProvider,
  onSelectProvider,
  onClose,
  primaryAction,
  controls,
  children,
}: PickerTemplateProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border-secondary)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>{title}</h3>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={onClose}
              style={{
                padding: '7px 14px',
                borderRadius: 10,
                border: '1px solid var(--border-primary)',
                background: 'none',
                fontSize: 12,
                cursor: 'pointer',
                fontFamily: 'inherit',
                color: 'var(--text-muted)',
              }}
            >
              {cancelLabel}
            </button>
            {primaryAction}
          </div>
        </div>

        <div style={{ marginBottom: controls ? 10 : 0 }}>
          <ProviderTabs
            availableProviders={availableProviders}
            selectedProvider={selectedProvider}
            onSelectProvider={onSelectProvider}
          />
        </div>

        {controls}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>{children}</div>
    </div>
  )
}
