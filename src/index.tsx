import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/cloudflare-workers'
import { extractTextFromPDF } from './utils/pdf-extractor'
import { extractFromExcel } from './utils/excel-reader'
import { mergeExcelFiles } from './utils/excel-merger'
import { summarizeAndMergeExcelFiles } from './utils/summarize-and-merge'
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
    <title>月次経過記録システム - AI要約 & Excel統合</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
</head>
<body class="bg-gradient-to-br from-blue-50 to-indigo-100 min-h-screen">
    <div class="container mx-auto px-4 py-8">
        <div class="max-w-4xl mx-auto">
            <!-- Header -->
            <div class="text-center mb-8">
                <h1 class="text-4xl font-bold text-gray-800 mb-2">
                    <i class="fas fa-file-alt text-blue-600 mr-3"></i>
                    月次経過記録システム
                </h1>
                <p class="text-gray-600">高齢者デイサービス向け AI要約 & Excel統合ツール</p>
            </div>
            
            <!-- Mode Selection -->
            <div class="bg-white rounded-xl shadow-lg p-6 mb-6">
                <h2 class="text-xl font-semibold text-gray-800 mb-4">
                    <i class="fas fa-cog text-blue-600 mr-2"></i>
                    処理モードを選択
                </h2>
                <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <label class="cursor-pointer">
                        <input type="radio" name="mode" value="summarize" checked class="peer sr-only" />
                        <div class="p-4 border-2 rounded-lg transition-all peer-checked:border-blue-500 peer-checked:bg-blue-50 hover:border-gray-400">
                            <div class="flex items-center mb-2">
                                <i class="fas fa-brain text-blue-600 text-xl mr-2"></i>
                                <span class="font-semibold">AI要約のみ</span>
                            </div>
                            <p class="text-xs text-gray-600">
                                1つのファイルから各利用者を要約
                            </p>
                        </div>
                    </label>
                    
                    <label class="cursor-pointer">
                        <input type="radio" name="mode" value="merge" class="peer sr-only" />
                        <div class="p-4 border-2 rounded-lg transition-all peer-checked:border-green-500 peer-checked:bg-green-50 hover:border-gray-400">
                            <div class="flex items-center mb-2">
                                <i class="fas fa-object-group text-green-600 text-xl mr-2"></i>
                                <span class="font-semibold">統合のみ</span>
                            </div>
                            <p class="text-xs text-gray-600">
                                複数ファイルを1つに統合（要約なし）
                            </p>
                        </div>
                    </label>
                    
                    <label class="cursor-pointer">
                        <input type="radio" name="mode" value="summarize-merge" class="peer sr-only" />
                        <div class="p-4 border-2 rounded-lg transition-all peer-checked:border-purple-500 peer-checked:bg-purple-50 hover:border-gray-400">
                            <div class="flex items-center mb-2">
                                <i class="fas fa-magic text-purple-600 text-xl mr-2"></i>
                                <span class="font-semibold">要約＋統合</span>
                            </div>
                            <p class="text-xs text-gray-600">
                                複数ファイルを要約して統合
                            </p>
                        </div>
                    </label>
                </div>
            </div>
            
            <!-- Main Card -->
            <div class="bg-white rounded-xl shadow-2xl p-8">
                <!-- Mode-specific instructions -->
                <div id="summarizeInstructions" class="mode-content mb-6">
                    <h2 class="text-xl font-semibold text-gray-800 mb-3">
                        <i class="fas fa-info-circle text-blue-600 mr-2"></i>
                        AI要約モード
                    </h2>
                    <ul class="space-y-2 text-gray-600 text-sm">
                        <li><i class="fas fa-check text-green-500 mr-2"></i>1つのPDF/Excelファイルをアップロード</li>
                        <li><i class="fas fa-check text-green-500 mr-2"></i>各利用者ごとに200〜300文字に要約</li>
                        <li><i class="fas fa-check text-green-500 mr-2"></i>要約結果をExcelの各タブに出力</li>
                    </ul>
                </div>
                
                <div id="mergeInstructions" class="mode-content mb-6 hidden">
                    <h2 class="text-xl font-semibold text-gray-800 mb-3">
                        <i class="fas fa-info-circle text-green-600 mr-2"></i>
                        統合モード
                    </h2>
                    <ul class="space-y-2 text-gray-600 text-sm">
                        <li><i class="fas fa-check text-green-500 mr-2"></i>複数のExcelファイルをアップロード</li>
                        <li><i class="fas fa-check text-green-500 mr-2"></i>同じ利用者のデータを自動統合</li>
                        <li><i class="fas fa-check text-green-500 mr-2"></i>要約せずに元のデータのまま統合</li>
                    </ul>
                </div>
                
                <div id="summarizeMergeInstructions" class="mode-content mb-6 hidden">
                    <h2 class="text-xl font-semibold text-gray-800 mb-3">
                        <i class="fas fa-info-circle text-purple-600 mr-2"></i>
                        要約＋統合モード（推奨）
                    </h2>
                    <ul class="space-y-2 text-gray-600 text-sm">
                        <li><i class="fas fa-star text-yellow-500 mr-2"></i><strong>複数のExcelファイルをアップロード</strong></li>
                        <li><i class="fas fa-star text-yellow-500 mr-2"></i><strong>各ファイルから利用者を抽出・統合</strong></li>
                        <li><i class="fas fa-star text-yellow-500 mr-2"></i><strong>AIで200〜300文字に要約</strong></li>
                        <li><i class="fas fa-star text-yellow-500 mr-2"></i><strong>60名分を1つのExcelファイルに統合</strong></li>
                    </ul>
                    <div class="mt-3 p-3 bg-purple-50 rounded-lg">
                        <p class="text-sm text-purple-800">
                            <i class="fas fa-lightbulb mr-1"></i>
                            このモードが最も効率的です！
                        </p>
                    </div>
                </div>
                
                <form id="uploadForm" class="space-y-6">
                    <div class="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center hover:border-blue-500 transition-all duration-300 bg-gray-50 hover:bg-blue-50">
                        <input type="file" id="file" accept=".xlsx,.xls,.pdf" class="hidden" />
                        <input type="file" id="files" accept=".xlsx,.xls" multiple class="hidden" />
                        <label id="fileLabel" for="file" class="cursor-pointer block">
                            <i class="fas fa-cloud-upload-alt text-5xl text-gray-400 mb-4"></i>
                            <p class="text-lg font-medium text-gray-700" id="fileLabelText">ファイルを選択</p>
                            <p class="text-sm text-gray-500 mt-2">クリックまたはドラッグ＆ドロップ</p>
                            <p class="text-xs text-gray-400 mt-1" id="fileFormatHint">対応形式: .xlsx, .xls</p>
                        </label>
                        <div id="fileList" class="mt-4 text-left hidden">
                            <p class="text-sm font-medium text-gray-700 mb-2">選択されたファイル:</p>
                            <ul id="fileListItems" class="text-sm text-gray-600 space-y-1 max-h-32 overflow-y-auto"></ul>
                        </div>
                    </div>
                    
                    <button type="submit" id="submitBtn" disabled 
                            class="w-full bg-gradient-to-r from-blue-600 to-indigo-600 text-white py-4 px-6 rounded-lg font-semibold disabled:from-gray-400 disabled:to-gray-500 disabled:cursor-not-allowed hover:from-blue-700 hover:to-indigo-700 transition-all duration-300 shadow-lg">
                        <i class="fas fa-magic mr-2" id="submitIcon"></i>
                        <span id="submitText">処理を開始</span>
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
                                <p id="successText" class="text-green-600 text-sm mt-1">Excelファイルがダウンロードされます。</p>
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
            </div>
        </div>
    </div>

    <script>
        const fileInput = document.getElementById('file');
        const filesInput = document.getElementById('files');
        const fileLabel = document.getElementById('fileLabel');
        const fileLabelText = document.getElementById('fileLabelText');
        const fileFormatHint = document.getElementById('fileFormatHint');
        const fileList = document.getElementById('fileList');
        const fileListItems = document.getElementById('fileListItems');
        const submitBtn = document.getElementById('submitBtn');
        const submitText = document.getElementById('submitText');
        const submitIcon = document.getElementById('submitIcon');
        const uploadForm = document.getElementById('uploadForm');
        const progressArea = document.getElementById('progressArea');
        const progressText = document.getElementById('progressText');
        const progressBar = document.getElementById('progressBar');
        const progressDetail = document.getElementById('progressDetail');
        const errorArea = document.getElementById('errorArea');
        const errorText = document.getElementById('errorText');
        const successArea = document.getElementById('successArea');
        const successText = document.getElementById('successText');
        
        let currentMode = 'summarize';
        let selectedFiles = [];
        
        // Mode selection
        document.querySelectorAll('input[name="mode"]').forEach(radio => {
            radio.addEventListener('change', (e) => {
                currentMode = e.target.value;
                updateUIForMode();
                clearFileSelection();
            });
        });
        
        function updateUIForMode() {
            const summarizeInstructions = document.getElementById('summarizeInstructions');
            const mergeInstructions = document.getElementById('mergeInstructions');
            const summarizeMergeInstructions = document.getElementById('summarizeMergeInstructions');
            
            // Hide all instructions
            summarizeInstructions.classList.add('hidden');
            mergeInstructions.classList.add('hidden');
            summarizeMergeInstructions.classList.add('hidden');
            
            if (currentMode === 'summarize') {
                summarizeInstructions.classList.remove('hidden');
                fileLabel.setAttribute('for', 'file');
                fileLabelText.textContent = 'ファイルを選択';
                fileFormatHint.textContent = '対応形式: .xlsx, .xls, .pdf（最大30MB）';
                submitText.textContent = 'AI要約を開始';
                submitIcon.className = 'fas fa-brain mr-2';
            } else if (currentMode === 'merge') {
                mergeInstructions.classList.remove('hidden');
                fileLabel.setAttribute('for', 'files');
                fileLabelText.textContent = '複数のExcelファイルを選択';
                fileFormatHint.textContent = '対応形式: .xlsx, .xls（複数選択可）';
                submitText.textContent = 'ファイル統合を開始';
                submitIcon.className = 'fas fa-object-group mr-2';
            } else { // summarize-merge
                summarizeMergeInstructions.classList.remove('hidden');
                fileLabel.setAttribute('for', 'files');
                fileLabelText.textContent = '複数のExcelファイルを選択';
                fileFormatHint.textContent = '対応形式: .xlsx, .xls（複数選択可）';
                submitText.textContent = 'AI要約＋統合を開始';
                submitIcon.className = 'fas fa-magic mr-2';
            }
        }
        
        function clearFileSelection() {
            fileInput.value = '';
            filesInput.value = '';
            selectedFiles = [];
            fileList.classList.add('hidden');
            fileListItems.innerHTML = '';
            updateFileLabel();
            submitBtn.disabled = true;
        }
        
        function updateFileLabel() {
            if (selectedFiles.length === 0) {
                if (currentMode === 'summarize') {
                    fileLabelText.textContent = 'ファイルを選択';
                } else {
                    fileLabelText.textContent = '複数のExcelファイルを選択';
                }
            } else if (selectedFiles.length === 1) {
                const file = selectedFiles[0];
                const sizeMB = (file.size / 1024 / 1024).toFixed(2);
                fileLabelText.innerHTML = \`<i class="fas fa-file-excel text-green-600 mr-2"></i>\${file.name} (\${sizeMB} MB)\`;
                fileList.classList.add('hidden');
            } else {
                fileLabelText.innerHTML = \`<i class="fas fa-layer-group text-purple-600 mr-2"></i>\${selectedFiles.length}個のファイルが選択されました\`;
                fileListItems.innerHTML = '';
                selectedFiles.forEach(file => {
                    const sizeMB = (file.size / 1024 / 1024).toFixed(2);
                    const li = document.createElement('li');
                    li.innerHTML = \`<i class="fas fa-file-excel text-green-500 text-xs mr-1"></i>\${file.name} <span class="text-gray-400">(\${sizeMB} MB)</span>\`;
                    fileListItems.appendChild(li);
                });
                fileList.classList.remove('hidden');
            }
        }
        
        // Single file selection
        fileInput.addEventListener('change', (e) => {
            if (currentMode !== 'summarize') return;
            selectedFiles = Array.from(e.target.files);
            updateFileLabel();
            submitBtn.disabled = selectedFiles.length === 0;
        });
        
        // Multiple file selection
        filesInput.addEventListener('change', (e) => {
            if (currentMode === 'summarize') return;
            selectedFiles = Array.from(e.target.files);
            updateFileLabel();
            submitBtn.disabled = selectedFiles.length === 0;
        });
        
        // Drag and drop
        const dropZone = fileLabel.parentElement;
        
        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
            dropZone.addEventListener(eventName, preventDefaults, false);
        });
        
        function preventDefaults(e) {
            e.preventDefault();
            e.stopPropagation();
        }
        
        ['dragenter', 'dragover'].forEach(eventName => {
            dropZone.addEventListener(eventName, () => dropZone.classList.add('border-blue-500', 'bg-blue-50'), false);
        });
        
        ['dragleave', 'drop'].forEach(eventName => {
            dropZone.addEventListener(eventName, () => dropZone.classList.remove('border-blue-500', 'bg-blue-50'), false);
        });
        
        dropZone.addEventListener('drop', (e) => {
            const files = Array.from(e.dataTransfer.files);
            if (currentMode === 'summarize') {
                fileInput.files = e.dataTransfer.files;
                selectedFiles = files.slice(0, 1);
            } else {
                const dt = new DataTransfer();
                files.forEach(file => {
                    if (file.name.match(/\.xlsx?$/i)) dt.items.add(file);
                });
                filesInput.files = dt.files;
                selectedFiles = Array.from(dt.files);
            }
            updateFileLabel();
            submitBtn.disabled = selectedFiles.length === 0;
        });
        
        // Form submission
        uploadForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            
            if (selectedFiles.length === 0) return;
            
            // Reset UI
            errorArea.classList.add('hidden');
            successArea.classList.add('hidden');
            progressArea.classList.remove('hidden');
            submitBtn.disabled = true;
            
            const formData = new FormData();
            formData.append('mode', currentMode);
            selectedFiles.forEach((file, index) => {
                formData.append(\`file\${index}\`, file);
            });
            formData.append('fileCount', selectedFiles.length.toString());
            
            try {
                // Update progress
                updateProgress(10, '処理を開始しています...', \`\${selectedFiles.length}個のファイルをアップロード中\`);
                
                const response = await fetch('/api/process', {
                    method: 'POST',
                    body: formData
                });
                
                if (!response.ok) {
                    const errorData = await response.text();
                    let errorMessage = 'エラーが発生しました';
                    try {
                        const errorJson = JSON.parse(errorData);
                        errorMessage = errorJson.error || errorMessage;
                    } catch {
                        errorMessage = errorData || errorMessage;
                    }
                    throw new Error(errorMessage);
                }
                
                // Update progress based on mode
                if (currentMode === 'summarize-merge') {
                    updateProgress(50, 'AI要約を生成中...', '各利用者の記録を要約しています');
                } else if (currentMode === 'merge') {
                    updateProgress(50, 'ファイルを統合中...', '利用者ごとにデータを整理しています');
                } else {
                    updateProgress(50, 'AI要約を生成中...', '記録を解析しています');
                }
                
                const blob = await response.blob();
                updateProgress(100, '完了！', 'ファイルをダウンロードします');
                
                // Download file
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                const timestamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
                const prefix = currentMode === 'merge' ? '統合' : '要約';
                a.download = \`\${prefix}_\${timestamp}.xlsx\`;
                a.click();
                URL.revokeObjectURL(url);
                
                // Show success
                setTimeout(() => {
                    progressArea.classList.add('hidden');
                    successArea.classList.remove('hidden');
                    if (currentMode === 'summarize-merge') {
                        successText.textContent = \`\${selectedFiles.length}個のファイルを要約・統合しました！\`;
                    }
                    submitBtn.disabled = false;
                    setTimeout(() => {
                        clearFileSelection();
                        successArea.classList.add('hidden');
                    }, 5000);
                }, 1000);
                
            } catch (error) {
                console.error('Processing error:', error);
                progressArea.classList.add('hidden');
                errorArea.classList.remove('hidden');
                
                // Provide more helpful error messages
                let errorMessage = error.message || 'エラーが発生しました';
                if (errorMessage.includes('APIキー')) {
                    errorMessage += ' (DeepSeek APIキーの設定を確認してください)';
                } else if (errorMessage.includes('Failed to fetch')) {
                    errorMessage = 'サーバーに接続できません。しばらく待ってから再試行してください。';
                } else if (errorMessage.includes('timeout')) {
                    errorMessage = '処理がタイムアウトしました。ファイルサイズを確認してください。';
                }
                
                errorText.textContent = errorMessage;
                submitBtn.disabled = false;
            }
        });
        
        function updateProgress(percent, text, detail) {
            progressBar.style.width = percent + '%';
            progressText.textContent = text;
            progressDetail.textContent = detail || '';
        }
        
        // Initialize
        updateUIForMode();
    </script>
</body>
</html>`

// Routes remain the same...
app.get('/', (c) => {
  if (!checkBasicAuth(c)) {
    c.status(401)
    c.header('WWW-Authenticate', 'Basic realm="Protected"')
    return c.text('Unauthorized')
  }
  
  return c.html(INDEX_HTML)
})

// Process endpoint - handles all three modes
app.post('/api/process', async (c) => {
  const { OPENAI_API_KEY, OPENAI_MODEL = 'deepseek-chat', MAX_CONCURRENCY = '8' } = c.env
  
  // Log environment variables for debugging (mask sensitive data)
  console.log('Environment check:', {
    hasApiKey: !!OPENAI_API_KEY,
    apiKeyLength: OPENAI_API_KEY ? OPENAI_API_KEY.length : 0,
    apiKeyPrefix: OPENAI_API_KEY ? OPENAI_API_KEY.substring(0, 5) + '...' : 'not set',
    model: OPENAI_MODEL,
    maxConcurrency: MAX_CONCURRENCY
  })
  
  if (!checkBasicAuth(c)) {
    return c.text('Unauthorized', 401)
  }
  
  try {
    const formData = await c.req.formData()
    const mode = formData.get('mode') as string
    const fileCount = parseInt(formData.get('fileCount') as string || '1')
    
    // Collect files
    const files: { fileName: string; buffer: ArrayBuffer }[] = []
    for (let i = 0; i < fileCount; i++) {
      const file = formData.get(`file${i}`) as File
      if (file) {
        files.push({
          fileName: file.name,
          buffer: await file.arrayBuffer()
        })
      }
    }
    
    if (files.length === 0) {
      return c.text('ファイルがアップロードされていません', 400)
    }
    
    console.log(`Processing ${files.length} files in ${mode} mode`)
    
    let resultBuffer: ArrayBuffer
    
    switch (mode) {
      case 'merge':
        // Simple merge without summarization
        resultBuffer = await mergeExcelFiles(files)
        break
        
      case 'summarize-merge':
        // Summarize and merge multiple files
        if (!OPENAI_API_KEY) {
          console.error('API key not configured for API request')
          return c.json({ error: 'APIキーが設定されていません。管理者に連絡してください。' }, 500)
        }
        resultBuffer = await summarizeAndMergeExcelFiles(
          files,
          OPENAI_API_KEY,
          OPENAI_MODEL,
          parseInt(MAX_CONCURRENCY)
        )
        break
        
      case 'summarize':
      default:
        // Single file summarization
        if (files.length !== 1) {
          return c.text('要約モードでは1つのファイルのみ処理できます', 400)
        }
        
        if (!OPENAI_API_KEY) {
          console.error('API key not configured for API request')
          return c.json({ error: 'APIキーが設定されていません。管理者に連絡してください。' }, 500)
        }
        
        const file = files[0]
        const isExcel = file.fileName.toLowerCase().match(/\.xlsx?$/)
        let sections: Map<string, string>
        
        if (isExcel) {
          sections = await extractFromExcel(file.buffer)
        } else {
          const text = await extractTextFromPDF(file.buffer)
          sections = splitByPerson(text)
        }
        
        const summaries = await processSummaries(
          sections,
          OPENAI_API_KEY,
          OPENAI_MODEL,
          parseInt(MAX_CONCURRENCY)
        )
        
        resultBuffer = await buildExcel(summaries)
        break
    }
    
    // Return Excel file
    const timestamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '')
    const prefix = mode === 'merge' ? '統合' : mode === 'summarize-merge' ? '要約統合' : '要約'
    
    return new Response(resultBuffer, {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${prefix}_${timestamp}.xlsx"`,
        'Cache-Control': 'no-cache',
      },
    })
    
  } catch (error) {
    console.error('Processing error:', error)
    return c.text(error instanceof Error ? error.message : '処理中にエラーが発生しました', 500)
  }
})

// Health check
app.get('/api/health', (c) => {
  return c.json({
    status: 'healthy',
    version: '3.0.0',
    features: ['要約のみ', '統合のみ', '要約＋統合']
  })
})

export default app