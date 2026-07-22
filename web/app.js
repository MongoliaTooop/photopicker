/* ===== 选片助手 - 网页版核心逻辑 =====
 * 使用 File System Access API 读取本地文件夹
 * 支持 Chrome / Edge / Brave 等 Chromium 内核浏览器
 * 
 * v3.1 更新：
 * - 移除工具栏重复「导出」按钮
 * - 匹配RAW对话框导出选项：复制RAW / 复制JPG+RAW / 导出清单CSV
 * - 缩略图尺寸预设（400/800/1200/自定义/不压缩）
 * - 打开文件夹时自动检测已有缩略图，无缩略图先弹设置对话框
 * - 缩略图文件名带尺寸标记（如 IMG_001_800.jpg），兼容旧格式
 */

const RAW_EXTENSIONS = ['.cr2', '.cr3', '.nef', '.arw', '.raf', '.dng', '.rw2', '.orf', '.x3f', '.sr2', '.srf', '.pef'];
const JPG_EXTENSIONS = ['.jpg', '.jpeg'];
const THUMB_QUALITY = 0.7;
const PAGE_SIZE = 100;
const LOAD_THRESHOLD_PX = 700; // 约15个缩略图项的高度

// 状态
const state = {
  jpgDirHandle: null,
  rawDirHandle: null,
  thumbDirHandle: null,      // 缩略图文件夹句柄
  canWrite: false,            // 是否有读写权限
  jpgFiles: [],
  currentIndex: -1,
  marks: {},
  groups: [],
  groupingEnabled: false,
  sortBy: 'name',
  filterBy: 'all',
  displayList: [],
  matchedData: null,
  zoomLevel: 1,
  urlCache: new Map(),
  thumbUrlCache: new Map(),   // 缩略图URL缓存
  thumbGenInProgress: new Map(), // 正在生成的缩略图
  thumbGenTotal: 0,
  thumbGenDone: 0,
  // 分页
  renderPlan: [],
  planCursor: 0,
  _currentGroupContent: null,
  _currentSubContent: null,
  // 预览压缩
  previewCompression: parseInt(localStorage.getItem('previewCompression') || '100'),
  currentCompressedUrl: null,
  // 缩略图尺寸设置
  thumbSize: parseInt(localStorage.getItem('thumbSize') || '800'),   // 长边像素值，0=不压缩
  thumbNoCompress: localStorage.getItem('thumbNoCompress') === 'true',
  existingThumbSize: null,     // 从已有缩略图检测到的尺寸
};

// DOM 引用
const $thumbList = document.getElementById('thumb-list');
const $emptyState = document.getElementById('empty-state');
const $previewImg = document.getElementById('preview-img');
const $previewPlaceholder = document.getElementById('preview-placeholder');
const $previewBadge = document.getElementById('preview-badge');
const $thumbCount = document.getElementById('thumb-count');
const $statusCurrent = document.getElementById('status-current');
const $statusSelected = document.getElementById('status-selected');
const $statusDeleted = document.getElementById('status-deleted');
const $statusGroup = document.getElementById('status-group');
const $infoDetail = document.getElementById('info-detail');
const $infoSection = document.getElementById('info-section');

// ===== 浏览器兼容性检查 =====
function checkBrowserSupport() {
  if (!('showDirectoryPicker' in window)) {
    document.getElementById('browser-warning').style.display = 'flex';
    document.getElementById('app').style.display = 'none';
    return false;
  }
  return true;
}

// ===== 初始化 =====
function init() {
  if (!checkBrowserSupport()) return;
  bindToolbar();
  bindKeyboard();
  bindActions();
  bindDialogs();
  bindDropdowns();
  bindScrollPagination();
  bindSettings();
  bindThumbSettings();
  updateStats();
}

// ===== 工具栏 =====
function bindToolbar() {
  document.getElementById('btn-open').addEventListener('click', openJpgFolder);

  document.getElementById('btn-group').addEventListener('click', () => {
    state.groupingEnabled = !state.groupingEnabled;
    document.getElementById('btn-group').classList.toggle('btn-primary', state.groupingEnabled);
    if (state.groupingEnabled && state.jpgFiles.length > 0) {
      autoGroup();
    }
    renderThumbnails();
  });

  document.getElementById('btn-match-raw').addEventListener('click', () => {
    if (state.jpgFiles.length === 0) {
      alert('请先打开JPG文件夹。');
      return;
    }
    const selectedJpgs = getSelectedJpgs();
    if (selectedJpgs.length === 0) {
      alert('还没有标记为"选中"的照片，请先标记（按 1 或 P 键）。');
      return;
    }
    openMatchDialog(selectedJpgs);
  });
}

// ===== 打开JPG文件夹 =====
async function openJpgFolder() {
  try {
    // 请求读写权限（用于创建缩略图文件夹）
    let dirHandle;
    try {
      dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
      state.canWrite = true;
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      // 读写权限被拒绝，尝试只读
      dirHandle = await window.showDirectoryPicker({ mode: 'read' });
      state.canWrite = false;
    }

    // 扫描JPG文件
    const jpgFiles = [];
    for await (const entry of dirHandle.values()) {
      if (entry.kind === 'file') {
        const ext = entry.name.toLowerCase().match(/\.[^.]+$/)?.[0] || '';
        if (JPG_EXTENSIONS.includes(ext)) {
          jpgFiles.push({
            name: entry.name,
            baseName: entry.name.replace(/\.[^.]+$/, ''),
            handle: entry,
            url: null,
            exifTime: null,
          });
        }
      }
    }

    if (jpgFiles.length === 0) {
      alert('所选文件夹中未找到JPG文件。');
      return;
    }

    jpgFiles.sort((a, b) => a.name.localeCompare(b.name));

    // 检查是否已有缩略图
    state.thumbDirHandle = null;
    let hasExistingThumbs = false;

    if (state.canWrite) {
      try {
        const thumbDir = await dirHandle.getDirectoryHandle('缩略图');
        state.thumbDirHandle = thumbDir;

        // 检测已有缩略图的尺寸
        const detectedSize = await detectExistingThumbSize(thumbDir, jpgFiles);
        if (detectedSize !== null) {
          state.existingThumbSize = detectedSize;
          state.thumbSize = detectedSize;
          state.thumbNoCompress = false;
          hasExistingThumbs = true;
        }
      } catch (e) {
        // 缩略图文件夹不存在
      }
    }

    // 如果没有已有缩略图，弹出缩略图设置对话框
    if (!hasExistingThumbs) {
      const settings = await openThumbSettingsDialog();
      if (settings === null) return; // 用户取消了

      state.thumbSize = settings.size;
      state.thumbNoCompress = settings.noCompress;
      localStorage.setItem('thumbSize', String(settings.size));
      localStorage.setItem('thumbNoCompress', String(settings.noCompress));

      // 创建缩略图文件夹（如果不压缩则不需要）
      if (!settings.noCompress && state.canWrite) {
        try {
          state.thumbDirHandle = await dirHandle.getDirectoryHandle('缩略图', { create: true });
        } catch (e) {
          console.warn('创建缩略图文件夹失败:', e);
        }
      }

      if (settings.noCompress) {
        state.thumbDirHandle = null;
      }
    } else {
      // 已有缩略图，确保文件夹句柄可用
      if (!state.thumbDirHandle && state.canWrite) {
        try {
          state.thumbDirHandle = await dirHandle.getDirectoryHandle('缩略图', { create: true });
        } catch (e) {}
      }
    }

    // 加载文件夹内容
    loadFolderContent(dirHandle, jpgFiles);

  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error('打开文件夹失败:', err);
      alert('打开文件夹失败: ' + err.message);
    }
  }
}

