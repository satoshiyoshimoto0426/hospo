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
  
  // Strategy 1: Look for structured data with name column
  const structuredRecords = extractStructuredRecords(worksheet)
  if (structuredRecords.length > 0) {
    return structuredRecords
  }
  
  // Strategy 2: Look for name patterns in cells
  const patternBasedRecords = extractByNamePatterns(worksheet)
  if (patternBasedRecords.length > 0) {
    return patternBasedRecords
  }
  
  // Strategy 3: Each sheet is one person (sheet name is person name)
  const sheetAsPersonRecord = extractSheetAsPerson(worksheet)
  if (sheetAsPersonRecord) {
    return [sheetAsPersonRecord]
  }
  
  return records
}

/**
 * Strategy 1: Extract structured records (name column + content column)
 */
function extractStructuredRecords(worksheet: ExcelJS.Worksheet): PersonRecord[] {
  const records: PersonRecord[] = []
  const rows = worksheet.getRows(1, worksheet.rowCount) || []
  
  // Look for header row with name-related columns
  let nameColumnIndex = -1
  let contentColumnIndex = -1
  
  // Check first few rows for headers
  for (let i = 0; i < Math.min(5, rows.length); i++) {
    const row = rows[i]
    if (!row) continue
    
    row.eachCell((cell, colNumber) => {
      const value = String(cell.value || '').toLowerCase()
      if (value.includes('氏名') || value.includes('名前') || value.includes('利用者')) {
        nameColumnIndex = colNumber
      }
      if (value.includes('記録') || value.includes('内容') || value.includes('経過')) {
        contentColumnIndex = colNumber
      }
    })
    
    if (nameColumnIndex > 0 && contentColumnIndex > 0) {
      break
    }
  }
  
  // Extract data if columns found
  if (nameColumnIndex > 0 && contentColumnIndex > 0) {
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i]
      if (!row) continue
      
      const name = sanitizeCellValue(row.getCell(nameColumnIndex).value)
      const content = sanitizeCellValue(row.getCell(contentColumnIndex).value)
      
      // Ensure name has honorific
      const nameWithHonorific = ensureHonorific(name)
      
      if (nameWithHonorific && content && content.length > 10) {
        records.push({ name: nameWithHonorific, content })
      }
    }
  }
  
  return records
}

/**
 * Strategy 2: Extract by searching for name patterns
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
      rowText += sanitizeCellValue(cell.value) + ' '
    })
    rowText = rowText.trim()
    
    // Check if this row contains a person name
    const nameMatch = rowText.match(/^(.+?(?:さん|様|氏))[\s　]/)
    
    if (nameMatch) {
      // Save previous person's data
      if (currentPerson && currentContent.length > 0) {
        records.push({
          name: currentPerson,
          content: currentContent.join('\n').trim()
        })
      }
      
      // Start new person
      currentPerson = nameMatch[1]
      currentContent = [rowText.replace(nameMatch[0], '').trim()]
    } else if (currentPerson && rowText.length > 0) {
      // Add to current person's content
      currentContent.push(rowText)
    }
  }
  
  // Save last person
  if (currentPerson && currentContent.length > 0) {
    records.push({
      name: currentPerson,
      content: currentContent.join('\n').trim()
    })
  }
  
  return records
}

/**
 * Strategy 3: Treat entire sheet as one person's record
 */
function extractSheetAsPerson(worksheet: ExcelJS.Worksheet): PersonRecord | null {
  // Check if sheet name looks like a person name
  const sheetName = worksheet.name
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
        rowText += value + ' '
      }
    })
    
    rowText = rowText.trim()
    if (rowText.length > 0) {
      contentParts.push(rowText)
    }
  }
  
  const content = contentParts.join('\n').trim()
  
  if (content.length > 20) {
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
  if (!name || name.length < 2) {
    return ''
  }
  
  // Remove existing honorifics if any
  let cleanName = name.replace(/さん|様|氏|殿|君|ちゃん/g, '').trim()
  
  // Skip if not a valid name
  if (!cleanName || cleanName.length < 1 || cleanName.length > 20) {
    return ''
  }
  
  // Skip if contains invalid characters for names
  if (/[0-9]{4,}|^[0-9]+$|^第|^Sheet|^sheet|^ページ|^Page/i.test(cleanName)) {
    return ''
  }
  
  // Add standard honorific
  return cleanName + 'さん'
}