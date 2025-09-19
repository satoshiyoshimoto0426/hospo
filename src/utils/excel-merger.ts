// Excel file merging utility for combining multiple Excel files
import ExcelJS from 'exceljs'
import { extractFromExcel } from './excel-reader'

// Constants for Excel sheet name handling
const EXCEL_FORBIDDEN = /[\[\]*:\/\\?]/g
const CIRCLED_NUMBERS: { [key: number]: string } = {
  1: '①', 2: '②', 3: '③', 4: '④', 5: '⑤',
  6: '⑥', 7: '⑦', 8: '⑧', 9: '⑨', 10: '⑩',
  11: '⑪', 12: '⑫', 13: '⑬', 14: '⑭', 15: '⑮',
  16: '⑯', 17: '⑰', 18: '⑱', 19: '⑲', 20: '⑳'
}

interface FileData {
  fileName: string
  buffer: ArrayBuffer
}

interface PersonData {
  name: string
  content: string
  sourceFile: string
  date?: string
}

/**
 * Merge multiple Excel files into a single Excel with tabs for each person
 */
export async function mergeExcelFiles(files: FileData[]): Promise<ArrayBuffer> {
  console.log(`Merging ${files.length} Excel files`)
  
  // Collect all person data from all files
  const allPersonData: PersonData[] = []
  
  for (const file of files) {
    console.log(`Processing file: ${file.fileName}`)
    
    try {
      // Extract data from this Excel file
      const sections = await extractFromExcel(file.buffer)
      
      // Convert to PersonData format
      for (const [name, content] of sections) {
        allPersonData.push({
          name,
          content,
          sourceFile: file.fileName,
          date: extractDateFromFileName(file.fileName)
        })
      }
      
      console.log(`Extracted ${sections.size} persons from ${file.fileName}`)
    } catch (error) {
      console.error(`Failed to process ${file.fileName}:`, error)
      // Continue with other files even if one fails
    }
  }
  
  console.log(`Total persons collected: ${allPersonData.length}`)
  
  // Group by person name
  const groupedData = groupByPerson(allPersonData)
  
  // Create merged Excel file
  return await createMergedExcel(groupedData)
}

/**
 * Group data by person name, combining content from multiple files
 */
function groupByPerson(data: PersonData[]): Map<string, PersonData[]> {
  const grouped = new Map<string, PersonData[]>()
  
  for (const item of data) {
    const existing = grouped.get(item.name) || []
    existing.push(item)
    grouped.set(item.name, existing)
  }
  
  // Sort each person's data by date/filename
  for (const [name, items] of grouped) {
    items.sort((a, b) => {
      // Sort by date if available, otherwise by filename
      if (a.date && b.date) {
        return a.date.localeCompare(b.date)
      }
      return a.sourceFile.localeCompare(b.sourceFile)
    })
  }
  
  return grouped
}

/**
 * Create the merged Excel file with one tab per person
 */
async function createMergedExcel(groupedData: Map<string, PersonData[]>): Promise<ArrayBuffer> {
  const workbook = new ExcelJS.Workbook()
  
  // Track sheet names to handle duplicates
  const seen = new Map<string, number>()
  
  // Create summary sheet
  const summarySheet = workbook.addWorksheet('📊 統合サマリー')
  setupSummarySheet(summarySheet, groupedData)
  
  // Create a sheet for each person
  for (const [name, dataItems] of groupedData) {
    const sheetName = assignUniqueSheetName(name, seen)
    const worksheet = workbook.addWorksheet(sheetName)
    
    // Setup worksheet
    setupPersonSheet(worksheet, name, dataItems)
  }
  
  // Generate buffer
  const buffer = await workbook.xlsx.writeBuffer()
  return buffer as ArrayBuffer
}

/**
 * Setup summary sheet with overview of all persons
 */
function setupSummarySheet(worksheet: ExcelJS.Worksheet, groupedData: Map<string, PersonData[]>) {
  // Set column widths
  worksheet.getColumn(1).width = 5
  worksheet.getColumn(2).width = 25
  worksheet.getColumn(3).width = 15
  worksheet.getColumn(4).width = 50
  worksheet.getColumn(5).width = 30
  
  // Add title
  const titleRow = worksheet.addRow(['', '📊 統合ファイルサマリー'])
  titleRow.getCell(2).font = { bold: true, size: 16 }
  titleRow.height = 30
  
  worksheet.addRow([]) // Empty row
  
  // Add stats
  const totalPersons = groupedData.size
  const totalRecords = Array.from(groupedData.values()).reduce((sum, items) => sum + items.length, 0)
  
  worksheet.addRow(['', '総利用者数:', totalPersons + '名'])
  worksheet.addRow(['', '総レコード数:', totalRecords + '件'])
  worksheet.addRow([]) // Empty row
  
  // Add header
  const headerRow = worksheet.addRow(['No.', '利用者名', 'レコード数', 'ソースファイル', '備考'])
  headerRow.font = { bold: true }
  headerRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFE0E0E0' }
  }
  
  // Add data rows
  let index = 1
  for (const [name, items] of groupedData) {
    const sourceFiles = [...new Set(items.map(item => item.sourceFile))].join(', ')
    const row = worksheet.addRow([
      index++,
      name,
      items.length,
      sourceFiles,
      items.length > 1 ? '複数ファイルから統合' : ''
    ])
    
    // Add alternating row colors
    if (index % 2 === 0) {
      row.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFF5F5F5' }
      }
    }
  }
  
  // Add borders
  const lastRow = worksheet.lastRow?.number || 7
  for (let i = 7; i <= lastRow; i++) {
    const row = worksheet.getRow(i)
    for (let j = 1; j <= 5; j++) {
      row.getCell(j).border = {
        top: { style: 'thin' },
        left: { style: 'thin' },
        bottom: { style: 'thin' },
        right: { style: 'thin' }
      }
    }
  }
}

