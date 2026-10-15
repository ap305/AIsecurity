import { useEffect, useState, type ReactNode } from 'react'
import {
  prdApi,
  type ApiPoolItem,
  type EvaluationPackage,
  type HallCategory,
  type QuestionDefinition,
  type SelfTest,
} from '../lib/prdApi'

function Field({ label, children, full = false }: { label: string; children: ReactNode; full?: boolean }) {
  return (
    <label className={`prd-label ${full ? 'full' : ''}`}>
      {label}
      {children}
    </label>
  )
}
export default function QuestionDefinitionEditor({
  value,
  onChange,
  category,
  onValidityChange,
}: {
  value: QuestionDefinition
  onChange: (definition: QuestionDefinition) => void
  category: HallCategory
  onValidityChange: (valid: boolean) => void
}) {
  const [pool, setPool] = useState<ApiPoolItem[]>([])
  const [packages, setPackages] = useState<EvaluationPackage[]>([])
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [testCode, setTestCode] = useState('')
  const [phase, setPhase] = useState<'basic' | 'baseline' | 'opponent'>(
    category === 'basic' ? 'basic' : 'baseline',
  )
  const [opponentCode, setOpponentCode] = useState('')
  const [opponentWeightFixture, setOpponentWeightFixture] = useState('')
  const [weightFixture, setWeightFixture] = useState('')
  const [test, setTest] = useState<SelfTest | null>(null)
  const [parameters, setParameters] = useState(JSON.stringify(value.evaluation.parameters ?? {}, null, 2))
  const load = async () => {
    const result = await Promise.allSettled([prdApi.pool(), prdApi.packages()])
    if (result[0].status === 'fulfilled') setPool(result[0].value)
    if (result[1].status === 'fulfilled') setPackages(result[1].value)
    const failures = result.filter((r) => r.status === 'rejected')
    if (failures.length) setError('模型池或环境包暂未加载，请重试。')
  }
  useEffect(() => {
    void load()
  }, [])
  useEffect(() => {
    setPhase(category === 'basic' ? 'basic' : 'baseline')
  }, [category])
  useEffect(() => {
    setParameters(JSON.stringify(value.evaluation.parameters ?? {}, null, 2))
  }, [value.evaluation.packageId])
  useEffect(() => {
    if (!test || test.status === 'completed') return
    let stopped = false
    const timer = setInterval(() => {
      prdApi
        .selfTestStatus(test.packageId, test.id)
        .then((result) => {
          if (!stopped) setTest(result)
        })
        .catch((err) => {
          if (!stopped) setError(err instanceof Error ? err.message : '自测状态查询失败。')
        })
    }, 2000)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [test?.id, test?.status])
  const weights = (patch: Partial<QuestionDefinition['weights']>) =>
    onChange({ ...value, weights: { ...value.weights, ...patch } })
  const teacher = (patch: Partial<QuestionDefinition['teacherApi']>) =>
    onChange({ ...value, teacherApi: { ...value.teacherApi, ...patch } })
  const evaluation = (patch: Partial<QuestionDefinition['evaluation']>) =>
    onChange({ ...value, evaluation: { ...value.evaluation, ...patch } })
  const upload = async (file?: File) => {
    if (!file) return
    setBusy(true)
    setError('')
    try {
      const result = await prdApi.uploadPackage(file)
      setPackages((items) => [result, ...items.filter((p) => p.id !== result.id)])
      evaluation({ packageId: result.id })
      setNotice('环境包已上传并完成格式校验。请使用标准样例执行自测。')
    } catch (err) {
      setError(err instanceof Error ? err.message : '环境包上传失败。')
    } finally {
      setBusy(false)
    }
  }
  const selfTest = async () => {
    if (!value.evaluation.packageId || !testCode.trim()) {
      setError('请先选择环境包并填写自测代码。')
      return
    }
    if (category === 'adversarial' && !value.role) {
      setError('请先选择本题固定角色。')
      return
    }
    if (phase === 'opponent' && !opponentCode.trim()) {
      setError('对手阶段请填写相反角色的标准对手代码。')
      return
    }
    setBusy(true)
    setError('')
    try {
      setTest(
        await prdApi.selfTest(value.evaluation.packageId, {
          code: testCode,
          role: category === 'adversarial' ? value.role : null,
          category,
          definition: value,
          phase,
          opponent:
            phase === 'opponent'
              ? { code: opponentCode, weightFixture: opponentWeightFixture || undefined }
              : undefined,
          weightFixture: weightFixture || undefined,
        }),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : '自测提交失败。')
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <section className="prd-section">
        <h2>提交与评测能力</h2>
        <div className="prd-grid">
          <Field label="评测方式">
            <select
              className="prd-input"
              value={value.kind}
              onChange={(e) => onChange({ ...value, kind: e.target.value as QuestionDefinition['kind'] })}
            >
              <option value="algorithm">算法代码</option>
              <option value="model">本地训练模型</option>
              <option value="distillation">蒸馏 / 黑盒查询</option>
              <option value="agent">Agent / 提示词渲染</option>
            </select>
          </Field>
          {category === 'adversarial' && (
            <>
              <Field label="本题固定角色">
                <select
                  className="prd-input"
                  value={value.role ?? ''}
                  onChange={(e) => onChange({ ...value, role: e.target.value as 'attack' | 'defense' })}
                >
                  <option value="">请选择</option>
                  <option value="attack">攻击（需要防御基线）</option>
                  <option value="defense">防御（需要攻击基线）</option>
                </select>
              </Field>
              <Field label="共同攻防关联标识">
                <input
                  className="prd-input"
                  value={value.scenarioId ?? ''}
                  onChange={(e) => onChange({ ...value, scenarioId: e.target.value })}
                  placeholder="攻击题与防御题填写同一标识"
                />
              </Field>
            </>
          )}
          <label className="prd-check">
            <input
              type="checkbox"
              checked={value.weights.enabled}
              onChange={(e) =>
                weights({ enabled: e.target.checked, required: e.target.checked && value.weights.required })
              }
            />
            启用参数上传
          </label>
          <label className="prd-check">
            <input
              type="checkbox"
              disabled={!value.weights.enabled}
              checked={value.weights.required}
              onChange={(e) => weights({ required: e.target.checked })}
            />
            参数文件必需
          </label>
          {value.weights.enabled && (
            <>
              <Field label="允许的参数扩展名（逗号分隔）">
                <input
                  className="prd-input"
                  value={value.weights.extensions.join(', ')}
                  onChange={(e) =>
                    weights({
                      extensions: e.target.value
                        .split(',')
                        .map((v) => v.trim())
                        .filter(Boolean),
                    })
                  }
                />
              </Field>
              <Field label="大小上限（MB，最多500）">
                <input
                  className="prd-input"
                  type="number"
                  min={1}
                  max={500}
                  value={value.weights.maxBytes / 1024 / 1024}
                  onChange={(e) => weights({ maxBytes: Math.round(Number(e.target.value) * 1024 * 1024) })}
                />
              </Field>
              <Field label="参数提交说明" full>
                <textarea
                  className="prd-input"
                  value={value.weights.description}
                  onChange={(e) => weights({ description: e.target.value })}
                />
              </Field>
              <Field label="预期模型结构">
                <input
                  className="prd-input"
                  value={value.weights.modelStructure ?? ''}
                  onChange={(e) => weights({ modelStructure: e.target.value })}
                />
              </Field>
              <Field label="权重类型">
                <input
                  className="prd-input"
                  value={value.weights.weightType ?? ''}
                  onChange={(e) => weights({ weightType: e.target.value })}
                  placeholder="例如 state_dict"
                />
              </Field>
              <Field label="加载接口">
                <input
                  className="prd-input"
                  value={value.weights.loadInterface ?? ''}
                  onChange={(e) => weights({ loadInterface: e.target.value })}
                />
              </Field>
              <Field label="设备兼容性">
                <input
                  className="prd-input"
                  value={value.weights.device ?? ''}
                  onChange={(e) => weights({ device: e.target.value })}
                  placeholder="例如 CPU / CUDA 版本限制"
                />
              </Field>
              <Field label="必需参数键（逗号分隔）" full>
                <input
                  className="prd-input"
                  value={value.weights.requiredKeys?.join(', ') ?? ''}
                  onChange={(e) =>
                    weights({
                      requiredKeys: e.target.value
                        .split(',')
                        .map((v) => v.trim())
                        .filter(Boolean),
                    })
                  }
                />
              </Field>
            </>
          )}
        </div>
      </section>
      <section className="prd-section">
        <h2>模型与教师 API</h2>
        <div className="prd-grid">
          <label className="prd-check">
            <input
              type="checkbox"
              checked={value.llm.enabled}
              onChange={(e) => onChange({ ...value, llm: { ...value.llm, enabled: e.target.checked } })}
            />
            启用平台固定大模型评测
          </label>
          <label className="prd-check">
            <input
              type="checkbox"
              checked={value.teacherApi.enabled}
              onChange={(e) => teacher({ enabled: e.target.checked })}
            />
            启用两小时临时教师 API
          </label>
          {value.llm.enabled && (
            <Field label="题目绑定的大模型配置">
              <select
                className="prd-input"
                value={value.llm.poolId ?? ''}
                onChange={(e) => onChange({ ...value, llm: { ...value.llm, poolId: e.target.value } })}
              >
                <option value="">请选择可用配置</option>
                {pool
                  .filter((item) => item.kind === 'llm')
                  .map((item) => (
                    <option key={item.id} value={item.id} disabled={!item.enabled}>
                      {item.name} · {item.model} · {item.modelVersion}
                      {item.isDefault ? '（默认）' : ''}
                      {!item.enabled ? '（停用）' : ''}
                    </option>
                  ))}
              </select>
            </Field>
          )}
          {value.teacherApi.enabled && (
            <>
              <Field label="题目绑定的教师服务">
                <select
                  className="prd-input"
                  value={value.teacherApi.poolId ?? ''}
                  onChange={(e) => teacher({ poolId: e.target.value })}
                >
                  <option value="">请选择可用服务</option>
                  {pool
                    .filter((item) => item.kind === 'teacher')
                    .map((item) => (
                      <option key={item.id} value={item.id} disabled={!item.enabled}>
                        {item.name}
                        {!item.enabled ? '（停用）' : ''}
                      </option>
                    ))}
                </select>
              </Field>
              <Field label="租期查询次数上限">
                <input
                  className="prd-input"
                  type="number"
                  min={1}
                  value={value.teacherApi.maxCalls ?? 1000}
                  onChange={(e) => teacher({ maxCalls: Number(e.target.value) })}
                />
              </Field>
              <Field label="教师服务输入契约">
                <textarea
                  className="prd-input"
                  value={value.teacherApi.inputSchema ?? ''}
                  onChange={(e) => teacher({ inputSchema: e.target.value })}
                />
              </Field>
              <Field label="教师服务输出契约">
                <textarea
                  className="prd-input"
                  value={value.teacherApi.outputSchema ?? ''}
                  onChange={(e) => teacher({ outputSchema: e.target.value })}
                />
              </Field>
              <Field label="调用示例（不含任何平台密钥）" full>
                <textarea
                  className="prd-input"
                  value={value.teacherApi.example ?? ''}
                  onChange={(e) => teacher({ example: e.target.value })}
                />
              </Field>
            </>
          )}
        </div>
        <p className="prd-muted">
          发布时冻结题目模型版本和参数。学生不能自选模型；平台默认项变化不自动改写已发布题目。
        </p>
      </section>
      <section className="prd-section">
        <h2>Docker Compose 评测环境</h2>
        <div className="prd-grid">
          <Field label="选择已校验环境包">
            <select
              className="prd-input"
              value={value.evaluation.packageId ?? ''}
              onChange={(e) => {
                evaluation({ packageId: e.target.value })
                setTest(null)
              }}
            >
              <option value="">请选择</option>
              {packages.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} · {item.id.slice(0, 10)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="上传环境包（ZIP）">
            <input
              type="file"
              accept=".zip"
              disabled={busy}
              onChange={(e) => void upload(e.target.files?.[0])}
            />
          </Field>
          <Field label="评测规则版本">
            <input
              className="prd-input"
              value={value.evaluation.version}
              onChange={(e) => evaluation({ version: e.target.value })}
            />
          </Field>
          <Field label="每次评测超时（毫秒）">
            <input
              className="prd-input"
              type="number"
              min={1000}
              max={3600000}
              value={value.evaluation.timeoutMs}
              onChange={(e) => evaluation({ timeoutMs: Number(e.target.value) })}
            />
          </Field>
          <Field label="满分">
            <input
              className="prd-input"
              type="number"
              min={0.01}
              value={value.evaluation.maxScore}
              onChange={(e) => evaluation({ maxScore: Number(e.target.value) })}
            />
          </Field>
          <Field label="固定评测重复次数">
            <input
              className="prd-input"
              type="number"
              min={1}
              step={1}
              value={value.evaluation.repetitions ?? 1}
              onChange={(e) => evaluation({ repetitions: Number(e.target.value) })}
            />
          </Field>
        </div>
        <p className="prd-muted">
          ZIP 根目录包含 manifest.json、compose.yaml 和 main.py。manifest 须声明 protocol:
          platform-rpc-v1，评测入口通过 platform_student.invoke
          调用学生函数；每次提交使用独立环境。配置或模型池版本变化后须重新自测。
        </p>
        {category === 'adversarial' && (
          <div className="prd-grid">
            <Field label="基线资格指标">
              <input
                className="prd-input"
                value={value.evaluation.baselineMetric}
                onChange={(e) => evaluation({ baselineMetric: e.target.value })}
              />
            </Field>
            <Field label="基线资格门槛（统一 ≥）">
              <input
                className="prd-input"
                type="number"
                step="any"
                value={value.evaluation.baselineThreshold}
                onChange={(e) => evaluation({ baselineThreshold: Number(e.target.value) })}
              />
            </Field>
            <Field label="单对手成功指标">
              <input
                className="prd-input"
                value={value.evaluation.successMetric}
                onChange={(e) => evaluation({ successMetric: e.target.value })}
              />
            </Field>
            <Field label="成功聚合阈值">
              <input
                className="prd-input"
                type="number"
                step="any"
                value={value.evaluation.successThreshold}
                onChange={(e) => evaluation({ successThreshold: Number(e.target.value) })}
              />
            </Field>
            <Field label="相反角色基线代码（或在环境包中提供）" full>
              <textarea
                rows={5}
                className="prd-input"
                value={value.evaluation.baselineCode ?? ''}
                onChange={(e) => evaluation({ baselineCode: e.target.value })}
              />
            </Field>
            <Field label="基线参数材料引用">
              <input
                className="prd-input"
                value={value.evaluation.baselineWeightFixture ?? ''}
                onChange={(e) => evaluation({ baselineWeightFixture: e.target.value })}
                placeholder="环境包内模型参数位置"
              />
            </Field>
          </div>
        )}
        <details>
          <summary>固定评测参数（JSON）</summary>
          <textarea
            className="prd-input"
            rows={5}
            value={parameters}
            onChange={(e) => {
              setParameters(e.target.value)
              try {
                const parsed = JSON.parse(e.target.value)
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
                evaluation({ parameters: parsed })
                onValidityChange(true)
                setError('')
              } catch {
                onValidityChange(false)
                setError('固定评测参数必须为有效 JSON 对象，保存前请修正。')
              }
            }}
          />
        </details>
        <div className="prd-toolbar">
          <button
            type="button"
            className="prd-button"
            disabled={busy || !value.evaluation.packageId}
            onClick={async () => {
              setBusy(true)
              setError('')
              try {
                const result = await prdApi.validatePackage(value.evaluation.packageId!)
                setNotice(result.valid ? '环境包校验通过。' : '环境包校验未通过。')
              } catch (err) {
                setError(err instanceof Error ? err.message : '校验失败。')
              } finally {
                setBusy(false)
              }
            }}
          >
            重新校验环境包
          </button>
          <button
            type="button"
            className="prd-button"
            onClick={() => {
              setError('')
              void load()
            }}
          >
            刷新环境包与模型池
          </button>
        </div>
        <div className="prd-grid">
          <Field label="自测阶段">
            <select
              className="prd-input"
              value={phase}
              onChange={(e) => setPhase(e.target.value as typeof phase)}
            >
              <option value="basic">基础评测</option>
              <option value="baseline">基线资格</option>
              <option value="opponent">单对手攻防</option>
            </select>
          </Field>
          <Field label="自测权重文件（环境包内材料引用）">
            <input
              className="prd-input"
              value={weightFixture}
              onChange={(e) => setWeightFixture(e.target.value)}
            />
          </Field>
          <Field label="标准样例自测代码" full>
            <textarea
              className="prd-input"
              rows={5}
              value={testCode}
              onChange={(e) => setTestCode(e.target.value)}
              placeholder="填写可验证评分边界的标准样例"
            />
          </Field>
          {phase === 'opponent' && (
            <>
              <Field label="相反角色标准对手代码" full>
                <textarea
                  className="prd-input"
                  rows={5}
                  value={opponentCode}
                  onChange={(e) => setOpponentCode(e.target.value)}
                />
              </Field>
              <Field label="对手自测权重文件（环境包内材料引用，可选）" full>
                <input
                  className="prd-input"
                  value={opponentWeightFixture}
                  onChange={(e) => setOpponentWeightFixture(e.target.value)}
                  placeholder="例如 fixtures/defense.pt"
                />
              </Field>
            </>
          )}
        </div>
        <p className="prd-muted">
          基础题发布前需通过基础自测；攻防题需通过基线与单对手阶段自测，并完成环境清理。运行失败会显示实际原因。
        </p>
        <div className="prd-toolbar">
          <button
            type="button"
            className="prd-button"
            disabled={
              busy ||
              !value.evaluation.packageId ||
              (!!test && test.status !== 'completed') ||
              !testCode.trim()
            }
            onClick={selfTest}
          >
            运行自测
          </button>
          {test && (
            <span className="prd-muted">
              {test.status === 'queued'
                ? '排队中'
                : test.status === 'running'
                  ? '执行中'
                  : `已完成：${test.result?.status ?? '—'}`}
            </span>
          )}
        </div>
        {test?.result && (
          <div className="prd-notice">
            得分：{test.result.score ?? '—'} / {test.result.maxScore ?? '—'}
            <br />
            {test.result.publicMessage}
            <br />
            资源清理：{test.result.cleanupStatus ?? '—'}
          </div>
        )}
      </section>
      {notice && (
        <div className="prd-notice" role="status">
          {notice}
        </div>
      )}
      {error && (
        <div className="prd-error" role="alert">
          {error}
        </div>
      )}
    </>
  )
}
