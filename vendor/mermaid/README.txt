# Mermaid 渲染器（已安装）

本目录的 `mermaid.min.js` 已就位：**mermaid v11.16.1** 官方 `dist/mermaid.min.js`
（经典 script 构建，MIT 协议），来源：用户下载的 npm 包
`mermaid-11.16.1.tgz`（`package/dist/mermaid.min.js`，3,565,917 字节）。

加载机制：阅读器打开包含 ```mermaid 代码块的文档时，客户端先探测
`/md-reader/assets/mermaid/mermaid.min.js`（HEAD → GET 回退），存在则注入
`<script>` 标签，加载完成后以 `securityLevel: 'strict'` 沙箱渲染，主题自动跟随
Web GUI 的 `body[data-ds-dark-theme]` 明暗标记；文件缺失时优雅降级为带说明的
源码块（无控制台报错）。

已验证（`node test/mermaid-e2e.mjs`）：
- 经典 script 语义加载 → `globalThis.mermaid` 就位
- `initialize` / `render` / `parse` API 齐全
- `initialize({ startOnLoad: false, securityLevel: 'strict', theme })` 兼容
- `parse('graph TD; ...')` → `diagramType = flowchart-v2`
（SVG 渲染需要真实浏览器 DOM，请在 GUI 中验证）

升级方法：用新版包里的 `dist/mermaid.min.js` 覆盖本文件即可。
