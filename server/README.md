# 捎麦 · 服务端（Cloudflare Worker + D1）

看板服务端源码：单文件 `worker.js`（REST API + 看板页 + 轻量鉴权，全部内聚），数据存 Cloudflare D1（Serverless SQLite）。

## 看板地址

**https://shaomai.win** —— 已内置于 Skill 客户端，用户无需配置（自建部署说明后续补充）。

## 文件

| 文件 | 作用 |
|------|------|
| `worker.js` | 单文件后端：D1 建表 + REST API + 看板页面 |
| `wrangler.toml` | 部署配置（D1 绑定 `DB`） |
