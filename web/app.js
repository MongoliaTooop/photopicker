/* ===== 选片助手 - 网页版核心逻辑 =====
 * 使用 File System Access API 读取本地文件夹
 * 支持 Chrome / Edge / Brave 等 Chromium 内核浏览器
 */

const RAW_EXTENSIONS = ['.cr2', '.cr3', '.nef', '.arw', '.raf', '.dng', '.rw2', '.orf', '.x3f', '.sr2', '.srf', '.pef'];
const JPG_EXTENSIONS = ['.jpg', '.jpeg'];

// 状态
const state = {
  jpgDirHandle: null,     // JPG文件夹句柄
  rawDirHandle: null,     // RAW文件夹句柄
  jpgFiles: [],           // [{ name, baseName, handle, url, exifTime }]
  currentIndex: -1,
  marks: {},
  groups: [],
  groupingEnabled: false,
  sortBy: 'name',
  filterBy: 'all',
  displayList: [],
  matchedData: null,
  zoomLevel: 1,
  urlCache: new Map(),    // 缓存 objectURL 防止重复创建
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

  document.getElementById('btn-export').addEventListener('click', () => {
    if (!state.matchedData || state.matchedData.matched.length === 0) {
      alert('请先匹配RAW文件。');
      return;
    }
    openExportDialog();
  });
}

// ===== 打开JPG文件夹 =====
async function openJpgFolder() {
  try {
    const dirHandle = await window.showDirectoryPicker({ mode: 'read' });
    state.jpgDirHandle = dirHandle;

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

    // 按文件名排序
    jpgFiles.sort((a, b) => a.name.localeCompare(b.name));

    // 清理旧的 objectURL
    state.urlCache.forEach(url => URL.revokeObjectURL(url));
    state.urlCache.clear();

    state.jpgFiles = jpgFiles;
    state.marks = {};
    jpgFiles.forEach(f => { state.marks[f.baseName] = 'pending'; });

    // 更新标题
    document.getElementById('toolbar-title').textContent = dirHandle.name + ' - 选片助手';

    updateDisplayList();
    renderThumbnails();
    navigateTo(0);
    updateStats();

    // 后台异步加载所有EXIF（用于分组功能）
    loadAllExif();
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error('打开文件夹失败:', err);
      alert('打开文件夹失败: ' + err.message);
    }
  }
}

