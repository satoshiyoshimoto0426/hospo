// Excel file reading utility for Cloudflare Workers
import ExcelJS from 'exceljs'

// Maximum text length per person (to prevent token overflow)
const MAX_CHARS_PER_SECTION = 10000

export interface PersonRecord {
  name: string
  content: string
}

/**
 * Read Excel file and extract person records
 * Supports multiple sheet formats
 */
export async function extractFromExcel(buffer: ArrayBuffer): Promise<Map<string, string>> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer)
  
  const sections = new Map<string, string>()
  let totalRecordsFound = 0
  
  console.log(`Excel file has ${workbook.worksheets.length} sheets`)
  
  // Process each worksheet
  for (const worksheet of workbook.worksheets) {
    console.log(`Processing sheet: ${worksheet.name}`)
    
    // Try different extraction strategies
    const records = await extractRecordsFromSheet(worksheet)
    
    for (const record of records) {
      if (record.name && record.content) {
        // Apply length limit
        let content = record.content
        if (content.length > MAX_CHARS_PER_SECTION) {
          console.warn(`Truncating content for ${record.name}: ${content.length} -> ${MAX_CHARS_PER_SECTION}`)
          content = content.substring(0, MAX_CHARS_PER_SECTION) + '...[以下省略]'
        }
        
        // Merge if same person appears in multiple sheets
        if (sections.has(record.name)) {
          const existing = sections.get(record.name)!
          const combined = existing + '\n\n' + content
          if (combined.length > MAX_CHARS_PER_SECTION) {
            sections.set(record.name, combined.substring(0, MAX_CHARS_PER_SECTION) + '...[以下省略]')
          } else {
            sections.set(record.name, combined)
          }
        } else {
          sections.set(record.name, content)
        }
        totalRecordsFound++
      }
    }
  }
  
  console.log(`Total records extracted: ${totalRecordsFound}`)
  
  // If no records found, return error indicator
  if (sections.size === 0) {
    throw new Error('Excelファイルから利用者記録を抽出できませんでした。ファイル形式を確認してください。')
  }
  
  return sections
}

/**
 * Extract records from a single worksheet
 * Tries multiple strategies to find the data
 */
async function extractRecordsFromSheet(worksheet: ExcelJS.Worksheet): Promise<PersonRecord[]> {
  const records: PersonRecord[] = []
  
  // Strategy 1: Each sheet is one person (sheet name is person name) - PRIORITIZED
  // This is the most common format for care facility records
  const sheetAsPersonRecord = extractSheetAsPerson(worksheet)
  if (sheetAsPersonRecord) {
    console.log(`Found person record from sheet name: ${sheetAsPersonRecord.name}`)
    return [sheetAsPersonRecord]
  }
  
  // Strategy 2: Look for structured data with name column
  const structuredRecords = extractStructuredRecords(worksheet)
  if (structuredRecords.length > 0) {
    console.log(`Found ${structuredRecords.length} structured records`)
    return structuredRecords
  }
  
  // Strategy 3: Look for name patterns in cells
  const patternBasedRecords = extractByNamePatterns(worksheet)
  if (patternBasedRecords.length > 0) {
    console.log(`Found ${patternBasedRecords.length} pattern-based records`)
    return patternBasedRecords
  }
  
  return records
}

/**
 * Strategy 2: Extract structured records (name column + content column)
 */
function extractStructuredRecords(worksheet: ExcelJS.Worksheet): PersonRecord[] {
  const records: PersonRecord[] = []
  const rows = worksheet.getRows(1, worksheet.rowCount) || []
  
  // Look for header row with name-related columns
  let nameColumnIndex = -1
  let contentColumnIndices: number[] = []
  
  // Check first few rows for headers
  for (let i = 0; i < Math.min(5, rows.length); i++) {
    const row = rows[i]
    if (!row) continue
    
    row.eachCell((cell, colNumber) => {
      const value = String(cell.value || '')
      const valueLower = value.toLowerCase()
      
      // Look for name column
      if (valueLower.includes('氏名') || valueLower.includes('名前') || 
          valueLower.includes('利用者名') || valueLower.includes('対象者') ||
          valueLower === 'name' || valueLower === 'person') {
        nameColumnIndex = colNumber
      }
      
      // Look for content columns (can be multiple)
      if (valueLower.includes('記録') || valueLower.includes('内容') || 
          valueLower.includes('経過') || valueLower.includes('状況') ||
          valueLower.includes('様子') || valueLower.includes('備考') ||
          valueLower.includes('コメント') || valueLower.includes('所見')) {
        if (!contentColumnIndices.includes(colNumber)) {
          contentColumnIndices.push(colNumber)
        }
      }
    })
    
    if (nameColumnIndex > 0 && contentColumnIndices.length > 0) {
      break
    }
  }
  
  // If no specific content column found, use all columns after name column
  if (nameColumnIndex > 0 && contentColumnIndices.length === 0) {
    const firstRow = rows[0]
    if (firstRow) {
      for (let col = nameColumnIndex + 1; col <= firstRow.cellCount; col++) {
        contentColumnIndices.push(col)
      }
    }
  }
  
  // Extract data if columns found
  if (nameColumnIndex > 0 && contentColumnIndices.length > 0) {
    // Start from row after headers
    const startRow = nameColumnIndex > 0 ? 1 : 0
    
    for (let i = startRow; i < rows.length; i++) {
      const row = rows[i]
      if (!row) continue
      
      const name = sanitizeCellValue(row.getCell(nameColumnIndex).value)
      if (!name) continue
      
      // Collect content from all content columns
      const contentParts: string[] = []
      for (const colIndex of contentColumnIndices) {
        const cellValue = sanitizeCellValue(row.getCell(colIndex).value)
        if (cellValue && cellValue.length > 0) {
          contentParts.push(cellValue)
        }
      }
      
      const content = contentParts.join(' ').trim()
      
      // Ensure name has honorific
      const nameWithHonorific = ensureHonorific(name)
      
      if (nameWithHonorific && content && content.length > 10) {
        // Check if we already have this person
        const existing = records.find(r => r.name === nameWithHonorific)
        if (existing) {
          // Append to existing content
          existing.content += '\n' + content
        } else {
          records.push({ name: nameWithHonorific, content })
        }
      }
    }
  }
  
  return records
}

