import { useMemo } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { EditorView } from '@codemirror/view'
import { oneDark } from '@codemirror/theme-one-dark'
import { indentUnit } from '@codemirror/language'
import { python } from '@codemirror/lang-python'
import { java } from '@codemirror/lang-java'
import { javascript } from '@codemirror/lang-javascript'
import { rust } from '@codemirror/lang-rust'
import { go } from '@codemirror/lang-go'
import { markdown } from '@codemirror/lang-markdown'

// 轻量级代码编辑器（基于 CodeMirror 6），替代 Monaco。
// 通过 React.lazy 引入可独立分包，避免拖慢首屏与主 bundle。

type LanguageLoader = () => ReturnType<typeof python>

const LANGUAGE_LOADERS: Record<string, LanguageLoader> = {
  python: () => python(),
  java: () => java(),
  javascript: () => javascript(),
  typescript: () => javascript({ typescript: true }),
  rust: () => rust(),
  go: () => go(),
  markdown: () => markdown(),
}

export interface CodeEditorProps {
  value: string
  onChange: (value: string) => void
  language?: string
  height?: string
  readOnly?: boolean
  fontSize?: number
  wordWrap?: boolean
}

export default function CodeEditor({
  value,
  onChange,
  language = 'python',
  height = '100%',
  readOnly = false,
  fontSize = 13,
  wordWrap = false,
}: CodeEditorProps) {
  const extensions = useMemo(() => {
    const loader = LANGUAGE_LOADERS[language] ?? LANGUAGE_LOADERS.python
    const exts = [oneDark, loader(), indentUnit.of('    ')]
    if (wordWrap) exts.push(EditorView.lineWrapping)
    return exts
  }, [language, wordWrap])

  return (
    <CodeMirror
      value={value}
      height={height}
      extensions={extensions}
      onChange={onChange}
      editable={!readOnly}
      theme={oneDark}
      basicSetup={{
        lineNumbers: true,
        highlightActiveLine: !readOnly,
        highlightActiveLineGutter: !readOnly,
        foldGutter: true,
        autocompletion: true,
        bracketMatching: true,
        closeBrackets: true,
        indentOnInput: true,
        tabSize: 4,
      }}
      style={{
        fontSize,
        fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
        height: '100%',
      }}
    />
  )
}
