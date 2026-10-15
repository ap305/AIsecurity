import { requireAdminMw } from '../lib/auth.js';
import { Router } from 'express'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const router = Router()
router.use('/admin', requireAdminMw)

// Resources directory: quiz-svc/resources/ (sibling of judge-assets/)
const RESOURCES_DIR = path.resolve(__dirname, '../../resources')
if (!fs.existsSync(RESOURCES_DIR)) {
  fs.mkdirSync(RESOURCES_DIR, { recursive: true })
}

// Multer storage for admin resource uploads: preserve original filename (including
// Chinese chars) directly into resources/<questionId>/, overwriting on name clash.
const resourceStorage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const id = req.params.id
    // Reject path separators in question id (defensive; should be validated earlier)
    if (id.includes('/') || id.includes('\\') || id.includes('..')) {
      return cb(new Error('Invalid question id'), '')
    }
    const questionDir = path.resolve(RESOURCES_DIR, id)
    if (!questionDir.startsWith(RESOURCES_DIR + path.sep)) {
      return cb(new Error('Invalid question id'), '')
    }
    if (!fs.existsSync(questionDir)) {
      fs.mkdirSync(questionDir, { recursive: true })
    }
    cb(null, questionDir)
  },
  filename: (_req, file, cb) => {
    // Multer v1 reads multipart filename bytes as latin-1, but browsers send
    // UTF-8. Re-decode as UTF-8 so Chinese filenames are preserved correctly.
    let name = file.originalname
    try {
      name = Buffer.from(file.originalname, 'latin1').toString('utf8')
    } catch {
      // fallback: keep original if conversion fails
    }
    cb(null, name)
  },
})

const resourceUpload = multer({
  storage: resourceStorage,
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB per file
})

// GET /api/questions/:id/resources - list available resource files for a question
router.get('/questions/:id/resources', (req, res) => {
  try {
    const questionDir = path.resolve(RESOURCES_DIR, req.params.id)

    // Path traversal protection
    if (!questionDir.startsWith(RESOURCES_DIR + path.sep)) {
      return res
        .status(400)
        .json({ code: 40000, message: 'Invalid question id', data: null })
    }

    if (!fs.existsSync(questionDir) || !fs.statSync(questionDir).isDirectory()) {
      return res.json({ code: 0, message: 'ok', data: [] })
    }

    res.json({ code: 0, message: 'ok', data: listResources(questionDir) })
  } catch (err) {
    console.error('Failed to list resources:', err)
    res.status(500).json({ code: 50000, message: 'Internal server error', data: null })
  }
})

// GET /api/questions/:id/resources/:filename - download a resource file
router.get('/questions/:id/resources/:filename', (req, res) => {
  try {
    const { id, filename } = req.params

    // Reject any path separators in filename (defensive)
    if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
      return res
        .status(400)
        .json({ code: 40000, message: 'Invalid filename', data: null })
    }

    const questionDir = path.resolve(RESOURCES_DIR, id)
    // Path traversal protection on question id
    if (!questionDir.startsWith(RESOURCES_DIR + path.sep)) {
      return res
        .status(400)
        .json({ code: 40000, message: 'Invalid question id', data: null })
    }

    const filePath = path.join(questionDir, filename)
    // Final safety check: resolved path must still be inside questionDir
    if (!filePath.startsWith(questionDir + path.sep)) {
      return res
        .status(400)
        .json({ code: 40000, message: 'Invalid filename', data: null })
    }

    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      return res
        .status(404)
        .json({ code: 40400, message: 'Resource not found', data: null })
    }

    // Use the raw filename (UTF-8) in Content-Disposition; res.download's
    // second arg sets the download filename. Express will handle headers.
    res.download(filePath, filename)
  } catch (err) {
    console.error('Failed to download resource:', err)
    res.status(500).json({ code: 50000, message: 'Internal server error', data: null })
  }
})

// ─── 管理员接口：上传 / 删除资源文件 ────────────────────────────────────────
//
// 与 questions.ts 中的 admin 接口一致，暂不在路由层做身份校验，部署时由
// nginx 或中间件层加 admin role 检查（TODO: 后续加 auth 中间件）。

// POST /api/admin/questions/:id/resources - upload one or more resource files
router.post('/admin/questions/:id/resources', (req, res, next) => {
  // Validate question id BEFORE multer processes the upload (path traversal protection)
  const { id } = req.params
  if (id.includes('/') || id.includes('\\') || id.includes('..')) {
    return res.status(400).json({ code: 40000, message: 'Invalid question id', data: null })
  }
  const questionDir = path.resolve(RESOURCES_DIR, id)
  if (!questionDir.startsWith(RESOURCES_DIR + path.sep)) {
    return res.status(400).json({ code: 40000, message: 'Invalid question id', data: null })
  }
  next()
}, resourceUpload.array('files', 20), (req, res) => {
  try {
    const { id } = req.params

    const questionDir = path.resolve(RESOURCES_DIR, id)

    const files = (req.files as Express.Multer.File[] | undefined) ?? []
    if (files.length === 0) {
      return res.status(400).json({ code: 40001, message: '未收到文件', data: null })
    }

    // Return the refreshed full file list for this question
    const listed = listResources(questionDir)
    res.json({ code: 0, message: `已上传 ${files.length} 个文件`, data: listed })
  } catch (err) {
    console.error('Failed to upload resources:', err)
    res.status(500).json({ code: 50000, message: 'Internal server error', data: null })
  }
})

// DELETE /api/admin/questions/:id/resources/:filename - delete a resource file
router.delete('/admin/questions/:id/resources/:filename', (req, res) => {
  try {
    const { id, filename } = req.params

    if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
      return res.status(400).json({ code: 40000, message: 'Invalid filename', data: null })
    }
    if (id.includes('/') || id.includes('\\') || id.includes('..')) {
      return res.status(400).json({ code: 40000, message: 'Invalid question id', data: null })
    }

    const questionDir = path.resolve(RESOURCES_DIR, id)
    if (!questionDir.startsWith(RESOURCES_DIR + path.sep)) {
      return res.status(400).json({ code: 40000, message: 'Invalid question id', data: null })
    }
    const filePath = path.join(questionDir, filename)
    if (!filePath.startsWith(questionDir + path.sep)) {
      return res.status(400).json({ code: 40000, message: 'Invalid filename', data: null })
    }

    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      return res.status(404).json({ code: 40400, message: 'Resource not found', data: null })
    }

    fs.unlinkSync(filePath)
    const listed = listResources(questionDir)
    res.json({ code: 0, message: '已删除', data: listed })
  } catch (err) {
    console.error('Failed to delete resource:', err)
    res.status(500).json({ code: 50000, message: 'Internal server error', data: null })
  }
})

function listResources(questionDir: string) {
  if (!fs.existsSync(questionDir) || !fs.statSync(questionDir).isDirectory()) return []
  return fs
    .readdirSync(questionDir)
    .filter((name) => fs.statSync(path.join(questionDir, name)).isFile())
    .map((filename) => {
      const stat = fs.statSync(path.join(questionDir, filename))
      return {
        filename,
        size: stat.size,
        sizeLabel: formatSize(stat.size),
        extension: path.extname(filename).toLowerCase().slice(1),
      }
    })
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export default router