// ===== 检测已有缩略图尺寸 =====
async function detectExistingThumbSize(thumbDir, jpgFiles) {
  // 从缩略图文件夹中扫描文件名，检测尺寸后缀
  let detectedSize = null;
  let fileCount = 0;

  for await (const entry of thumbDir.values()) {
    if (entry.kind === 'file') {
      fileCount++;
      // 新格式：basename_Npx.ext → 提取 N
      const sizeMatch = entry.name.match(/_(\d+)\.[^.]+$/);
      if (sizeMatch) {
        const size = parseInt(sizeMatch[1]);
        if (detectedSize === null) detectedSize = size;
        else if (detectedSize !== size) {
          // 混合尺寸，取最常见的（简化：取第一个）
          break;
        }
      } else {
        // 旧格式：直接用原文件名，假定 800px
        const ext = entry.name.toLowerCase().match(/\.[^.]+$/)?.[0] || '';
        if (JPG_EXTENSIONS.includes(ext)) {
          if (detectedSize === null) detectedSize = 800;
        }
      }
      // 只检查前几个文件即可确定尺寸
      if (fileCount >= 5) break;
    }
  }

  return fileCount > 0 ? detectedSize : null;
}

// ===== 缩略图文件名格式 =====
function getThumbFileName(baseName, originalName, thumbSize) {
  if (thumbSize === 800) {
    // 800px 兼容旧格式（直接用原文件名），也支持新格式
    // 优先使用新格式，但查找时兼容旧格式
    return `${baseName}_${thumbSize}.jpg`;
  }
  return `${baseName}_${thumbSize}.jpg`;
}

// ===== 打开缩略图设置对话框 =====
function openThumbSettingsDialog() {
  return new Promise((resolve) => {
    const $dialog = document.getElementById('dialog-thumb-settings');
    $dialog.style.display = 'flex';

    // 设置当前选中状态
    const presets = $dialog.querySelectorAll('.thumb-preset');
    presets.forEach(p => p.classList.remove('active'));

    if (state.thumbNoCompress) {
      $dialog.querySelector('.thumb-preset-original').classList.add('active');
    } else {
      const matchingPreset = $dialog.querySelector(`.thumb-preset[data-size="${state.thumbSize}"]`);
      if (matchingPreset) {
        matchingPreset.classList.add('active');
      }
    }

    // 确认按钮
    const confirmBtn = document.getElementById('btn-thumb-confirm');
    const onConfirm = () => {
      const activePreset = $dialog.querySelector('.thumb-preset.active');
      let size, noCompress;

      if (activePreset) {
        size = parseInt(activePreset.dataset.size);
        noCompress = size === 0;
      } else {
        size = parseInt(document.getElementById('thumb-custom-size').value) || 800;
        noCompress = false;
      }

      if (!noCompress && (size < 200 || size > 4000)) {
        alert('自定义尺寸范围：200-4000px');
        return;
      }

      cleanup();
      resolve({ size, noCompress });
    };

    // ESC 取消处理 — 监听键盘事件
    const onKeydown = (e) => {
      if (e.key === 'Escape') {
        cleanup();
        resolve(null);
      }
    };

    // 清理函数
    const cleanup = () => {
      $dialog.style.display = 'none';
      confirmBtn.removeEventListener('click', onConfirm);
      document.removeEventListener('keydown', onKeydown);
    };

    confirmBtn.addEventListener('click', onConfirm);
    // 注意：只在对话框可见时监听ESC，避免和主键盘监听冲突
    // 主键盘监听器已有ESC处理，但Promise模式需要单独的resolve
    // 方案：给对话框添加一个隐藏的取消按钮
    // 实际上，closeAllDialogs()已经会关闭dialog-thumb-settings
    // 但Promise需要resolve(null)，所以在键盘监听里也要处理
    document.addEventListener('keydown', onKeydown);
  });
}

// ===== 缩略图设置对话框交互 =====
function bindThumbSettings() {
  const $dialog = document.getElementById('dialog-thumb-settings');
  const presets = $dialog.querySelectorAll('.thumb-preset');

  // 预设按钮点击
  presets.forEach(preset => {
    preset.addEventListener('click', () => {
      presets.forEach(p => p.classList.remove('active'));
      preset.classList.add('active');

      const size = parseInt(preset.dataset.size);
      if (size > 0) {
        document.getElementById('thumb-custom-size').value = size;
      }
    });
  });

  // 自定义尺寸输入 + 应用按钮
  document.getElementById('btn-thumb-apply-custom').addEventListener('click', () => {
    let val = parseInt(document.getElementById('thumb-custom-size').value);
    if (isNaN(val) || val < 200) val = 200;
    if (val > 4000) val = 4000;
    document.getElementById('thumb-custom-size').value = val;

    // 取消预设选中，标记为自定义
    presets.forEach(p => p.classList.remove('active'));

    // 如果自定义值等于某个预设值，自动选中那个预设
    const matchingPreset = $dialog.querySelector(`.thumb-preset[data-size="${val}"]`);
    if (matchingPreset) {
      matchingPreset.classList.add('active');
    }
  });
}

// ===== 加载文件夹内容（从openJpgFolder提取） =====
function loadFolderContent(dirHandle, jpgFiles) {
  state.jpgDirHandle = dirHandle;

  // 清理旧的缓存
  state.urlCache.forEach(url => URL.revokeObjectURL(url));
  state.urlCache.clear();
  state.thumbUrlCache.forEach(url => URL.revokeObjectURL(url));
  state.thumbUrlCache.clear();
  state.thumbGenInProgress.clear();

  state.jpgFiles = jpgFiles;
  state.marks = {};
  jpgFiles.forEach(f => { state.marks[f.baseName] = 'pending'; });

  // 更新标题
  document.getElementById('toolbar-title').textContent = dirHandle.name + ' - 选片助手';

  updateDisplayList();
  renderThumbnails();
  navigateTo(0);
  updateStats();

  // 后台异步加载所有EXIF
  loadAllExif();

  // 后台生成缩略图（不压缩模式不需要）
  if (!state.thumbNoCompress) {
    generateAllThumbnails();
  }
}

