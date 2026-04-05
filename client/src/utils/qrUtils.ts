import type { PackingItem } from '../types'

interface QrPackingItem {
  n: string
  q?: number
}

interface QrPackingData {
  t: 'p' // Type identifier for packing lists
  c: string // Category name
  i: QrPackingItem[] // Items
}

/**
 * Encodes a packing list as a universally readable CSV string.
 * Format: Category,Item Name,Quantity
 */
export function encodePackingList(categoryName: string, items: PackingItem[]): string {
  const escape = (str: string) => `"${str.replace(/"/g, '""')}"`
  
  const header = "Category,Item,Quantity"
  const rows = items.map(item => {
    return `${escape(categoryName)},${escape(item.name)},${item.quantity || 1}`
  })
  
  return [header, ...rows].join('\n')
}

/**
 * Decodes a packing list from either the new CSV format or the legacy JSON format.
 */
export function decodePackingList(dataString: string): { category: string, items: Partial<PackingItem>[] } {
  const trimmed = dataString.trim()
  
  // Try legacy JSON format first
  if (trimmed.startsWith('{')) {
    try {
      const data: QrPackingData = JSON.parse(trimmed)
      if (data.t === 'p' && data.c && Array.isArray(data.i)) {
        const category = data.c
        const items: Partial<PackingItem>[] = data.i.map(qrItem => ({
          name: qrItem.n,
          category: category,
          quantity: qrItem.q || 1,
          checked: 0
        }))
        return { category, items }
      }
    } catch (e) {
      // Not JSON, continue to CSV
    }
  }

  // Try CSV format
  const lines = trimmed.split('\n').map(l => l.trim()).filter(Boolean)
  if (lines.length < 2) {
    throw new Error('Invalid QR code format')
  }

  // Check for header (optional but good for validation)
  const isHeader = lines[0].toLowerCase().includes('item') && lines[0].toLowerCase().includes('category')
  const startIdx = isHeader ? 1 : 0
  
  const items: Partial<PackingItem>[] = []
  let detectedCategory = 'Imported'

  for (let i = startIdx; i < lines.length; i++) {
    // Basic CSV parser that handles quotes
    const parts: string[] = []
    let current = ''
    let inQuotes = false
    
    for (let j = 0; j < lines[i].length; j++) {
      const char = lines[i][j]
      if (char === '"') {
        if (inQuotes && lines[i][j+1] === '"') {
          current += '"'
          j++
        } else {
          inQuotes = !inQuotes
        }
      } else if (char === ',' && !inQuotes) {
        parts.push(current.trim())
        current = ''
      } else {
        current += char
      }
    }
    parts.push(current.trim())

    if (parts.length >= 2) {
      detectedCategory = parts[0] || detectedCategory
      items.push({
        name: parts[1],
        category: detectedCategory,
        quantity: parseInt(parts[2], 10) || 1,
        checked: 0
      })
    } else if (parts.length === 1 && parts[0]) {
      // Fallback for single column list
      items.push({
        name: parts[0],
        category: detectedCategory,
        quantity: 1,
        checked: 0
      })
    }
  }

  if (items.length === 0) {
    throw new Error('No items found in QR code')
  }

  return { category: detectedCategory, items }
}
