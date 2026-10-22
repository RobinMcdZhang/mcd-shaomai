---
name: shaomai
description: 麦麦堂食顺带「捎麦」——办公室场景下，一个人当发车人去餐厅取餐，同楼同事「上车」顺带、由看板聚合的拼单取餐协调。当用户说「捎麦 / 发车 / 顺路单 / 上车拼一份 / 麦当劳拼单 / 谁在发车 / 帮我顺带 / 顺带一份麦当劳」时使用。依赖用户个人的 mcd-mcp（麦当劳 Token）与一个共享协调后端（后端地址已内置于本 skill，无需用户配置；由本 skill 自带的 shaomai_client.py 调用）。
agent_created: true
---

# 捎麦 · 麦麦堂食顺带协调 Skill

## 0. 这是什么

一句话：**把麦麦堂食做成办公室「拼车」**——一个人当司机去取，顺路帮同楼同事把餐带回来分发。

本质是**取餐物流的拼单，不是付款拼单**：每人各自在麦当劳 MCP 下自己的单、各自付款，司机只负责去一次餐厅、凭各自的取餐码把全车人的餐一次性取走、回办公室按昵称分发。

> 关键约束（来自官方 MCP 文档）：麦当劳 MCP 每人独立账户、无跨用户拼单能力。所以「组团顺带」的协调逻辑由共享后端负责，MCP 只管个人下单/取餐码。

## 1. 接入前提（必须确认，否则直接执行会失败）

1. **mcd-mcp 已配**：用户 WorkBuddy 的 `~/.workbuddy/mcp.json` 含 `mcd-mcp` 且已填入用户**本人**的麦当劳 MCP Token（去 open.mcd.cn 申请）。未配则提示用户先配。
2. **后端无需配置**：后端地址已随本 skill 内置，直接用即可。
3. **可选环境变量**：
   - `SHAOMAI_USER` / `SHAOMAI_USER_SALT`：稳定匿名 ID 种子（默认取系统用户，跨会话稳定）。

若任一不满足，先提示用户补齐，不要硬跑。

## 2. 核心概念（务必理解再执行）

- **发车人（团长/司机）**：第一个下单、去餐厅取餐并分发的人。
- **乘客（捎客）**：上车顺带的人。
- **顺路单 / 捎单**：一次行程 = 一个 `trip`，用 6 位单号（`code`）标识。
- **同店硬约束**：一个 trip 锚定一个门店（`storeCode`）。所有乘客上车时门店**必须与发车单一致**——这是「取餐能一次取齐」的前提，Skill 必须自动锁定。
- **LLM 软判定顺带**：在「同店」前提下，把发车人 `officeLabel` 与乘客 `returnLabel` 交 LLM 判断「顺带/可能不顺路」，结果**只作建议**，最终由发车人截单时确认。**绝不做自动拒绝的硬门槛**（LLM 对文本地址的精确米数不可靠）。
- **状态链**：`RECRUITING 发车中 → CLOSED 已截单 → PICKING_UP 取餐中 → DELIVERING 送达分发中 → DONE 完成`。满员自动截单。
- **团长支付状态**：发车时带 `--order` 记录团长自己的订单号，该单进入 **15 分钟支付倒计时**；超时未支付则**自动从看板隐藏**（看板上以「团长待支付 · 剩 N 分钟」标签提示）。团长付款后用 `pay` 标记已支付。
- **有效期**：默认 **2 小时**（`--ttl` 可调，10 分钟 ~ 12 小时）。**必须覆盖到出发时刻**——旧版固定 30 分钟，导致「11:30 出发」的单在 09:57 就消失，用户完全看不到。过期单从看板隐藏。
- **先查后发**：发车前必须先 `active --store <storeCode>` 查该门店在途单；同店已有车就加入别人的车，别重复发车。

## 3. 客户端调用约定（所有后端交互走它）

本 skill 自带 `shaomai_client.py`（标准库零依赖），**用绝对路径调用**（位于本 skill 目录下）。输出统一为 JSON，便于解析。

