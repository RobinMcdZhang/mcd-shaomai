# 捎麦服务端日志

用于线上问题定位（如「发车成功但看板看不到」这类）。日志记录所有 `/api/*` 请求，
写入 D1 的 `logs` 表，可通过 HTTP 在线查看或下载。

> ⚠️ 这是**临时运维能力**，定位问题后可以去掉（见文末「后续处理」）。

## 快速使用

令牌：`<LOG_TOKEN>`（由 Cloudflare secret `LOG_TOKEN` 注入，不再硬编码于源码；查看/轮换请用 `wrangler secret put LOG_TOKEN` 或 Cloudflare 控制台）

### 1. 在线查看（JSON）

```
https://shaomai.win/api/logs?token=<LOG_TOKEN>&limit=100
```

### 2. 在线查看（纯文本，好读）

```
https://shaomai.win/api/logs?token=<LOG_TOKEN>&limit=50&format=text
```

输出形如：

```
[2026-10-21 10:27:03] GET /api/trips/active -> 200 149ms ip=221.181.215.242 action=trips
[2026-10-21 10:25:26] POST /api/trips -> 201 1014ms ip=221.181.215.242 action=trips
```

### 3. 下载（txt 附件，浏览器直接存盘）

```
https://shaomai.win/api/logs?token=<LOG_TOKEN>&limit=1000&format=txt
```

`Content-Disposition` 会带文件名，浏览器直接触发下载。

### 4. 筛选

| 参数 | 说明 | 示例 |
|---|---|---|
| `token` | 访问令牌（必填） | `<LOG_TOKEN>` |
| `limit` | 条数，1~1000，默认 100 | `limit=200` |
| `action` | 按接口筛选 | `action=trips` / `action=ticket` / `action=join` |
| `since` | 只看某毫秒时间戳之后 | `since=1792547000000` |
| `q` | 模糊搜索 path / detail / UA | `q=TLEHLM` |
| `format` | `json`（默认）/ `text` / `txt` | `format=txt` |

组合示例——只看发车接口最近 50 条：

```
https://shaomai.win/api/logs?token=<LOG_TOKEN>&action=trips&limit=50
```

### 5. 清空

```bash
curl -X POST "https://shaomai.win/api/logs/clear?token=<LOG_TOKEN>"
```

## 记录了什么

| 字段 | 含义 |
|---|---|
| `ts` / `timeLocal` | 时间戳 / 北京时间可读字符串（UTC+8） |
| `method` `path` | HTTP 方法与完整路径（含 query） |
| `action` | 归类接口名（`trips` / `ticket` / `join` / `code` …） |
| `status` | HTTP 状态码 |
| `durationMs` | 耗时（毫秒） |
| `ip` | 来源 IP（`CF-Connecting-IP`，取不到时用 `X-Forwarded-For` 首段） |
| `ua` | User-Agent（截断 200 字符） |
| `detail` | 错误信息（仅异常路径写入，截断 500 字符） |

**不记录**：请求体、订单号、取餐码、任何密钥（driverSecret / memberSecret / ticket）。
日志本身不记录敏感数据。

## 排查思路

1. 先看 **有没有请求到达**：`action=trips` 有没有记录。
   - 没有 → 请求没到服务端（客户端路径/网络/会话问题）。
   - 有 → 看 `status`：2xx 说明成功，继续查业务逻辑；4xx/5xx 看错误。
2. 想知道**某单发生了什么**：`q=<单号>` 模糊搜。
3. **写操作没生效**：对比 `POST /api/ticket` 与 `POST /api/trips` 两条记录——
   ticket 发了但 trips 没到，说明卡在票据校验（票据过期/已用/用户不匹配）。

## 另一种方式：wrangler tail

不依赖本功能，直接看实时日志流：

```bash
cd server
wrangler tail
```

## 后续处理

定位完问题后可以：
- 删掉 `worker.js` 中的 `writeLog` / `queryLogs` 与 `/api/logs` 路由；
- 或保留日志能力：令牌已改为 Cloudflare secret（`wrangler secret put LOG_TOKEN`），不进源码。

`logs` 表本身可以留着（不写就不占空间），也可以 `DELETE FROM logs` 清空。
