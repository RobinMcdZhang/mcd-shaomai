# workbuddy.md —— 捎麦（Shaomai）· WorkBuddy 开发上下文导出

## 1. 项目一句话

办公室场景下的麦当劳「拼车取餐」工具：一个人当**发车人**去餐厅取餐，同楼同事凭 6 位单号**上车**顺带，各自在麦当劳 MCP 下自己的单，取餐码自动汇总到看板，司机一次取齐、按昵称分发。

- 本质是**取餐物流拼单，不是付款拼单**：每人独立 Token、独立下单、独立付款。
- 技术形态：WorkBuddy Skill（`skill/`）+ 轻量共享协调后端（Cloudflare Worker + D1 单文件，`server/`），自带看板。
- 线上服务：<https://shaomai.win>（默认公共服务，后端地址已内置于 skill，用户零配置）。
- 开源仓库：<https://github.com/RobinMcdZhang/mcd-shaomai>（MIT）。

---

## 2. WorkBuddy 使用证据

| 项 | 数据 |
| --- | --- |
| 开发周期 | 2026-10-19 ～ 2026-10-20（约 2 天） |
| 用户指令 | 54 条（含需求提出、方案质疑、技术选型、迭代调整） |
| 助手回复 | 约 297 条文本消息 |
| 工具调用 | 约 817 次（文件读写 231 次、命令执行、联网检索等） |
| 使用模式 | Agent 模式为主（用户授权下直接读写文件、执行命令、联网） |
| 典型协作方式 | 用户定方向 → WorkBuddy 出方案 → 用户拍板 → WorkBuddy 落地 → 自测验证 → 用户验收 |

---

## 3. 开发时间线（对话上下文）

### 10-19 18:08 策划期 · 需求提出

> 用户：「麦当劳出了一个 mcp，这是官方文档：<https://open.mcd.cn/mcp/doc>。现在使用这个 mcp 我想做一款麦当劳堂食顺带的 skill，你来帮我策划方案……」

WorkBuddy 动作：

1. 抓取并解析麦当劳官方 MCP 文档，梳理 33 个工具的能力边界（地址查询、门店查询、下单、订单查询四类是可用核心）。
2. 产出 `捎麦_策划方案.md`：确定「发车人 / 上车 / 顺路单 / 盯码推看板」产品形态与楼栋匹配（初版 geohash）方案。

### 10-19 18:33 架构质疑

> 用户：「从 skill 的通用概念来说，这个 skill 还需要依赖一个特定的服务端（看板）来进行协同，是否不太合适？」

WorkBuddy 论证后确认：多人协同必须有一个共享状态源，服务端合理；边界定为**读操作全开放、写操作轻量鉴权**，并给出隐私最小化原则（只暴露楼栋标签 + 昵称 + 楼层）。

### 10-19 18:46 技术选型

> 用户：「我倾向于使用 cloudflare worker……有提供免费的数据库吗？此外，对于是否顺带的距离的计算，是否需要调用外部地图接口来做？」

结论：**Cloudflare Worker + D1（SQLite）**，零地图 API、零第三方密钥。

### 10-19 18:59 关键设计变更

> 用户：「……用户上车的时候，能否把用户的收餐地址和团长的收餐地址，一起给 llm 判断，是否能够顺带。这样可以吗？」

方案从 geohash 经纬度匹配改为：**同店硬约束 + LLM 比较双方收餐地址文本给「软建议」**，发车人最终决定。避免采集坐标、避免地图 API。

### 10-19 19:53 ～ 23:24 Phase 1-4 落地

> 用户：「好的，开始 phase1。文件尽量合成单文件实现」/「接着开」/「轮询放快一点，放到 10 秒钟一次」/「Phase4 先不做发车确认，也暂不接入地理编码……快速上线小范围试跑」/「不需要本地的服务端，我会放到 worker 去部署来试用」

WorkBuddy 动作：