// ===== 异步加载所有EXIF数据 =====
async function loadAllExif() {
  const BATCH_SIZE = 20;
  for (let i = 0; i < state.jpgFiles.length; i += BATCH_SIZE) {
    const batch = state.jpgFiles.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(async (file) => {
      if (file.exifTime !== null) return;
      try {
        const f = await file.handle.getFile();
        const exif = await exifr.parse(f, { tiff: true, exif: true });
        if (exif && exif.DateTimeOriginal) {
          file.exifTime = new Date(exif.DateTimeOriginal).getTime();
        }
      } catch (e) {
        // 忽略EXIF读取错误
      }
    }));
    if (state.groupingEnabled && i + BATCH_SIZE >= state.jpgFiles.length) {
      autoGroup();
      updateDisplayList();
      renderThumbnails();
    }
  }
}

// ===== 图片加载工具 =====
function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = (e) => {
      URL.revokeObjectURL(url);
      reject(e);
    };
    img.src = url;
  });
}

// ===== 获取原图URL（带缓存） =====
async function getImageUrl(file) {
  if (state.urlCache.has(file.baseName)) {
    return state.urlCache.get(file.baseName);
  }
  const f = await file.handle.getFile();
  const url = URL.createObjectURL(f);
  state.urlCache.set(file.baseName, url);
  return url;
}

// ===== 获取缩略图URL（带缓存+自动生成） =====
async function getThumbnailUrl(file) {
  // 不压缩模式：直接使用原图
  if (state.thumbNoCompress) {
    return await getImageUrl(file);
  }

  // 1. 检查URL缓存
  const cacheKey = `${file.baseName}_${state.thumbSize}`;
  if (state.thumbUrlCache.has(cacheKey)) {
    return state.thumbUrlCache.get(cacheKey);
  }

  // 2. 检查是否正在生成
  if (state.thumbGenInProgress.has(cacheKey)) {
    return state.thumbGenInProgress.get(cacheKey);
  }

  // 3. 开始生成
  const promise = generateThumbnailInternal(file);
  state.thumbGenInProgress.set(cacheKey, promise);

  try {
    return await promise;
  } finally {
    state.thumbGenInProgress.delete(cacheKey);
  }
}

async function generateThumbnailInternal(file) {
  const thumbSize = state.thumbSize;
  const thumbFileName = getThumbFileName(file.baseName, file.name, thumbSize);
  const cacheKey = `${file.baseName}_${thumbSize}`;

  // 检查磁盘上是否已有缩略图（新格式）
  if (state.thumbDirHandle) {
    try {
      const thumbHandle = await state.thumbDirHandle.getFileHandle(thumbFileName);
      const thumbFile = await thumbHandle.getFile();
      const url = URL.createObjectURL(thumbFile);
      state.thumbUrlCache.set(cacheKey, url);
      return url;
    } catch (e) {
      // 新格式不存在，继续检查旧格式
    }

    // 旧格式兼容：800px缩略图可能用原文件名存储
    if (thumbSize === 800) {
      try {
        const thumbHandle = await state.thumbDirHandle.getFileHandle(file.name);
        const thumbFile = await thumbHandle.getFile();
        const url = URL.createObjectURL(thumbFile);
        state.thumbUrlCache.set(cacheKey, url);
        return url;
      } catch (e) {
        // 旧格式也不存在，继续生成
      }
    }
  }

  // 生成缩略图
  try {
    const origFile = await file.handle.getFile();
    const img = await loadImageFromFile(origFile);

    let w = img.naturalWidth;
    let h = img.naturalHeight;
    if (w > h) {
      if (w > thumbSize) {
        h = Math.round(h * thumbSize / w);
        w = thumbSize;
      }
    } else {
      if (h > thumbSize) {
        w = Math.round(w * thumbSize / h);
        h = thumbSize;
      }
    }

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(img, 0, 0, w, h);

    const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', THUMB_QUALITY));

    // 尝试写入磁盘（新格式文件名）
    if (state.thumbDirHandle) {
      try {
        const thumbHandle = await state.thumbDirHandle.getFileHandle(thumbFileName, { create: true });
        const writable = await thumbHandle.createWritable();
        await writable.write(blob);
        await writable.close();
      } catch (e) {
        // 写入失败，仅使用内存中的缩略图
      }
    }

    const url = URL.createObjectURL(blob);
    state.thumbUrlCache.set(cacheKey, url);
    return url;
  } catch (e) {
    // 生成失败，回退到原图
    return await getImageUrl(file);
  }
}

// ===== 后台批量生成所有缩略图 =====
async function generateAllThumbnails() {
  state.thumbGenTotal = state.jpgFiles.length;
  state.thumbGenDone = 0;

  const $progress = document.getElementById('thumb-gen-progress');
  if ($progress) $progress.style.display = 'flex';
  updateThumbGenProgress();

  const BATCH = 5;
  for (let i = 0; i < state.jpgFiles.length; i += BATCH) {
    const batch = state.jpgFiles.slice(i, i + BATCH);
    await Promise.all(batch.map(async (file) => {
      try {
        await getThumbnailUrl(file);
      } catch (e) {
        // 忽略
      }
      state.thumbGenDone++;
    }));
    updateThumbGenProgress();
    // 让出UI线程
    await new Promise(r => setTimeout(r, 0));
  }

  // 延迟隐藏进度条
  setTimeout(() => {
    const $p = document.getElementById('thumb-gen-progress');
    if ($p) $p.style.display = 'none';
  }, 1000);
}

function updateThumbGenProgress() {
  const $bar = document.getElementById('thumb-gen-bar');
  const $text = document.getElementById('thumb-gen-text');
  if (!$bar || !$text) return;
  const pct = state.thumbGenTotal > 0 ? Math.round(state.thumbGenDone / state.thumbGenTotal * 100) : 0;
  $bar.style.width = pct + '%';
  $text.textContent = `生成缩略图 ${state.thumbGenDone}/${state.thumbGenTotal}`;
}