// ===== 异步加载所有EXIF数据 =====
async function loadAllExif() {
  const BATCH_SIZE = 20;
  for (let i = 0; i < state.jpgFiles.length; i += BATCH_SIZE) {
    const batch = state.jpgFiles.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(async (file) => {
      if (file.exifTime !== null) return; // 已加载
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
    // 如果分组已开启，更新分组
    if (state.groupingEnabled && i + BATCH_SIZE >= state.jpgFiles.length) {
      autoGroup();
      updateDisplayList();
      renderThumbnails();
    }
  }
}

// ===== 获取图片URL（带缓存） =====
async function getImageUrl(file) {
  if (state.urlCache.has(file.baseName)) {
    return state.urlCache.get(file.baseName);
  }
  const f = await file.handle.getFile();
  const url = URL.createObjectURL(f);
  state.urlCache.set(file.baseName, url);
  return url;
}

// ===== 键盘快捷键 =====
function bindKeyboard() {
  document.addEventListener('keydown', (e) => {
    if (document.querySelector('.dialog-overlay[style*="display: flex"]') ||
        document.querySelector('.dialog-overlay[style*="display:block"]')) {
      if (e.key === 'Escape') closeAllDialogs();
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

// ===== 对话框 =====
function bindDialogs() {
  document.getElementById('dialog-match-close').addEventListener('click', () => {
    document.getElementById('dialog-match').style.display = 'none';
  });
}

function closeAllDialogs() {
  document.getElementById('dialog-match').style.display = 'none';
  document.getElementById('dialog-export').style.display = 'none';
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

// ===== 渲染缩略图 =====
function renderThumbnails() {
  $thumbList.innerHTML = '';
  $thumbCount.textContent = state.displayList.length;

  if (state.displayList.length === 0) {
    $thumbList.appendChild($emptyState);
    $emptyState.style.display = 'flex';
    return;
  }

  $emptyState.style.display = 'none';

  if (state.groupingEnabled && state.groups.length > 0) {
    renderGroupedThumbnails();
  } else {
    renderFlatThumbnails();
  }
}

function renderFlatThumbnails() {
  state.displayList.forEach((file, i) => {
    const el = createThumbItem(file, i);
    $thumbList.appendChild(el);
  });
}

function renderGroupedThumbnails() {
  state.groups.forEach((group) => {
    const header = document.createElement('div');
    header.className = 'group-header';
    header.innerHTML = `<span class="group-dot"></span>
      <span>${group.name}</span>
      <span class="group-count">${group.files.length}</span>
      <span class="group-expand">▼</span>`;
    header.addEventListener('click', () => {
      const content = header.nextElementSibling;
      if (content) {
        const isHidden = content.style.display === 'none';
        content.style.display = isHidden ? 'block' : 'none';
        header.querySelector('.group-expand').textContent = isHidden ? '▼' : '▶';
      }
    });
    $thumbList.appendChild(header);

    const groupContent = document.createElement('div');

    if (group.subgroups.length > 0) {
      group.subgroups.forEach((sub) => {
        const subHeader = document.createElement('div');
        subHeader.className = 'subgroup-header';
        subHeader.innerHTML = `<span>▼</span> ${sub.name} (${sub.files.length})`;
        subHeader.addEventListener('click', () => {
          const subContent = subHeader.nextElementSibling;
          if (subContent) {
            const isHidden = subContent.style.display === 'none';
            subContent.style.display = isHidden ? 'block' : 'none';
          }
        });
        groupContent.appendChild(subHeader);

        const subContent = document.createElement('div');
        sub.files.forEach((file) => {
          const idx = state.displayList.indexOf(file);
          if (idx >= 0) subContent.appendChild(createThumbItem(file, idx));
        });
        groupContent.appendChild(subContent);
      });
    } else {
      group.files.forEach((file) => {
        const idx = state.displayList.indexOf(file);
        if (idx >= 0) groupContent.appendChild(createThumbItem(file, idx));
      });
    }

    $thumbList.appendChild(groupContent);
  });

  // 未分组的文件
  const ungrouped = state.displayList.filter(f => {
    return !state.groups.some(g => g.files.includes(f));
  });
  if (ungrouped.length > 0) {
    const header = document.createElement('div');
    header.className = 'group-header';
    header.innerHTML = `<span class="group-dot" style="background:var(--color-pending);"></span>
      <span>未分组</span>
      <span class="group-count">${ungrouped.length}</span>`;
    $thumbList.appendChild(header);

    const content = document.createElement('div');
    ungrouped.forEach((file) => {
      const idx = state.displayList.indexOf(file);
      content.appendChild(createThumbItem(file, idx));
    });
    $thumbList.appendChild(content);
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

  // 异步加载缩略图
  const imgEl = el.querySelector('.thumb-img');
  getImageUrl(file).then(url => {
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

  // 更新预览图
  $previewImg.style.display = 'none';
  $previewPlaceholder.style.display = 'flex';
  try {
    const url = await getImageUrl(file);
    $previewImg.src = url;
    $previewImg.style.display = 'block';
    $previewPlaceholder.style.display = 'none';
    zoomFit();
  } catch (err) {
    console.error('加载预览失败:', err);
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
  updateStatusBar(file);

  // 异步加载EXIF
  loadExif(file);
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
  document.getElementById('info-group').textContent = findGroupForFile(file) || '无';
  updateInfoStatus(file);
}

function updateInfoStatus(file) {
  const mark = state.marks[file.baseName];
  const labels = { selected: '选中（保留）', pending: '待定（未决定）', deleted: '删除（移除）' };
  document.getElementById('info-status').textContent = labels[mark] || '待定';
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
      }

      if (exif.DateTimeOriginal) {
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

      // 扫描RAW文件，建立 baseName → handle 映射
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

      // 匹配
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

      // 显示统计
      document.getElementById('match-stats').style.display = 'flex';
      document.getElementById('match-count-matched').textContent = matched.length;
      document.getElementById('match-count-unmatched').textContent = unmatched.length;

      // 显示匹配列表
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

  // 导出按钮
  document.getElementById('btn-export-copy').onclick = async () => {
    if (!state.matchedData || state.matchedData.matched.length === 0) {
      alert('没有匹配的RAW文件可导出。');
      return;
    }
    await copyRawFiles(state.matchedData.matched);
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
    // 选择输出文件夹（需要读写权限）
    const outDirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });

    const success = [];
    const failed = [];

    for (let i = 0; i < matchedList.length; i++) {
      const item = matchedList[i];
      $progressText.textContent = `${i} / ${total}`;

      try {
        // 读取源文件
        const file = await item.raw.handle.getFile();
        // 在目标文件夹创建文件
        const newHandle = await outDirHandle.getFileHandle(item.raw.name, { create: true });
        const writable = await newHandle.createWritable();
        await writable.write(file);
        await writable.close();
        success.push(item.raw.name);
      } catch (err) {
        console.error('复制失败:', item.raw.name, err);
        failed.push({ name: item.raw.name, error: err.message });
      }

      // 更新进度条
      const pct = Math.round(((i + 1) / total) * 100);
      $progressBar.style.width = pct + '%';
      $progressText.textContent = `${i + 1} / ${total}`;
    }

    // 显示结果
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
