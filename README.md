# 选片助手

摄影师JPG选片 + RAW匹配导出工具。纯浏览器运行，无需安装。

## 功能

- **看图选片**：暗色主题三栏布局，缩略图浏览 + 大图预览 + EXIF信息
- **三态标记**：选中（绿色）/ 待定（黄色）/ 删除（红色），全键盘操作
- **RAW匹配**：根据选中的JPG文件名，自动匹配对应RAW文件（CR2/CR3/NEF/ARW/RAF/DNG等）
- **一键导出**：将匹配的RAW文件复制到指定文件夹，或导出CSV清单
- **智能分组**：按EXIF拍摄时间自动分组（机位 → 动作）

## 浏览器要求

需使用 Chromium 内核浏览器（File System Access API）：

- Google Chrome 86+
- Microsoft Edge 86+
- Brave / Opera 等

> Firefox 和 Safari 暂不支持。

## 快捷键

| 按键 | 功能 |
|------|------|
| ← / → / 空格 | 切换照片 |
| 1 或 P | 标记为选中 |
| 2 或 X | 标记为删除 |
| 3 或 U | 清除标记 |
| + / - / 0 | 缩放 / 适应 |
| F | 全屏 |
| Home / End | 跳到首张/末张 |

---

## 部署方式

### 方式一：GitHub Pages（推荐，免费）

1. **创建 GitHub 仓库**
   ```bash
   git init
   git add .
   git commit -m "选片助手网页版"
   git branch -M main
   git remote add origin https://github.com/你的用户名/photopicker.git
   git push -u origin main
   ```

2. **启用 GitHub Pages**
   - 进入仓库 → Settings → Pages
   - Source 选择 **GitHub Actions**
   - 推送代码后会自动触发 `.github/workflows/deploy-web.yml` 部署

3. **访问链接**
   部署完成后，访问：
   ```
   https://你的用户名.github.io/photopicker/
   ```

### 方式二：Vercel（免费，速度更快）

1. 将代码推送到 GitHub
2. 登录 [vercel.com](https://vercel.com)，导入 GitHub 仓库
3. 设置：
   - Root Directory: `web`
   - Framework Preset: Other
4. 点击 Deploy，几秒后获得链接：
   ```
   https://photopicker-xxx.vercel.app
   ```

### 方式三：Netlify（免费）

1. 将代码推送到 GitHub
2. 登录 [netlify.com](https://netlify.com)，从 GitHub 导入
3. 设置：
   - Publish directory: `web`
4. Deploy

---

## 本地运行

用任意静态文件服务器启动：

```bash
# 方式一：Python
cd web
python -m http.server 8080

# 方式二：Node.js (npx)
npx serve web

# 方式三：VS Code Live Server 插件
# 右键 web/index.html → Open with Live Server
```

然后浏览器打开 `http://localhost:8080`

> 注意：必须通过 HTTP(S) 访问，不能直接用 `file://` 打开（浏览器安全限制）。

---

## 项目结构

```
photopicker/
├── web/                    # 网页版（部署用）
│   ├── index.html          # 主页面
│   ├── style.css           # 暗色主题样式
│   ├── app.js              # 核心逻辑（File System Access API）
│   └── .nojekyll           # 禁用 GitHub Pages Jekyll 处理
├── .github/workflows/
│   └── deploy-web.yml      # GitHub Pages 自动部署
├── src/                    # Electron 桌面版源码
├── main.js                 # Electron 主进程
├── preload.js              # Electron 预加载脚本
└── package.json            # Electron 项目配置
```

## 技术说明

- 网页版使用 **File System Access API** 读取/写入本地文件，所有操作在浏览器本地完成，不上传任何文件到服务器
- EXIF 读取使用 [exifr](https://github.com/MikeKovarik/exifr) 库（CDN 加载）
- 纯原生 HTML/CSS/JS，无构建步骤，无依赖
