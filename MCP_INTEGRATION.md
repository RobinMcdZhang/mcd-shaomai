# MCP 集成说明（MCP_INTEGRATION）

本文档说明「捎麦（Shaomai）」项目对麦当劳 MCP 的实际集成方式：使用了哪个 MCP Server、调用了哪些 Tool、调用流程与业务价值。

## 一、MCP Server

| 项 | 内容 |
| --- | --- |
| Server 名称 | `mcd-mcp`（麦当劳官方 MCP Server） |
| 服务地址 | `https://mcp.mcd.cn` |
| 传输方式 | `streamablehttp` |
| 鉴权方式 | `Authorization: Bearer <MCP_TOKEN>`（每用户独立 Token，在 <https://open.mcd.cn> 申请） |
| 官方文档 | <https://open.mcd.cn/mcp/doc> |

连接配置示例（WorkBuddy 自定义连接器）：

```
{
  "mcpServers": {
    "mcd-mcp": {
      "type": "streamablehttp",
      "url": "https://mcp.mcd.cn",
      "headers": {
        "Authorization": "Bearer YOUR_MCP_TOKEN"
      }
    }
  }
}
```

## 二、实际调用的 Tool

本项目共调用 4 个麦当劳 MCP 工具，全部为只读下单侧能力，不触碰支付与账号敏感操作：

| Tool | 用途 | 调用时机 |
| --- | --- | --- |
| `delivery-query-addresses` | 查询用户已保存的收货/取餐地址 | 发车或上车时，引导用户选择自己的办公点（楼栋标签） |
| `query-nearby-stores` | 查询附近麦当劳门店 | 发车选门店 / 上车站校验门店，拿到 `storeCode`、`storeName` |
| `create-order` | 创建订单（`beType=1` 到店取餐） | 每位参与者各自下自己的单、各自付款 |
| `query-order` | 查询订单状态与取餐信息 | 盯码阶段轮询，取 `pickupCode` / `lockerCode` |

> 说明：下单与付款动作由使用者在自己的 MCP 会话中完成，Skill 只做选址引导、订单轮询与取餐码汇总，不代扣、不代付。

## 三、调用流程

```
① 发车
   Skill → delivery-query-addresses   （取办公点楼栋标签）
   Skill → query-nearby-stores         （选定门店，得到 storeCode/storeName）
   Skill → shaomai_client.py create    （向共享后端登记顺路单，领司机密钥 + 6 位单号）

② 上车
   同事 → Skill 「上车 X1X2X3」→ query-nearby-stores 校验同门店
   Skill → shaomai_client.py join      （登记成员，领成员密钥）

③ 各自下单（每人独立）
   参与者 → mcd-mcp create-order（beType=1 到店取餐），各自付款

④ 盯码（每人独立，每 10 秒一次）
   Skill → mcd-mcp query-order（orderId）
      └─ 出现 pickupCode/lockerCode
           └─ Skill → shaomai_client.py code ... （推送到看板，司机可见）

⑤ 取餐分发
   司机看板「取餐码汇总」到齐 → 到店一次取齐 → 按昵称分发
```

关键约束：

- **同店硬约束**：一个顺路单锚定一个门店，上车时用 `query-nearby-stores` 校验门店一致，保证司机一次取齐。
- **每人独立账户**：所有 MCP 调用都发生在使用者自己的 Token 会话中，顺路单只交换「楼栋标签 + 昵称 + 楼层 + 取餐码」，不交换账户与支付信息。
- **限流友好**：`query-order` 盯码 10 秒一次（约 6 次/分），远低于 MCP 每 Token 600 次/分的上限。

## 四、业务价值

1. **解决真实痛点**：办公楼里「谁去麦当劳、帮我带一份」的顺路带餐长期靠群聊刷屏 + 私聊对码，司机要翻聊天记录核对每个人的取餐码，漏带错带常发生。本项目把「同店拼车取餐」变成结构化流程：单号上车、同店校验、取餐码自动汇总到看板。
2. **盘活 MCP 已有能力**：`query-nearby-stores` + `create-order` + `query-order` 分别覆盖选址、下单、跟单三个环节，与「盯码推看板」组合后形成闭环，无需任何额外餐饮系统对接。
3. **零新增隐私暴露**：跨用户只暴露楼栋标签、昵称、楼层与取餐码；完整门牌、电话不进看板、不进接口响应。
4. **可复用的开源实现**：Skill 本体 + 协调后端（Cloudflare Worker + D1，单文件）全部开源，附默认公共服务，装完即用；也可按 `server/README.md` 一键自部署。

## 五、代码位置索引

| 功能 | 位置 |
| --- | --- |
| MCP 连接配置与工具说明 | `skill/SKILL.md`、`skill/README.md` |
| 盯码 prompt（10 秒轮询 `query-order`） | `skill/SKILL.md` §盯码 |
| 后端客户端（create/join/code/status 等） | `skill/shaomai_client.py` |
| 协调后端与看板（REST + D1 + 鉴权） | `server/worker.js` |
