import { execFile } from 'child_process'
import { promisify } from 'util'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { fileURLToPath } from 'url'

const execFileAsync = promisify(execFile)

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// 判题子进程降权：官方 node 镜像内置 node 用户 uid/gid=1000
const JUDGE_UID = Number(process.env.JUDGE_UID) || 1000
const JUDGE_GID = Number(process.env.JUDGE_GID) || 1000

/** 判题子进程环境白名单：不继承 DATABASE_URL / Token 等敏感变量 */
function judgeEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: '/tmp',
    PYTHONUNBUFFERED: '1',
    PYTHONUTF8: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONPATH: path.resolve(JUDGE_ASSETS_DIR, '_common'),
  }
}
const JUDGE_ASSETS_DIR = path.resolve(__dirname, '../../judge-assets')

interface JudgeInput {
  submissionId: string
  code: string
  filePath: string | null
  testConfig: Record<string, unknown>
}

interface JudgeOutput {
  status: 'passed' | 'failed' | 'error'
  score: number | null
  result: Record<string, unknown>
}

export async function executeJudge(input: JudgeInput): Promise<JudgeOutput> {
  const { testConfig } = input
  const judgeType = testConfig.type as string

  switch (judgeType) {
    case 'model_eval':
      return judgeModelEval(input)
    case 'code_eval':
      return judgeCodeEval(input)
    case 'theory_eval':
      return judgeTheoryEval(input)
    default:
      return {
        status: 'error',
        score: null,
        result: { message: `Unknown judge type: ${judgeType}` },
      }
  }
}

async function judgeModelEval(input: JudgeInput): Promise<JudgeOutput> {
  const { submissionId, code, filePath, testConfig } = input

  if (!filePath || !fs.existsSync(filePath)) {
    return {
      status: 'error',
      score: null,
      result: { message: '模型文件未找到，请上传 model.pth 文件' },
    }
  }

  if (!code || code.trim().length === 0) {
    return {
      status: 'error',
      score: null,
      result: { message: '代码不能为空' },
    }
  }

  const scriptName = testConfig.script as string
  if (!scriptName) {
    return {
      status: 'error',
      score: null,
      result: { message: '评测脚本未配置' },
    }
  }

  // Find the judge asset directory for this question
  const assetDir = path.join(JUDGE_ASSETS_DIR, testConfig.assetDir as string || '')
  const scriptPath = path.join(assetDir, scriptName)

  if (!fs.existsSync(scriptPath)) {
    return {
      status: 'error',
      score: null,
      result: { message: `评测脚本不存在: ${scriptPath}` },
    }
  }

  // Write student's code to a temp directory so test_code.py can import it
  const workDir = path.join(os.tmpdir(), `judge-${submissionId}`)
  fs.mkdirSync(workDir, { recursive: true })
  const studentCodePath = path.join(workDir, 'student_code.py')

  try {
    fs.writeFileSync(studentCodePath, code, 'utf-8')
  } catch {
    return {
      status: 'error',
      score: null,
      result: { message: '无法写入学生代码到临时文件' },
    }
  }

  const threshold = (testConfig.threshold as number) || 0.95
  const timeout = (testConfig.timeout as number) || 120000

  try {
    // Find python binary (python3 or python)
    const pythonBin = process.env.PYTHON_BIN || 'python3'

    // Pass: script, model_path, code_dir
    const { stdout, stderr } = await execFileAsync(
      pythonBin,
      [scriptPath, filePath, workDir],
      {
        cwd: assetDir,
        timeout,
        maxBuffer: 1024 * 1024,
        uid: JUDGE_UID,
        gid: JUDGE_GID,
        env: judgeEnv(),
      }
    )

    const output = stdout + stderr

    // Parse output: look for "Test Accuracy: XX.XX%" and "测试通过/测试未通过"
    const accuracyMatch = output.match(/Test Accuracy:\s*(\d+\.?\d*)%/i)
    const passed = output.includes('测试通过')
    const accuracy = accuracyMatch ? parseFloat(accuracyMatch[1]) / 100 : null

    const resultObj: Record<string, unknown> = {
      output,
      accuracy,
      passed: accuracy !== null ? accuracy >= threshold : passed,
      message: '',
    }

    if (accuracy !== null) {
      const isPassed = accuracy >= threshold
      resultObj.message = isPassed
        ? `测试通过！准确率: ${(accuracy * 100).toFixed(2)}% (阈值: ${(threshold * 100).toFixed(0)}%)`
        : `测试未通过。准确率: ${(accuracy * 100).toFixed(2)}% (阈值: ${(threshold * 100).toFixed(0)}%)`

      return {
        status: isPassed ? 'passed' : 'failed',
        score: accuracy * 100,
        result: resultObj,
      }
    }

    // Fallback if no accuracy pattern found
    resultObj.message = passed ? '测试通过' : '测试未通过'
    return {
      status: passed ? 'passed' : 'failed',
      score: passed ? 100 : 0,
      result: resultObj,
    }
  } catch (err: unknown) {
    const error = err as Error & { code?: string; killed?: boolean; stdout?: string; stderr?: string }
    const errorOutput = (error.stdout || '') + (error.stderr || '')
    return {
      status: 'error',
      score: null,
      result: {
        message: error.killed
          ? `评测超时（超过 ${timeout / 1000} 秒）`
          : `评测执行错误: ${error.message}`,
        output: errorOutput,
        error: error.message,
      },
    }
  } finally {
    // Cleanup temp student code
    try {
      fs.rmSync(workDir, { recursive: true, force: true })
    } catch { /* ignore cleanup errors */ }
  }
}

