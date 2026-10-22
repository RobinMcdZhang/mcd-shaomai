# 捎麦 Skill（shaomai）

麦麦堂食「顺带」协调 Skill：办公室场景下，一个人当**发车人**去餐厅取餐，同楼同事凭单号**上车**顺带，取餐码自动汇到看板，司机一次取齐、回部分发。

> 本质是**取餐物流拼单，不是付款拼单**：每人各自在麦当劳 MCP 下自己的单、各自付款。

## 文件

| 文件 | 作用 |
|------|------|
| `SKILL.md` | Skill 主文件（意图识别、执行流程、盯码 prompt、防滥用说明） |
| `shaomai_client.py` | 零依赖后端客户端（仅标准库：`urllib/json/hashlib/argparse` 等） |

## 依赖

- **共享后端**：后端地址已随本 skill 内置，用户无需配置。
- 每人自己的**麦当劳 MCP Token**：https://open.mcd.cn 申请（MCP 每人独立账户）。

## 安装（WorkBuddy）

把本目录放到技能目录下（二选一）：

```bash
# 用户级（所有项目可用）
mkdir -p ~/.workbuddy/skills/shaomai
cp SKILL.md shaomai_client.py ~/.workbuddy/skills/shaomai/
```

然后配置 MCP（`~/.workbuddy/mcp.json`，Token 换成你本人的）：

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

后端地址已随本 skill 内置，无需配置。

## 使用（对 WorkBuddy 说）

1. **发车**：「捎麦，我要发车，门店 MCD001，最多 3 人，12:30 出发」→ 返回 6 位单号，发到办公室群。
2. **看顺路单**：「捎麦，看下谁在发车」→ Skill 用 LLM 按楼栋文本判顺带，列出顺路单。
3. **上车**：「捎麦，上车 A1B2C3，我是小李，收餐点 软件大道XX大厦B座」→ 各自用**同门店**在 MCP 下单。
4. **盯码**：下单后说「帮我盯码」，每 10 秒查一次订单，出码自动推看板。
5. **取餐分发**：司机开看板 →「🎫 取餐码汇总」全部到齐 → 取餐 → 分发 → 推进状态到「已完成」。

## 客户端子命令

```bash
python shaomai_client.py create --name 阿强 --office "XX大厦A座" --store MCD001 --max 6
python shaomai_client.py active
python shaomai_client.py get <CODE>
python shaomai_client.py join <CODE> --name 小李 --return-label "XX大厦B座"
python shaomai_client.py code <CODE> <MEMBER_ID> --pickup A1B2 --locker 8848
python shaomai_client.py status <CODE> CLOSED|PICKING_UP|DELIVERING|DONE
python shaomai_client.py leave <CODE> <MEMBER_ID>
python shaomai_client.py kick <CODE> <MEMBER_ID>
python shaomai_client.py watch <CODE> <MEMBER_ID> --check "<取码命令>" --interval 10
```

## 防滥用（轻量鉴权）

- 发车需先领一次性票据（`POST /api/ticket`，服务端限流、一票一单）；`create` 已自动完成。
- 写取餐码/下车需 `memberSecret`；状态流转/踢人需 `driverSecret`。密钥由客户端自动存于同目录 `shaomai_state.json` 并自动携带，**该文件勿提交/外传**。

## 隐私

跨用户只暴露楼栋标签 + 昵称 + 楼层；完整门牌/电话不出现在看板与接口响应中。