/**
 * Strategy 3: Extract by searching for name patterns in content
 */
function extractByNamePatterns(worksheet: ExcelJS.Worksheet): PersonRecord[] {
  const records: PersonRecord[] = []
  const rows = worksheet.getRows(1, worksheet.rowCount) || []
  
  let currentPerson: string | null = null
  let currentContent: string[] = []
  
  for (const row of rows) {
    if (!row) continue
    
    let rowText = ''
    row.eachCell((cell) => {
      const value = sanitizeCellValue(cell.value)
      if (value) {
        rowText += value + ' '
      }
    })
    rowText = rowText.trim()
    
    if (!rowText) continue
    
    // Check if this row contains a person name at the beginning
    // Patterns to match:
    // 1. Name with honorific: "山田太郎様", "A様", "B様"
    // 2. Name with colon: "山田太郎:", "利用者: 山田太郎"
    // 3. Bracketed name: "【山田太郎】", "[山田太郎様]"
    
    let foundName: string | null = null
    let remainingContent = rowText
    
    // Pattern 1: Name with honorific at start of line
    const honorificMatch = rowText.match(/^([A-Za-zぁ-んァ-ヶー一-龥]{1,}(?:様|さん|氏|殿|君|ちゃん))[\s　：:】\]、。]/);
    if (honorificMatch) {
      foundName = honorificMatch[1]
      remainingContent = rowText.substring(honorificMatch[0].length).trim()
    }
    
    // Pattern 2: Labeled name
    if (!foundName) {
      const labelMatch = rowText.match(/^(?:利用者|対象者|氏名|名前)[\s　]*[:：]\s*([A-Za-zぁ-んァ-ヶー一-龥]{1,}(?:様|さん|氏)?)/);
      if (labelMatch) {
        foundName = ensureHonorific(labelMatch[1])
        remainingContent = rowText.substring(labelMatch[0].length).trim()
      }
    }
    
    // Pattern 3: Bracketed name
    if (!foundName) {
      const bracketMatch = rowText.match(/^[【\[]([A-Za-zぁ-んァ-ヶー一-龥]{1,}(?:様|さん|氏)?)[】\]]/);
      if (bracketMatch) {
        foundName = ensureHonorific(bracketMatch[1])
        remainingContent = rowText.substring(bracketMatch[0].length).trim()
      }
    }
    
    if (foundName) {
      // Save previous person's data
      if (currentPerson && currentContent.length > 0) {
        const content = currentContent.join('\n').trim()
        if (content.length > 10) {
          records.push({
            name: currentPerson,
            content: content
          })
        }
      }
      
      // Start new person
      currentPerson = foundName
      currentContent = remainingContent ? [remainingContent] : []
    } else if (currentPerson && rowText.length > 0) {
      // Add to current person's content
      currentContent.push(rowText)
    }
  }
  
  // Save last person
  if (currentPerson && currentContent.length > 0) {
    const content = currentContent.join('\n').trim()
    if (content.length > 10) {
      records.push({
        name: currentPerson,
        content: content
      })
    }
  }
  
  return records
}

/**
 * Strategy 1 (Prioritized): Treat entire sheet as one person's record
 * This is the most common format in care facilities where each tab/sheet represents one person
 */