1. **Phase 1**：单文件 `worker.js`（D1 建表 + REST + 看板页全部内聚）+ `wrangler.toml`；用 Node 测试桩 mock D1 跑通 14 项路由测试，全绿。
2. **Phase 2/3**：Skill 主文件（`SKILL.md`）+ 零依赖客户端 `shaomai_client.py`（Python 标准库，子命令 create/active/get/join/code/status/leave/kick/watch）+ mcp 连接配置。
3. **盯码**：`query-order` 轮询间隔按用户要求定为 10 秒（6 次/分，远低于 MCP 600 次/分上限）。
4. 范围收敛：Phase 4 发车确认、地理编码按用户要求暂不做，先小范围试跑。

### 10-19 23:43 ～ 10-20 00:51 命名与部署

> 用户：「这个项目的名称，从麦捎 该成 捎麦」「shaomai-coordination 这个前缀太长了，能否改成 shaomai-mcd」「之前我已经执行 wrangler deploy 部署了一次……重新执行部署。看看有没有问题」

WorkBuddy 全量改名（麦捎 → 捎麦、前缀 → shaomai-mcd），用户删除旧 Worker 后重新 `wrangler deploy` 成功。

### 10-20 00:51 ～ 04:34 后端迁移探索

> 用户：「cloudflare worker 的访问由于一些原因无法访问。能否使用腾讯云的免费方案替代？」→「整体方案能否使用阿里云的免费服务来做服务端……我要出去一会儿，不在电脑前」→「阿里云的访问 URL 是否有中间页？或者需要备案什么的要求？」→「我们还是回到使用 cloudflare worker 来部署」

WorkBuddy 先后产出两套备选后端（`tcb/` CloudBase 版、`shaomai2/` 阿里云 FC 版），用户实测 CloudBase 可部署；最终因访问体验与备案问题**收敛回 Cloudflare Worker**，两套备选代码随后按用户要求全部删除。Cloudflare 访问问题的根因后来定位为 **Bot 校验拦截默认 UA**，客户端加自定义 UA 后解决。

### 10-20 01:08 防滥用设计

> 用户：「这个发车的功能，需要让 skill 在用户使用过程中直接和服务端自动交互……初步想法是需要从服务端先取一个号……后续用户发车带上这个号作为一种轻量鉴权……加入拼车的 mcp，一并考虑如何防止滥用。看板的读操作基本都开放，只有发车、加入拼车、写取餐码这些写操作，才要考虑滥用问题。」

WorkBuddy 落地**能力令牌模型**：`POST /api/ticket` 领一次性票据（userId + IP 双限流、一票一单、TTL 10 分钟）；create 返回 `driverSecret`、join 返回 `memberSecret`；推码/自退需成员密钥、状态流转/踢人需司机密钥；写接口叠加 IP 限流。防滥用逻辑完整移植进最终版 worker.js（31 条 SQL 逐字校验 + 真实 SQLite 业务流程验证）。

### 10-20 16:36 ～ 17:16 目录整理与开源

> 用户：「现在我们做一下目录的整理……建个 server 目录……建个 skill 目录……再建个 github 目录，里面放部署的脚本」→「token 已经写入，不过仓库我手动建好了。脚本改一下我来进行发布」→「<https://shaomai.win/> 作为默认的协同服务，这个地址也写入到 git 仓库的说明中」

WorkBuddy 交付三分层结构：`server/`（服务端源码）、`skill/`（可分享 Skill）、`github/`（发布工具链 `publish.sh`，离线演练验证仅 9+2 个文件进仓库、无 Token 无密钥）。用户手动建仓 `RobinMcdZhang/mcd-shaomai` 后自行执行发布。

### 10-20 18:46 ～ 21:20 推广、参赛与修复

> 用户：「帮我针对几种场景下，推广这个 skill 的话术。场景不能少于 5 个」→「帮我草拟一下参赛申请说明」→「参赛失败了：您的 GitHub 项目中缺少【README.md/参赛申明/MCP说明】……」

WorkBuddy 交付 7 个场景推广话术、参赛申请草稿；按官方活动要求补齐 `CONTEST_DECLARATION.md`（官方原件未改动）与 `MCP_INTEGRATION.md`（MCP Server/Tool/调用流程/业务价值），更新发布脚本把参赛文件纳入仓库根，离线演练确认文件树干净。

---

## 4. 关键技术决策记录

