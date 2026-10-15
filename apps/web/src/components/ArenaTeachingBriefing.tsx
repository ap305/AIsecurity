import type { QuestionRecord } from '../lib/prdApi'
import { arenaScoringRules, getArenaTeaching } from '../lib/arenaTeaching'

function TeachingList({ title, items }: { title: string; items: readonly string[] }) {
  return (
    <section className="arena-teaching-section">
      <h4>{title}</h4>
      <ul>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </section>
  )
}

export default function ArenaTeachingBriefing({ question }: { question: QuestionRecord }) {
  const teaching = getArenaTeaching(question)
  if (!teaching) return null
  const roleLabel = teaching.role === 'attack' ? '攻击' : '防御'
  return (
    <details className="arena-teaching prd-markdown" open>
      <summary>
        {teaching.scenario.title} · {roleLabel}教学简报
      </summary>
      <p>{teaching.scenario.summary}</p>
      <section className="arena-teaching-section">
        <h4>本题目标</h4>
        <p>{teaching.objective}</p>
      </section>
      <TeachingList title="场景与公开环境" items={teaching.environment} />
      <TeachingList title="输入与调用接口" items={teaching.input} />
      <TeachingList title="需要返回或完成的操作" items={teaching.output} />
      <TeachingList title="实现约束" items={teaching.constraints} />
      <TeachingList title={`当前版本 ${question.revision} 的计分规则`} items={arenaScoringRules(question)} />
      <TeachingList title="资料怎么用" items={teaching.resourceHints} />
      <p className="prd-muted">详细数据格式、材料要求和运行配置见下方完整题面与当前代码模板。</p>
    </details>
  )
}
