// Text splitting utility to divide PDF content by person sections

// Section detection patterns
const NAME_HEADER_PATTERNS = [
  // Markdown headers with name (## Aさん, ### Bさん, etc.)
  /^\s*#{1,6}\s+(.+?(?:さん|様|氏))\s*$/gm,
  // Standalone name lines (Aさん on its own line)
  /^([^\n#]+?(?:さん|様|氏))\s*$/gm,
  // Name with colon (氏名：Aさん, 利用者：Bさん, etc.)
  /^(?:氏名|利用者|対象者)[：:]\s*(.+?(?:さん|様|氏))\s*$/gm,
  // Decorated names (--- Aさん ---, === Bさん ===, etc.)
  /^[-=]{3,}\s*(.+?(?:さん|様|氏))\s*[-=]{3,}\s*$/gm,
]

export function splitByPerson(text: string): Map<string, string> {
  const sections = new Map<string, string>()
  
  // Try each pattern until we find matches
  let matches: RegExpMatchArray[] = []
  let usedPattern: RegExp | null = null
  
  for (const pattern of NAME_HEADER_PATTERNS) {
    const foundMatches = Array.from(text.matchAll(pattern))
    if (foundMatches.length > 0) {
      matches = foundMatches
      usedPattern = pattern
      break
    }
  }
  
  if (matches.length === 0) {
    // No sections found, treat entire text as one section
    sections.set('未分類さん', text.trim())
    return sections
  }
  
  // Extract sections based on found matches
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i]
    const name = match[1].trim()
    
    // Get content between this header and the next (or end of text)
    const startIdx = match.index! + match[0].length
    const endIdx = i + 1 < matches.length ? matches[i + 1].index! : text.length
    let content = text.substring(startIdx, endIdx).trim()
    
    // Clean up the content
    // Remove sub-headers that might be in the content
    content = content.replace(/^\s*#{1,6}\s*(日付|内容|記録|備考)\s*$/gm, '')
    content = content.replace(/^[-=]{3,}\s*$/gm, '') // Remove horizontal lines
    content = content.trim()
    
    // Merge if same person appears multiple times
    if (sections.has(name)) {
      const existing = sections.get(name)!
      sections.set(name, existing + '\n\n' + content)
    } else {
      sections.set(name, content)
    }
  }
  
  // Validate sections (remove empty ones)
  for (const [name, content] of sections) {
    if (!content || content.length < 10) {
      sections.delete(name)
    }
  }
  
  // If all sections were removed, add fallback
  if (sections.size === 0) {
    sections.set('未分類さん', text.trim())
  }
  
  return sections
}

// Utility to preview section detection for debugging
export function previewSections(text: string): string[] {
  const sections = splitByPerson(text)
  const preview: string[] = []
  
  for (const [name, content] of sections) {
    const contentPreview = content.substring(0, 100) + (content.length > 100 ? '...' : '')
    preview.push(`【${name}】(${content.length}文字): ${contentPreview}`)
  }
  
  return preview
}