```bash
# 发车：发一个顺路单（--order 带上团长自己的订单号，启动 15 分钟支付倒计时）
# --ttl 有效期（分钟），必须覆盖到出发时刻；默认 120
python <skill_dir>/shaomai_client.py create --name 阿强 --office "软件大道XX大厦A座" \
    --store MCD001 --store-name "麦当劳(XX店)" --max 6 --note "12:30出发" \
    --order <orderId> [--paid] [--ttl 180]

# 查该门店是否已有在途顺路车（发车前必做：先查后发）
python <skill_dir>/shaomai_client.py active --store MCD001

# 在途单（发车中）
python <skill_dir>/shaomai_client.py active

# 详情
python <skill_dir>/shaomai_client.py get <CODE>

# 上车
python <skill_dir>/shaomai_client.py join <CODE> --name 小李 \
    --return-label "软件大道XX大厦B座" --order <orderId可选>

# 推取餐码 / 柜码
python <skill_dir>/shaomai_client.py code <CODE> <MEMBER_ID> --pickup A1B2 --locker 8848

# 改状态（发车人）
python <skill_dir>/shaomai_client.py status <CODE> CLOSED|PICKING_UP|DELIVERING|DONE

# 团长标记自己的订单已支付（取消 15 分钟倒计时，自动带 driverSecret）
python <skill_dir>/shaomai_client.py pay <CODE> [--order <orderId>]

# 下车 / 取消
python <skill_dir>/shaomai_client.py leave <CODE> <MEMBER_ID>

# 踢人（发车人，需 driverSecret）
python <skill_dir>/shaomai_client.py kick <CODE> <MEMBER_ID>

# 后台盯码（Phase 3）：每 10 秒跑一次 --check，出码自动推看板后退出
#   --check 输出取餐码文本，或 JSON {"pickupCode":"A1B2","lockerCode":"8848"}
python <skill_dir>/shaomai_client.py watch <CODE> <MEMBER_ID> \
    --check "python mcd_query.py <orderId>" --interval 10
```

> **轻量鉴权（防滥用）**：`create` 会自动先 `POST /api/ticket` 领取一次性发车票据（服务端限流发放、一票一单）；`join` 返回 `memberSecret`、`create` 返回 `driverSecret`，客户端自动存入同目录 `shaomai_state.json`，后续 `code`/`status`/`leave`/`kick`/`watch` 自动携带。看板的读操作（列单/详情/取餐码汇总）完全开放；写操作（发车/上车/推码/状态/踢人）均经上述能力令牌校验。看板本身只做只读协同展示 + 司机粘贴 driverSecret 后的状态/踢人快捷操作。

> `<skill_dir>` 即本 SKILL.md 所在目录。命令失败会返回 `{"status": <HTTP码>, "error": "..."}`，据此向用户解释。

## 4. 意图识别与执行流程

### 4.1 「我要发车 / 我当司机」

**核心原则：先查后发。** 发车前**必须先查该门店是否已有在途顺路车**——有就加入别人的车（同店硬约束下取餐能一次取齐），没有才自己发一车。**不要跳过第 3 步直接发车。**

1. 确认**收餐点**：调 mcd-mcp `delivery-query-addresses` 列出用户已存地址，让用户选一个作办公点；没有则问一句「你的办公/收餐点在哪栋楼？」。取其楼栋标签作 `officeLabel`（跨用户只展示楼栋级文本）。
2. 确认**昵称**（发车人昵称）、**人数上限**（默认 6）、**出发时间**（如「12:30 出发」）。
3. 选门店：调 mcd-mcp `query-nearby-stores` 查离该收餐点最近的麦当劳，拿到 `storeCode`/`storeName`。
   > 注意：mcd 门店搜索按**门店名**索引（如搜「徐庄路」能出，搜「玄武大道」查不到），搜不到时换关键词重试。
4. **查有没有现成的同店顺路车**（关键步骤，不可跳过）：调客户端 `active --store <storeCode>` 查该门店在途单。
   - **有单** → 把候选单列给用户（单号、司机昵称、收餐点、已上车/上限、备注、团长支付状态），让用户选：
     - 用户选「加入这车」→ 走 **§4.3 上车流程**（用同一 `storeCode` 下自己的单，然后 `join`），**不要自己发车**。
     - 用户选「我自己发一车」→ 继续第 5 步（并 `join` 已有单仍可并行，用户可自行决定）。
   - **无单** → 直接继续第 5 步发车。
   - 顺路性仍由 **§5 LLM 软判定**辅助：拿该单的 `officeLabel` 与用户收餐点比对，只作建议、最终让用户定。
