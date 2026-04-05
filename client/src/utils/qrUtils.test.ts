import { describe, it, expect } from 'vitest'
import { encodePackingList, decodePackingList } from './qrUtils'
import type { PackingItem } from '../types'

describe('qrUtils', () => {
  const mockItems: PackingItem[] = [
    { id: 1, trip_id: 1, name: 'Passport', category: 'Documents', checked: 0, quantity: 1 },
    { id: 2, trip_id: 1, name: 'T-Shirts', category: 'Clothing', checked: 0, quantity: 5 },
  ]

  it('should encode a packing list correctly (CSV)', () => {
    const encoded = encodePackingList('Travel', mockItems)
    
    // Check header
    expect(encoded).toContain('Category,Item,Quantity')
    // Check rows
    expect(encoded).toContain('"Travel","Passport",1')
    expect(encoded).toContain('"Travel","T-Shirts",5')
    
    // Test round-trip
    const { category, items } = decodePackingList(encoded)
    expect(category).toBe('Travel')
    expect(items).toHaveLength(2)
    expect(items[0].name).toBe('Passport')
    expect(items[1].name).toBe('T-Shirts')
    expect(items[1].quantity).toBe(5)
  })

  it('should decode a legacy JSON QR string correctly', () => {
    const jsonString = JSON.stringify({
      t: 'p',
      c: 'Backpacking',
      i: [{ n: 'Tent' }, { n: 'Sleeping Bag', q: 1 }]
    })
    
    const { category, items } = decodePackingList(jsonString)
    
    expect(category).toBe('Backpacking')
    expect(items).toHaveLength(2)
    expect(items[0].name).toBe('Tent')
    expect(items[0].category).toBe('Backpacking')
    expect(items[1].name).toBe('Sleeping Bag')
    expect(items[1].quantity).toBe(1)
  })

  it('should handle CSV with special characters', () => {
    const itemsWithQuotes: PackingItem[] = [
      { id: 1, trip_id: 1, name: 'Item with "Quotes"', category: 'My, Category', checked: 0, quantity: 1 }
    ]
    const encoded = encodePackingList('My, Category', itemsWithQuotes)
    const { category, items } = decodePackingList(encoded)
    
    expect(category).toBe('My, Category')
    expect(items[0].name).toBe('Item with "Quotes"')
  })

  it('should handle CSV with missing quantity column', () => {
    const csvData = `Category,Item
Documents,Passport
Clothing,Socks`
    
    const { items } = decodePackingList(csvData)
    expect(items).toHaveLength(2)
    expect(items[0].name).toBe('Passport')
    expect(items[0].quantity).toBe(1) // Default value
  })

  it('should handle CSV without a header', () => {
    const csvData = `"Personal","Wallet",1
"Personal","Phone",1`
    
    const { category, items } = decodePackingList(csvData)
    expect(category).toBe('Personal')
    expect(items).toHaveLength(2)
    expect(items[1].name).toBe('Phone')
  })

  it('should handle extra whitespace and CRLF', () => {
    const csvData = "Category, Item, Quantity \r\n Travel , Map , 2 \r\n\r\n"
    const { items } = decodePackingList(csvData)
    expect(items).toHaveLength(1)
    expect(items[0].name).toBe('Map')
    expect(items[0].quantity).toBe(2)
  })

  it('should throw error for invalid format', () => {
    expect(() => decodePackingList('Just one line')).toThrow('Invalid QR code format')
    expect(() => decodePackingList('   \n   ')).toThrow('Invalid QR code format')
  })
})
