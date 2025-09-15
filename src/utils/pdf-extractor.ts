// PDF text extraction utility for Cloudflare Workers
// Since most PDF libraries don't work in Workers environment,
// we'll use a simple text extraction approach

export async function extractTextFromPDF(pdfBuffer: ArrayBuffer): Promise<string> {
  try {
    // Convert ArrayBuffer to string to check for text content
    const uint8Array = new Uint8Array(pdfBuffer)
    const decoder = new TextDecoder('utf-8', { fatal: false })
    const pdfString = decoder.decode(uint8Array)
    
    // Extract text using regex patterns
    // This works for PDFs with embedded text (not scanned images)
    const textParts: string[] = []
    
    // Pattern 1: Text between BT and ET markers (PDF text objects)
    const btEtPattern = /BT\s*(.*?)\s*ET/gs
    const btEtMatches = pdfString.matchAll(btEtPattern)
    
    for (const match of btEtMatches) {
      const content = match[1]
      // Extract text from Tj and TJ operators
      const tjPattern = /\((.*?)\)\s*Tj/g
      const tjMatches = content.matchAll(tjPattern)
      
      for (const tjMatch of tjMatches) {
        const text = decodePDFString(tjMatch[1])
        if (text && text.trim()) {
          textParts.push(text)
        }
      }
      
      // Handle TJ arrays
      const tjArrayPattern = /\[(.*?)\]\s*TJ/g
      const tjArrayMatches = content.matchAll(tjArrayPattern)
      
      for (const tjArrayMatch of tjArrayMatches) {
        const arrayContent = tjArrayMatch[1]
        const stringPattern = /\((.*?)\)/g
        const strings = arrayContent.matchAll(stringPattern)
        
        for (const str of strings) {
          const text = decodePDFString(str[1])
          if (text && text.trim()) {
            textParts.push(text)
          }
        }
      }
    }
    
    // Pattern 2: Stream content
    const streamPattern = /stream\s*(.*?)\s*endstream/gs
    const streamMatches = pdfString.matchAll(streamPattern)
    
    for (const match of streamMatches) {
      const streamContent = match[1]
      // Try to extract readable text from streams
      const readable = extractReadableText(streamContent)
      if (readable) {
        textParts.push(readable)
      }
    }
    
    // Combine and clean up extracted text
    let extractedText = textParts.join(' ')
    
    // Clean up common PDF artifacts
    extractedText = extractedText
      .replace(/\\(\d{3})/g, (match, octal) => String.fromCharCode(parseInt(octal, 8)))
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\\\/g, '\\')
      .replace(/\\\(/g, '(')
      .replace(/\\\)/g, ')')
      .replace(/\s+/g, ' ')
      .trim()
    
    // If no text was extracted, try a simpler approach
    if (!extractedText || extractedText.length < 100) {
      // Look for any Japanese text patterns
      const japanesePattern = /[ぁ-んァ-ヶー一-龯０-９Ａ-Ｚａ-ｚ][ぁ-んァ-ヶー一-龯０-９Ａ-Ｚａ-ｚ\s。、！？「」『』（）｛｝［］【】〈〉《》・…ー－―～〜]+/g
      const japaneseMatches = pdfString.matchAll(japanesePattern)
      
      const japaneseTexts = []
      for (const match of japaneseMatches) {
        if (match[0].length > 10) {
          japaneseTexts.push(match[0])
        }
      }
      
      if (japaneseTexts.length > 0) {
        extractedText = japaneseTexts.join('\n')
      }
    }
    
    if (!extractedText || extractedText.length < 100) {
      throw new Error('PDFからテキストを抽出できませんでした。スキャン画像のPDFではなく、テキスト抽出可能なPDFファイルをアップロードしてください。')
    }
    
    return extractedText
    
  } catch (error) {
    console.error('PDF extraction error:', error)
    throw new Error('PDFの読み取りに失敗しました。テキスト抽出可能なPDFファイルか確認してください。')
  }
}

function decodePDFString(str: string): string {
  // Decode PDF string escapes
  return str
    .replace(/\\(\d{3})/g, (match, octal) => String.fromCharCode(parseInt(octal, 8)))
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\\\/g, '\\')
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
}

function extractReadableText(content: string): string {
  // Extract readable ASCII and Unicode text
  const readable = content.match(/[\x20-\x7E\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF\u3400-\u4DBF]+/g)
  if (readable) {
    return readable.join(' ').trim()
  }
  return ''
}