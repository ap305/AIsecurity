# 2026-11-13 独立安全与兼容性复核

范围：本次三来源题解的实际基线读取，以及现存非邮件依赖告警的代码可达性。此记录基于当前代码与本地隔离测试，不代表已部署或完成生产压力测试。Nodemailer 的升级与邮件测试另行记录。

## JSON 请求兼容性变化

服务端 `express.json` 仍限制 2 MiB，新增 `inflate: false`。从本次版本起，带非 identity `Content-Encoding` 的 JSON 请求体不再接受，返回 HTTP 415、业务码 41501 和固定中文提示；客户端应发送未压缩 JSON。注册、登录和其他 JSON API 的客户端不应添加 gzip/deflate 请求压缩。

此配置使用 body-parser 维护者公布的绕过解压流的缓解方式，针对默认解压分支可能被尾随压缩字节终止进程的问题。[维护者公告](https://github.com/expressjs/body-parser/security/advisories/GHSA-27r3-jxmh-p828)

代码核查显示现有浏览器 API 客户端、题目导入/校准/验收 CLI 使用 `JSON.stringify` 发送未压缩 JSON；模型参数 ZIP 和题包压缩文件使用 multipart 上传，因此不经过 JSON 解压分支。没有修改 multipart 处理、普通字段校验或原有 400/500 错误映射。

`compressedJson.integration.test.ts` 覆盖普通 gzip、带尾随字节的 gzip 均固定 415、其后健康检查与普通注册登录正常、原有语法/超限 400 与通用 500 保持、multipart ZIP 到达正常题目校验且没有创建提交或评测任务。测试仅使用临时数据库、测试账号和本地监听，无真实模型或邮件。

## 实际评测基线读取

独立复核 `publishedReferences.ts` 和 `questionSolutions.ts` 的读取路径，未发现阻断问题：

- 只从管理员预先审核发布的目录读取按题目 ID 哈希命名的资料；请求不能指定题包文件路径。源码相对路径经过现有题包路径验证，逐层拒绝符号链接，题包目录也拒绝链接。
- 当前题目 revision、evaluationVersion、原始 definition 摘要、packageId、题包文件清单摘要、各选定源码摘要以及发布代码摘要均必须匹配。不匹配、缺失或格式错误只显示固定提示，不返回路径、私有源码、摘要和异常堆栈。
- 返回字段采用公开字段白名单；代码来自已审核发布资料，读取源码只用于摘要校验。此流程不调用保存题目、修改评分、提交或执行代码。旧版本资料不会作为新版本基线显示。
- 手工标准题解仍标为教师补充讲解，实际资格基线具有独立标记。不能把教师文本当作已校准评测基线。

新增独立 `publishedReferences.security.test.ts` 验证路径穿越、Windows 路径、重复来源、资料/元数据/源码体积上限和来源数量上限，并验证题包目录与源码中间目录的 junction 即使指向摘要正确的文件也会拒绝。与现有绑定/旧版本测试合计 6 项通过。Windows 沙箱禁止创建 junction；相同用例在授权本机临时目录执行通过，不需修改线上文件。

运行边界：管理员发布目录和题包存储必须由可信部署方管理。摘要能检查发布物与冻结版本的一致性，不能取代管理员对 AST 节选内容的审核；运行时不会重新执行 AST 提取。当前每次题解读取都重新核对文件，资料上限 1 MiB、元数据 512 KiB、最多 24 个源码各 2 MiB，理论额外磁盘读取上限约 49.5 MiB，位于 15 秒数据库事务内。未来发布大量大源码时，应考虑总字节预算或绑定版本的缓存以减少数据库连接占用；本次未增加缓存，也未进行并发压力测试。特殊文件或目录被本机管理员并发替换不属于普通用户可写边界。

## 其余已有依赖告警

以下结论是对现有调用链的只读判断，不能理解为已升级依赖或扫描结果清零。新增调用方式或部署配置变化时需要重新判断。

| 依赖告警 | 当前代码判断 |
| --- | --- |
| [proxy-addr IPv4 映射地址信任问题](https://github.com/jshttp/proxy-addr/security/advisories/GHSA-jqcg-44mw-7w3h) | 未配置 Express `trust proxy`；登录节流读取 `req.socket.remoteAddress`，不使用 `req.ip` 或转发头。未发现受影响信任子网分支可达。 |
| [qs bracket/comma 数组上限绕过](https://github.com/ljharb/qs/security/advisories/GHSA-x5fp-wj9c-mxmx) | 所安装 qs 默认 `comma:false`；Express extended query parser 仅设置 `allowPrototypes:true`，应用未启用 comma 解析或 urlencoded middleware。该公告所需 comma 条件不成立。 |
| [qs isBuffer](https://github.com/ljharb/qs/security/advisories/GHSA-4mjr-xmp4-gh2g)、[qs comma stringify](https://github.com/ljharb/qs/security/advisories/GHSA-6pq8-jhm2-2vcw) | 未发现将不可信对象传入 `qs.stringify` 的应用调用；现有 JSON 返回使用 JSON 序列化。未发现公告中的 stringify 触发链。 |
| [React Router 反斜线外跳](https://github.com/remix-run/react-router/security/advisories/GHSA-wrjc-x8rr-h8h6)、[开放跳转/XSS](https://github.com/remix-run/react-router/security/advisories/GHSA-jjmj-jmhj-qwj2) | 登录 returnTo 经过 `safeReturnTo`，拒绝协议相对地址、反斜线、控制字符及重复编码分隔符；返回题库限定同源根路径/arena。其他动态题目路径使用固定前缀和编码 ID。未发现新功能接受任意不可信跳转目的地址。 |
| [React Router SSR hydration 构造器注入](https://github.com/remix-run/react-router/security/advisories/GHSA-337j-9hxr-rhxg) | 当前客户端使用 `createRoot` 与 `BrowserRouter`，没有 SSR hydration/data router 错误反序列化路径。 |
| [KaTeX 既有原型污染绕过 trust](https://github.com/KaTeX/KaTeX/security/advisories/GHSA-238p-pmpm-9mq7) | 公告依赖先发生原型污染。旧题面渲染仍包含受影响的传递依赖，未发现本次功能引入前置污染路径；用户题解仅用 remarkGfm，不运行 KaTeX。保留后续依赖维护事项，不声明风险已消除。 |

验证命令：后端 `compressedJson.integration.test.ts`、`authSecurity.integration.test.ts` 与 `http.integration.test.ts` 联跑 33/33；`publishedReferences.test.ts` 与新安全测试 6/6；`pnpm --filter quiz-svc exec tsc --noEmit` 通过。完整项目回归由本次集成记录汇总，以上不是全项目测试总数。
