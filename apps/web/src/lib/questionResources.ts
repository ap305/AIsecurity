export interface QuestionResource {
  filename: string
  size: number
}

export function isPublicResource(value: unknown): value is QuestionResource {
  if (!value || typeof value !== 'object') return false
  const resource = value as Record<string, unknown>
  return (
    typeof resource.filename === 'string' &&
    resource.filename.length > 0 &&
    !resource.filename.startsWith('.') &&
    !/[\\/\u0000-\u001f\u007f]/.test(resource.filename) &&
    !resource.filename.includes('..') &&
    typeof resource.size === 'number' &&
    Number.isFinite(resource.size) &&
    resource.size >= 0
  )
}

export function resourceSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

const kinds = [
  {
    kind: 'code',
    label: '代码模板',
    hint: '下载模板，按题面接口实现。',
    extensions: ['py', 'ipynb', 'js', 'ts', 'cpp', 'c', 'java'],
  },
  {
    kind: 'bundle',
    label: '本地实验与接口包',
    hint: '解压后按包内说明准备环境和运行。',
    extensions: ['zip', '7z', 'gz', 'tar'],
  },
  {
    kind: 'document',
    label: '说明文档',
    hint: '查看实验步骤与提交要求。',
    extensions: ['md', 'pdf', 'txt', 'docx', 'html'],
  },
  { kind: 'other', label: '其他资料', hint: '按题面要求使用。', extensions: [] },
  {
    kind: 'image',
    label: '题目配图',
    hint: '题面引用的图片，也可单独下载。',
    extensions: ['png', 'jpg', 'jpeg', 'webp', 'svg', 'gif'],
  },
]

export function groupResources(resources: QuestionResource[]) {
  return kinds
    .map((group) => ({
      ...group,
      resources: resources.filter((resource) => {
        const extension = resource.filename.split('.').at(-1)?.toLowerCase() || ''
        const kind = kinds.find((item) => item.extensions.includes(extension))?.kind || 'other'
        return kind === group.kind
      }),
    }))
    .filter((group) => group.resources.length > 0)
}
