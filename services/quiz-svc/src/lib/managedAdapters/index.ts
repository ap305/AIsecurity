/**
 * 模型类六题 Managed Adapter
 * 每道题 blank 契约不同且 metrics 结构不同；提供符号校验与评分换算。
 * 六题 version.json 仍为 ready:false，未切换课堂。
 */
export type JudgeRole = 'solo_attack' | 'solo_defense'

export interface AdapterScore { score: number; status: 'passed' | 'failed'; note: string }
export interface ManagedAdapter {
  scenario: string
  requiredSymbols: Record<JudgeRole, string[]>
  score: (role: JudgeRole, metrics: Record<string, unknown>) => AdapterScore
}
function num(m: Record<string, unknown>, key: string, dft = 0): number {
  const v = m[key]; const n = Number(v); return Number.isFinite(n) ? n : dft
}
function bool(m: Record<string, unknown>, key: string): boolean {
  return m[key] === true || m[key] === 'true' || num(m, key) > 0
}
function deepGet(obj: unknown, path: string): unknown {
  let cur: unknown = obj
  for (const k of path.split('.')) {
    if (cur && typeof cur === 'object' && k in (cur as Record<string, unknown>)) cur = (cur as Record<string, unknown>)[k]
    else return undefined
  }
  return cur
}
const mnistBackdoor: ManagedAdapter = {
  scenario: 'mnist_backdoor',
  requiredSymbols: { solo_attack: ['def attack('], solo_defense: ['def defend('] },
  score: (role, m) => {
    if (role === 'solo_attack') {
      const ok = bool(m, 'attack_qualified')
      return { score: ok ? Math.round(100 * num(m, 'attack_score')) : 0, status: ok ? 'passed' : 'failed', note: `attack_qualified=${ok}` }
    }
    const ok = bool(m, 'defense_success')
    return { score: ok ? Math.round(100 * num(m, 'defense_score')) : 0, status: ok ? 'passed' : 'failed', note: `defense_success=${ok}` }
  },
}
const mnistPoison: ManagedAdapter = {
  scenario: 'mnist_poison',
  requiredSymbols: { solo_attack: ['def attack('], solo_defense: ['def defend('] },
  score: (role, m) => {
    if (role === 'solo_attack') {
      const ok = bool(m, 'attack_success')
      return { score: ok ? 100 : 0, status: ok ? 'passed' : 'failed', note: 'attack_success 达标=100（阈值换算后续细化）' }
    }
    const rec = num(m, 'recovery_rate'); const eff = num(m, 'effective_asr')
    const s = Math.round(Math.max(0, Math.min(100, 100 * rec - 100 * eff)))
    return { score: s, status: s > 0 ? 'passed' : 'failed', note: `recovery_rate=${rec} effective_asr=${eff}` }
  },
}
const watermark: ManagedAdapter = {
  scenario: 'watermark_image',
  requiredSymbols: { solo_attack: ['def attack('], solo_defense: ['def defense(', 'def detect('] },
  score: (role, m) => {
    if (role === 'solo_attack') {
      const am = deepGet(m, 'attack_metrics') as Record<string, unknown> | undefined
      const ok = am ? bool(am, 'attack_success') : false
      const strength = am ? num(am, 'attack_strength') : 0
      const s = ok ? Math.round(Math.min(100, 100 * strength / 0.4)) : 0
      return { score: s, status: s > 0 ? 'passed' : 'failed', note: 'watermark attack 口径待官方阈值对齐' }
    }
    const dm = deepGet(m, 'defense_metrics') as Record<string, unknown> | undefined
    const s = dm ? Math.round(100 * num(dm, 'detect_success_rate_id_d0')) : 0
    return { score: s, status: s > 0 ? 'passed' : 'failed', note: 'watermark defense' }
  },
}
const patch: ManagedAdapter = {
  scenario: 'patch_attack',
  requiredSymbols: { solo_attack: ['class GradientPatchAttack'], solo_defense: ['class ResNet18Classifier'] },
  score: (role, m) => {
    if (role === 'solo_attack') {
      const ok = bool(m, 'attack_qualified')
      return { score: ok ? Math.round(100 * Math.min(1, num(m, 'attack_attack_score_base'))) : 0, status: ok ? 'passed' : 'failed', note: `attack_qualified=${ok}` }
    }
    const ok = bool(m, 'defense_qualified')
    return { score: ok ? Math.round(100 * num(m, 'defense_defense_score')) : 0, status: ok ? 'passed' : 'failed', note: '防御训练耗时未解决前不启用' }
  },
}
const deepfakeImage: ManagedAdapter = {
  scenario: 'deepfake_image',
  requiredSymbols: { solo_attack: ['class JPEGReencodeAttack'], solo_defense: ['class Defense'] },
  score: (role, m) => {
    if (role === 'solo_attack') {
      const ok = bool(m, 'qualified')
      return { score: ok ? Math.round(100 * num(m, 'mean_asr')) : 0, status: ok ? 'passed' : 'failed', note: `qualified=${ok}` }
    }
    const s = Math.round(100 * num(m, 'defense_score'))
    return { score: s, status: s > 0 ? 'passed' : 'failed', note: `defense_score=${s / 100}` }
  },
}
const deepfakeAudio: ManagedAdapter = {
  scenario: 'deepfake_audio',
  requiredSymbols: { solo_attack: ['class CodecAttack'], solo_defense: ['class Defense'] },
  score: (role, m) => {
    const pa = deepGet(m, 'per_attack') as Array<Record<string, unknown>> | undefined
    if (role === 'solo_attack' && Array.isArray(pa) && pa.length > 0) {
      const vals = pa.map((x) => num(x, 'AttackScore', 0))
      const s = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length)
      return { score: s, status: s > 0 ? 'passed' : 'failed', note: `mean AttackScore=${s}` }
    }
    if (Array.isArray(pa) && pa.some((x) => 'DefenseScore' in x)) {
      const vals = pa.map((x) => num(x, 'DefenseScore', 0))
      const s = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length)
      return { score: s, status: s > 0 ? 'passed' : 'failed', note: `mean DefenseScore=${s}` }
    }
    // audio 防御文件 per_attack 只含 AttackScore（攻击成功率视角）；防御成绩按 robust.EER/AUC 兜底
    const robust = deepGet(m, 'robust') as Record<string, unknown> | undefined
    const auc = robust ? num(robust, 'AUC', -1) : -1
    if (auc >= 0) {
      const s = Math.round(100 * auc)
      return { score: s, status: s > 0 ? 'passed' : 'failed', note: `robust AUC=${auc}` }
    }
    const eer = robust ? num(robust, 'EER', 1) : 1
    const s = Math.round(100 * (1 - Math.min(1, eer)))
    return { score: s, status: s > 0 ? 'passed' : 'failed', note: `EER=${eer}` }
  },
}
const ADAPTERS: Record<string, ManagedAdapter> = Object.fromEntries(
  [mnistBackdoor, mnistPoison, watermark, patch, deepfakeImage, deepfakeAudio].map((a) => [a.scenario, a]),
)
export function getAdapter(scenario: string): ManagedAdapter | undefined { return ADAPTERS[scenario] }
export default ADAPTERS
