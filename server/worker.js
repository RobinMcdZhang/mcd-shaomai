/**
 * 捎麦（Shaomai）· 麦麦堂食顺带协调后端 + 看板
 *
 * 单文件 Cloudflare Worker：
 *   - D1 建表（trips / members / tickets / ratelimit），标准 SQLite 语义
 *   - REST API（领票 / 发单 / 拉在途单 / 上车 / 推取餐码 / 状态流转 / 下车）
 *   - 轻量鉴权 / 防滥用：
 *       · 发车需先 POST /api/ticket 领一次性票据（一票一单、按 userId+IP 限流）
 *       · 上车用拼车码 + 同单同 userId 只占一座，返回 memberSecret
 *       · 推取餐码 / 自退 需 memberSecret；状态流转 / 踢人 需 driverSecret
 *       · 全部写接口叠加每 IP 基线限流
 *   - 看板只读协同展示（发车/上车/推码均由 Skill 自动完成；司机可粘贴 driverSecret 改状态/踢人）
 *
 * 部署：wrangler.toml 里把 DB 绑到名为 DB 的 D1 数据库即可。
 */

// ---------- 工具函数 ----------
const STATUS = ['RECRUITING', 'CLOSED', 'PICKING_UP', 'DELIVERING', 'DONE'];
const STATUS_LABEL = {
  RECRUITING: '发车中',
  CLOSED: '已截单',
  PICKING_UP: '取餐中',
  DELIVERING: '送达分发中',
  DONE: '已完成',
};

// 轻量鉴权 / 防滥用参数
const TICKET_TTL = 10 * 60 * 1000;      // 票据有效期 10 分钟
const TICKET_WINDOW = 10 * 60 * 1000;   // 限流窗口 10 分钟
const TICKET_USER_LIMIT = 8;            // 每 userId 窗口内最多持 8 张未用票
const TICKET_IP_LIMIT = 30;             // 每 IP 窗口内最多持 30 张未用票
const WRITE_RATE_LIMIT = 60;            // 每 IP 每窗口写操作上限
const WRITE_RATE_WINDOW = 60 * 1000;    // 写操作限流窗口 1 分钟

// 顺路单默认有效期：2 小时（覆盖「现在发车、午餐时段出发」的常见节奏）
// 旧版固定 30 分钟，导致「11:30 出发」的单在 09:57 就消失——有效期必须覆盖到出发时刻。
const DEFAULT_TTL = 2 * 60 * 60 * 1000;
const MIN_TTL = 10 * 60 * 1000;         // 最短 10 分钟
const MAX_TTL = 12 * 60 * 60 * 1000;    // 最长 12 小时

// 运维日志：查看/下载日志的访问令牌——通过 wrangler secret (LOG_TOKEN) 注入，
// 不再硬编码于源码（避免随公开仓库泄露；旧公开令牌已作废轮换）。
// 未配置 secret 时日志接口自动关闭（返回 404）。