| # | 决策点 | 结论 | 理由 |
| --- | --- | --- | --- |
| 1 | 服务端形态 | Cloudflare Worker + D1，单文件 `worker.js` | 免费额度够用、零运维；增删改查性能需求不大 |
| 2 | 楼栋/顺带判定 | 同店硬约束 + LLM 比较收餐地址（软建议） | 用户明确拒绝经纬度采集；mcp 按 IP 取的地址误差大 |
| 3 | 地图能力 | 不接入外部地图 API | 省密钥、省配额，判定交 LLM |
| 4 | 盯码间隔 | 10 秒/次 | 用户要求「放快一点」；6 次/分远低于 MCP 600 次/分上限 |
| 5 | 防滥用 | 一次性票据 + 司机/成员双密钥 + IP 限流；读开放 | 用户提出「先取号再发车」的轻量鉴权思路 |
| 6 | 隐私边界 | 跨用户只暴露楼栋标签 + 昵称 + 楼层 + 取餐码 | 完整门牌/电话不进看板与接口响应 |
| 7 | 部署形态 | 不上本地服务端，直接上 Worker | 用户决定，便于小范围试跑 |
| 8 | 命名 | 麦捎 → 捎麦；前缀 → shaomai-mcd | 用户要求；口播品牌统一为「麦麦」，事实引用保留「麦当劳」 |
| 9 | 开源结构 | `server/` + `skill/` + `github/` 三层 | 服务端、可分发的 Skill、发布工具链职责分离 |
| 10 | 客户端 UA | 必须带自定义 UA | urllib 默认 UA 被 Cloudflare 浏览器签名检测拦截（403） |
| 11 | 后端配置 | `DEFAULT_BACKEND = "https://shaomai.win"` 内置，环境变量仅作可选覆盖 | 用户要求「零配置即用」，降低开源使用门槛 |
| 12 | 备选后端 | CloudBase / 阿里云 FC 各写一套后删除 | 迁移探索的中间产物，最终收敛 Cloudflare |

---

## 5. 最终产物清单

```
skill/                    # 可分发的 WorkBuddy Skill
├── SKILL.md              #   意图流程 / 盯码 prompt / 防滥用说明
├── shaomai_client.py     #   零依赖后端客户端（Python 标准库）
└── README.md             #   安装与使用说明
server/                   # 协调后端（Cloudflare Worker + D1）
├── worker.js             #   REST API + 看板页 + 轻量鉴权，单文件内聚
├── wrangler.toml         #   部署配置（D1 绑定）
├── .gitignore
└── README.md             #   部署指南
github/                   # 发布工具链（不进仓库）
├── publish.sh            #   组装并强制推送到 GitHub
├── REPO_README.md        #   发布后为仓库根 README.md
├── CONTEST_DECLARATION.md#   官方参赛声明原件
├── MCP_INTEGRATION.md    #   MCP 集成说明
├── LICENSE / .gitignore / README.md
└── token.txt（本地，已被 .gitignore 排除）
```

---

## 6. 脱敏说明

本导出为**整理版对话上下文**（非原始记录转储），已做如下处理：

**已移除**

- GitHub Personal Access Token：开发过程中从未在对话出现，仅在本地 `token.txt` 中由发布脚本运行时读取；本文件不含任何 Token。
- 麦当劳 MCP Token：同样未在对话出现，连接配置中只使用 `Bearer YOUR_MCP_TOKEN` 占位符。
- 云厂商账号邮箱（Cloudflare 登录邮箱）。
- 已删除的 CloudBase 环境 ID、D1 数据库 ID 等云资源标识。
- 内网 IP 地址（属于本机其他项目的测试环境）。
- 官方 MCP 文档示例数据中的测试手机号。
- 用户身份文件内容（SOUL.md / IDENTITY.md / USER.md 等个人档案）。
- 工具回执中的大段中间输出（构建日志、文档全文等）。

**保留（均为公开信息或核验必要）**

- 公开仓库地址：<https://github.com/RobinMcdZhang/mcd-shaomai>
- 公开服务地址：<https://shaomai.win>
- 麦当劳官方 MCP 文档地址：<https://open.mcd.cn/mcp/doc>
- WorkBuddy 会话 ID（用于核验开发过程确由 WorkBuddy 完成）。
- 用户指令原文摘录与技术决策记录。
