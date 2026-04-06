import type { PhotoProvider } from '../types'

interface ProviderTabsProps {
  availableProviders: PhotoProvider[]
  selectedProvider: string
  onSelectProvider: (providerId: string) => void
}

export function ProviderTabs({ availableProviders, selectedProvider, onSelectProvider }: ProviderTabsProps) {
  if (availableProviders.length < 2) return null

  return (
    <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
      {availableProviders.map(provider => (
        <button
          key={provider.id}
          onClick={() => onSelectProvider(provider.id)}
          style={{
            padding: '6px 12px',
            borderRadius: 99,
            fontSize: 12,
            fontWeight: 600,
            cursor: 'pointer',
            fontFamily: 'inherit',
            border: '1px solid',
            transition: 'all 0.15s',
            background: selectedProvider === provider.id ? 'var(--text-primary)' : 'var(--bg-card)',
            borderColor: selectedProvider === provider.id ? 'var(--text-primary)' : 'var(--border-primary)',
            color: selectedProvider === provider.id ? 'var(--bg-primary)' : 'var(--text-muted)',
            textTransform: 'capitalize',
          }}
        >
          {provider.name}
        </button>
      ))}
    </div>
  )
}