5. 用户在 mcd-mcp 完成自己的下单（`create-order`，`beType=1` 到店取餐），拿到 `orderId`。
6. 调客户端 `create` 发顺路单，**带上团长的 `--order <orderId>`**（若此时已付款再加 `--paid`），并用 `--ttl` 让有效期**覆盖到出发时刻**（默认 120 分钟；若出发时间较晚，显式给足分钟数，例如 12:30 出发、10:00 发车 → `--ttl 180`）。拿到 `code` 与 `driverSecret`（后者自动存入本地状态，供后续 `status`/`kick`/`pay` 使用）。**把 code 告诉用户：「发到办公室群里，同事凭码上车」**；`driverSecret` 仅司机自持，如需在看板直接操作也可粘贴进看板。
7. **支付倒计时**：带 `--order` 时，该单进入 **15 分钟支付倒计时**——15 分钟内未标记已支付，**该单自动从看板隐藏**。团长付款后须调 `pay <code>` 标记已支付（`pay` 会自动带 `driverSecret`），或直接在看板详情页点「我已支付」。**发车后主动提醒用户付款，并说明超时后果。**
8. **有效期提醒**：告知用户该单何时过期（`expiresAt`），并提示「临近出发若人数不足，可重发一车或延长有效期」。

### 4.2 「附近谁在发车 / 看顺路单 / 顺路拼一份」
1. 调客户端 `active` 拉所有发车中单。
2. 用用户自己的 `officeLabel`（同 4.1 来源），对每个单的 `driver.officeLabel` 做 **§5 LLM 顺带判定**，筛出「顺路」的列出。
3. 展示：单号、司机昵称、收餐点、门店、已上车/上限、备注。让用户挑一个。

### 4.3 「上车拼一份 / 我上这单」
1. 拿到目标 `code`。
2. **同店锁定**：调 `get <code>` 取该单 `storeCode`，明确告知用户「本单门店为 X，你的下单必须用同一门店」。
3. 问用户昵称、收餐楼栋标签（`returnLabel`，同 4.1 来源）。
4. 用户在 mcd-mcp 用**同一 `storeCode`** 下单，拿到 `orderId`。
5. 调 `join <code> --return-label <...> --order <orderId>`，拿到 `memberId` 与 `memberSecret`（后者自动存入本地状态，供后续 `code`/`leave` 使用）。提示「已上车，等司机取餐」。（满员时返回 400「已满员」，提示换单或等下一班；同一人重复上车会被拒。）

### 4.4 「我的取餐码 / 班车状态」
- 状态：调 `get <code>` 读 `status` 与成员。
- 取餐码：调 mcd-mcp `query-order`（用自己 `orderId`）拿 `pickupCode`/`lockerCode`；出现后用客户端 `code <code> <memberId> --pickup ... --locker ...` 推给看板（自动带 `memberSecret`），让司机能一次取齐。

### 4.5 「截单 / 我取到餐了 / 已送达 / 完成」
发车人操作，调 `status <code> <状态>`（自动带 `driverSecret`）：
- `CLOSED` 截单（截单前可用 §5 判定结果辅助决定是否保留某乘客）
- `PICKING_UP` 到站取餐
- `DELIVERING` 带回分发中
- `DONE` 完成

## 5. LLM 顺带判定模板（软建议）

输入：发车人 `officeLabel` + 候选乘客 `returnLabel`（均为楼栋级文本，如「软件大道XX大厦A座」）。
要求 LLM 直接产出：
- **结论**：`顺带` / `可能不顺路`
- **理由**：一句话（同栋楼 / 相邻楼 / 隔了主干道）
- **置信度**：高 / 中 / 低

**强调**：LLM 对文本地址的精确米数不可靠，结论仅供发车人参考、由发车人最终确认/截单；**绝不做自动拒绝的硬门槛**。

## 6. 隐私红线

- 跨用户只暴露**楼栋标签 + 昵称 + 楼层**；绝不展示完整门牌、电话。
- 取餐码仅在「取餐中」后由看板对同单展示，用于司机一次性取齐分发。

## 7. 取餐码监控（10 秒轮询）

目标：每人下单后盯自己的 `pickupCode`，一出现就推给看板，让司机一次取齐。

**轮询节奏：每 10 秒一次**（远低于 mcd-mcp 600/min 限流，单用户 6/min，多个用户并行也极宽松）。两种落地方式：

**方式 A（推荐，agent 会话内盯码）**：用户说「帮我盯码 / 下单了」后，agent 在**当前会话内**每 10 秒调一次 mcd-mcp `query-order`（用该用户 `orderId`）；一旦 `pickupCode` 出现，立即 `shaomai_client.py code <CODE> <MEMBER_ID> --pickup ... --locker ...` 推看板，并提示用户「码已推给司机」。适合「下单后留在聊天页等码」的办公室场景。