// ===== 键盘快捷键 =====
function bindKeyboard() {
  document.addEventListener('keydown', (e) => {
    // 检查对话框/浮层是否打开
    const hasOpenDialog = document.querySelector('.dialog-overlay[style*="display: flex"]') ||
                          document.querySelector('.dialog-overlay[style*="display:block"]');
    const hasOpenOverlay = document.getElementById('original-overlay') &&
                           document.getElementById('original-overlay').style.display === 'flex';

    if (hasOpenDialog || hasOpenOverlay) {
      if (e.key === 'Escape') {
        closeAllDialogs();
        const $overlay = document.getElementById('original-overlay');
        if ($overlay) $overlay.style.display = 'none';
      }
      return;
    }
    if (state.displayList.length === 0) return;

    switch (e.key) {
      case 'ArrowRight':
      case ' ':
        e.preventDefault();
        navigateNext();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        navigatePrev();
        break;
      case '1': case 'p': case 'P':
        markCurrent('selected');
        break;
      case '2': case 'x': case 'X':
        markCurrent('deleted');
        break;
      case '3': case 'u': case 'U':
        markCurrent('pending');
        break;
      case 'Home':
        navigateTo(0);
        break;
      case 'End':
        navigateTo(state.displayList.length - 1);
        break;
      case '+': zoomIn(); break;
      case '-': zoomOut(); break;
      case '0': zoomFit(); break;
      case 'f': case 'F': toggleFullscreen(); break;
      case 'Escape': closeAllDialogs(); break;
    }
  });
}

// ===== 操作按钮 =====
function bindActions() {
  document.getElementById('btn-select').addEventListener('click', () => markCurrent('selected'));
  document.getElementById('btn-delete').addEventListener('click', () => markCurrent('deleted'));
  document.getElementById('btn-clear').addEventListener('click', () => markCurrent('pending'));
  document.getElementById('btn-prev').addEventListener('click', navigatePrev);
  document.getElementById('btn-next').addEventListener('click', navigateNext);
  document.getElementById('btn-zoom-in').addEventListener('click', zoomIn);
  document.getElementById('btn-zoom-out').addEventListener('click', zoomOut);
  document.getElementById('btn-zoom-fit').addEventListener('click', zoomFit);
}

// ===== 下拉菜单 =====
function bindDropdowns() {
  const $sortBtn = document.getElementById('btn-sort');
  const $filterBtn = document.getElementById('btn-filter');
  const $sortDrop = document.getElementById('dropdown-sort');
  const $filterDrop = document.getElementById('dropdown-filter');

  $sortBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const rect = $sortBtn.getBoundingClientRect();
    $sortDrop.style.display = 'block';
    $sortDrop.style.top = rect.bottom + 'px';
    $sortDrop.style.left = rect.left + 'px';
    $filterDrop.style.display = 'none';
  });

  $filterBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const rect = $filterBtn.getBoundingClientRect();
    $filterDrop.style.display = 'block';
    $filterDrop.style.top = rect.bottom + 'px';
    $filterDrop.style.left = rect.left + 'px';
    $sortDrop.style.display = 'none';
  });

  document.addEventListener('click', () => {
    $sortDrop.style.display = 'none';
    $filterDrop.style.display = 'none';
  });

  $sortDrop.querySelectorAll('.dropdown-item').forEach(btn => {
    btn.addEventListener('click', () => {
      state.sortBy = btn.dataset.sort;
      $sortDrop.querySelectorAll('.dropdown-item').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      updateDisplayList();
      renderThumbnails();
      $sortDrop.style.display = 'none';
    });
  });

  $filterDrop.querySelectorAll('.dropdown-item').forEach(btn => {
    btn.addEventListener('click', () => {
      state.filterBy = btn.dataset.filter;
      $filterDrop.querySelectorAll('.dropdown-item').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      updateDisplayList();
      renderThumbnails();
      $filterDrop.style.display = 'none';
    });
  });
}

// ===== 设置 =====
function bindSettings() {
  document.getElementById('btn-settings').addEventListener('click', () => {
    document.getElementById('dialog-settings').style.display = 'flex';
    document.getElementById('settings-compression').value = state.previewCompression;
  });

  document.getElementById('dialog-settings-close').addEventListener('click', () => {
    document.getElementById('dialog-settings').style.display = 'none';
  });

  document.getElementById('btn-settings-save').addEventListener('click', () => {
    let val = parseInt(document.getElementById('settings-compression').value);
    if (isNaN(val) || val < 1) val = 1;
    if (val > 100) val = 100;
    state.previewCompression = val;
    localStorage.setItem('previewCompression', String(val));
    document.getElementById('dialog-settings').style.display = 'none';

    // 用新压缩比重新加载当前预览
    if (state.currentIndex >= 0) {
      navigateTo(state.currentIndex);
    }
  });

  // 查看原图按钮
  document.getElementById('btn-view-original').addEventListener('click', async () => {
    if (state.currentIndex < 0) return;
    const file = state.displayList[state.currentIndex];
    const overlay = document.getElementById('original-overlay');
    const overlayImg = document.getElementById('original-overlay-img');

    overlay.style.display = 'flex';
    overlayImg.src = '';

    try {
      const url = await getImageUrl(file);
      overlayImg.src = url;
    } catch (e) {
      console.error('加载原图失败:', e);
    }
  });

  // 关闭原图浮层
  document.getElementById('original-overlay-close').addEventListener('click', () => {
    document.getElementById('original-overlay').style.display = 'none';
  });

  document.getElementById('original-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'original-overlay') {
      document.getElementById('original-overlay').style.display = 'none';
    }
  });
}

// ===== 对话框 =====
function bindDialogs() {
  document.getElementById('dialog-match-close').addEventListener('click', () => {
    document.getElementById('dialog-match').style.display = 'none';
  });
}

function closeAllDialogs() {
  document.getElementById('dialog-match').style.display = 'none';
  document.getElementById('dialog-export').style.display = 'none';
  document.getElementById('dialog-settings').style.display = 'none';
  document.getElementById('dialog-thumb-settings').style.display = 'none';
  document.querySelectorAll('.dropdown').forEach(d => d.style.display = 'none');
}

// ===== 显示列表 =====
function updateDisplayList() {
  let list = [...state.jpgFiles];

  switch (state.sortBy) {
    case 'name':
      list.sort((a, b) => a.name.localeCompare(b.name));
      break;
    case 'time':
      list.sort((a, b) => {
        if (a.exifTime && b.exifTime) return a.exifTime - b.exifTime;
        if (a.exifTime) return -1;
        if (b.exifTime) return 1;
        return a.name.localeCompare(b.name);
      });
      break;
    case 'group':
      break;
  }

  if (state.filterBy !== 'all') {
    list = list.filter(f => state.marks[f.baseName] === state.filterBy);
  }

  if (state.groupingEnabled && state.groups.length > 0) {
    const grouped = [];
    state.groups.forEach(group => {
      group.subgroups.forEach(sub => {
        sub.files.forEach(f => {
          if (list.includes(f)) grouped.push(f);
        });
      });
      group.files.forEach(f => {
        if (list.includes(f) && !grouped.includes(f)) grouped.push(f);
      });
    });
    list.forEach(f => { if (!grouped.includes(f)) grouped.push(f); });
    list = grouped;
  }

  state.displayList = list;
}

