// Summarize and merge multiple Excel files into one
import ExcelJS from 'exceljs'
import { extractFromExcel } from './excel-reader'
import { processSummaries } from './summarizer'

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

interface PersonSummary {
  name: string
  originalContent: string
  summary: string
  sourceFile: string
  date?: string
}

/**
 * Process multiple Excel files: extract, summarize, and merge
 */
export async function summarizeAndMergeExcelFiles(
  files: FileData[],
  apiKey: string,
  model: string,
  maxConcurrency: number
): Promise<ArrayBuffer> {
  console.log(`Processing ${files.length} Excel files for summarization and merge`)
  
  // Step 1: Extract all person data from all files
  const allSections = new Map<string, string[]>() // name -> [contents from different files]
  const sourceTracking = new Map<string, string[]>() // name -> [source files]
  
  for (const file of files) {
    console.log(`Extracting data from: ${file.fileName}`)
    
    try {
      // Extract data from this Excel file
      const sections = await extractFromExcel(file.buffer)
      
      // Organize by person name, tracking sources
      for (const [name, content] of sections) {
        if (!allSections.has(name)) {
          allSections.set(name, [])
          sourceTracking.set(name, [])
        }
        allSections.get(name)!.push(content)
        sourceTracking.get(name)!.push(file.fileName)
      }
      
      console.log(`Extracted ${sections.size} persons from ${file.fileName}`)
    } catch (error) {
      console.error(`Failed to process ${file.fileName}:`, error)
      // Continue with other files even if one fails
    }
  }
  
  console.log(`Total unique persons found: ${allSections.size}`)
  
  // Step 2: Combine content for each person and prepare for summarization
  const combinedSections = new Map<string, string>()
  const personMetadata = new Map<string, { sources: string[], originalLength: number }>()
  
  for (const [name, contents] of allSections) {
    // Combine all content for this person
    const sources = sourceTracking.get(name) || []
    const combinedContent = contents
      .map((content, idx) => {
        const source = sources[idx]
        const dateStr = extractDateFromFileName(source)
        const header = dateStr ? `【${dateStr}の記録】` : `【${source}】`
        return `${header}\n${content}`
      })
      .join('\n\n' + '='.repeat(30) + '\n\n')
    
    combinedSections.set(name, combinedContent)
    personMetadata.set(name, {
      sources: [...new Set(sources)], // unique source files
      originalLength: combinedContent.length
    })
  }
  
  // Step 3: Generate summaries using AI
  console.log('Generating summaries for all persons...')
  const summaries = await processSummaries(
    combinedSections,
    apiKey,
    model,
    maxConcurrency
  )
  
  console.log(`Generated ${summaries.size} summaries`)
  
  // Step 4: Create final Excel with summaries
  const personSummaries: PersonSummary[] = []
  for (const [name, summary] of summaries) {
    const metadata = personMetadata.get(name)
    personSummaries.push({
      name,
      originalContent: combinedSections.get(name) || '',
      summary,
      sourceFile: metadata?.sources.join(', ') || '',
      date: extractLatestDate(metadata?.sources || [])
    })
  }
  
  // Step 5: Create Excel file with all summaries
  return await createSummarizedExcel(personSummaries)
}

/**
 * Create Excel file with summarized content
 */
async function createSummarizedExcel(summaries: PersonSummary[]): Promise<ArrayBuffer> {
  const workbook = new ExcelJS.Workbook()
  
  // Track sheet names to handle duplicates
  const seen = new Map<string, number>()
  
  // Create summary sheet
  const summarySheet = workbook.addWorksheet('📊 要約サマリー')
  setupSummarySheet(summarySheet, summaries)
  
  // Create a sheet for each person with their summary
  for (const personData of summaries) {
    const sheetName = assignUniqueSheetName(personData.name, seen)
    const worksheet = workbook.addWorksheet(sheetName)
    
    // Setup worksheet with summary
    setupPersonSummarySheet(worksheet, personData)
  }
  
  // Generate buffer
  const buffer = await workbook.xlsx.writeBuffer()
  return buffer as ArrayBuffer
}

/**
 * Setup summary sheet with overview
 */
