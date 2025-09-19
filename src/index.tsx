import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/cloudflare-workers'
import { extractTextFromPDF } from './utils/pdf-extractor'
import { extractFromExcel } from './utils/excel-reader'
import { splitByPerson } from './utils/text-splitter'
import { processSummaries } from './utils/summarizer'
import { buildExcel } from './utils/excel-generator'

// Types for Cloudflare Bindings
type Bindings = {
  OPENAI_API_KEY: string
  BASIC_USER?: string
  BASIC_PASS?: string
  OPENAI_MODEL?: string
  MAX_CONCURRENCY?: string
}

const app = new Hono<{ Bindings: Bindings }>()

// Enable CORS for API routes
app.use('/api/*', cors())

// Serve static files
app.use('/static/*', serveStatic({ root: './public' }))

// Basic Authentication check function
function checkBasicAuth(c: any): boolean {
  const { BASIC_USER, BASIC_PASS } = c.env
  
  // If no credentials configured, allow access
  if (!BASIC_USER || !BASIC_PASS) {
    return true
  }
  
  const auth = c.req.header('Authorization')
  
  if (!auth || !auth.startsWith('Basic ')) {
    return false
  }
  
  try {
    const base64Credentials = auth.substring(6)
    const credentials = atob(base64Credentials)
    const [user, pass] = credentials.split(':')
    
    return user === BASIC_USER && pass === BASIC_PASS
  } catch {
    return false
  }
}