**方式 B（后台进程，离开会话也盯）**：agent 用 `run_in_background` 启动客户端 `watch` 子命令，由它每 10 秒跑一次 `--check` 命令、出码即推：
```
python <skill_dir>/shaomai_client.py watch <CODE> <MEMBER_ID> --check "<取码命令>" --interval 10
```
`--check` 由 agent 提供：能拿到 `pickupCode` 即可（直连 mcd 不便时，可让 `--check` 调用一个持有 mcd Token 的小脚本，或读用户本地订单快照）。`watch` 推码成功后自动退出，外层据此停止。

> 说明：WorkBuddy 的**计划任务（自动化）**最小粒度是「小时级」（RRULE 仅支持 DAILY/HOURLY/WEEKLY…），**做不到 10 秒级**，因此 10 秒盯码不依赖计划任务，而走「会话内轮询（A）」或「后台 `watch` 进程（B）」。若日后要做长时间无人值守，可把节奏放宽到分钟级再转计划任务。

## 8. 错误处理与降级

- **后端不可达**（网络错/服务异常）：客户端返回 `{"error":...}`，提示用户检查网络后重试。
- **mcd-mcp 未配置/未授权**：提示用户去 open.mcd.cn 申请并填 Token。
- **上车满员**：`join` 返回 400「已满员」，提示换单或等下一班。
- **团长未支付**：`pay` 返回 403 表示 driverSecret 不匹配；单子超时后不在 `active` 列表里（可能已隐藏），用 `get <code>` 仍可查到，此时提示用户「本单因未支付已超时隐藏，请重新下单发车」。
- **鸽单**：发车人可 `status <code> CLOSED` 关闭；乘客凭自己取餐码单独去取（各自订单独立）。

## 9. MCP 配置（mcd-mcp）

在用户 WorkBuddy 的 `~/.workbuddy/mcp.json` 写入（替换 Token）：

```json
{
  "mcpServers": {
    "mcd-mcp": {
      "type": "streamablehttp",
      "url": "https://mcp.mcd.cn",
      "headers": { "Authorization": "Bearer 你的_MCP_TOKEN" }
    }
  }
}
```

> 字段采用麦当劳官方文档格式（`type: streamablehttp`，全小写无连字符）。若你的 WorkBuddy 版本要求 `transport` 字段，按版本微调即可。首次使用引导每个人去 open.mcd.cn 申请自己的 Token。
> 注意：每 Token 每分钟最多 600 次请求（超限 429），盯码轮询节奏控制在 **每 10 秒一次**即可（单用户仅 6/min，远低于上限）。

## 10. 取餐码监控自动化 prompt（供 WorkBuddy 自动化 / 会话内盯码使用）

> 每 10 秒检查一次我在麦当劳的订单 `<orderId>` 状态（调 mcd-mcp `query-order`）。一旦出现 `pickupCode` 或 `lockerCode`，立即执行 `python <skill_dir>/shaomai_client.py code <CODE> <MEMBER_ID> --pickup <码> --locker <柜码>` 把码推到捎麦看板；推送成功后停止盯码并提醒我「取餐码已同步给司机」。若订单被取消则停止并提醒我。

## 11. 轻量鉴权与防滥用（架构约束）

服务端**无法独立验证 mcd 用户身份**（mcd MCP 不暴露稳定用户 id），因此不做密码学强绑定，而用「服务端发放的能力令牌」做轻量门禁 + 限流 + 审计：

- **发车**：先 `POST /api/ticket`（带 skill 本地稳定 `userId`）领一次性票据；服务端按 `userId` + IP 双重限流发放。发车 `POST /api/trips` 必须带该票，一票一单、用过即废，并绑定 `creatorUserId`。→ 脚本无法循环刷单。
- **加入**：拼车码 `code`（6 位共享密钥）已挡外部随机加入；同单同 `userId` 只占一座，挡占座。小范围试跑不加 join-ticket（遭 griefing 再加）。
- **写取餐码 / 自退**：`join` 时返回 `memberSecret`，仅本人持有，写码 / 下车需匹配 → 杜绝冒充他人写假码。
- **司机操作（状态流转 / 踢人 / 标记已支付）**：`create` 时返回 `driverSecret`，仅发车人持有；`PATCH` 状态、`DELETE` 踢人、`POST /paid` 标记已支付均需匹配。
- **读操作**：列单 / 详情 / 取餐码汇总 完全开放；看板为只读协同展示，仅保留司机粘贴 `driverSecret` 后的状态/踢人快捷按钮。
- **基线**：所有写接口叠加每 IP 限流（`ratelimit` 表，best-effort）。

密钥（`driverSecret`/`memberSecret`/票据）均由客户端存于本地 `shaomai_state.json`，不上看板、不跨用户暴露；`shaomai_client.py` 各子命令自动携带，无需手工传。