/**
 * code_eval 评判模式：运行学生代码 + 预置测试脚本
 * 与 model_eval 不同：不需要上传模型文件，学生代码直接被测试脚本导入并运行
 *
 * testConfig 字段：
 *   - assetDir: 测试资源目录（JUDGE_ASSETS_DIR 子目录）
 *   - script: 测试脚本文件名（Python）
 *   - threshold: 通过阈值（0-1，测试用例通过率）
 *   - timeout: 超时毫秒
 *
 * 测试脚本约定：
 *   - 调用方式：python3 <script> <student_code_dir>
 *   - stdout 输出格式：
 *     "Tests Passed: N/M"（N 通过，M 总数）
 *     "测试通过" / "测试未通过"
 *     可选 "Score: XX.XX"
 */
async function judgeCodeEval(input: JudgeInput): Promise<JudgeOutput> {
  const { submissionId, code, testConfig } = input

  if (!code || code.trim().length === 0) {
    return {
      status: 'error',
      score: null,
      result: { message: '代码不能为空' },
    }
  }

  const scriptName = testConfig.script as string
  if (!scriptName) {
    return {
      status: 'error',
      score: null,
      result: { message: '评测脚本未配置' },
    }
  }

  const assetDir = path.join(JUDGE_ASSETS_DIR, (testConfig.assetDir as string) || '')
  const scriptPath = path.join(assetDir, scriptName)

  if (!fs.existsSync(scriptPath)) {
    return {
      status: 'error',
      score: null,
      result: { message: `评测脚本不存在: ${scriptPath}` },
    }
  }

  const workDir = path.join(os.tmpdir(), `judge-${submissionId}`)
  fs.mkdirSync(workDir, { recursive: true })
  const studentCodePath = path.join(workDir, 'student_code.py')

  try {
    fs.writeFileSync(studentCodePath, code, 'utf-8')
  } catch {
    return {
      status: 'error',
      score: null,
      result: { message: '无法写入学生代码到临时文件' },
    }
  }

  const threshold = (testConfig.threshold as number) || 0.8
  const timeout = (testConfig.timeout as number) || 30000

  try {
    const pythonBin = process.env.PYTHON_BIN || 'python3'
    const { stdout, stderr } = await execFileAsync(
      pythonBin,
      [scriptPath, workDir],
      {
        cwd: assetDir,
        timeout,
        maxBuffer: 1024 * 1024,
        uid: JUDGE_UID,
        gid: JUDGE_GID,
        env: judgeEnv(),
      }
    )

    const output = stdout + stderr

    // Parse "Tests Passed: N/M" pattern
    const passedMatch = output.match(/Tests Passed:\s*(\d+)\s*\/\s*(\d+)/i)
    // Parse optional "Score: XX.XX"
    const scoreMatch = output.match(/Score:\s*(\d+\.?\d*)/i)

    const resultObj: Record<string, unknown> = {
      output,
      message: '',
    }

    if (passedMatch) {
      const passed = parseInt(passedMatch[1])
      const total = parseInt(passedMatch[2])
      const ratio = total > 0 ? passed / total : 0
      const isPassed = ratio >= threshold

      resultObj.passed = isPassed
      resultObj.testsPassed = passed
      resultObj.testsTotal = total
      resultObj.ratio = ratio
      resultObj.message = isPassed
        ? `测试通过！通过 ${passed}/${total} 个用例（阈值: ${(threshold * 100).toFixed(0)}%）`
        : `测试未通过。通过 ${passed}/${total} 个用例（阈值: ${(threshold * 100).toFixed(0)}%）`

      // Use explicit Score if provided, else ratio * 100
      const score = scoreMatch ? parseFloat(scoreMatch[1]) : ratio * 100

      return {
        status: isPassed ? 'passed' : 'failed',
        score,
        result: resultObj,
      }
    }

    // Fallback: check for 测试通过 / 测试未通过 markers
    const passed = output.includes('测试通过')
    resultObj.message = passed ? '测试通过' : '测试未通过'
    return {
      status: passed ? 'passed' : 'failed',
      score: passed ? 100 : 0,
      result: resultObj,
    }
  } catch (err: unknown) {
    const error = err as Error & { code?: string; killed?: boolean; stdout?: string; stderr?: string }
    const errorOutput = (error.stdout || '') + (error.stderr || '')
    return {
      status: 'error',
      score: null,
      result: {
        message: error.killed
          ? `评测超时（超过 ${timeout / 1000} 秒）`
          : `评测执行错误: ${error.message}`,
        output: errorOutput,
        error: error.message,
      },
    }
  } finally {
    try {
      fs.rmSync(workDir, { recursive: true, force: true })
    } catch { /* ignore cleanup errors */ }
  }
}

