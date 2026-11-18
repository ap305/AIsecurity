import { Link } from 'react-router-dom'
export default function Help() {
  return (
    <div className="prd-page">
      <h1>使用帮助</h1>
      <section className="prd-panel">
        <h2>基础任务</h2>
        <p>
          在<Link to="/">基础题库</Link>选择基础题，阅读左侧 Markdown
          题面，在右侧代码模板中完成填空。按题目要求上传本地训练的参数文件，再点击提交评测。
        </p>
        <p className="prd-muted">
          提交后可查看评测进度与本人历史，刷新页面不会丢失已受理任务。只有严格提高题目最高分的有效提交才更新基础总分；相同或较低分数不改变排行榜。
        </p>
      </section>
      <section className="prd-panel">
        <h2>攻防任务</h2>
        <p>
          在<Link to="/arena?role=attack">攻击题库</Link>或<Link to="/arena?role=defense">防御题库</Link>
          选择题目，进入后角色固定。达到基线门槛（大于等于）后，与其他用户相反角色的有效算法对抗。
        </p>
        <p className="prd-muted">
          成绩是成功人数占有效对手人数的百分比。零有效对手正式记 100%，正常全败可为
          0%。候选版本完整评测并产生正式成绩后才替换旧版本；异常或未完成保留旧有效版本。新增有效算法会触发动态重评，更新中显示上次正式成绩。
        </p>
      </section>
      <section className="prd-panel">
        <h2>蒸馏与模型配置</h2>
        <p>
          题目启用教师模型 API（蒸馏专用）
          时，点击开启。服务可用且租约生效后开始两小时计时；到期后手动续期，刷新页面不会续期。通过本人临时链接和凭证获取训练数据，在自己的设备上训练模型。
        </p>
        <p className="prd-muted">
          Agent 评测模型由出题人从平台 API 池固定选择。学生无需填写平台密钥、API 地址或自选大模型。
        </p>
      </section>
      <section className="prd-panel">
        <h2>班级与教学空间</h2>
        <p>
          学生在<Link to="/classes">我加入的班级</Link>使用邀请码加入班级。加入班级不会转移账号、提交或成绩。
        </p>
        <p>
          教师使用同一个师生登录入口，由平台管理员授予教学权限后，可切换到教学空间管理自己的班级、查看成员成绩与提交，以及发布标准题解。学生仍在练习空间完成题目。
        </p>
        <p className="prd-muted">
          教师不能管理其他教师的班级，也不能重置账号密码。撤销教师权限后，班级、成员和历史成绩保留；所有管理操作由服务端重新校验权限。
        </p>
      </section>
      <section className="prd-panel">
        <h2>题解与我的讲解</h2>
        <p>
          在题目中进入题解页面，查看标准题解、优秀用户题解，并按页面提示公开自己的题解。公开前请确认代码中不含密钥、个人信息或不应公开的内容。
        </p>
        <p>
          教师在教学空间的“我的讲解”集中查找和编辑自己发布的标准题解。标准题解是教学材料；评测使用的参考算法以题目评测配置为准。
        </p>
      </section>
      <section className="prd-panel">
        <h2>登录与密码恢复</h2>
        <p>
          学生和教师均选择“师生登录”，管理员使用“管理员登录”。忘记密码时，可通过已验证的绑定邮箱找回，或联系平台管理员核验身份后人工恢复；授课教师没有密码管理权限。
        </p>
        <p className="prd-muted">教师模型 API（蒸馏专用）用于题目训练数据，与账号的教师授权无关。</p>
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