// ===== 渲染缩略图（分页加载） =====

function buildRenderPlan() {
  const plan = [];

  if (state.groupingEnabled && state.groups.length > 0) {
    state.groups.forEach(group => {
      plan.push({ type: 'group-header', group });

      if (group.subgroups.length > 0) {
        group.subgroups.forEach(sub => {
          plan.push({ type: 'subgroup-header', subgroup: sub });
          sub.files.forEach(file => {
            const idx = state.displayList.indexOf(file);
            if (idx >= 0) {
              plan.push({ type: 'thumb', file, index: idx });
            }
          });
        });
      } else {
        group.files.forEach(file => {
          const idx = state.displayList.indexOf(file);
          if (idx >= 0) {
            plan.push({ type: 'thumb', file, index: idx });
          }
        });
      }
    });

    // 未分组
    const ungrouped = state.displayList.filter(f =>
      !state.groups.some(g => g.files.includes(f))
    );
    if (ungrouped.length > 0) {
      plan.push({ type: 'group-header', group: { name: '未分组', files: ungrouped, _ungrouped: true } });
      ungrouped.forEach(file => {
        const idx = state.displayList.indexOf(file);
        plan.push({ type: 'thumb', file, index: idx });
      });
    }
  } else {
    state.displayList.forEach((file, idx) => {
      plan.push({ type: 'thumb', file, index: idx });
    });
  }

  return plan;
}

function renderThumbnails() {
  $thumbList.innerHTML = '';
  state.renderPlan = buildRenderPlan();
  state.planCursor = 0;
  state._currentGroupContent = null;
  state._currentSubContent = null;

  $thumbCount.textContent = state.displayList.length;

  if (state.displayList.length === 0) {
    $thumbList.appendChild($emptyState);
    $emptyState.style.display = 'flex';
    return;
  }

  $emptyState.style.display = 'none';
  loadMoreThumbs();
}

function loadMoreThumbs() {
  let thumbsAdded = 0;

  while (state.planCursor < state.renderPlan.length && thumbsAdded < PAGE_SIZE) {
    const item = state.renderPlan[state.planCursor];

    if (item.type === 'group-header') {
      const header = document.createElement('div');
      header.className = 'group-header';
      const isUngrouped = item.group._ungrouped;
      header.innerHTML = `<span class="group-dot" ${isUngrouped ? 'style="background:var(--color-pending);"' : ''}></span>
        <span>${item.group.name}</span>
        <span class="group-count">${item.group.files.length}</span>
        ${!isUngrouped ? '<span class="group-expand">▼</span>' : ''}`;

      if (!isUngrouped) {
        header.addEventListener('click', () => {
          const content = header.nextElementSibling;
          if (content) {
            const isHidden = content.style.display === 'none';
            content.style.display = isHidden ? 'block' : 'none';
            header.querySelector('.group-expand').textContent = isHidden ? '▼' : '▶';
          }
        });
      }
      $thumbList.appendChild(header);

      const content = document.createElement('div');
      $thumbList.appendChild(content);
      state._currentGroupContent = content;
      state._currentSubContent = null;

    } else if (item.type === 'subgroup-header') {
      const subHeader = document.createElement('div');
      subHeader.className = 'subgroup-header';
      subHeader.innerHTML = `<span>▼</span> ${item.subgroup.name} (${item.subgroup.files.length})`;
      subHeader.addEventListener('click', () => {
        const subContent = subHeader.nextElementSibling;
        if (subContent) {
          const isHidden = subContent.style.display === 'none';
          subContent.style.display = isHidden ? 'block' : 'none';
        }
      });
      state._currentGroupContent.appendChild(subHeader);

      const subContent = document.createElement('div');
      state._currentGroupContent.appendChild(subContent);
      state._currentSubContent = subContent;

    } else if (item.type === 'thumb') {
      const el = createThumbItem(item.file, item.index);
      if (state._currentSubContent) {
        state._currentSubContent.appendChild(el);
      } else if (state._currentGroupContent) {
        state._currentGroupContent.appendChild(el);
      } else {
        $thumbList.appendChild(el);
      }
      thumbsAdded++;
    }

    state.planCursor++;
  }
}

// ===== 滚动分页监听 =====
function bindScrollPagination() {
  $thumbList.addEventListener('scroll', () => {
    if (state.planCursor >= state.renderPlan.length) return;

    const { scrollTop, scrollHeight, clientHeight } = $thumbList;
    const remaining = scrollHeight - scrollTop - clientHeight;

    // 剩余约15个缩略图项高度时加载下一批
    if (remaining < LOAD_THRESHOLD_PX) {
      loadMoreThumbs();
    }
  });
}

// ===== 确保目标缩略图已加载 =====
function ensureThumbLoaded(targetIndex) {
  const existing = document.querySelector(`.thumb-item[data-index="${targetIndex}"]`);
  if (existing) return;

  while (state.planCursor < state.renderPlan.length) {
    loadMoreThumbs();
    if (document.querySelector(`.thumb-item[data-index="${targetIndex}"]`)) break;
  }
}

function createThumbItem(file, index) {
  const el = document.createElement('div');
  const mark = state.marks[file.baseName] || 'pending';
  el.className = `thumb-item ${mark} ${index === state.currentIndex ? 'active' : ''}`;
  el.dataset.index = index;
  el.dataset.basename = file.baseName;

  el.innerHTML = `<img class="thumb-img" src="" loading="lazy" />
    <span class="thumb-name">${file.name}</span>
    <span class="thumb-dot ${mark === 'selected' ? 'green' : mark === 'deleted' ? 'red' : 'yellow'}"></span>`;

  // 异步加载缩略图（非原图）
  const imgEl = el.querySelector('.thumb-img');
  getThumbnailUrl(file).then(url => {
    if (imgEl) imgEl.src = url;
  });

  el.addEventListener('click', () => navigateTo(index));
  return el;
}

