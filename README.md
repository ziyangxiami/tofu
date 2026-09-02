# 豆伴

## 更新日志

### V0.13.0

进行深度重构，修复了大量因升级 Manifest V3 机制变化及豆瓣 API 反爬限制而导致的问题，恢复了插件的核心能力：

1. **Service Worker 运行异常与连接修复**：
   - 移除了由于 MV3 不支持 `import()` 动态加载和没有 `document` DOM 树而导致的 `import is disallowed on ServiceWorker` 崩溃。
   - 内置并打包了轻量级的 JS DOM 解释引擎以供后台刮取豆瓣网页页面。
   - 修复 Service Worker 休眠唤醒后 `onConnect` 监听未同步注册及 `options.html` 连接时 `port.sender.tab` 为空引发的 `Could not establish connection. Receiving end does not exist.` 致命报错。
2. **前后端代理消息瘫痪与 UI 失联修复**：
   - 修复了因为 `CustomEvent` 事件转发时篡改并覆盖原始拦截代理而导致前端出现满屏 `getProperty is not a function` 并让执行状态僵死无法加载报错及继续执行等界面顽疾。
   - 修复了服务日志传输被硬编码吞掉以及多层嵌套导致控制面板查无调试信息的问题。
   - 修复创建备份任务时 RPC 方法未异步序列化导致的 `DataCloneError: Promise/Object could not be cloned` 弹窗卡死问题，实现新建任务自动触发服务启动。
   - 优化控制面板“停止”按钮响应逻辑，点击停止后直接切换状态并立刻刷新 UI。
3. **HTML 解析器兼容性与数据抓取修复**：
   - 为后台 AST 节点补全 `.dataset` 属性 Getter 代理与 `DOMTokenList`（`classList`）`[Symbol.iterator]` 可迭代接口，彻底解决了 `TypeError: itemBody.classList is not iterable` 导致的豆列备份崩溃中断。
4. **彻底解决 418 与 1287 API 大量拒绝阻断问题**：
   - 后台 `fetch` 现在已经能够顺利跨域携带浏览器本地所有登陆凭证 (`credentials: 'include'`) 来攻克 `sec.douban.com` 爬虫反制封锁验证跳转请求了。
   - 修复了“影评抓取失败”、“广播由于游标分页参数错误永远只能抓取第一页”等逻辑陈年旧疾。
   - 利用 `declarativeNetRequest` 注入防盗链反制代理突破豆瓣新近针对扩展背景 `*.doubanio.com` 图片链接返回 418 I'm a Teapot 的拦截策略，缩略图再次照亮所有组件。
5. **全代码库深度审计与稳定性加固**：
   - 修复了所有任务模块（相册、日记、影音书剧游、笔记、豆邮、黑名单、关注/粉丝、留言板、豆列）中由于 AST 节点属性访问（如 `.src`、`.href`、`.alt` 等）缺失导致的潜在异常，统一采用 `getAttribute` 与安全链式访问。
   - 修复全部迁移（Migrate）任务类名与反序列化映射，修复 Dexie.js 倒序分页查询链与评论/笔记迁移发布逻辑。
   - 修复 Excel 导出器在字段缺失时的安全判空，增强异常捕获并确保加载遮罩在任何情况下正常关闭。
   - 增强 ServiceProxy 跨进程 RPC 在 Service Worker 休眠断开时的 Promise 异常处理，避免请求永久挂起。
   - 补充 `alarms` 与 Cloudinary 上传所需 host 权限，完善请求间隔配置与用户主页链接格式兼容。
6. **分页、数据一致性与任务恢复补充修复**：
   - 修复 Chrome 与 Edge 中广播备份完成第一页后停止的问题：统一 `max_id` 与广播 ID 的类型，正确跳过跨页重复项、持续保存分页游标，并增加游标停滞保护。
   - 修复相册照片、豆列条目复用父记录变量，导致相册或豆列主表被最后一个子项错误覆盖的问题。
   - 重构后台阻塞队列的可序列化状态，避免将 `Promise` 写入 `chrome.storage.session`；恢复时按完整 Job 而非单个 Task 反序列化。
   - 将“同步图片”延后到其他备份任务完成后运行，避免并发读取尚未写完的数据而漏同步图片。
   - 修复留言板无新消息时断点被重置、关注或粉丝归零时仍显示旧快照，以及登录检查未明确携带 Cookie 的边界问题。
   - 修复 Cloudinary context 特殊字符转义与空元数据兼容，避免图片同步因标题、描述等字段为空而中断。

### V0.13.0 验证范围

- 广播多页游标、跨页边界重复及重复页停滞回归测试。
- 相册/照片与豆列/条目父子记录写入回归测试。
- 后台队列 FIFO、阻塞唤醒、状态序列化和恢复测试。
- 关注/粉丝零数据快照测试。
- 全部非第三方 JavaScript 文件语法检查、Manifest JSON 校验及 Git diff 校验。