// Main page HTML
const INDEX_HTML = `<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>月次経過記録 → Excel要約（200〜300文字・敬体）</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
</head>
<body class="bg-gradient-to-br from-blue-50 to-indigo-100 min-h-screen">
    <div class="container mx-auto px-4 py-8">
        <div class="max-w-3xl mx-auto">
            <!-- Header -->
            <div class="text-center mb-8">
                <h1 class="text-4xl font-bold text-gray-800 mb-2">
                    <i class="fas fa-file-alt text-blue-600 mr-3"></i>
                    月次経過記録要約システム
                </h1>
                <p class="text-gray-600">高齢者デイサービス向け AI要約ツール</p>
            </div>
            
            <!-- Important Notice -->
            <div class="bg-yellow-50 border-l-4 border-yellow-500 p-4 mb-6 rounded">
                <div class="flex">
                    <i class="fas fa-exclamation-circle text-yellow-600 mt-1 mr-3"></i>
                    <div>
                        <p class="text-yellow-800 font-semibold mb-1">推奨ファイル形式</p>
                        <p class="text-yellow-700 text-sm">
                            <span class="font-medium">Excelファイル（.xlsx）</span>を推奨します。
                            PDFの場合、文字化けする可能性があります。
                        </p>
                    </div>
                </div>
            </div>
            
            <!-- Main Card -->
            <div class="bg-white rounded-xl shadow-2xl p-8">
                <div class="mb-6">
                    <h2 class="text-xl font-semibold text-gray-800 mb-3">
                        <i class="fas fa-info-circle text-blue-600 mr-2"></i>
                        システムの特徴
                    </h2>
                    <ul class="space-y-2 text-gray-600">
                        <li class="flex items-start">
                            <i class="fas fa-check-circle text-green-500 mt-1 mr-2"></i>
                            <span>Excel・PDFファイルから60名分の記録を自動抽出</span>
                        </li>
                        <li class="flex items-start">
                            <i class="fas fa-check-circle text-green-500 mt-1 mr-2"></i>
                            <span>各利用者ごとに200〜300文字の要約を生成</span>
                        </li>
                        <li class="flex items-start">
                            <i class="fas fa-check-circle text-green-500 mt-1 mr-2"></i>
                            <span>敬体（です・ます調）で統一された文章</span>
                        </li>
                        <li class="flex items-start">
                            <i class="fas fa-check-circle text-green-500 mt-1 mr-2"></i>
                            <span>重複名は自動で番号付与（①②③...）</span>
                        </li>
                    </ul>
                </div>
                
                <!-- File Format Guide -->
                <div class="mb-6 bg-blue-50 rounded-lg p-4">
                    <h3 class="text-lg font-semibold text-blue-800 mb-2">
                        <i class="fas fa-file-excel text-green-600 mr-2"></i>
                        推奨Excelファイル形式
                    </h3>
                    <ul class="text-sm text-blue-700 space-y-1">
                        <li>• 列構成: 「氏名」列と「記録内容」列</li>
                        <li>• または各シートに1名分の記録</li>
                        <li>• UTF-8エンコーディング（文字化け防止）</li>
                    </ul>
                </div>
                
                <form id="uploadForm" class="space-y-6">
                    <div class="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center hover:border-blue-500 transition-all duration-300 bg-gray-50 hover:bg-blue-50">
                        <input type="file" id="file" accept=".xlsx,.xls,.pdf" class="hidden" />
                        <label for="file" class="cursor-pointer block">
                            <i class="fas fa-cloud-upload-alt text-5xl text-gray-400 mb-4"></i>
                            <p class="text-lg font-medium text-gray-700" id="fileLabel">Excel または PDFファイルを選択</p>
                            <p class="text-sm text-gray-500 mt-2">クリックまたはドラッグ＆ドロップ</p>
                            <p class="text-xs text-gray-400 mt-1">対応形式: .xlsx, .xls, .pdf（最大30MB）</p>
                        </label>
                    </div>
                    
                    <button type="submit" id="submitBtn" disabled 
                            class="w-full bg-gradient-to-r from-blue-600 to-indigo-600 text-white py-4 px-6 rounded-lg font-semibold disabled:from-gray-400 disabled:to-gray-500 disabled:cursor-not-allowed hover:from-blue-700 hover:to-indigo-700 transition-all duration-300 shadow-lg">
                        <i class="fas fa-magic mr-2"></i>
                        要約処理を開始
                    </button>
                </form>
                
                <!-- Progress Area -->
                <div id="progressArea" class="hidden mt-6">
                    <div class="bg-blue-50 border-l-4 border-blue-500 p-4 rounded">
                        <div class="flex items-center mb-2">
                            <i class="fas fa-spinner fa-spin text-blue-600 mr-3"></i>
                            <span id="progressText" class="text-blue-700 font-medium">処理中...</span>
                        </div>
                        <div class="bg-gray-200 rounded-full h-3 overflow-hidden">
                            <div id="progressBar" class="bg-gradient-to-r from-blue-500 to-indigo-500 h-3 rounded-full transition-all duration-500 ease-out" style="width: 0%"></div>
                        </div>
                        <p id="progressDetail" class="text-sm text-blue-600 mt-2"></p>
                    </div>
                </div>
                
                <!-- Error Area -->
                <div id="errorArea" class="hidden mt-6">
                    <div class="bg-red-50 border-l-4 border-red-500 p-4 rounded">
                        <div class="flex items-start">
                            <i class="fas fa-exclamation-triangle text-red-600 mr-3 mt-1"></i>
                            <div>
                                <p class="text-red-700 font-medium">エラーが発生しました</p>
                                <p id="errorText" class="text-red-600 text-sm mt-1"></p>
                            </div>
                        </div>
                    </div>
                </div>
                
                <!-- Success Area -->
                <div id="successArea" class="hidden mt-6">
                    <div class="bg-green-50 border-l-4 border-green-500 p-4 rounded">
                        <div class="flex items-center">
                            <i class="fas fa-check-circle text-green-600 mr-3"></i>
                            <div>
                                <p class="text-green-700 font-medium">処理が完了しました</p>
                                <p class="text-green-600 text-sm mt-1">Excelファイルがダウンロードされます。</p>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            
            <!-- Footer -->
            <div class="mt-8 text-center">
                <p class="text-sm text-gray-600">
                    <i class="fas fa-shield-alt mr-1"></i>
                    セキュアな環境で処理され、データは保存されません
                </p>
                <p class="text-xs text-gray-500 mt-2">
                    © 2024 高齢者デイサービス 月次経過記録要約システム
                </p>
            </div>
        </div>
    </div>

    <script>
        const fileInput = document.getElementById('file');
        const fileLabel = document.getElementById('fileLabel');
        const submitBtn = document.getElementById('submitBtn');
        const uploadForm = document.getElementById('uploadForm');
        const progressArea = document.getElementById('progressArea');
        const progressText = document.getElementById('progressText');
        const progressBar = document.getElementById('progressBar');
        const progressDetail = document.getElementById('progressDetail');
        const errorArea = document.getElementById('errorArea');
        const errorText = document.getElementById('errorText');
        const successArea = document.getElementById('successArea');
        
        // File selection
        fileInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) {
                const sizeMB = (file.size / 1024 / 1024).toFixed(2);
                const extension = file.name.split('.').pop().toLowerCase();
                let icon = 'fa-file';
                if (extension === 'xlsx' || extension === 'xls') {
                    icon = 'fa-file-excel text-green-600';
                } else if (extension === 'pdf') {
                    icon = 'fa-file-pdf text-red-600';
                }
                fileLabel.innerHTML = \`<i class="fas \${icon} mr-2"></i><span class="font-medium">\${file.name}</span><br><span class="text-sm text-gray-500">(\${sizeMB} MB)</span>\`;
                submitBtn.disabled = false;
            } else {
                fileLabel.innerHTML = 'Excel または PDFファイルを選択';
                submitBtn.disabled = true;
            }
        });
        
        // Drag and drop
        const dropZone = fileInput.parentElement.parentElement;
        
        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
            dropZone.addEventListener(eventName, preventDefaults, false);
        });
        
        function preventDefaults(e) {
            e.preventDefault();
            e.stopPropagation();
        }
        
        ['dragenter', 'dragover'].forEach(eventName => {
            dropZone.addEventListener(eventName, highlight, false);
        });
        
        ['dragleave', 'drop'].forEach(eventName => {
            dropZone.addEventListener(eventName, unhighlight, false);
        });
        
        function highlight(e) {
            dropZone.classList.add('border-blue-500', 'bg-blue-50');
        }
        
        function unhighlight(e) {
            dropZone.classList.remove('border-blue-500', 'bg-blue-50');
        }
        
        dropZone.addEventListener('drop', handleDrop, false);
        
        function handleDrop(e) {
            const dt = e.dataTransfer;
            const files = dt.files;
            
            if (files.length > 0) {
                const file = files[0];
                const extension = file.name.split('.').pop().toLowerCase();
                if (['xlsx', 'xls', 'pdf'].includes(extension)) {
                    fileInput.files = files;
                    const sizeMB = (file.size / 1024 / 1024).toFixed(2);
                    let icon = 'fa-file';
                    if (extension === 'xlsx' || extension === 'xls') {
                        icon = 'fa-file-excel text-green-600';
                    } else if (extension === 'pdf') {
                        icon = 'fa-file-pdf text-red-600';
                    }
                    fileLabel.innerHTML = \`<i class="fas \${icon} mr-2"></i><span class="font-medium">\${file.name}</span><br><span class="text-sm text-gray-500">(\${sizeMB} MB)</span>\`;
                    submitBtn.disabled = false;
                }
            }
        }
        
        // Form submission
        uploadForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const file = fileInput.files[0];
            if (!file) return;
            
            // Check file size (30MB limit)
            if (file.size > 30 * 1024 * 1024) {
                errorArea.classList.remove('hidden');
                errorText.textContent = 'ファイルサイズが大きすぎます。30MB以下のファイルを選択してください。';
                return;
            }
            
            // Reset UI
            errorArea.classList.add('hidden');
            successArea.classList.add('hidden');
            progressArea.classList.remove('hidden');
            submitBtn.disabled = true;
            
            // Update progress based on file type
            const extension = file.name.split('.').pop().toLowerCase();
            const fileType = (extension === 'xlsx' || extension === 'xls') ? 'Excel' : 'PDF';
            
            updateProgress(10, \`\${fileType}ファイルをアップロード中...\`, 'ファイルを送信しています');
            
            const formData = new FormData();
            formData.append('file', file);
            
            try {
                updateProgress(30, \`\${fileType}ファイルを解析中...\`, 'データを抽出しています');
                
                const response = await fetch('/api/upload', {
                    method: 'POST',
                    body: formData
                });
                
                if (!response.ok) {
                    const errorMessage = await response.text();
                    throw new Error(errorMessage || 'アップロードに失敗しました');
                }
                
                updateProgress(60, '要約を生成中...', 'AIが各利用者の記録を要約しています');
                
                // Since the processing is done on the server, we simulate progress
                setTimeout(() => {
                    updateProgress(80, 'Excelファイルを生成中...', '最終処理を実行しています');
                }, 500);
                
                // Get the blob and create download link
                const blob = await response.blob();
                
                updateProgress(100, '完了！', 'ダウンロードを開始します');
                
                // Create download link
                const url = window.URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                const now = new Date();
                const timestamp = now.toISOString().slice(0, 19).replace(/[T:]/g, '-');
                a.download = \`要約_\${timestamp}.xlsx\`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                window.URL.revokeObjectURL(url);
                
                // Show success message
                setTimeout(() => {
                    progressArea.classList.add('hidden');
                    successArea.classList.remove('hidden');
                    submitBtn.disabled = false;
                    
                    // Reset form after 3 seconds
                    setTimeout(() => {
                        fileInput.value = '';
                        fileLabel.innerHTML = 'Excel または PDFファイルを選択';
                        successArea.classList.add('hidden');
                    }, 3000);
                }, 1000);
                
            } catch (error) {
                console.error('Upload error:', error);
                progressArea.classList.add('hidden');
                errorArea.classList.remove('hidden');
                errorText.textContent = error.message || '処理中にエラーが発生しました。Excelファイル（.xlsx）の使用を推奨します。';
                submitBtn.disabled = false;
            }
        });
        
        function updateProgress(percent, text, detail) {
            progressBar.style.width = percent + '%';
            progressText.textContent = text;
            if (detail) {
                progressDetail.textContent = detail;
            }
        }
    </script>
</body>
</html>`