function extractSheetAsPerson(worksheet: ExcelJS.Worksheet): PersonRecord | null {
  const sheetName = worksheet.name
  
  // First, check if this looks like a person's name
  // Accept names with honorifics (様、さん等) or without
  // Also accept single letters like A, B with honorifics (A様、B様)
  const isLikelyPersonName = (name: string): boolean => {
    if (!name || name.length === 0) return false
    
    // Skip obvious non-person sheet names
    if (/^Sheet[0-9]+$|^sheet[0-9]+$|^Page[0-9]+$|^ページ[0-9]+$|^データ$|^一覧$|^目次$|^INDEX$/i.test(name)) {
      return false
    }
    
    // Accept single letters with honorifics (A様, B様, etc.)
    if (/^[A-Za-zあ-ん一-龥]{1,}[様さん氏殿君ちゃん]$/.test(name)) {
      return true
    }
    
    // Accept names that look like Japanese names (1-10 kanji/hiragana/katakana)
    if (/^[ぁ-んァ-ヶー一-龥]{1,10}$/.test(name)) {
      return true
    }
    
    // Accept names with spaces (姓 名 format)
    if (/^[ぁ-んァ-ヶー一-龥]+[\s　]+[ぁ-んァ-ヶー一-龥]+$/.test(name)) {
      return true
    }
    
    // Accept single English letters (A, B, C, etc.) - common in anonymized data
    if (/^[A-Z]$/.test(name)) {
      return true
    }
    
    return false
  }
  
  // Check if sheet name is likely a person's name
  if (!isLikelyPersonName(sheetName)) {
    // If sheet name doesn't look like a person name, try to find the name in the first few cells
    const rows = worksheet.getRows(1, 5) || []
    let personName: string | null = null
    
    for (const row of rows) {
      if (!row) continue
      
      row.eachCell((cell, colNumber) => {
        if (colNumber > 3) return // Only check first 3 columns
        
        const value = sanitizeCellValue(cell.value)
        // Look for cells that might contain a name
        if (value && isLikelyPersonName(value)) {
          personName = value
          return
        }
        // Also look for "氏名:" or "名前:" patterns
        const nameMatch = value.match(/(?:氏名|名前|利用者)[：:]\s*(.+)/)
        if (nameMatch && nameMatch[1]) {
          personName = nameMatch[1].trim()
          return
        }
      })
      
      if (personName) break
    }
    
    if (!personName) {
      return null
    }
  }
  
  // Use sheet name as person name (with honorific if needed)
  const nameWithHonorific = ensureHonorific(sheetName)
  
  if (!nameWithHonorific) {
    return null
  }
  
  // Collect all text from the sheet
  const contentParts: string[] = []
  const rows = worksheet.getRows(1, worksheet.rowCount) || []
  
  for (const row of rows) {
    if (!row) continue
    
    let rowText = ''
    row.eachCell((cell) => {
      const value = sanitizeCellValue(cell.value)
      if (value) {
        // Skip the cell if it's just the person's name
        if (value === nameWithHonorific || value === sheetName) {
          return
        }
        rowText += value + ' '
      }
    })
    
    rowText = rowText.trim()
    if (rowText.length > 0) {
      contentParts.push(rowText)
    }
  }
  
  const content = contentParts.join('\n').trim()
  
  // Accept sheets with at least some content
  if (content.length > 10) {
    console.log(`Extracted person record: ${nameWithHonorific} (${content.length} chars)`)
    return { name: nameWithHonorific, content }
  }
  
  return null
}

/**
 * Sanitize cell value to string
 */
function sanitizeCellValue(value: any): string {
  if (value === null || value === undefined) {
    return ''
  }
  
  // Handle different Excel value types
  if (value instanceof Date) {
    return value.toLocaleDateString('ja-JP')
  }
  
  if (typeof value === 'object') {
    // Handle rich text or formula results
    if (value.richText) {
      return value.richText.map((rt: any) => rt.text).join('')
    }
    if (value.result !== undefined) {
      return String(value.result)
    }
    if (value.text) {
      return String(value.text)
    }
  }
  
  return String(value).trim()
}

/**
 * Ensure name has proper honorific
 */
function ensureHonorific(name: string): string {
  if (!name || name.length < 1) {
    return ''
  }
  
  // Trim whitespace
  name = name.trim()
  
  // Skip if contains invalid patterns for names
  if (/^[0-9]+$|^第|^Sheet|^sheet|^ページ|^Page|^[A-Z]+[0-9]+$/i.test(name)) {
    return ''
  }
  
  // Check if name already has honorific
  const hasHonorific = /さん$|様$|氏$|殿$|君$|ちゃん$/.test(name)
  
  if (hasHonorific) {
    // Name already has honorific, return as is
    return name
  }
  
  // Remove partial honorifics that might be incomplete
  let cleanName = name.replace(/さ$|さん$|様$|氏$|殿$|君$|ちゃん$/g, '').trim()
  
  // Skip if not a valid name after cleaning
  if (!cleanName || cleanName.length < 1 || cleanName.length > 30) {
    // But if original name was valid length, use it
    if (name.length >= 1 && name.length <= 30) {
      return name + '様'
    }
    return ''
  }
  
  // Add standard honorific (様) for formal business use
  return cleanName + '様'
}