// Excel generation utility using ExcelJS
import ExcelJS from 'exceljs'

// Constants for Excel sheet name handling
const EXCEL_FORBIDDEN = /[\[\]*:\/\\?]/g
const CIRCLED_NUMBERS: { [key: number]: string } = {
  1: '①', 2: '②', 3: '③', 4: '④', 5: '⑤',
  6: '⑥', 7: '⑦', 8: '⑧', 9: '⑨', 10: '⑩',
  11: '⑪', 12: '⑫', 13: '⑬', 14: '⑭', 15: '⑮',
  16: '⑯', 17: '⑰', 18: '⑱', 19: '⑲', 20: '⑳'
}

function sanitizeSheetName(name: string): string {
  // Remove forbidden characters and limit to 31 characters
  return name.replace(EXCEL_FORBIDDEN, '').substring(0, 31)
}

function assignUniqueSheetName(base: string, seen: Map<string, number>): string {
  if (!seen.has(base)) {
    seen.set(base, 1)
    return sanitizeSheetName(base)
  }
  
  const count = seen.get(base)! + 1
  seen.set(base, count)
  const circled = CIRCLED_NUMBERS[count - 1] || `(${count - 1})`
  
  let candidate = `${base}${circled}`
  if (candidate.length > 31) {
    // Trim base name to fit with circled number
    candidate = `${base.substring(0, 31 - circled.length)}${circled}`
  }
  
  return sanitizeSheetName(candidate)
}

export async function buildExcel(summaries: Map<string, string>): Promise<ArrayBuffer> {
  const workbook = new ExcelJS.Workbook()
  
  // Track sheet names to handle duplicates
  const seen = new Map<string, number>()
  
  for (const [name, summary] of summaries) {
    const sheetName = assignUniqueSheetName(name, seen)
    const worksheet = workbook.addWorksheet(sheetName)
    
    // Set column widths
    worksheet.getColumn(1).width = 26
    worksheet.getColumn(2).width = 90
    
    // Add header row
    const headerRow = worksheet.addRow(['項目', '内容'])
    headerRow.font = { bold: true }
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE0E0E0' }
    }
    
    // Add data rows
    worksheet.addRow(['氏名', name])
    
    const summaryRow = worksheet.addRow(['要約（200〜300文字・敬体）', summary])
    summaryRow.getCell(2).alignment = { 
      wrapText: true, 
      vertical: 'top',
      horizontal: 'left'
    }
    summaryRow.height = Math.max(100, Math.ceil(summary.length / 50) * 15)
    
    worksheet.addRow(['作成日時', new Date().toLocaleString('ja-JP', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })])
    
    // Add borders to all cells
    worksheet.eachRow((row, rowNumber) => {
      row.eachCell((cell) => {
        cell.border = {
          top: { style: 'thin' },
          left: { style: 'thin' },
          bottom: { style: 'thin' },
          right: { style: 'thin' }
        }
      })
    })
  }
  
  // Generate buffer
  const buffer = await workbook.xlsx.writeBuffer()
  return buffer as ArrayBuffer
}