// Routes
app.get('/', (c) => {
  if (!checkBasicAuth(c)) {
    c.status(401)
    c.header('WWW-Authenticate', 'Basic realm="Protected"')
    return c.text('Unauthorized')
  }
  
  return c.html(INDEX_HTML)
})

// Upload endpoint - supports both Excel and PDF
app.post('/api/upload', async (c) => {
  const { OPENAI_API_KEY, OPENAI_MODEL = 'deepseek-reasoner', MAX_CONCURRENCY = '8' } = c.env
  
  // Check basic auth
  if (!checkBasicAuth(c)) {
    return c.text('Unauthorized', 401)
  }
  
  // Check if OpenAI API key is configured
  if (!OPENAI_API_KEY) {
    return c.text('DeepSeek APIキーが設定されていません', 500)
  }
  
  try {
    // Parse multipart form data
    const formData = await c.req.formData()
    const file = formData.get('file') as File
    
    if (!file) {
      return c.text('ファイルがアップロードされていません', 400)
    }
    
    // Check file size (30MB limit)
    if (file.size > 30 * 1024 * 1024) {
      return c.text('ファイルサイズが大きすぎます（最大30MB）', 400)
    }
    
    const fileName = file.name.toLowerCase()
    const isExcel = fileName.endsWith('.xlsx') || fileName.endsWith('.xls')
    const isPDF = fileName.endsWith('.pdf')
    
    if (!isExcel && !isPDF) {
      return c.text('対応していないファイル形式です。Excel（.xlsx/.xls）またはPDF（.pdf）をアップロードしてください', 400)
    }
    
    console.log(`Processing ${isExcel ? 'Excel' : 'PDF'} file: ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`)
    
    // Read file content
    const buffer = await file.arrayBuffer()
    
    let sections: Map<string, string>
    
    if (isExcel) {
      // Process Excel file
      console.log('Processing as Excel file')
      try {
        sections = await extractFromExcel(buffer)
      } catch (error) {
        console.error('Excel extraction failed:', error)
        return c.text(`Excelファイルの読み取りに失敗しました: ${error instanceof Error ? error.message : 'Unknown error'}`, 400)
      }
    } else {
      // Process PDF file
      console.log('Processing as PDF file')
      const text = await extractTextFromPDF(buffer)
      
      if (!text || text.trim().length < 100) {
        return c.text('PDFからテキストを抽出できませんでした。Excelファイル（.xlsx）の使用を推奨します', 400)
      }
      
      console.log(`Extracted text length: ${text.length} characters`)
      
      // Check for garbled text
      const garbledRatio = (text.match(/[�\uFFFD]/g) || []).length / text.length
      if (garbledRatio > 0.1) {
        return c.text('PDFの文字が正しく読み取れません。Excelファイル（.xlsx）の使用を強く推奨します', 400)
      }
      
      // Split by person
      sections = splitByPerson(text)
    }
    
    if (sections.size === 0) {
      return c.text('利用者ごとのセクションを検出できませんでした。ファイル形式を確認してください', 400)
    }
    
    console.log(`Found ${sections.size} person sections`)
    
    // Log section details for debugging
    let totalChars = 0
    for (const [name, content] of sections) {
      console.log(`  - ${name}: ${content.length} characters`)
      totalChars += content.length
    }
    console.log(`Total characters across all sections: ${totalChars}`)
    
    // Warn if sections seem unusually large
    if (sections.size === 1 && totalChars > 100000) {
      console.warn('WARNING: Only 1 section found with very large content. File splitting may have failed.')
    }
    
    // Process summaries with OpenAI/DeepSeek
    const maxConcurrency = parseInt(MAX_CONCURRENCY)
    const summaries = await processSummaries(
      sections,
      OPENAI_API_KEY,
      OPENAI_MODEL,
      maxConcurrency
    )
    
    console.log(`Generated ${summaries.size} summaries`)
    
    // Generate Excel file
    const excelBuffer = await buildExcel(summaries)
    
    // Return Excel file
    const now = new Date()
    const filename = `要約_${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}.xlsx`
    
    return new Response(excelBuffer, {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      },
    })
    
  } catch (error) {
    console.error('Processing error:', error)
    return c.text(
      `処理中にエラーが発生しました: ${error instanceof Error ? error.message : 'Unknown error'}`,
      500
    )
  }
})

// Health check endpoint
app.get('/api/health', (c) => {
  return c.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: '2.0.0',
    features: ['Excel', 'PDF', 'DeepSeek AI']
  })
})

export default app