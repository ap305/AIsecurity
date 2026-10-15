import { Link } from 'react-router-dom'
export default function Help() {
  return (
    <div className="prd-page">
      <h1>使用帮助</h1>
      <section className="prd-panel">
        <h2>基础任务</h2>
        <p>
          在<Link to="/">任务大厅</Link>选择基础题，阅读左侧 Markdown
          题面，在右侧代码模板中完成填空。按题目要求上传本地训练的参数文件，再点击提交评测。
        </p>
        <p className="prd-muted">
          提交后可查看评测进度与本人历史，刷新页面不会丢失已受理任务。只有严格提高题目最高分的有效提交才更新基础总分；相同或较低分数不改变排行榜。
        </p>
      </section>
      <section className="prd-panel">
        <h2>攻防任务</h2>
        <p>
          在<Link to="/arena">对战大厅</Link>
          直接选择攻击题或防御题，进入后角色固定。达到基线门槛（大于等于）后，与其他用户相反角色的有效算法对抗。
        </p>
        <p className="prd-muted">
          成绩是成功人数占有效对手人数的百分比。零有效对手正式记 100%，正常全败可为
          0%。候选版本完整评测并产生正式成绩后才替换旧版本；异常或未完成保留旧有效版本。新增有效算法会触发动态重评，更新中显示上次正式成绩。
        </p>
      </section>
      <section className="prd-panel">
        <h2>蒸馏与模型配置</h2>
        <p>
          题目启用临时教师 API
          时，点击开启。服务可用且租约生效后开始两小时计时；到期后手动续期，刷新页面不会续期。通过本人临时链接和凭证获取训练数据，在自己的设备上训练模型。
        </p>
        <p className="prd-muted">
          Agent 评测模型由出题人从平台 API 池固定选择。学生无需填写平台密钥、API 地址或自选大模型。
        </p>
      </section>
      <section className="prd-panel">
        <h2>排行榜与资料</h2>
        <p>
          <Link to="/leaderboard">排行榜</Link>
          只统计基础题最高分之和，同分时先达到当前总分者在前。攻防成就将在规则确定后开放。大学学号和手机号当前均为选填，可在
          <Link to="/profile">个人资料</Link>自愿补全。
        </p>
      </section>
    </div>
  )
}
