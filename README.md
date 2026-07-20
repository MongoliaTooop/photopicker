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