// ===== 导航 =====
async function navigateTo(index) {
  if (index < 0 || index >= state.displayList.length) return;

  state.currentIndex = index;
  const file = state.displayList[index];

  // 确保目标缩略图已渲染
  ensureThumbLoaded(index);

  // 回收上一个压缩预览URL
  if (state.currentCompressedUrl) {
    URL.revokeObjectURL(state.currentCompressedUrl);
    state.currentCompressedUrl = null;
  }

  // 更新预览图
  $previewImg.style.display = 'none';
  $previewPlaceholder.style.display = 'flex';
  try {
    const url = await getPreviewUrl(file);
    $previewImg.src = url;
    $previewImg.style.display = 'block';
    $previewPlaceholder.style.display = 'none';
    zoomFit();
  } catch (err) {
    console.error('加载预览失败:', err);
  }

  // 显示/隐藏「查看原图」按钮
  const $btnViewOriginal = document.getElementById('btn-view-original');
  if ($btnViewOriginal) {
    $btnViewOriginal.style.display = state.previewCompression < 100 ? 'flex' : 'none';
  }

  // 更新状态标签
  const mark = state.marks[file.baseName];
  updatePreviewBadge(mark);

  // 更新缩略图选中状态
  document.querySelectorAll('.thumb-item').forEach(el => {
    el.classList.toggle('active', parseInt(el.dataset.index) === index);
  });

  // 滚动到可见区域
  const activeThumb = document.querySelector('.thumb-item.active');
  if (activeThumb) {
    activeThumb.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // 更新信息面板
  updateInfoPanel(file);
  loadFileInfo(file);
  updateStatusBar(file);
}

// ===== 获取预览图URL（按压缩设置） =====
async function getPreviewUrl(file) {
  if (state.previewCompression >= 100) {
    return await getImageUrl(file);
  }

  // 压缩预览
  try {
    const origFile = await file.handle.getFile();
    const img = await loadImageFromFile(origFile);

    const scale = state.previewCompression / 100;
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(img, 0, 0, w, h);

    const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.85));
    const url = URL.createObjectURL(blob);
    state.currentCompressedUrl = url;
    return url;
  } catch (e) {
    // 压缩失败，回退到原图
    return await getImageUrl(file);
  }
}

function navigateNext() {
  if (state.currentIndex < state.displayList.length - 1) {
    navigateTo(state.currentIndex + 1);
  }
}

function navigatePrev() {
  if (state.currentIndex > 0) {
    navigateTo(state.currentIndex - 1);
  }
}

// ===== 标记 =====
function markCurrent(markType) {
  if (state.currentIndex < 0) return;
  const file = state.displayList[state.currentIndex];
  state.marks[file.baseName] = markType;

  const thumbEl = document.querySelector(`.thumb-item[data-basename="${file.baseName}"]`);
  if (thumbEl) {
    thumbEl.className = `thumb-item ${markType} ${state.currentIndex === parseInt(thumbEl.dataset.index) ? 'active' : ''}`;
    const dot = thumbEl.querySelector('.thumb-dot');
    dot.className = `thumb-dot ${markType === 'selected' ? 'green' : markType === 'deleted' ? 'red' : 'yellow'}`;
  }

  updatePreviewBadge(markType);
  updateStats();
  updateInfoStatus(file);
}

function getSelectedJpgs() {
  return state.jpgFiles.filter(f => state.marks[f.baseName] === 'selected');
}

// ===== 预览状态标签 =====
function updatePreviewBadge(mark) {
  $previewBadge.style.display = 'block';
  const colors = {
    selected: { bg: '#639922', text: '已选' },
    pending: { bg: '#EF9F27', text: '待定' },
    deleted: { bg: '#E24B4A', text: '删除' },
  };
  const c = colors[mark] || colors.pending;
  $previewBadge.style.background = c.bg;
  $previewBadge.textContent = c.text;
}

// ===== 文件大小格式化 =====
function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

// ===== 信息面板 =====
function updateInfoPanel(file) {
  $infoDetail.style.display = 'block';
  document.getElementById('info-filename').textContent = file.name;
  document.getElementById('info-camera').textContent = '-';
  document.getElementById('info-lens').textContent = '-';
  document.getElementById('info-focal').textContent = '-';
  document.getElementById('info-aperture').textContent = '-';
  document.getElementById('info-shutter').textContent = '-';
  document.getElementById('info-iso').textContent = '-';
  document.getElementById('info-date').textContent = '-';
  document.getElementById('info-filesize').textContent = '-';
  document.getElementById('info-thumbsize').textContent = '-';
  document.getElementById('info-group').textContent = findGroupForFile(file) || '无';
  updateInfoStatus(file);
}

function updateInfoStatus(file) {
  const mark = state.marks[file.baseName];
  const labels = { selected: '选中（保留）', pending: '待定（未决定）', deleted: '删除（移除）' };
  document.getElementById('info-status').textContent = labels[mark] || '待定';
}

async function loadFileInfo(file) {
  // 加载原图文件大小
  try {
    const f = await file.handle.getFile();
    document.getElementById('info-filesize').textContent = formatFileSize(f.size);
  } catch (e) {}

  // 加载缩略图文件大小
  try {
    if (state.thumbNoCompress) {
      document.getElementById('info-thumbsize').textContent = '不压缩（原图）';
    } else if (state.thumbDirHandle) {
      const thumbFileName = getThumbFileName(file.baseName, file.name, state.thumbSize);
      let thumbFound = false;

      // 先找新格式
      try {
        const thumbHandle = await state.thumbDirHandle.getFileHandle(thumbFileName);
        const thumbFile = await thumbHandle.getFile();
        document.getElementById('info-thumbsize').textContent = formatFileSize(thumbFile.size);
        thumbFound = true;
      } catch (e) {}

      // 800px时兼容旧格式
      if (!thumbFound && state.thumbSize === 800) {
        try {
          const thumbHandle = await state.thumbDirHandle.getFileHandle(file.name);
          const thumbFile = await thumbHandle.getFile();
          document.getElementById('info-thumbsize').textContent = formatFileSize(thumbFile.size);
          thumbFound = true;
        } catch (e) {}
      }

      if (!thumbFound) {
        document.getElementById('info-thumbsize').textContent = '生成中...';
      }
    } else {
      document.getElementById('info-thumbsize').textContent = '未生成';
    }
  } catch (e) {
    document.getElementById('info-thumbsize').textContent = '未生成';
  }

  // 加载EXIF
  await loadExif(file);
}