/**
 * theory_eval 评判模式：基于关键词匹配的理论题作答评分
 *
 * testConfig 字段：
 *   - keywords: string[] - 必须出现的关键词（每个 10 分）
 *   - optionalKeywords: string[] - 可选关键词（每个 5 分，最多 30 分）
 *   - minScore: number - 通过阈值（默认 60）
 *   - minWords: number - 最少字数要求（默认 50）
 *
 * 评分规则：
 *   - 基础分：必需关键词命中数 * 10（最多 70 分）
 *   - 加分：可选关键词命中数 * 5（最多 30 分）
 *   - 总分 = 基础分 + 加分
 *   - 字数不足 minWords 则扣 20 分
 *   - 总分 >= minScore 则 passed
 */
async function judgeTheoryEval(input: JudgeInput): Promise<JudgeOutput> {
  const { code, testConfig } = input

  if (!code || code.trim().length === 0) {
    return {
      status: 'error',
      score: null,
      result: { message: '答案不能为空' },
    }
  }

  const requiredKeywords = (testConfig.keywords as string[]) || []
  const optionalKeywords = (testConfig.optionalKeywords as string[]) || []
  const minScore = (testConfig.minScore as number) ?? 60
  const minWords = (testConfig.minWords as number) ?? 50

  const answer = code.toLowerCase()
  // 字数统计：中文字符按字算，英文按空格分词
  const chineseChars = (code.match(/[\u4e00-\u9fa5]/g) || []).length
  const englishWords = code.replace(/[\u4e00-\u9fa5]/g, ' ').trim().split(/\s+/).filter(Boolean).length
  const wordCount = chineseChars + englishWords

  // 检查必需关键词命中
  const hitRequired: string[] = []
  const missedRequired: string[] = []
  for (const kw of requiredKeywords) {
    if (answer.includes(kw.toLowerCase())) {
      hitRequired.push(kw)
    } else {
      missedRequired.push(kw)
    }
  }

  // 检查可选关键词命中
  const hitOptional: string[] = []
  for (const kw of optionalKeywords) {
    if (answer.includes(kw.toLowerCase())) {
      hitOptional.push(kw)
    }
  }

  // 计算分数
  const requiredScore = Math.min(hitRequired.length * 10, 70)
  const optionalScore = Math.min(hitOptional.length * 5, 30)
  let totalScore = requiredScore + optionalScore

  // 字数不足扣分
  let wordPenalty = false
  if (wordCount < minWords) {
    totalScore = Math.max(0, totalScore - 20)
    wordPenalty = true
  }

  const isPassed = totalScore >= minScore

  return {
    status: isPassed ? 'passed' : 'failed',
    score: totalScore,
    result: {
      message: isPassed
        ? `答案评分通过：${totalScore} 分`
        : `答案评分未通过：${totalScore} 分（需 ${minScore} 分）`,
      score: totalScore,
      passed: isPassed,
      wordCount,
      wordPenalty,
      minWords,
      hitRequired,
      missedRequired,
      hitOptional,
      requiredScore,
      optionalScore,
    },
  }
}
