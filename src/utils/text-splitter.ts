// Text splitting utility to divide PDF content by person sections

// Maximum characters per section (to prevent token overflow)
const MAX_CHARS_PER_SECTION = 10000 // 約3000トークン相当

// Section detection patterns - more comprehensive patterns
const NAME_HEADER_PATTERNS = [
  // Pattern 1: Name at the beginning of a line with honorifics
  /^([^#\n]*?(?:さん|様|氏))[\s　]*$/gm,
  
  // Pattern 2: Markdown headers with name
  /^\s*#{1,6}\s+(.+?(?:さん|様|氏))\s*$/gm,
  
  // Pattern 3: Name with label (氏名：, 利用者：, etc.)
  /^(?:氏名|利用者|対象者|名前|お名前)[\s　]*[:：]\s*(.+?(?:さん|様|氏))\s*$/gm,
  
  // Pattern 4: Decorated names with lines
  /^[-=━─]{2,}\s*(.+?(?:さん|様|氏))\s*[-=━─]{2,}\s*$/gm,
  
  // Pattern 5: Names in brackets
  /^[【\[](.+?(?:さん|様|氏))[】\]]\s*$/gm,
  
  // Pattern 6: Names with date format (common in care records)
  /^(\d{1,2}月\d{1,2}日)?[\s　]*(.+?(?:さん|様|氏))[\s　]*$/gm,
]

// Additional patterns for section breaks (without names)
const SECTION_BREAK_PATTERNS = [
  /^[-=━─]{5,}\s*$/gm,  // Horizontal lines
  /^[＊\*]{3,}\s*$/gm,   // Asterisks
  /^\s*(?:ページ|Page)\s*\d+\s*$/gm, // Page numbers
]

export function splitByPerson(text: string): Map<string, string> {
  const sections = new Map<string, string>()
  
  // Debug logging
  console.log('Input text length:', text.length)
  
  // Try to detect the most appropriate pattern
  let bestMatches: RegExpMatchArray[] = []
  let bestPattern: RegExp | null = null
  let maxMatchCount = 0
  
  // Test each pattern and find the one with the most matches
  for (const pattern of NAME_HEADER_PATTERNS) {
    const matches = Array.from(text.matchAll(pattern))
    // Filter out false positives (very long names, etc.)
    const validMatches = matches.filter(m => {
      const name = m[m.length - 1] // Get the last capturing group (the name)
      return name && name.length > 1 && name.length < 50
    })
    
    if (validMatches.length > maxMatchCount) {
      bestMatches = validMatches
      bestPattern = pattern
      maxMatchCount = validMatches.length
    }
  }
  
  console.log(`Found ${bestMatches.length} name sections`)
  
  // If we found a reasonable number of sections (2-100), use them
  if (bestMatches.length >= 2 && bestMatches.length <= 100) {
    for (let i = 0; i < bestMatches.length; i++) {
      const match = bestMatches[i]
      const name = match[match.length - 1].trim() // Get the last capturing group
      
      if (!name || name.length < 2) continue
      
      // Get content between this header and the next
      const startIdx = match.index! + match[0].length
      const endIdx = i + 1 < bestMatches.length ? bestMatches[i + 1].index! : text.length
      let content = text.substring(startIdx, endIdx).trim()
      
      // Clean up the content
      content = cleanContent(content)
      
      // Skip if content is too short
      if (content.length < 10) continue
      
      // Truncate if content is too long (to prevent token overflow)
      if (content.length > MAX_CHARS_PER_SECTION) {
        console.warn(`Truncating content for ${name}: ${content.length} -> ${MAX_CHARS_PER_SECTION}`)
        content = content.substring(0, MAX_CHARS_PER_SECTION) + '...[以下省略]'
      }
      
      // Handle duplicates by merging
      if (sections.has(name)) {
        const existing = sections.get(name)!
        const combined = existing + '\n\n' + content
        // Apply max length limit to combined content
        if (combined.length > MAX_CHARS_PER_SECTION) {
          sections.set(name, combined.substring(0, MAX_CHARS_PER_SECTION) + '...[以下省略]')
        } else {
          sections.set(name, combined)
        }
      } else {
        sections.set(name, content)
      }
    }
  }
  
  // Fallback: If no good sections found, try to split by other patterns
  if (sections.size === 0) {
    console.log('No sections found with name patterns, trying fallback split')
    const fallbackSections = fallbackSplit(text)
    return fallbackSections
  }
  
  console.log(`Successfully split into ${sections.size} sections`)
  
  return sections
}

// Clean up content by removing unnecessary elements
function cleanContent(content: string): string {
  return content
    // Remove sub-headers
    .replace(/^\s*#{1,6}\s*(日付|内容|記録|備考|観察|状態)\s*$/gm, '')
    // Remove horizontal lines
    .replace(/^[-=━─＊\*]{3,}\s*$/gm, '')
    // Remove page numbers
    .replace(/^\s*(?:ページ|Page|頁)\s*\d+\s*$/gm, '')
    // Remove excessive whitespace
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// Fallback splitting when name detection fails
function fallbackSplit(text: string): Map<string, string> {
  const sections = new Map<string, string>()
  
  // Try to split by page breaks or large gaps
  const chunks = text.split(/\n{4,}|\f/)
  
  if (chunks.length > 1 && chunks.length <= 100) {
    chunks.forEach((chunk, index) => {
      const trimmed = chunk.trim()
      if (trimmed.length > 50) {
        // Look for a name in the first few lines
        const lines = trimmed.split('\n').slice(0, 5)
        let name = '未分類' + (index + 1) + 'さん'
        
        for (const line of lines) {
          const nameMatch = line.match(/(.+?(?:さん|様|氏))/)
          if (nameMatch) {
            name = nameMatch[1]
            break
          }
        }
        
        // Apply length limit
        const content = trimmed.length > MAX_CHARS_PER_SECTION 
          ? trimmed.substring(0, MAX_CHARS_PER_SECTION) + '...[以下省略]'
          : trimmed
          
        sections.set(name, content)
      }
    })
  }
  
  // If still no sections, create a single truncated section
  if (sections.size === 0) {
    const truncated = text.length > MAX_CHARS_PER_SECTION
      ? text.substring(0, MAX_CHARS_PER_SECTION) + '...[以下省略]'
      : text
    sections.set('未分類さん', truncated)
  }
  
  return sections
}

// Utility to preview section detection for debugging
export function previewSections(text: string): string[] {
  const sections = splitByPerson(text)
  const preview: string[] = []
  
  preview.push(`総セクション数: ${sections.size}`)
  
  for (const [name, content] of sections) {
    const lines = content.split('\n').length
    const chars = content.length
    const contentPreview = content.substring(0, 100).replace(/\n/g, ' ') + (content.length > 100 ? '...' : '')
    preview.push(`【${name}】${chars}文字, ${lines}行: ${contentPreview}`)
  }
  
  return preview
}