async function loadExif(file) {
  try {
    const f = await file.handle.getFile();
    const exif = await exifr.parse(f, { tiff: true, exif: true });
    if (exif) {
      document.getElementById('info-camera').textContent = `${exif.Make || ''} ${exif.Model || '-'}`.trim();
      document.getElementById('info-lens').textContent = exif.LensModel || '-';
      document.getElementById('info-focal').textContent = exif.FocalLength ? `${exif.FocalLength}mm` : '-';
      document.getElementById('info-aperture').textContent = exif.FNumber ? `f/${exif.FNumber}` : '-';
      document.getElementById('info-shutter').textContent = exif.ExposureTime ? `1/${Math.round(1/exif.ExposureTime)}s` : '-';
      document.getElementById('info-iso').textContent = exif.ISO ? `ISO ${exif.ISO}` : '-';

      if (exif.DateTimeOriginal) {
        const d = new Date(exif.DateTimeOriginal);
        document.getElementById('info-date').textContent = d.toLocaleString('zh-CN');
        file.exifTime = new Date(exif.DateTimeOriginal).getTime();
      }
    }
  } catch (err) {
    console.error('EXIF读取失败:', err);
  }
}

// ===== 统计 =====
function updateStats() {
  const selCount = Object.values(state.marks).filter(m => m === 'selected').length;
  const delCount = Object.values(state.marks).filter(m => m === 'deleted').length;
  $statusSelected.textContent = `已选：${selCount}`;
  $statusDeleted.textContent = `已删：${delCount}`;
  $thumbCount.textContent = state.displayList.length;
}

function updateStatusBar(file) {
  const idx = state.currentIndex + 1;
  $statusCurrent.textContent = `${idx} / ${state.displayList.length}`;
  const group = findGroupForFile(file);
  $statusGroup.textContent = group ? `分组：${group}` : '-';
}

// ===== 缩放 =====
function zoomIn() {
  state.zoomLevel = Math.min(state.zoomLevel + 0.2, 5);
  applyZoom();
}

function zoomOut() {
  state.zoomLevel = Math.max(state.zoomLevel - 0.2, 0.2);
  applyZoom();
}

function zoomFit() {
  state.zoomLevel = 1;
  $previewImg.style.maxWidth = '95%';
  $previewImg.style.maxHeight = '95%';
  $previewImg.style.width = '';
  $previewImg.style.height = '';
}

function applyZoom() {
  $previewImg.style.maxWidth = 'none';
  $previewImg.style.maxHeight = 'none';
  $previewImg.style.width = `${state.zoomLevel * 100}%`;
}

function toggleFullscreen() {
  const el = document.getElementById('panel-center');
  if (el.requestFullscreen) {
    el.requestFullscreen();
  }
}

// ===== 自动分组 =====
function autoGroup() {
  if (state.jpgFiles.length === 0) return;

  const sorted = [...state.jpgFiles].sort((a, b) => {
    if (a.exifTime && b.exifTime) return a.exifTime - b.exifTime;
    return a.name.localeCompare(b.name);
  });

  const POSITION_GAP = 60000;
  const ACTION_GAP = 10000;

  state.groups = [];
  let currentGroup = null;
  let currentSub = null;

  sorted.forEach((file, i) => {
    const time = file.exifTime || (i * 3000);
    const prevTime = i > 0 ? (sorted[i-1].exifTime || ((i-1) * 3000)) : null;

    if (!currentGroup || (prevTime && (time - prevTime) > POSITION_GAP)) {
      currentGroup = {
        name: `机位 ${state.groups.length + 1}`,
        files: [],
        subgroups: [],
      };
      state.groups.push(currentGroup);
      currentSub = null;
    }

    if (!currentSub || (prevTime && (time - prevTime) > ACTION_GAP)) {
      currentSub = {
        name: `动作 ${currentGroup.subgroups.length + 1}`,
        files: [],
      };
      currentGroup.subgroups.push(currentSub);
    }

    currentSub.files.push(file);
    currentGroup.files.push(file);
  });

  updateDisplayList();
}

function findGroupForFile(file) {
  for (const group of state.groups) {
    for (const sub of group.subgroups) {
      if (sub.files.includes(file)) {
        return `${group.name} - ${sub.name}`;
      }
    }
  }
  return null;
}

// ===== 匹配RAW对话框 =====
function openMatchDialog(selectedJpgs) {
  const $dialog = document.getElementById('dialog-match');
  $dialog.style.display = 'flex';

  document.getElementById('match-jpg-info').textContent = `已选中 ${selectedJpgs.length} 个JPG文件`;

  state.rawDirHandle = null;
  state.matchedData = null;
  document.getElementById('match-raw-folder-info').textContent = '未选择';
  document.getElementById('match-stats').style.display = 'none';
  document.getElementById('match-list').innerHTML = '';

  document.getElementById('btn-pick-raw-folder').onclick = async () => {
    try {
      const dirHandle = await window.showDirectoryPicker({ mode: 'read' });
      state.rawDirHandle = dirHandle;
      document.getElementById('match-raw-folder-info').textContent = dirHandle.name;

      const rawMap = new Map();
      for await (const entry of dirHandle.values()) {
        if (entry.kind === 'file') {
          const ext = entry.name.toLowerCase().match(/\.[^.]+$/)?.[0] || '';
          if (RAW_EXTENSIONS.includes(ext)) {
            const baseName = entry.name.replace(/\.[^.]+$/, '');
            rawMap.set(baseName, { name: entry.name, handle: entry });
          }
        }
      }

      const matched = [];
      const unmatched = [];
      selectedJpgs.forEach(jpg => {
        const raw = rawMap.get(jpg.baseName);
        if (raw) {
          matched.push({ jpg: { name: jpg.name, baseName: jpg.baseName, handle: jpg.handle }, raw });
        } else {
          unmatched.push({ name: jpg.name, baseName: jpg.baseName });
        }
      });

      state.matchedData = { matched, unmatched };

      document.getElementById('match-stats').style.display = 'flex';
      document.getElementById('match-count-matched').textContent = matched.length;
      document.getElementById('match-count-unmatched').textContent = unmatched.length;

      const $list = document.getElementById('match-list');
      $list.innerHTML = '';

      matched.forEach(item => {
        const el = document.createElement('div');
        el.className = 'match-item';
        el.innerHTML = `<span class="match-icon-ok">✓</span>
          <span>${item.jpg.name}</span>
          <span style="color:var(--text-muted);">→</span>
          <span>${item.raw.name}</span>`;
        $list.appendChild(el);
      });

      unmatched.forEach(item => {
        const el = document.createElement('div');
        el.className = 'match-item';
        el.innerHTML = `<span class="match-icon-fail">✗</span>
          <span>${item.name}</span>
          <span style="color:var(--color-deleted);">未找到匹配的RAW文件</span>`;
        $list.appendChild(el);
      });
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error('选择RAW文件夹失败:', err);
        alert('操作失败: ' + err.message);
      }
    }
  };

  document.getElementById('btn-export-copy').onclick = async () => {
    if (!state.matchedData || state.matchedData.matched.length === 0) {
      alert('没有匹配的RAW文件可导出。');
      return;
    }
    await copyRawFiles(state.matchedData.matched);
  };

  document.getElementById('btn-export-copy-both').onclick = async () => {
    if (!state.matchedData || state.matchedData.matched.length === 0) {
      alert('没有匹配的文件可导出。');
      return;
    }
    await copyJpgAndRawFiles(state.matchedData.matched);
  };

  document.getElementById('btn-export-list').onclick = () => {
    if (!state.matchedData) {
      alert('请先选择RAW文件夹。');
      return;
    }
    exportList(state.matchedData);
  };
}