function setupSummarySheet(worksheet: ExcelJS.Worksheet, summaries: PersonSummary[]) {
  // Set column widths
  worksheet.getColumn(1).width = 5
  worksheet.getColumn(2).width = 25
  worksheet.getColumn(3).width = 60
  worksheet.getColumn(4).width = 40
  worksheet.getColumn(5).width = 15
  
  // Add title
  const titleRow = worksheet.addRow(['', '📊 AI要約統合サマリー'])
  titleRow.getCell(2).font = { bold: true, size: 16, color: { argb: 'FF2563EB' } }
  titleRow.height = 35
  
  worksheet.addRow([]) // Empty row
  
  // Add stats
  const totalPersons = summaries.length
  const successCount = summaries.filter(s => !s.summary.includes('要約失敗')).length
  
  const statsRow1 = worksheet.addRow(['', '総利用者数:', `${totalPersons}名`])
  statsRow1.getCell(2).font = { bold: true }
  
  const statsRow2 = worksheet.addRow(['', '要約成功:', `${successCount}/${totalPersons}名`])
  statsRow2.getCell(2).font = { bold: true }
  
  const statsRow3 = worksheet.addRow(['', '処理日時:', new Date().toLocaleString('ja-JP')])
  statsRow3.getCell(2).font = { bold: true }
  
  worksheet.addRow([]) // Empty row
  
  // Add header
  const headerRow = worksheet.addRow(['No.', '利用者名', '要約（200-300文字）', 'ソースファイル', '文字数'])
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } }
  headerRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF2563EB' }
  }
  headerRow.height = 25
  
  // Add data rows
  let index = 1
  for (const summary of summaries) {
    const charCount = summary.summary.replace(/\n/g, '').length
    const isError = summary.summary.includes('要約失敗')
    
    const row = worksheet.addRow([
      index++,
      summary.name,
      summary.summary,
      summary.sourceFile,
      isError ? 'エラー' : `${charCount}文字`
    ])
    
    // Wrap text for summary column
    row.getCell(3).alignment = { wrapText: true, vertical: 'top' }
    row.height = Math.max(60, Math.ceil(summary.summary.length / 40) * 15)
    
    // Color coding for errors
    if (isError) {
      row.getCell(3).font = { color: { argb: 'FFDC2626' } }
      row.getCell(5).font = { color: { argb: 'FFDC2626' } }
    } else if (charCount >= 200 && charCount <= 300) {
      row.getCell(5).font = { color: { argb: 'FF059669' } }
    }
    
    // Add alternating row colors
    if (index % 2 === 0) {
      row.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFF3F4F6' }
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
  
  // Freeze panes (header row)
  worksheet.views = [
    { state: 'frozen', xSplit: 0, ySplit: 7 }
  ]
}

/**
 * Setup individual person sheet with summary
 */
function setupPersonSummarySheet(worksheet: ExcelJS.Worksheet, personData: PersonSummary) {
  // Set column widths
  worksheet.getColumn(1).width = 30
  worksheet.getColumn(2).width = 90
  
  // Add title with person name
  const titleRow = worksheet.addRow(['利用者名', personData.name])
  titleRow.font = { bold: true, size: 14 }
  titleRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFE8F4FF' }
  }
  titleRow.height = 30
  
  worksheet.addRow([]) // Empty row
  
  // Add summary section
  const summaryHeaderRow = worksheet.addRow(['📝 AI要約', '200〜300文字の要約'])
  summaryHeaderRow.font = { bold: true, size: 12 }
  summaryHeaderRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFF0F9FF' }
  }
  
  const summaryRow = worksheet.addRow(['', personData.summary])
  summaryRow.getCell(2).alignment = { 
    wrapText: true, 
    vertical: 'top',
    horizontal: 'left'
  }
  summaryRow.getCell(2).font = { size: 11 }
  summaryRow.height = Math.max(80, Math.ceil(personData.summary.length / 60) * 15)
  
  // Add summary stats
  const charCount = personData.summary.replace(/\n/g, '').length
  const statsRow = worksheet.addRow(['文字数', `${charCount}文字`])
  statsRow.getCell(2).font = { 
    color: charCount >= 200 && charCount <= 300 
      ? { argb: 'FF059669' } 
      : { argb: 'FFDC2626' }
  }
  
  worksheet.addRow([]) // Empty row
  
  // Add source information
  const sourceHeaderRow = worksheet.addRow(['📁 ソース情報', ''])
  sourceHeaderRow.font = { bold: true }
  sourceHeaderRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFF3F4F6' }
  }
  
  worksheet.addRow(['ソースファイル', personData.sourceFile])
  if (personData.date) {
    worksheet.addRow(['記録日付', personData.date])
  }
  worksheet.addRow(['元データ文字数', `${personData.originalContent.length}文字`])
  
  worksheet.addRow([]) // Empty row
  worksheet.addRow([]) // Empty row
  
  // Add original content section (collapsed by default)
  const originalHeaderRow = worksheet.addRow(['📄 元の記録内容', '※要約前の全文'])
  originalHeaderRow.font = { bold: true }
  originalHeaderRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFFEF3C7' }
  }
  
  const originalRow = worksheet.addRow(['', personData.originalContent])
  originalRow.getCell(2).alignment = { 
    wrapText: true, 
    vertical: 'top',
    horizontal: 'left'
  }
  originalRow.getCell(2).font = { size: 9, color: { argb: 'FF6B7280' } }
  originalRow.height = Math.min(300, Math.ceil(personData.originalContent.length / 80) * 12)
  
  // Add borders to all cells
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber > 2) { // Skip title row
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
 * Extract date from filename
 */
function extractDateFromFileName(fileName: string): string | undefined {
  const patterns = [
    /(\d{4})[年\-\/](\d{1,2})[月\-\/](\d{1,2})[日]?/,
    /(\d{4})(\d{2})(\d{2})/,
    /(\d{1,2})[月\-\/](\d{1,2})[日]?/,
  ]
  
  for (const pattern of patterns) {
    const match = fileName.match(pattern)
    if (match) {
      if (match.length === 4) {
        return `${match[1]}年${match[2]}月${match[3]}日`
      } else if (match.length === 3) {
        const currentYear = new Date().getFullYear()
        return `${currentYear}年${match[1]}月${match[2]}日`
      }
    }
  }
  
  return undefined
}

/**
 * Extract the latest date from multiple filenames
 */
function extractLatestDate(fileNames: string[]): string | undefined {
  const dates = fileNames
    .map(name => extractDateFromFileName(name))
    .filter(date => date !== undefined)
  
  if (dates.length === 0) return undefined
  
  // Sort and return the latest
  dates.sort()
  return dates[dates.length - 1]
}