import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/cloudflare-workers'
import { extractTextFromPDF } from './utils/pdf-extractor'
import { extractFromExcel } from './utils/excel-reader'
import { mergeExcelFiles } from './utils/excel-merger'
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

// Main page HTML with multiple file upload support
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
                <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <label class="cursor-pointer">
                        <input type="radio" name="mode" value="summarize" checked class="peer sr-only" />
                        <div class="p-4 border-2 rounded-lg transition-all peer-checked:border-blue-500 peer-checked:bg-blue-50 hover:border-gray-400">
                            <div class="flex items-center mb-2">
                                <i class="fas fa-brain text-blue-600 text-2xl mr-3"></i>
                                <span class="font-semibold text-lg">AI要約モード</span>
                            </div>
                            <p class="text-sm text-gray-600">
                                1つのPDF/Excelファイルから各利用者の記録を200〜300文字に要約
                            </p>
                        </div>
                    </label>
                    
                    <label class="cursor-pointer">
                        <input type="radio" name="mode" value="merge" class="peer sr-only" />
                        <div class="p-4 border-2 rounded-lg transition-all peer-checked:border-green-500 peer-checked:bg-green-50 hover:border-gray-400">
                            <div class="flex items-center mb-2">
                                <i class="fas fa-object-group text-green-600 text-2xl mr-3"></i>
                                <span class="font-semibold text-lg">Excel統合モード</span>
                            </div>
                            <p class="text-sm text-gray-600">
                                複数のExcelファイルを1つに統合し、利用者ごとにタブ分け
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
                        AI要約モードの特徴
                    </h2>
                    <ul class="space-y-2 text-gray-600">
                        <li class="flex items-start">
                            <i class="fas fa-check-circle text-green-500 mt-1 mr-2"></i>
                            <span>60名分の記録を自動で個別に分割</span>
                        </li>
                        <li class="flex items-start">
                            <i class="fas fa-check-circle text-green-500 mt-1 mr-2"></i>
                            <span>各利用者ごとに200〜300文字の要約を生成</span>
                        </li>
                        <li class="flex items-start">
                            <i class="fas fa-check-circle text-green-500 mt-1 mr-2"></i>
                            <span>敬体（です・ます調）で統一された文章</span>
                        </li>
                    </ul>
                    <div class="mt-4 p-3 bg-yellow-50 rounded-lg">
                        <p class="text-sm text-yellow-800">
                            <i class="fas fa-lightbulb mr-1"></i>
                            <strong>推奨:</strong> Excelファイル（.xlsx）を使用してください
                        </p>
                    </div>
                </div>
                
                <div id="mergeInstructions" class="mode-content mb-6 hidden">
                    <h2 class="text-xl font-semibold text-gray-800 mb-3">
                        <i class="fas fa-info-circle text-green-600 mr-2"></i>
                        Excel統合モードの特徴
                    </h2>
                    <ul class="space-y-2 text-gray-600">
                        <li class="flex items-start">
                            <i class="fas fa-check-circle text-green-500 mt-1 mr-2"></i>
                            <span>複数のExcelファイルを一度にアップロード</span>
                        </li>
                        <li class="flex items-start">
                            <i class="fas fa-check-circle text-green-500 mt-1 mr-2"></i>
                            <span>同じ利用者の記録を自動で統合</span>
                        </li>
                        <li class="flex items-start">
                            <i class="fas fa-check-circle text-green-500 mt-1 mr-2"></i>
                            <span>各利用者ごとに個別のタブを作成</span>
                        </li>
                        <li class="flex items-start">
                            <i class="fas fa-check-circle text-green-500 mt-1 mr-2"></i>
                            <span>統合サマリーシートを自動生成</span>
                        </li>
                    </ul>
                    <div class="mt-4 p-3 bg-blue-50 rounded-lg">
                        <p class="text-sm text-blue-800">
                            <i class="fas fa-info-circle mr-1"></i>
                            <strong>用途:</strong> 月別・日別のExcelファイルをまとめたい時に便利です
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
                            <p class="text-xs text-gray-400 mt-1" id="fileFormatHint">対応形式: .xlsx, .xls, .pdf（最大30MB）</p>
                        </label>
                        <div id="fileList" class="mt-4 text-left hidden">
                            <p class="text-sm font-medium text-gray-700 mb-2">選択されたファイル:</p>
                            <ul id="fileListItems" class="text-sm text-gray-600 space-y-1"></ul>
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
                    © 2024 高齢者デイサービス 月次経過記録システム
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
            
            if (currentMode === 'summarize') {
                summarizeInstructions.classList.remove('hidden');
                mergeInstructions.classList.add('hidden');
                fileLabel.setAttribute('for', 'file');
                fileLabelText.textContent = 'ファイルを選択';
                fileFormatHint.textContent = '対応形式: .xlsx, .xls, .pdf（最大30MB）';
                submitText.textContent = 'AI要約を開始';
                submitIcon.className = 'fas fa-magic mr-2';
            } else {
                summarizeInstructions.classList.add('hidden');
                mergeInstructions.classList.remove('hidden');
                fileLabel.setAttribute('for', 'files');
                fileLabelText.textContent = '複数のExcelファイルを選択';
                fileFormatHint.textContent = '対応形式: .xlsx, .xls（複数選択可、各30MB以下）';
                submitText.textContent = 'Excel統合を開始';
                submitIcon.className = 'fas fa-object-group mr-2';
            }
        }
        
        function clearFileSelection() {
            fileInput.value = '';
            filesInput.value = '';
            selectedFiles = [];
            fileList.classList.add('hidden');
            fileListItems.innerHTML = '';
            fileLabelText.textContent = currentMode === 'merge' ? '複数のExcelファイルを選択' : 'ファイルを選択';
            submitBtn.disabled = true;
        }
        
        // Single file selection (summarize mode)
        fileInput.addEventListener('change', (e) => {
            if (currentMode !== 'summarize') return;
            
            const file = e.target.files[0];
            if (file) {
                selectedFiles = [file];
                displaySelectedFiles();
                submitBtn.disabled = false;
            } else {
                clearFileSelection();
            }
        });
        
        // Multiple file selection (merge mode)
        filesInput.addEventListener('change', (e) => {
            if (currentMode !== 'merge') return;
            
            selectedFiles = Array.from(e.target.files);
            if (selectedFiles.length > 0) {
                displaySelectedFiles();
                submitBtn.disabled = false;
            } else {
                clearFileSelection();
            }
        });
        
        function displaySelectedFiles() {
            if (selectedFiles.length === 1) {
                const file = selectedFiles[0];
                const sizeMB = (file.size / 1024 / 1024).toFixed(2);
                const extension = file.name.split('.').pop().toLowerCase();
                let icon = 'fa-file';
                if (extension === 'xlsx' || extension === 'xls') {
                    icon = 'fa-file-excel text-green-600';
                } else if (extension === 'pdf') {
                    icon = 'fa-file-pdf text-red-600';
                }
                fileLabelText.innerHTML = \`<i class="fas \${icon} mr-2"></i><span class="font-medium">\${file.name}</span> (\${sizeMB} MB)\`;
                fileList.classList.add('hidden');
            } else {
                fileLabelText.textContent = \`\${selectedFiles.length}個のファイルが選択されました\`;
                fileListItems.innerHTML = '';
                selectedFiles.forEach(file => {
                    const sizeMB = (file.size / 1024 / 1024).toFixed(2);
                    const li = document.createElement('li');
                    li.innerHTML = \`<i class="fas fa-file-excel text-green-600 mr-2"></i>\${file.name} (\${sizeMB} MB)\`;
                    fileListItems.appendChild(li);
                });
                fileList.classList.remove('hidden');
            }
        }
        
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
            const files = Array.from(dt.files);
            
            if (files.length > 0) {
                if (currentMode === 'summarize') {
                    // Single file mode
                    const file = files[0];
                    const extension = file.name.split('.').pop().toLowerCase();
                    if (['xlsx', 'xls', 'pdf'].includes(extension)) {
                        fileInput.files = dt.files;
                        selectedFiles = [file];
                        displaySelectedFiles();
                        submitBtn.disabled = false;
                    }
                } else {
                    // Multiple file mode
                    const validFiles = files.filter(file => {
                        const extension = file.name.split('.').pop().toLowerCase();
                        return ['xlsx', 'xls'].includes(extension);
                    });
                    
                    if (validFiles.length > 0) {
                        // Create a new FileList-like object
                        const dataTransfer = new DataTransfer();
                        validFiles.forEach(file => dataTransfer.items.add(file));
                        filesInput.files = dataTransfer.files;
                        selectedFiles = validFiles;
                        displaySelectedFiles();
                        submitBtn.disabled = false;
                    }
                }
            }
        }
        
        // Form submission
        uploadForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            
            if (selectedFiles.length === 0) return;
            
            // Check total file size
            const totalSize = selectedFiles.reduce((sum, file) => sum + file.size, 0);
            if (totalSize > 100 * 1024 * 1024) { // 100MB total limit for multiple files
                errorArea.classList.remove('hidden');
                errorText.textContent = 'ファイルの合計サイズが大きすぎます。合計100MB以下にしてください。';
                return;
            }
            
            // Reset UI
            errorArea.classList.add('hidden');
            successArea.classList.add('hidden');
            progressArea.classList.remove('hidden');
            submitBtn.disabled = true;
            
            // Update progress based on mode
            const modeText = currentMode === 'summarize' ? 'AI要約' : 'Excel統合';
            updateProgress(10, \`\${modeText}処理を開始...\`, 'ファイルをアップロード中');
            
            const formData = new FormData();
            formData.append('mode', currentMode);
            
            // Add files to form data
            selectedFiles.forEach((file, index) => {
                formData.append(\`file\${index}\`, file);
            });
            formData.append('fileCount', selectedFiles.length.toString());
            
            try {
                updateProgress(30, 'ファイルを解析中...', \`\${selectedFiles.length}個のファイルを処理しています\`);
                
                const response = await fetch('/api/process', {
                    method: 'POST',
                    body: formData
                });
                
                if (!response.ok) {
                    const errorMessage = await response.text();
                    throw new Error(errorMessage || '処理に失敗しました');
                }
                
                if (currentMode === 'summarize') {
                    updateProgress(60, 'AI要約を生成中...', '各利用者の記録を要約しています');
                } else {
                    updateProgress(60, 'Excelファイルを統合中...', '利用者ごとにタブを作成しています');
                }
                
                // Get the blob and create download link
                const blob = await response.blob();
                
                updateProgress(100, '完了！', 'ダウンロードを開始します');
                
                // Create download link
                const url = window.URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                const now = new Date();
                const timestamp = now.toISOString().slice(0, 19).replace(/[T:]/g, '-');
                const prefix = currentMode === 'summarize' ? '要約' : '統合';
                a.download = \`\${prefix}_\${timestamp}.xlsx\`;
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
                        clearFileSelection();
                        successArea.classList.add('hidden');
                    }, 3000);
                }, 1000);
                
            } catch (error) {
                console.error('Processing error:', error);
                progressArea.classList.add('hidden');
                errorArea.classList.remove('hidden');
                errorText.textContent = error.message || '処理中にエラーが発生しました。';
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
        
        // Initialize UI
        updateUIForMode();
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

// Unified processing endpoint - handles both summarization and merging
app.post('/api/process', async (c) => {
  const { OPENAI_API_KEY, OPENAI_MODEL = 'deepseek-reasoner', MAX_CONCURRENCY = '8' } = c.env
  
  // Check basic auth
  if (!checkBasicAuth(c)) {
    return c.text('Unauthorized', 401)
  }
  
  try {
    // Parse multipart form data
    const formData = await c.req.formData()
    const mode = formData.get('mode') as string
    const fileCount = parseInt(formData.get('fileCount') as string || '1')
    
    // Collect all files
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
    
    // Process based on mode
    if (mode === 'merge') {
      // Excel merge mode - no AI processing needed
      console.log('Starting Excel merge process')
      
      // Check all files are Excel
      const allExcel = files.every(f => 
        f.fileName.toLowerCase().endsWith('.xlsx') || 
        f.fileName.toLowerCase().endsWith('.xls')
      )
      
      if (!allExcel) {
        return c.text('統合モードではExcelファイルのみ対応しています', 400)
      }
      
      // Merge Excel files
      const mergedBuffer = await mergeExcelFiles(files)
      
      // Return merged Excel file
      const now = new Date()
      const filename = `統合_${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}.xlsx`
      
      return new Response(mergedBuffer, {
        headers: {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Cache-Control': 'no-cache, no-store, must-revalidate',
        },
      })
      
    } else {
      // Summarization mode - process with AI
      if (!OPENAI_API_KEY) {
        return c.text('DeepSeek APIキーが設定されていません', 500)
      }
      
      // Should only be one file for summarization
      if (files.length !== 1) {
        return c.text('要約モードでは1つのファイルのみ処理できます', 400)
      }
      
      const file = files[0]
      const fileName = file.fileName.toLowerCase()
      const isExcel = fileName.endsWith('.xlsx') || fileName.endsWith('.xls')
      const isPDF = fileName.endsWith('.pdf')
      
      if (!isExcel && !isPDF) {
        return c.text('対応していないファイル形式です', 400)
      }
      
      let sections: Map<string, string>
      
      if (isExcel) {
        // Process Excel file
        console.log('Processing as Excel file for summarization')
        sections = await extractFromExcel(file.buffer)
      } else {
        // Process PDF file
        console.log('Processing as PDF file for summarization')
        const text = await extractTextFromPDF(file.buffer)
        
        if (!text || text.trim().length < 100) {
          return c.text('PDFからテキストを抽出できませんでした。Excelファイル（.xlsx）の使用を推奨します', 400)
        }
        
        // Check for garbled text
        const garbledRatio = (text.match(/[�\uFFFD]/g) || []).length / text.length
        if (garbledRatio > 0.1) {
          return c.text('PDFの文字が正しく読み取れません。Excelファイル（.xlsx）の使用を強く推奨します', 400)
        }
        
        sections = splitByPerson(text)
      }
      
      if (sections.size === 0) {
        return c.text('利用者ごとのセクションを検出できませんでした', 400)
      }
      
      console.log(`Found ${sections.size} person sections for summarization`)
      
      // Process summaries with AI
      const maxConcurrency = parseInt(MAX_CONCURRENCY)
      const summaries = await processSummaries(
        sections,
        OPENAI_API_KEY,
        OPENAI_MODEL,
        maxConcurrency
      )
      
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
    }
    
  } catch (error) {
    console.error('Processing error:', error)
    return c.text(
      `処理中にエラーが発生しました: ${error instanceof Error ? error.message : 'Unknown error'}`,
      500
    )
  }
})

// Keep the old upload endpoint for compatibility
app.post('/api/upload', async (c) => {
  // Redirect to the new unified endpoint
  return c.redirect('/api/process', 307)
})

// Health check endpoint
app.get('/api/health', (c) => {
  return c.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: '3.0.0',
    features: ['Excel', 'PDF', 'DeepSeek AI', 'Multi-file merge']
  })
})

export default app