// ===== 复制RAW文件到输出文件夹 =====
async function copyRawFiles(matchedList) {
  const $dialog = document.getElementById('dialog-export');
  $dialog.style.display = 'flex';

  const $progressBar = document.getElementById('export-progress-bar');
  const $progressText = document.getElementById('export-progress-text');
  const $result = document.getElementById('export-result');
  const $btnDone = document.getElementById('btn-export-done');

  $result.style.display = 'none';
  $btnDone.style.display = 'none';

  const total = matchedList.length;

  try {
    const outDirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });

    const success = [];
    const failed = [];

    for (let i = 0; i < matchedList.length; i++) {
      const item = matchedList[i];
      $progressText.textContent = `${i} / ${total}`;

      try {
        const file = await item.raw.handle.getFile();
        const newHandle = await outDirHandle.getFileHandle(item.raw.name, { create: true });
        const writable = await newHandle.createWritable();
        await writable.write(file);
        await writable.close();
        success.push(item.raw.name);
      } catch (err) {
        console.error('复制失败:', item.raw.name, err);
        failed.push({ name: item.raw.name, error: err.message });
      }

      const pct = Math.round(((i + 1) / total) * 100);
      $progressBar.style.width = pct + '%';
      $progressText.textContent = `${i + 1} / ${total}`;
    }

    $progressBar.style.width = '100%';
    $progressText.textContent = `${success.length} / ${total}`;

    $result.style.display = 'block';
    $result.innerHTML = `
      <div style="color:var(--color-selected);">✓ 成功：${success.length}</div>
      ${failed.length > 0 ? `<div style="color:var(--color-deleted);">✗ 失败：${failed.length}</div>` : ''}
      <div style="margin-top:8px; color:var(--text-muted);">输出目录：${outDirHandle.name}</div>
    `;

    $btnDone.style.display = 'inline-block';
    $btnDone.onclick = () => closeAllDialogs();

  } catch (err) {
    if (err.name !== 'AbortError') {
      $result.style.display = 'block';
      $result.innerHTML = `<div style="color:var(--color-deleted);">导出失败：${err.message}</div>`;
      $btnDone.style.display = 'inline-block';
      $btnDone.onclick = () => closeAllDialogs();
    } else {
      closeAllDialogs();
    }
  }
}

// ===== 复制JPG+RAW文件到输出文件夹 =====
async function copyJpgAndRawFiles(matchedList) {
  const $dialog = document.getElementById('dialog-export');
  $dialog.style.display = 'flex';

  const $progressBar = document.getElementById('export-progress-bar');
  const $progressText = document.getElementById('export-progress-text');
  const $result = document.getElementById('export-result');
  const $btnDone = document.getElementById('btn-export-done');

  $result.style.display = 'none';
  $btnDone.style.display = 'none';

  const total = matchedList.length * 2; // JPG + RAW 各一份

  try {
    const outDirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });

    // 创建JPG和RAW子文件夹
    const jpgOutDir = await outDirHandle.getDirectoryHandle('JPG', { create: true });
    const rawOutDir = await outDirHandle.getDirectoryHandle('RAW', { create: true });

    const success = [];
    const failed = [];
    let done = 0;

    for (let i = 0; i < matchedList.length; i++) {
      const item = matchedList[i];

      // 复制JPG
      try {
        const jpgFile = await item.jpg.handle.getFile();
        const jpgHandle = await jpgOutDir.getFileHandle(item.jpg.name, { create: true });
        const jpgWritable = await jpgHandle.createWritable();
        await jpgWritable.write(jpgFile);
        await jpgWritable.close();
        success.push(item.jpg.name);
      } catch (err) {
        console.error('复制JPG失败:', item.jpg.name, err);
        failed.push({ name: item.jpg.name, error: err.message });
      }

      done++;
      $progressBar.style.width = Math.round((done / total) * 100) + '%';
      $progressText.textContent = `${done} / ${total}`;

      // 复制RAW
      try {
        const rawFile = await item.raw.handle.getFile();
        const rawHandle = await rawOutDir.getFileHandle(item.raw.name, { create: true });
        const rawWritable = await rawHandle.createWritable();
        await rawWritable.write(rawFile);
        await rawWritable.close();
        success.push(item.raw.name);
      } catch (err) {
        console.error('复制RAW失败:', item.raw.name, err);
        failed.push({ name: item.raw.name, error: err.message });
      }

      done++;
      $progressBar.style.width = Math.round((done / total) * 100) + '%';
      $progressText.textContent = `${done} / ${total}`;
    }

    $progressBar.style.width = '100%';
    $progressText.textContent = `${success.length} / ${total}`;

    $result.style.display = 'block';
    $result.innerHTML = `
      <div style="color:var(--color-selected);">✓ 成功：${success.length}</div>
      ${failed.length > 0 ? `<div style="color:var(--color-deleted);">✗ 失败：${failed.length}</div>` : ''}
      <div style="margin-top:8px; color:var(--text-muted);">输出目录：${outDirHandle.name}/JPG 和 ${outDirHandle.name}/RAW</div>
    `;

    $btnDone.style.display = 'inline-block';
    $btnDone.onclick = () => closeAllDialogs();

  } catch (err) {
    if (err.name !== 'AbortError') {
      $result.style.display = 'block';
      $result.innerHTML = `<div style="color:var(--color-deleted);">导出失败：${err.message}</div>`;
      $btnDone.style.display = 'inline-block';
      $btnDone.onclick = () => closeAllDialogs();
    } else {
      closeAllDialogs();
    }
  }
}

// ===== 导出CSV清单 =====
function exportList(matchedData) {
  let csv = 'JPG文件名,RAW文件名,状态\n';
  matchedData.matched.forEach(item => {
    csv += `${item.jpg.name},${item.raw.name},已匹配\n`;
  });
  matchedData.unmatched.forEach(item => {
    csv += `${item.name},,未匹配\n`;
  });

  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = '选片匹配结果.csv';
  a.click();
  URL.revokeObjectURL(url);
}

// ===== 启动 =====
document.addEventListener('DOMContentLoaded', init);