function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
function err(msg, status = 400) {
  return json({ error: msg }, status);
}
async function readJson(req) {
  try {
    return await req.json();
  } catch {
    return {};
  }
}
function genId() {
  return crypto.randomUUID();
}
function genCode(len = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
function genToken(len = 24) {
  const c = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let s = '';
  for (let i = 0; i < len; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
}
function getIp(req) {
  const h = req.headers;
  const cf = h.get('CF-Connecting-IP');
  if (cf) return cf;
  const xff = h.get('X-Forwarded-For');
  if (xff) return xff.split(',')[0].trim();
  return 'unknown';
}

// ---------- 建表（幂等，模块级只跑一次；含旧表补列） ----------
let schemaReady = null;
function ensureSchema(env) {
  if (!schemaReady) {
    schemaReady = (async () => {
      await env.DB.batch([
        env.DB.prepare(
          `CREATE TABLE IF NOT EXISTS trips (
            tripId TEXT PRIMARY KEY,
            code TEXT UNIQUE,
            driverId TEXT,
            driverName TEXT,
            driverFloor TEXT,
            officeLabel TEXT,
            driverAddr TEXT,
            storeCode TEXT,
            storeName TEXT,
            storeAddress TEXT,
            maxMembers INTEGER,
            status TEXT,
            note TEXT,
            createdAt INTEGER,
            expiresAt INTEGER,
            driverSecret TEXT,
            creatorTicket TEXT,
            creatorUserId TEXT,
            driverOrderId TEXT,
            driverPaid INTEGER,
            payDeadline INTEGER
          )`
        ),
        env.DB.prepare(
          `CREATE TABLE IF NOT EXISTS members (
            memberId TEXT PRIMARY KEY,
            tripId TEXT,
            userId TEXT,
            nickName TEXT,
            floor TEXT,
            orderId TEXT,
            orderStatus TEXT,
            pickupCode TEXT,
            lockerCode TEXT,
            lockerQrCode TEXT,
            returnLabel TEXT,
            returnAddr TEXT,
            joinedAt INTEGER,
            memberSecret TEXT
          )`
        ),
        env.DB.prepare(
          `CREATE TABLE IF NOT EXISTS tickets (
            ticket TEXT PRIMARY KEY,
            userId TEXT,
            ip TEXT,
            scope TEXT,
            issuedAt INTEGER,
            used INTEGER,
            usedAt INTEGER
          )`
        ),
        env.DB.prepare(
          `CREATE TABLE IF NOT EXISTS ratelimit (
            key TEXT PRIMARY KEY,
            count INTEGER,
            windowStart INTEGER
          )`
        ),
        env.DB.prepare(
          `CREATE TABLE IF NOT EXISTS logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts INTEGER,
            method TEXT,
            path TEXT,
            action TEXT,
            status INTEGER,
            durationMs INTEGER,
            ip TEXT,
            ua TEXT,
            detail TEXT
          )`
        ),
      ]);
      // 兼容更早版本建的表：补新增列（已存在则忽略）
      for (const sql of [
        'ALTER TABLE trips ADD COLUMN driverSecret TEXT',
        'ALTER TABLE trips ADD COLUMN creatorTicket TEXT',
        'ALTER TABLE trips ADD COLUMN creatorUserId TEXT',
        'ALTER TABLE members ADD COLUMN memberSecret TEXT',
        'ALTER TABLE trips ADD COLUMN driverOrderId TEXT',
        'ALTER TABLE trips ADD COLUMN driverPaid INTEGER',
        'ALTER TABLE trips ADD COLUMN payDeadline INTEGER',
      ]) {
        try { await env.DB.prepare(sql).run(); } catch (e) { /* 列已存在 */ }
      }
    })();
  }
  return schemaReady;
}

// ---------- 隐私过滤：对外只暴露楼栋标签/昵称/楼层，完整地址与密钥不跨用户展示 ----------
function publicTrip(t, memberCount) {
  return {
    tripId: t.tripId,
    code: t.code,
    driverName: t.driverName,
    driverFloor: t.driverFloor,
    officeLabel: t.officeLabel,
    storeCode: t.storeCode,
    storeName: t.storeName,
    storeAddress: t.storeAddress,
    maxMembers: t.maxMembers,
    status: t.status,
    statusLabel: STATUS_LABEL[t.status] || t.status,
    note: t.note,
    createdAt: t.createdAt,
    expiresAt: t.expiresAt,
    memberCount: memberCount ?? 0,
    // 团长（发车人）自己的订单支付状态：0=未支付/待支付，1=已支付
    driverOrderId: t.driverOrderId || '',
    driverPaid: t.driverPaid ? 1 : 0,
    payDeadline: t.payDeadline || 0,
    payExpired: payExpired(t) ? 1 : 0,
  };
}

// 团长下单后未在 PAY_WINDOW 内支付 → 该单视为失活，从看板隐藏
const PAY_WINDOW = 15 * 60 * 1000;
function payExpired(t, now = Date.now()) {
  if (!t.driverOrderId) return false;      // 团长未提供订单号 → 不做支付超时判定
  if (t.driverPaid) return false;          // 已支付 → 一直有效
  return !!(t.payDeadline && now > t.payDeadline);
}
function publicMember(m) {
  return {
    memberId: m.memberId,
    nickName: m.nickName,
    floor: m.floor,
    returnLabel: m.returnLabel,
    orderId: m.orderId,
    orderStatus: m.orderStatus,
    pickupCode: m.pickupCode,
    lockerCode: m.lockerCode,
    lockerQrCode: m.lockerQrCode,
    joinedAt: m.joinedAt,
  };
}

// 日志时间：统一按北京时间（UTC+8）输出，避免看日志时与本地时间错位
function logTime(ts) {
  const d = new Date(ts + 8 * 3600 * 1000);
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

// ---------- 运维日志：写日志 + 查询（在线查看 / 下载） ----------
async function writeLog(env, rec) {
  try {
    await env.DB.prepare(
      `INSERT INTO logs (ts,method,path,action,status,durationMs,ip,ua,detail)
       VALUES (?,?,?,?,?,?,?,?,?)`
    )
      .bind(
        rec.ts || Date.now(),
        (rec.method || '').slice(0, 10),
        (rec.path || '').slice(0, 200),
        (rec.action || '').slice(0, 60),
        rec.status || 0,
        rec.durationMs || 0,
        (rec.ip || '').slice(0, 64),
        (rec.ua || '').slice(0, 200),
        (rec.detail || '').slice(0, 2000)
      )
      .run();
  } catch (e) {
    // 日志失败不能影响主流程
  }
}

// 日志查询：?limit=100&action=xxx&since=<ms>&format=json|text
async function queryLogs(env, url) {
  const limit = Math.max(1, Math.min(1000, parseInt(url.searchParams.get('limit') || '100', 10) || 100));
  const action = (url.searchParams.get('action') || '').trim();
  const since = parseInt(url.searchParams.get('since') || '0', 10) || 0;
  const q = url.searchParams.get('q') || '';
  const format = (url.searchParams.get('format') || 'json').toLowerCase();

  const where = [];
  const binds = [];
  if (action) { where.push('action = ?'); binds.push(action); }
  if (since) { where.push('ts >= ?'); binds.push(since); }
  if (q) { where.push('(path LIKE ? OR detail LIKE ? OR ua LIKE ?)'); binds.push('%' + q + '%', '%' + q + '%', '%' + q + '%'); }
  const sql = `SELECT * FROM logs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
  binds.push(limit);
  const rows = await env.DB.prepare(sql).bind(...binds).all();
  const list = rows.results || [];

  if (format === 'text' || format === 'txt') {
    const lines = list.map((r) => {
      const t = logTime(r.ts);
      return `[${t}] ${r.method} ${r.path} -> ${r.status} ${r.durationMs}ms ip=${r.ip} action=${r.action || '-'} ${r.detail || ''}`.trim();
    });
    const text = lines.join('\n');
    if (format === 'txt') {
      return new Response(text, {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Disposition': `attachment; filename="shaomai-logs-${Date.now()}.txt"`,
        },
      });
    }
    return json({ count: list.length, logs: text });
  }
  return json({
    count: list.length,
    logs: list.map((r) => ({
      ...r,
      timeLocal: logTime(r.ts),
    })),
  });
}

// ---------- 基线 IP 限流（best-effort，异常不阻断） ----------
async function checkRate(env, ip, action) {
  const key = ip + ':' + action;
  const now = Date.now();
  try {
    const doc = await env.DB.prepare('SELECT * FROM ratelimit WHERE key=?').bind(key).first();
    if (!doc || now - doc.windowStart > WRITE_RATE_WINDOW) {
      await env.DB.prepare(
        `INSERT INTO ratelimit (key,count,windowStart) VALUES (?,?,?)
         ON CONFLICT(key) DO UPDATE SET count=1, windowStart=?`
      ).bind(key, 1, now, now).run();
      return true;
    }
    if (doc.count >= WRITE_RATE_LIMIT) return false;
    await env.DB.prepare('UPDATE ratelimit SET count=count+1 WHERE key=?').bind(key).run();
    return true;
  } catch (e) {
    return true;
  }
}

// ---------- 业务：领票（发车前先领取一次性能力令牌） ----------
async function issueTicket(env, body, req) {
  const userId = (body && body.userId) || '';
  if (!userId) return err('缺少 userId', 400);
  const ip = getIp(req);
  const since = Date.now() - TICKET_WINDOW;
  const recent = await env.DB.prepare(
    'SELECT COUNT(*) c FROM tickets WHERE userId=? AND used=0 AND issuedAt>?'
  ).bind(userId, since).first();
  if (recent.c >= TICKET_USER_LIMIT) return err('领票过于频繁，稍后再试', 429);
  const ipRecent = await env.DB.prepare(
    'SELECT COUNT(*) c FROM tickets WHERE ip=? AND used=0 AND issuedAt>?'
  ).bind(ip, since).first();
  if (ipRecent.c >= TICKET_IP_LIMIT) return err('当前网络领票过多，稍后再试', 429);
  const ticket = genToken(24);
  await env.DB.prepare(
    'INSERT INTO tickets (ticket,userId,ip,scope,issuedAt,used,usedAt) VALUES (?,?,?,?,?,0,NULL)'
  ).bind(ticket, userId, ip, 'create', Date.now()).run();
  return json({ ticket, ttlMs: TICKET_TTL }, 201);
}

// ---------- 业务：发单（需 create-ticket，返回 driverSecret） ----------
async function createTrip(env, body) {
  const ticket = body.ticket;
  if (!ticket) return err('缺少发车票据 ticket（请先 POST /api/ticket 领取）', 400);
  const tk = await env.DB.prepare('SELECT * FROM tickets WHERE ticket=?').bind(ticket).first();
  if (!tk) return err('发车票据无效', 403);
  if (tk.used) return err('发车票据已使用', 409);
  if (Date.now() - tk.issuedAt > TICKET_TTL) return err('发车票据已过期，请重新领取', 410);
  if (body.userId && tk.userId !== body.userId) return err('发车票据与用户不匹配', 403);
  await env.DB.prepare('UPDATE tickets SET used=1, usedAt=? WHERE ticket=?')
    .bind(Date.now(), ticket).run();

  const {
    driverId,
    driverName,
    driverFloor,
    officeLabel,
    driverAddr,
    storeCode,
    storeName,
    storeAddress,
    maxMembers,
    note,
    driverOrderId,
    driverPaid,
    ttl,
  } = body;
  if (!driverName || !officeLabel || !storeCode) {
    return err('缺少必填项：driverName / officeLabel / storeCode');
  }
  const max = Math.max(1, Math.min(50, parseInt(maxMembers, 10) || 6));
  let code;
  for (let i = 0; i < 6; i++) {
    code = genCode(6);
    const hit = await env.DB.prepare('SELECT 1 FROM trips WHERE code=?').bind(code).first();
    if (!hit) break;
  }
  const now = Date.now();
  // 有效期：默认 2 小时；发车时可指定（分钟），且至少 10 分钟、最长 12 小时。
  // 关键：有效期必须覆盖到「出发时刻」——旧版固定 30 分钟会让「11:30 出发」的单在 09:57 就消失。
  let ttlMs = DEFAULT_TTL;
  const ttlMin = parseInt(ttl, 10);
  if (ttlMin > 0) ttlMs = Math.max(MIN_TTL, Math.min(MAX_TTL, ttlMin * 60 * 1000));
  const row = {
    tripId: genId(),
    code,
    driverId: driverId || genId(),
    driverName,
    driverFloor: driverFloor || '',
    officeLabel,
    driverAddr: driverAddr || '',
    storeCode,
    storeName: storeName || '',
    storeAddress: storeAddress || '',
    maxMembers: max,
    status: 'RECRUITING',
    note: note || '',
    createdAt: now,
    expiresAt: now + ttlMs,
    driverSecret: genToken(24),
    creatorTicket: ticket,
    creatorUserId: tk.userId,
    // 团长自己的订单：带上订单号则进入「支付倒计时」，15 分钟内未支付即从看板隐藏
    driverOrderId: driverOrderId || '',
    driverPaid: driverPaid ? 1 : 0,
    payDeadline: driverOrderId && !driverPaid ? now + PAY_WINDOW : 0,
  };
  await env.DB.prepare(
    `INSERT INTO trips (tripId,code,driverId,driverName,driverFloor,officeLabel,driverAddr,
      storeCode,storeName,storeAddress,maxMembers,status,note,createdAt,expiresAt,
      driverSecret,creatorTicket,creatorUserId,driverOrderId,driverPaid,payDeadline)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  )
    .bind(
      row.tripId, row.code, row.driverId, row.driverName, row.driverFloor, row.officeLabel,
      row.driverAddr, row.storeCode, row.storeName, row.storeAddress, row.maxMembers,
      row.status, row.note, row.createdAt, row.expiresAt,
      row.driverSecret, row.creatorTicket, row.creatorUserId,
      row.driverOrderId, row.driverPaid, row.payDeadline
    )
    .run();
  return json({ ...publicTrip(row, 0), driverSecret: row.driverSecret }, 201);
}

// ---------- 业务：拉已结束/已过期的单（看板「已结束」分区） ----------
// 展示策略（试验阶段不让看板显得空）：
//   · 主查询：近 CLOSED_WINDOW_DAYS 天内、最多 MAX_CLOSED 条，避免历史单无限堆积；
//   · 兜底  ：窗口内不足 MIN_CLOSED 条时，不限时间直接取最近 MIN_CLOSED 条——
//             这样即使所有车次都超过窗口，也保证能看到最近几班。
const CLOSED_WINDOW_DAYS = 7;
const MIN_CLOSED = 5;
const MAX_CLOSED = 20;

async function listClosed(env) {
  const now = Date.now();
  const since = now - CLOSED_WINDOW_DAYS * 24 * 3600 * 1000;
  const cond = "(t.status != 'RECRUITING' OR t.expiresAt < ?)";
  const base =
    `SELECT t.*, (SELECT COUNT(*) FROM members m WHERE m.tripId=t.tripId) AS memberCount
     FROM trips t WHERE ` + cond;

  let rows = await env.DB.prepare(
    `${base} AND t.createdAt >= ? ORDER BY t.createdAt DESC LIMIT ?`
  ).bind(now, since, MAX_CLOSED).all();
  rows = (rows.results || []).slice();

  if (rows.length < MIN_CLOSED) {
    const more = await env.DB.prepare(
      `${base} ORDER BY t.createdAt DESC LIMIT ?`
    ).bind(now, MIN_CLOSED).all();
    rows = (more.results || []).slice(0, MIN_CLOSED);
  }

  return json(rows.map((t) => ({
    ...publicTrip(t, t.memberCount),
    expired: t.expiresAt < now && t.status === 'RECRUITING',
  })));
}

// ---------- 业务：拉在途单（发车中） ----------
async function listActive(env) {
  const now = Date.now();
  const rows = await env.DB.prepare(
    `SELECT t.*, (SELECT COUNT(*) FROM members m WHERE m.tripId=t.tripId) AS memberCount
     FROM trips t WHERE t.status='RECRUITING' ORDER BY t.createdAt DESC`
  ).all();
  // 过滤两类「僵尸单」：① 团长下单后超 15 分钟仍未支付 ② 超过 30 分钟有效期
  const list = (rows.results || []).filter(
    (t) => !payExpired(t, now) && (!t.expiresAt || now < t.expiresAt)
  );
  return json(list.map((t) => publicTrip(t, t.memberCount)));
}

// ---------- 业务：取完整单（看板/Skill 轮询） ----------
async function getTrip(env, key) {
  const t = await env.DB.prepare(
    `SELECT t.*, (SELECT COUNT(*) FROM members m WHERE m.tripId=t.tripId) AS memberCount
     FROM trips t WHERE t.tripId=? OR t.code=?`
  ).bind(key, key).first();
  if (!t) return err('顺路单不存在', 404);
  const m = await env.DB.prepare('SELECT * FROM members WHERE tripId=? ORDER BY joinedAt ASC')
    .bind(t.tripId).all();
  return json({
    ...publicTrip(t, t.memberCount),
    members: (m.results || []).map(publicMember),
  });
}

// ---------- 业务：上车（拼车码在路径；同单同 userId 只占一座；返回 memberSecret） ----------
async function joinTrip(env, key, body) {
  const t = await env.DB.prepare('SELECT * FROM trips WHERE tripId=? OR code=?')
    .bind(key, key).first();
  if (!t) return err('顺路单不存在', 404);
  if (t.status !== 'RECRUITING') return err('该单已截单，不可上车');
  const count = await env.DB.prepare('SELECT COUNT(*) c FROM members WHERE tripId=?')
    .bind(t.tripId).first();
  if (count.c >= t.maxMembers) return err('已满员');

  const { userId, nickName, floor, returnLabel, returnAddr, orderId } = body;
  if (!nickName || !returnLabel) return err('缺少必填项：nickName / returnLabel');
  const uid = userId || genId();
  const dup = await env.DB.prepare(
    'SELECT 1 FROM members WHERE tripId=? AND userId=? LIMIT 1'
  ).bind(t.tripId, uid).first();
  if (dup) return err('你已在该单上车，无需重复', 409);

  const mid = genId();
  const now = Date.now();
  const memberSecret = genToken(24);
  await env.DB.prepare(
    `INSERT INTO members (memberId,tripId,userId,nickName,floor,orderId,orderStatus,
      returnLabel,returnAddr,joinedAt,memberSecret)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  )
    .bind(mid, t.tripId, uid, nickName, floor || '', orderId || '',
      'PENDING', returnLabel, returnAddr || '', now, memberSecret)
    .run();

  // 满员自动截单
  const after = await env.DB.prepare('SELECT COUNT(*) c FROM members WHERE tripId=?')
    .bind(t.tripId).first();
  if (after.c >= t.maxMembers) {
    await env.DB.prepare("UPDATE trips SET status='CLOSED' WHERE tripId=?").bind(t.tripId).run();
  }
  const m = await env.DB.prepare('SELECT * FROM members WHERE memberId=?').bind(mid).first();
  return json({ ...publicMember(m), memberSecret }, 201);
}

// ---------- 业务：状态流转（需 driverSecret） ----------
async function patchTrip(env, key, body) {
  const t = await env.DB.prepare('SELECT * FROM trips WHERE tripId=? OR code=?')
    .bind(key, key).first();
  if (!t) return err('顺路单不存在', 404);
  if (!body.driverSecret || body.driverSecret !== t.driverSecret) {
    return err('缺少有效的司机密钥', 403);
  }
  const next = body.status;
  if (!STATUS.includes(next)) return err('非法状态: ' + next);
  await env.DB.prepare('UPDATE trips SET status=? WHERE tripId=?').bind(next, t.tripId).run();
  return getTrip(env, key);
}

// ---------- 业务：标记团长已支付（需 driverSecret） ----------
async function markPaid(env, key, body) {
  const t = await env.DB.prepare('SELECT * FROM trips WHERE tripId=? OR code=?')
    .bind(key, key).first();
  if (!t) return err('顺路单不存在', 404);
  if (!body.driverSecret || body.driverSecret !== t.driverSecret) {
    return err('缺少有效的司机密钥', 403);
  }
  // 顺带补记订单号（发车时没带 --order 也可在此补上）
  const orderId = body.orderId || t.driverOrderId || '';
  await env.DB.prepare(
    'UPDATE trips SET driverPaid=1, payDeadline=0, driverOrderId=COALESCE(NULLIF(?,?), driverOrderId) WHERE tripId=?'
  ).bind(orderId, t.driverOrderId || '', t.tripId).run();
  return getTrip(env, key);
}

// ---------- 业务：推取餐码（需 memberSecret） ----------
async function pushCode(env, key, mid, body) {
  const t = await env.DB.prepare('SELECT * FROM trips WHERE tripId=? OR code=?')
    .bind(key, key).first();
  if (!t) return err('顺路单不存在', 404);
  const m = await env.DB.prepare('SELECT * FROM members WHERE memberId=? AND tripId=?')
    .bind(mid, t.tripId).first();
  if (!m) return err('乘客不存在', 404);
  if (!body.memberSecret || body.memberSecret !== m.memberSecret) {
    return err('成员密钥错误，无权写入取餐码', 403);
  }
  const { orderId, orderStatus, pickupCode, lockerCode, lockerQrCode } = body;
  await env.DB.prepare(
    `UPDATE members SET orderId=COALESCE(?,orderId), orderStatus=COALESCE(?,orderStatus),
       pickupCode=COALESCE(?,pickupCode), lockerCode=COALESCE(?,lockerCode),
       lockerQrCode=COALESCE(?,lockerQrCode) WHERE memberId=?`
  )
    .bind(
      orderId || null, orderStatus || null, pickupCode || null, lockerCode || null,
      lockerQrCode || null, mid
    )
    .run();
  return json({ ok: true });
}

// ---------- 业务：下车 / 踢人（成员密钥自退，司机密钥踢人） ----------
async function leaveTrip(env, key, mid, body) {
  const t = await env.DB.prepare('SELECT * FROM trips WHERE tripId=? OR code=?')
    .bind(key, key).first();
  if (!t) return err('顺路单不存在', 404);
  const m = await env.DB.prepare('SELECT * FROM members WHERE memberId=? AND tripId=?')
    .bind(mid, t.tripId).first();
  if (!m) return err('乘客不存在', 404);
  const isDriver = body && body.driverSecret && body.driverSecret === t.driverSecret;
  const isSelf = body && body.memberSecret && body.memberSecret === m.memberSecret;
  if (!isDriver && !isSelf) return err('缺少有效的司机密钥或成员密钥', 403);
  await env.DB.prepare('DELETE FROM members WHERE memberId=? AND tripId=?').bind(mid, t.tripId).run();
  return getTrip(env, key);
}

// ---------- 路由 ----------
async function handleApi(env, req, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', 'trips', ...]
  const method = req.method;

  if (parts[1] === 'health') return json({ ok: true });

  // 运维日志：在线查看 / 下载（需令牌 ?token=）
  if (parts[1] === 'logs' && !parts[2]) {
    const tok = url.searchParams.get('token') || (req.headers.get('X-Log-Token') || '');
    const LT = (env && env.LOG_TOKEN) || '';
    if (!LT) return err('日志功能未启用', 404);
    if (tok !== LT) return err('日志令牌不正确', 403);
    if (method !== 'GET') return err('仅支持 GET', 405);
    return queryLogs(env, url);
  }
  if (parts[1] === 'logs' && parts[2] === 'clear' && method === 'POST') {
    const tok = url.searchParams.get('token') || (req.headers.get('X-Log-Token') || '');
    const LT = (env && env.LOG_TOKEN) || '';
    if (!LT) return err('日志功能未启用', 404);
    if (tok !== LT) return err('日志令牌不正确', 403);
    await env.DB.prepare('DELETE FROM logs').run();
    return json({ ok: true, cleared: true });
  }

  // 写操作基线 IP 限流（best-effort）
  if (method !== 'GET') {
    const ok = await checkRate(env, getIp(req), method + ':' + (parts[1] || ''));
    if (!ok) return err('操作过于频繁，请稍后再试', 429);
  }

  if (parts[1] === 'ticket' && !parts[2] && method === 'POST') {
    return issueTicket(env, await readJson(req), req);
  }

  if (parts[1] === 'trips' && parts[2] === 'active' && method === 'GET') {
    return listActive(env);
  }
  if (parts[1] === 'trips' && parts[2] === 'closed' && method === 'GET') {
    return listClosed(env);
  }
  // /api/trips (POST 发单)  /api/trips (GET 列表已发车=发车中)
  if (parts[1] === 'trips' && !parts[2]) {
    if (method === 'POST') return createTrip(env, await readJson(req));
    if (method === 'GET') return listActive(env);
  }
  // /api/trips/:key  /api/trips/:key/join  /api/trips/:key/members/:mid
  if (parts[1] === 'trips' && parts[2]) {
    const key = parts[2];
    const sub = parts[3];
    if (!sub && method === 'GET') return getTrip(env, key);
    if (!sub && method === 'PATCH') return patchTrip(env, key, await readJson(req));
    if (sub === 'paid' && method === 'POST') return markPaid(env, key, await readJson(req));
    if (sub === 'join' && method === 'POST') return joinTrip(env, key, await readJson(req));
    if (sub === 'members' && parts[4] && parts[5] === 'code' && method === 'POST') {
      return pushCode(env, key, parts[4], await readJson(req));
    }
    if (sub === 'members' && parts[4] && method === 'DELETE') {
      return leaveTrip(env, key, parts[4], await readJson(req));
    }
  }
  return err('未知接口: ' + method + ' ' + url.pathname, 404);
}

// ---------- 看板 HTML（只读协同展示；司机可粘贴 driverSecret 改状态/踢人） ----------
const DASHBOARD = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>捎麦（Shaomai）· 麦麦堂食捎带</title>
<style>
  :root{ --bg:#fff8f0; --card:#fff; --line:#f0d9c0; --brand:#ff5b00; --ink:#2b2118; --mut:#8a7a6a; }
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,system-ui,"PingFang SC","Microsoft YaHei",sans-serif;
    background:var(--bg);color:var(--ink);line-height:1.5}
  header{background:var(--brand);color:#fff;padding:12px 18px;
    display:flex;justify-content:space-between;align-items:center;gap:12px}
  .brand{display:flex;flex-direction:column;gap:2px;min-width:0}
  .brand b{font-size:17px;font-weight:700;letter-spacing:.2px}
  .brand span{font-size:12px;opacity:.85;font-weight:400}
  header a{color:#fff;font-size:12px;opacity:.9;text-decoration:none;border:1px solid rgba(255,255,255,.45);
    border-radius:20px;padding:3px 10px;white-space:nowrap}
  header a:hover{background:rgba(255,255,255,.18);opacity:1}
  .wrap{max-width:760px;margin:0 auto;padding:16px}
  .panel{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;margin-bottom:16px}
  .panel h2{margin:0 0 10px;font-size:15px}
  label{display:block;font-size:12px;color:var(--mut);margin:8px 0 3px}
  input,textarea{width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:8px;
    font-size:14px;background:#fffdf9}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
  button{background:var(--brand);color:#fff;border:0;border-radius:8px;padding:9px 14px;
    font-size:14px;cursor:pointer;margin-top:10px}
  button.ghost{background:#fff;color:var(--brand);border:1px solid var(--brand)}
  button.sm{padding:5px 9px;font-size:12px;margin:0}
  .card{border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin-bottom:10px;cursor:pointer;background:#fffdf9}
  .card:hover{border-color:var(--brand)}
  .row1{display:flex;justify-content:space-between;align-items:center}
  .row2{font-size:13px;color:var(--mut);margin-top:2px}
  .row3{font-size:12px;margin-top:4px}
  .badge{background:#fff0e6;color:var(--brand);font-size:11px;padding:2px 8px;border-radius:20px}
  .badge.warn{background:#fff6d9;color:#8a6100}
  .secret-panel{border-style:dashed}
  .secret-panel h2{margin-bottom:6px}
  .secret-status{font-size:12px;margin-top:8px;min-height:16px;color:var(--mut)}
  .secret-status.ok{color:#1a7f37}
  .secret-status.warn{color:#8a6100}
  .secret-status.err{color:#c0392b}
  .badge.ok{background:#e8f7ee;color:#1f8a4c}
  .code{font-size:11px;color:var(--mut);margin-top:5px}
  .empty{color:var(--mut);font-size:13px;padding:8px 0}
  .mem{display:flex;justify-content:space-between;align-items:center;gap:8px;border-top:1px dashed var(--line);padding:8px 0;font-size:13px}
  .code-row{font-size:13px;padding:4px 0;border-bottom:1px dotted var(--line)}
  .ok{background:#e8f7ee;color:#1f8a4c;padding:6px 10px;border-radius:8px;font-size:13px;margin-bottom:6px}
  .codes-head{display:flex;justify-content:space-between;align-items:center}
  .tag{font-size:11px;background:#eef6ff;color:#2b6cb0;padding:2px 6px;border-radius:6px}
  .back{color:var(--brand);font-size:13px;cursor:pointer;margin-bottom:8px;display:inline-block}
  .pill{display:inline-block;margin:3px 4px 0 0;padding:5px 10px;border:1px solid var(--line);border-radius:20px;font-size:13px;cursor:pointer}
  .pill.on{background:var(--brand);color:#fff;border-color:var(--brand)}
  #detail{display:none}
  .muted{color:var(--mut);font-size:12px}
</style>
</head>
<body>
<header>
  <div class="brand"><b>捎麦（Shaomai）· 麦麦堂食捎带</b><span>办公室拼车取餐 · 一人发车，同楼上车</span></div>
  <a href="https://github.com/RobinMcdZhang/mcd-shaomai" target="_blank" rel="noopener">GitHub</a>
</header>
<div class="wrap">

  <div id="list">
    <div class="panel">
      <h2>📋 在途顺路单（发车中）</h2>
      <div class="muted" style="margin-bottom:8px">发车 / 上车 / 推码 均由捎麦 Skill 自动与服务端交互，看板仅作协同展示。</div>
      <div id="activeList"><div class="empty">加载中…</div></div>
    </div>
    <div class="panel" id="closedPanel" style="display:none">
      <h2>🕘 已结束 / 历史车次 <span class="muted" id="closedCount" style="font-weight:400;font-size:12px"></span></h2>
      <div class="muted" style="margin-bottom:8px">已完成、已截单或已过期的车次都会保留在这里（不受 24 小时限制，至少保留最近几班）。</div>
      <div id="closedList"></div>
    </div>
  </div>

  <div id="detail">
    <span class="back" id="backBtn">← 返回列表</span>
    <div class="panel" id="tripHead"></div>
    <div class="panel secret-panel" id="secretPanel" style="display:none">
      <h2>🔑 司机密钥（可选）</h2>
      <div class="muted" style="margin-bottom:8px">粘贴发车时 Skill 给出的 driverSecret，即可在下方改状态、踢人。密钥只保存在本机浏览器，不上传。</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <input id="driverSecret" placeholder="粘贴 driverSecret" autocomplete="off" spellcheck="false" style="flex:1;min-width:200px" />
        <button class="sm" id="btnSaveSecret" type="button">保存</button>
        <button class="sm ghost" id="btnClearSecret" type="button">清除</button>
      </div>
      <div class="secret-status" id="secretStatus"></div>
    </div>
    <div class="panel">
      <h2>👥 已上车（<span id="memCount">0</span>）</h2>
      <div id="memList"></div>
      <div id="memActions"></div>
    </div>
    <div class="panel">
      <div class="codes-head"><h2>🎫 取餐码汇总（司机取餐用）</h2>
        <button class="sm ghost" id="copyCodes" type="button">📋 复制全部</button></div>
      <div id="codeSummary"></div>
    </div>
    <div class="panel">
      <h2>🙋 上车 / 推码</h2>
      <div class="muted">上车与推送取餐码请通过捎麦 Skill 完成（需拼车码与成员密钥）。看板仅展示协同结果。</div>
    </div>
  </div>

</div>
<script>
const $ = function(id){ return document.getElementById(id); };
function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,function(c){
  return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
async function api(path, method, body){
  const opts = {method:method, headers:{'Content-Type':'application/json'}};
  if(body) opts.body = JSON.stringify(body);
  const r = await fetch(path, opts);
  const data = await r.json().catch(function(){ return {}; });
  if(!r.ok) throw new Error(data.error || ('HTTP '+r.status));
  return data;
}
const LABEL = {RECRUITING:'发车中',CLOSED:'已截单',PICKING_UP:'取餐中',DELIVERING:'送达分发中',DONE:'已完成'};

// 团长支付状态标签：已支付 / 待支付（带倒计时）/ 未提供订单号
function payTag(t){
  if(!t.driverOrderId) return '';
  if(t.driverPaid) return '<div class="row3"><span class="badge ok">团长已支付</span></div>';
  var left = t.payDeadline ? Math.max(0, Math.ceil((t.payDeadline - Date.now())/60000)) : 0;
  return '<div class="row3"><span class="badge warn">团长待支付'+(left?(' · 剩'+left+'分钟'):'')+'</span></div>';
}

async function loadActive(){
  try{
    var list = await api('/api/trips/active','GET');
    var box = $('activeList');
    if(!list.length){ box.innerHTML = '<div class="empty">暂无发车中的顺路单</div>'; }
    else{
      box.innerHTML = list.map(function(t){
        var pay = payTag(t);
        return '<div class="card" data-code="'+esc(t.code)+'">'+
          '<div class="row1"><b>'+esc(t.driverName)+'</b><span class="badge">'+(LABEL[t.status]||t.status)+'</span></div>'+
          '<div class="row2">'+esc(t.officeLabel)+' · '+esc(t.storeName||t.storeCode)+'</div>'+
          '<div class="row3">已上车 '+t.memberCount+'/'+t.maxMembers+(t.note?' · '+esc(t.note):'')+'</div>'+
          pay+
          '<div class="code">单号 '+esc(t.code)+'</div></div>';
      }).join('');
    }
    loadClosed();
  }catch(e){ $('activeList').innerHTML = '<div class="empty">加载失败: '+esc(e.message)+'</div>'; }
}

// 已结束/已过期的单：让「过期消失」有迹可循，而不是凭空消失；
// 服务端保证至少返回最近几班，所以这里只要有数据就一定显示。
async function loadClosed(){
  try{
    var list = await api('/api/trips/closed','GET');
    if(!list || !list.length){ $('closedPanel').style.display='none'; return; }
    $('closedPanel').style.display='block';
    $('closedCount').textContent = '共 '+list.length+' 班';
    $('closedList').innerHTML = list.map(function(t){
      var label = t.expired ? '已过期' : (LABEL[t.status]||t.status);
      return '<div class="card" data-code="'+esc(t.code)+'" style="opacity:.7">'+
        '<div class="row1"><b>'+esc(t.driverName)+'</b><span class="badge">'+esc(label)+'</span></div>'+
        '<div class="row2">'+esc(t.officeLabel)+' · '+esc(t.storeName||t.storeCode)+'</div>'+
        '<div class="row3">已上车 '+t.memberCount+'/'+t.maxMembers+(t.note?' · '+esc(t.note):'')+'</div>'+
        '<div class="code">单号 '+esc(t.code)+'</div></div>';
    }).join('');
  }catch(e){ /* 静默失败，不影响主列表 */ }
}

let current = null;
let openCode = null;   // 当前打开的车次 code；返回列表时置 null（避免异步竞态把已关闭的详情重新打开）
async function openTrip(code){
  openCode = code;
  try{
    const t = await api('/api/trips/'+encodeURIComponent(code),'GET');
    current = t;
    if(openCode !== code) return;   // 等待期间用户已返回列表/切换了车次，放弃本次渲染
    $('tripHead').innerHTML =
      '<h2>顺路单 '+esc(t.code)+' <span class="badge">'+(LABEL[t.status]||t.status)+'</span></h2>'+
      '<div class="row2">司机：'+esc(t.driverName)+(t.driverFloor?(' · '+esc(t.driverFloor)):'')+'</div>'+
      '<div class="row2">收餐点：'+esc(t.officeLabel)+'</div>'+
      '<div class="row2">门店：'+esc(t.storeName||t.storeCode)+(t.storeAddress?(' · '+esc(t.storeAddress)):'')+'</div>'+
      (t.note?'<div class="row3">备注：'+esc(t.note)+'</div>':'')+
      (t.driverOrderId ? ('<div class="row3">团长订单：'+
        (t.driverPaid ? '<span class="badge ok">已支付</span>' : '<span class="badge warn">待支付</span>')+
        (t.payExpired?'<span class="muted">（已超时，将从看板隐藏）</span>':'')+'</div>') : '')+
      '<div id="tripSecretBox"></div>';
    renderMembers(t);
    renderActions(t);
    renderCodes(t);
    syncSecretPanel(current.code);
    $('list').style.display='none';
    $('detail').style.display='block';
  }catch(e){ if(openCode===code) alert('打开失败: '+e.message); }
}
function renderMembers(t){
  $('memCount').textContent = (t.members||[]).length;
  const box = $('memList');
  if(!t.members || !t.members.length){ box.innerHTML = '<div class="empty">还没有人上车</div>'; return; }
  box.innerHTML = t.members.map(function(m){
    const code = m.pickupCode ? ('<span class="tag">取餐码 '+esc(m.pickupCode)+'</span>') : '';
    const locker = m.lockerCode ? ('<span class="tag">柜码 '+esc(m.lockerCode)+'</span>') : '';
    return '<div class="mem"><div>'+esc(m.nickName)+(m.floor?(' · '+esc(m.floor)):'')+
      '<div class="muted">'+esc(m.returnLabel)+'</div>'+code+locker+'</div>'+
      '<button class="sm ghost" data-kick="'+esc(m.memberId)+'">下车</button></div>';
  }).join('');
}
function renderCodes(t){
  const members = t.members||[];
  const total = members.length;
  const codes = members.filter(function(m){ return m.pickupCode; });
  const box = $('codeSummary');
  if(!total){ box.innerHTML = '<div class="empty">还没人上车</div>'; window.__codes=''; return; }
  let html = '';
  if(codes.length === total){
    html += '<div class="ok">✅ 全部到齐（'+total+'/'+total+'），可出发取餐</div>';
  } else {
    html += '<div class="muted">已出码 '+codes.length+'/'+total+'，等待其余…</div>';
  }
  html += members.map(function(m){
    return '<div class="code-row">'+esc(m.nickName)+'：'+(m.pickupCode||'<span class="muted">待出码</span>')+
      (m.lockerCode?(' ｜柜码 '+esc(m.lockerCode)):'')+'</div>';
  }).join('');
  box.innerHTML = html;
  window.__codes = members.map(function(m){
    return m.nickName+': '+(m.pickupCode||'')+(m.lockerCode?(' 柜码'+m.lockerCode):'');
  }).join('\\n');
}
function copyCodes(){
  const txt = window.__codes||'';
  if(!txt) return;
  if(navigator.clipboard && navigator.clipboard.writeText){ navigator.clipboard.writeText(txt); }
  const b=$('copyCodes'); const o=b.textContent; b.textContent='已复制！';
  setTimeout(function(){ b.textContent=o; }, 1500);
}
function renderActions(t){
  const steps = ['RECRUITING','CLOSED','PICKING_UP','DELIVERING','DONE'];
  const idx = steps.indexOf(t.status);
  const next = {RECRUITING:'CLOSED',CLOSED:'PICKING_UP',PICKING_UP:'DELIVERING',DELIVERING:'DONE'};
  let html = '<h2>🔧 发车人操作（状态流转）</h2>';
  Object.keys(next).forEach(function(s){
    const target = next[s];
    html += '<span class="pill '+(s===t.status?'on':'')+'" data-go="'+target+'">'+
      (LABEL[s]||s)+' → '+(LABEL[target]||target)+'</span>';
  });
  if(t.status!=='DONE'){
    html += '<div style="margin-top:8px"><button data-go="DONE">直接标记完成</button></div>';
  }
  // 团长支付状态操作：未支付时给出「我已支付」按钮
  if(t.driverOrderId && !t.driverPaid){
    html += '<div style="margin-top:8px"><button class="ghost" data-paid="1">💰 我已支付（取消 15 分钟倒计时）</button></div>';
  }
  $('memActions').innerHTML = html;
}
function saveDriverSecret(){
  const code = current && current.code;
  if(!code){ setSecretStatus('warn','请先打开一个车次'); return; }
  const v = ($('driverSecret').value||'').trim();
  if(!v){ setSecretStatus('warn','请先粘贴 driverSecret'); return; }
  setSecretFor(code, v);
  setSecretStatus('ok','✅ 本车次密钥已保存到本机。现在可以改状态、踢人、标记已支付。');
  renderActions(current||{});
}
function clearDriverSecret(){
  const code = current && current.code;
  setSecretFor(code, '');
  const inp = $('driverSecret'); if(inp) inp.value = '';
  setSecretStatus('','');
  renderActions(current||{});
}
function setSecretStatus(kind, msg){
  const box = $('secretStatus'); if(!box) return;
  box.className = 'secret-status'+(kind?' '+kind:'');
  box.textContent = msg||'';
}
// 司机密钥按车次隔离存储（避免一份密钥被套用到所有车次）
function secretFor(code){ return (window.__secrets && window.__secrets[code]) || ''; }
function setSecretFor(code, v){
  window.__secrets = window.__secrets || {};
  if(v){ window.__secrets[code] = v; } else { delete window.__secrets[code]; }
  try{ localStorage.setItem('shaomai.driverSecrets', JSON.stringify(window.__secrets)); }catch(e){}
}
// 密钥面板：独立于 tripHead，轮询刷新不会清空用户输入
function syncSecretPanel(code){
  const p = $('secretPanel'); if(!p) return;
  if(current){ p.style.display='block'; } else { p.style.display='none'; return; }
  const key = code || (current && current.code) || '';
  const inp = $('driverSecret');
  if(inp && document.activeElement !== inp){ inp.value = secretFor(key); }
  if(secretFor(key)) setSecretStatus('ok','✅ 本车次密钥已保存到本机。现在可以改状态、踢人、标记已支付。');
  else setSecretStatus('','');
}
async function goStatus(s){
  const sec = secretFor(current && current.code);
  if(!sec){ setSecretStatus('warn','请先粘贴本车次的司机密钥 driverSecret（发车后由 Skill 给出）'); $('driverSecret').focus(); return; }
  try{ const t = await api('/api/trips/'+encodeURIComponent(current.code),'PATCH',{status:s,driverSecret:sec});
    current = t; renderMembers(t); renderActions(t);
    $('tripHead').querySelector('.badge').textContent = (LABEL[t.status]||t.status);
    setSecretStatus('ok','✅ 状态已更新为「'+(LABEL[t.status]||t.status)+'」');
  }catch(e){ setSecretStatus('err','操作失败：'+e.message); }
}
async function markPaid(){
  const sec = secretFor(current && current.code);
  if(!sec){ setSecretStatus('warn','请先粘贴本车次的司机密钥 driverSecret（发车后由 Skill 给出）'); $('driverSecret').focus(); return; }
  try{
    const t = await api('/api/trips/'+encodeURIComponent(current.code)+'/paid','POST',{driverSecret:sec});
    current = t; renderActions(t); loadActive();
    setSecretStatus('ok','✅ 已标记为已支付');
  }catch(e){ setSecretStatus('err','操作失败：'+e.message); }
}
async function kick(mid){
  const sec = secretFor(current && current.code);
  if(!sec){ setSecretStatus('warn','请先粘贴本车次的司机密钥 driverSecret'); $('driverSecret').focus(); return; }
  if(!confirm('确认把该乘客踢下车？')) return;
  try{ const t = await api('/api/trips/'+encodeURIComponent(current.code)+'/members/'+mid,'DELETE',{driverSecret:sec});
    current = t; renderMembers(t); loadActive();
    setSecretStatus('ok','✅ 已把该乘客移下车');
  }catch(e){ setSecretStatus('err','操作失败：'+e.message); }
}

async function doCreate(){ alert('发车已移至捎麦 Skill 自动完成，看板仅作协同展示。'); }
async function doJoin(){ alert('上车已移至捎麦 Skill 自动完成，看板仅作协同展示。'); }
function showList(){ openCode = null; $('detail').style.display='none'; $('list').style.display='block'; loadActive(); }
// 事件委托：点卡片打开详情（在途 + 已结束两个列表都生效）
$('activeList').addEventListener('click', function(e){
  const c = e.target.closest('.card'); if(c) openTrip(c.dataset.code);
});
$('closedList').addEventListener('click', function(e){
  const c = e.target.closest('.card'); if(c) openTrip(c.dataset.code);
});
// 事件委托：状态流转 pill / 直接完成 / 踢人（用 data 属性传参，避免内联 onclick 的引号嵌套）
$('memActions').addEventListener('click', function(e){
  const go = e.target.closest('[data-go]'); if(go){ goStatus(go.dataset.go); return; }
  const kk = e.target.closest('[data-kick]'); if(kk){ kick(kk.dataset.kick); return; }
  if(e.target.closest('[data-paid]')){ markPaid(); }
});
// 静态按钮
$('backBtn').addEventListener('click', showList);
$('copyCodes').addEventListener('click', copyCodes);
// 司机密钥：保存 / 清除
$('btnSaveSecret').addEventListener('click', saveDriverSecret);
$('btnClearSecret').addEventListener('click', clearDriverSecret);
$('driverSecret').addEventListener('keydown', function(e){ if(e.key==='Enter'){ e.preventDefault(); saveDriverSecret(); } });
// 恢复上次保存的密钥（本机）
try{ window.__secrets = JSON.parse(localStorage.getItem('shaomai.driverSecrets') || '{}') || {}; }catch(e){ window.__secrets = {}; }
// 初始加载 + 轮询
loadActive();
setInterval(function(){ if($('detail').style.display!=='block') loadActive(); }, 5000);
setInterval(function(){ if(openCode){ openTrip(openCode); } }, 3000);
</script>
</body>
</html>`;

// ---------- 入口 ----------
export default {
  async fetch(request, env) {
    await ensureSchema(env);
    const url = new URL(request.url);
    const started = Date.now();
    // 日志开关：默认记录 API 请求；页面与日志接口本身不记
    const loggable = url.pathname.startsWith('/api/') && !url.pathname.startsWith('/api/logs');
    const ip = getIp(request);
    const ua = request.headers.get('User-Agent') || '';
    try {
      if (url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/board') {
        return new Response(DASHBOARD, {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }
      if (url.pathname.startsWith('/api/')) {
        try {
          const resp = await handleApi(env, request, url);
          if (loggable) {
            await writeLog(env, {
              method: request.method,
              path: url.pathname + (url.search || ''),
              action: url.pathname.replace('/api/', '').split('/')[0],
              status: resp.status,
              durationMs: Date.now() - started,
              ip,
              ua,
              detail: '',
            });
          }
          return resp;
        } catch (e) {
          if (loggable) {
            await writeLog(env, {
              method: request.method,
              path: url.pathname,
              action: 'error',
              status: 500,
              durationMs: Date.now() - started,
              ip,
              ua,
              detail: String(e && e.message ? e.message : e).slice(0, 500),
            });
          }
          return err('服务端错误: ' + e.message, 500);
        }
      }
      return new Response('Not Found', { status: 404 });
    } catch (e) {
      return err('服务端错误: ' + e.message, 500);
    }
  },
};