/**
 * Setup individual person sheet
 */
function setupPersonSheet(worksheet: ExcelJS.Worksheet, name: string, dataItems: PersonData[]) {
  // Set column widths
  worksheet.getColumn(1).width = 30
  worksheet.getColumn(2).width = 90
  
  // Add title
  const titleRow = worksheet.addRow(['利用者名', name])
  titleRow.font = { bold: true, size: 14 }
  titleRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFE8F4FF' }
  }
  
  worksheet.addRow([]) // Empty row
  
  // Add header
  const headerRow = worksheet.addRow(['項目', '内容'])
  headerRow.font = { bold: true }
  headerRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFE0E0E0' }
  }
  
  // Add data from each source file
  for (const item of dataItems) {
    // Add source file info
    const sourceRow = worksheet.addRow(['ソースファイル', item.sourceFile])
    sourceRow.font = { italic: true, color: { argb: 'FF666666' } }
    
    // Add date if available
    if (item.date) {
      worksheet.addRow(['記録日付', item.date])
    }
    
    // Add content
    const contentRow = worksheet.addRow(['記録内容', item.content])
    contentRow.getCell(2).alignment = { 
      wrapText: true, 
      vertical: 'top',
      horizontal: 'left'
    }
    
    // Adjust row height based on content length
    const estimatedLines = Math.ceil(item.content.length / 80)
    contentRow.height = Math.max(100, estimatedLines * 15)
    
    // Add separator
    worksheet.addRow([]) // Empty row for separation
  }
  
  // If multiple records, add combined view
  if (dataItems.length > 1) {
    worksheet.addRow([]) // Empty row
    const combinedHeaderRow = worksheet.addRow(['統合記録', '全ファイルの記録を時系列順に結合'])
    combinedHeaderRow.font = { bold: true }
    combinedHeaderRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFFFF0E0' }
    }
    
    const combinedContent = dataItems
      .map(item => `【${item.sourceFile}】\n${item.content}`)
      .join('\n\n' + '='.repeat(50) + '\n\n')
    
    const combinedRow = worksheet.addRow(['', combinedContent])
    combinedRow.getCell(2).alignment = { 
      wrapText: true, 
      vertical: 'top',
      horizontal: 'left'
    }
    combinedRow.height = Math.min(500, Math.ceil(combinedContent.length / 80) * 15)
  }
  
  // Add borders to all cells
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber > 2) { // Skip title rows
      row.eachCell((cell) => {
        cell.border = {
          top: { style: 'thin' },
          left: { style: 'thin' },
          bottom: { style: 'thin' },
          right: { style: 'thin' }
        }
      })
    }
  })
}

/**
 * Assign unique sheet name handling duplicates
 */
function assignUniqueSheetName(base: string, seen: Map<string, number>): string {
  // Remove forbidden characters and limit length
  let cleanName = base.replace(EXCEL_FORBIDDEN, '').substring(0, 25)
  
  if (!seen.has(cleanName)) {
    seen.set(cleanName, 1)
    return cleanName
  }
  
  const count = seen.get(cleanName)! + 1
  seen.set(cleanName, count)
  const circled = CIRCLED_NUMBERS[count - 1] || `(${count - 1})`
  
  let candidate = `${cleanName}${circled}`
  if (candidate.length > 31) {
    candidate = `${cleanName.substring(0, 31 - circled.length)}${circled}`
  }
  
  return candidate
}

/**
 * Extract date from filename if possible
 */
function extractDateFromFileName(fileName: string): string | undefined {
  // Try various date patterns
  const patterns = [
    /(\d{4})[年\-\/](\d{1,2})[月\-\/](\d{1,2})[日]?/, // 2024年1月15日, 2024-01-15, 2024/01/15
    /(\d{4})(\d{2})(\d{2})/, // 20240115
    /(\d{1,2})[月\-\/](\d{1,2})[日]?/, // 1月15日, 1-15, 1/15
  ]
  
  for (const pattern of patterns) {
    const match = fileName.match(pattern)
    if (match) {
      if (match.length === 4) {
        // Year-month-day format
        return `${match[1]}年${match[2]}月${match[3]}日`
      } else if (match.length === 3) {
        // Month-day format (assume current year)
        const currentYear = new Date().getFullYear()
        return `${currentYear}年${match[1]}月${match[2]}日`
      }
    }
  }
  
  return undefined
}