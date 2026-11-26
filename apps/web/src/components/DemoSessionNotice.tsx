import { Link } from 'react-router-dom'

export default function DemoSessionNotice() {
  return (
    <main className="login-page sign-in-page">
      <section className="login-card sign-in-card" aria-labelledby="demo-session-title">
        <h1 id="demo-session-title">当前浏览器已登录正式账号</h1>
        <p className="sign-in-help">如需同时展示演示工作台，请用无痕窗口或另一个浏览器打开本网站的 /demo 地址。也可以先在工作台退出当前账号，再选择演示登录。</p>
        <Link to="/workspace">返回当前工作台</Link>
      </section>
    </main>
  )
}
