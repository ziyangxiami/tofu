# 豆伴

## 更新日志

### V0.13.0

进行深度重构，修复了大量因升级 Manifest V3 机制变化及豆瓣 API 反爬限制而导致的连环 Bug，终极修复版恢复了插件所有的核心能力：

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