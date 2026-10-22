#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
捎麦（Shaomai）后端客户端 · 零依赖（只用 Python 标准库）

对应后端：单文件 Cloudflare Worker（仓库 server/worker.js），REST 接口见 SKILL.md / 方案文档 §4.2。
全部用标准库 urllib / json / hashlib / argparse / os / sys / getpass，无任何第三方依赖。

用法（命令行，输出统一 JSON，便于 Skill / agent 解析）：
  python shaomai_client.py create --name 阿强 --office "软件大道XX大厦A座" \
      --store MCD001 --store-name "麦当劳(XX店)" --max 6 --note "12:30出发" \
      --order ORD1 [--paid]
  python shaomai_client.py active
  python shaomai_client.py get <CODE>
  python shaomai_client.py join <CODE> --name 小李 --return-label "软件大道XX大厦B座" --order ORD1
  python shaomai_client.py code <CODE> <MEMBER_ID> --pickup A1B2 --locker 8848
  python shaomai_client.py status <CODE> CLOSED
  python shaomai_client.py pay <CODE> [--order ORD1]
  python shaomai_client.py leave <CODE> <MEMBER_ID>
  python shaomai_client.py kick <CODE> <MEMBER_ID>     # 司机踢人（自动带 driverSecret）

支付倒计时：create 带 --order 时，团长订单进入 15 分钟支付倒计时；15 分钟内仍未标记已支付，
该单自动从看板隐藏。团长付款后用 pay <CODE> 标记已支付（--paid 可在发车时直接声明已付）。

轻量鉴权：create 会自动先 POST /api/ticket 领取一次性发车票据（服务端限流发放、一票一单）；
join 返回 memberSecret、create 返回 driverSecret，均自动存入脚本同目录 shaomai_state.json，
供 code / status / leave / kick / watch 自动携带，无需手工传密钥（该文件含敏感密钥，勿外泄/提交）。

配置（环境变量）：
  SHAOMAI_BACKEND    后端地址（可选；默认用公共服务 https://shaomai.win，装完即用）。
                     自建后端时才需设置，填自己的 Worker URL，如 https://shaomai.xxx.workers.dev
  SHAOMAI_USER       匿名用户标识种子（可选；默认取系统用户，跨设备/会话稳定）
  SHAOMAI_USER_SALT  匿名化盐（可选；团队内统一后同一人可稳定识别）
"""

import argparse
import getpass
import hashlib
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


DEFAULT_BACKEND = "https://shaomai.win"
# 必须带自定义 UA：urllib 默认的 "Python-urllib/3.x" 会被 Cloudflare 的浏览器签名检测拦下（403 Error 1010），
# 导致所有从本仓库安装 skill 的用户都连不上看板。带上普通客户端 UA 即可正常访问。
USER_AGENT = "shaomai-client/1.0 (+https://github.com/RobinMcdZhang/mcd-shaomai)"


def backend():
    """后端地址：优先读环境变量 SHAOMAI_BACKEND（自建时用），未设则落到默认公共服务。"""
    url = os.environ.get("SHAOMAI_BACKEND", "").strip().rstrip("/") or DEFAULT_BACKEND
    if not url.startswith(("http://", "https://")):
        die(f"SHAOMAI_BACKEND 格式不对：{url!r}（应为 http(s) 开头的地址，如 {DEFAULT_BACKEND}）")
    return url


def anon_user():
    seed = (os.environ.get("SHAOMAI_USER")
            or os.environ.get("USER")
            or os.environ.get("USERNAME")
            or getpass.getuser()
            or "anon")
    salt = os.environ.get("SHAOMAI_USER_SALT", "shaomai")
    return hashlib.sha256((salt + ":" + seed).encode("utf-8")).hexdigest()[:16]


def _req(method, path, body=None):
    url = backend() + path
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": USER_AGENT,
    }
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw = resp.read().decode("utf-8")
            return resp.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "ignore")
        try:
            payload = json.loads(raw)
        except Exception:
            payload = {"error": raw or e.reason}
        return e.code, payload
    except Exception as e:  # noqa: BLE001 - 网络/解析异常统一透传给调用方
        return 0, {"error": str(e)}


def die(msg, code=1):
    sys.stderr.write("ERROR: " + msg + "\n")
    sys.exit(code)


def out(obj):
    print(json.dumps(obj, ensure_ascii=False))


STATE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "shaomai_state.json")


def state_load():
    try:
        with open(STATE_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def state_save(s):
    try:
        with open(STATE_PATH, "w", encoding="utf-8") as f:
            json.dump(s, f, ensure_ascii=False, indent=2)
    except Exception:
        pass


def q(s):
    """URL 安全编码，保留可见字符。"""
    return urllib.parse.quote(str(s), safe="")


def cmd_create(a):
    uid = anon_user()
    # 1) 先领一次性发车票据（轻量鉴权：服务端限流发放，一票一单）
    st0, tk = _req("POST", "/api/ticket", {"userId": uid})
    if st0 != 201 or not tk.get("ticket"):
        out({"status": st0, "error": tk.get("error", "领取发车票据失败")})
        return
    # 2) 带票据发车
    body = {
        "ticket": tk["ticket"],
        "userId": uid,
        "driverId": uid,
        "driverName": a.name,
        "driverFloor": a.floor or "",
        "officeLabel": a.office,
        "driverAddr": a.addr or "",
        "storeCode": a.store,
        "storeName": a.store_name or "",
        "maxMembers": a.max,
        "note": a.note or "",
        # 团长自己的订单号：带上后进入「支付倒计时」，15 分钟内未标记已支付则从看板隐藏
        "driverOrderId": a.order or "",
        "driverPaid": 1 if a.paid else 0,
        # 有效期（分钟）：必须覆盖到出发时刻，默认服务端 120 分钟
        "ttl": a.ttl or 0,
    }
    st, res = _req("POST", "/api/trips", body)
    # 存司机密钥，供后续 status/kick 自动使用
    if st == 201 and res.get("driverSecret") and res.get("code"):
        s = state_load()
        s.setdefault("drivers", {})[res["code"]] = res["driverSecret"]
        state_save(s)
    out({"status": st, **res})


def cmd_active(a):
    """列出在途单；可按门店(store)/办公点(office)过滤，供「发车前先看有没有同店顺路车」使用。"""
    st, res = _req("GET", "/api/trips/active")
    trips = res if isinstance(res, list) else res.get("trips", [])
    if isinstance(trips, list):
        if a.store:
            trips = [t for t in trips if str(t.get("storeCode", "")) == str(a.store)]
        if a.office:
            trips = [t for t in trips if str(t.get("officeLabel", "")) == str(a.office)]
    out({"status": st, "trips": trips, "count": len(trips) if isinstance(trips, list) else 0})


def cmd_get(a):
    st, res = _req("GET", "/api/trips/" + q(a.code))
    out({"status": st, **res})


def cmd_join(a):
    uid = anon_user()
    body = {
        "userId": uid,
        "nickName": a.name,
        "floor": a.floor or "",
        "returnLabel": a.return_label,
        "returnAddr": a.addr or "",
        "orderId": a.order or "",
    }
    st, res = _req("POST", "/api/trips/" + q(a.code) + "/join", body)
    # 存成员密钥，供后续 code/leave 自动使用
    if st == 201 and res.get("memberSecret") and res.get("memberId"):
        s = state_load()
        s.setdefault("members", {})[res["memberId"]] = res["memberSecret"]
        state_save(s)
    out({"status": st, **res})


def cmd_code(a):
    s = state_load()
    ms = s.get("members", {}).get(a.member)
    body = {}
    if ms:
        body["memberSecret"] = ms
    if a.order:
        body["orderId"] = a.order
    if a.order_status:
        body["orderStatus"] = a.order_status
    if a.pickup:
        body["pickupCode"] = a.pickup
    if a.locker:
        body["lockerCode"] = a.locker
    if a.locker_qr:
        body["lockerQrCode"] = a.locker_qr
    path = "/api/trips/%s/members/%s/code" % (q(a.code), a.member)
    st, res = _req("POST", path, body if body else None)
    out({"status": st, **res})


def cmd_status(a):
    s = state_load()
    ds = s.get("drivers", {}).get(a.code)
    body = {"status": a.status}
    if ds:
        body["driverSecret"] = ds
    st, res = _req("PATCH", "/api/trips/" + q(a.code), body)
    out({"status": st, **res})


def cmd_pay(a):
    """团长标记自己的订单已支付：取消看板的 15 分钟支付倒计时。"""
    s = state_load()
    ds = s.get("drivers", {}).get(a.code)
    body = {}
    if ds:
        body["driverSecret"] = ds
    if a.order:
        body["orderId"] = a.order
    path = "/api/trips/%s/paid" % q(a.code)
    st, res = _req("POST", path, body if body else None)
    out({"status": st, **res})


def cmd_leave(a):
    s = state_load()
    ms = s.get("members", {}).get(a.member)
    body = {}
    if ms:
        body["memberSecret"] = ms
    path = "/api/trips/%s/members/%s" % (q(a.code), a.member)
    st, res = _req("DELETE", path, body if body else None)
    out({"status": st, **res})


def cmd_kick(a):
    """司机踢人下车：用司机密钥 driverSecret（自动从本地状态取）。"""
    s = state_load()
    ds = s.get("drivers", {}).get(a.code)
    body = {}
    if ds:
        body["driverSecret"] = ds
    path = "/api/trips/%s/members/%s" % (q(a.code), a.member)
    st, res = _req("DELETE", path, body if body else None)
    out({"status": st, **res})


def cmd_watch(a):
    """后台盯码：每 --interval 秒跑一次 --check 命令，一旦产出取餐码就推给看板。

    --check 命令约定：
      - 输出取餐码纯文本（如 A1B2），或
      - 输出 JSON {"pickupCode":"A1B2","lockerCode":"8848"}（字段名兼容 pickup/locker/status）
      - 空输出表示还没出码，继续等。
    推送成功后退出（便于外层自动化据此停止）。
    """
    code, member, interval, timeout = a.code, a.member, a.interval, a.timeout
    pushed = False
    while True:
        out_text = ""
        try:
            r = subprocess.run(a.check, shell=True, capture_output=True, text=True, timeout=timeout)
            out_text = (r.stdout or "").strip()
        except Exception as e:  # noqa: BLE001
            sys.stderr.write("watch: check 命令异常 %s\n" % e)
        if out_text:
            pickup, locker, order_status = out_text, "", ""
            try:
                obj = json.loads(out_text)
                if isinstance(obj, dict):
                    pickup = obj.get("pickupCode") or obj.get("pickup") or ""
                    locker = obj.get("lockerCode") or obj.get("locker") or ""
                    order_status = obj.get("orderStatus") or obj.get("status") or ""
            except Exception:
                pass
            if pickup:
                body = {"pickupCode": pickup}
                if locker:
                    body["lockerCode"] = locker
                if order_status:
                    body["orderStatus"] = order_status
                ms = state_load().get("members", {}).get(member)
                if ms:
                    body["memberSecret"] = ms
                st, res = _req("POST", "/api/trips/%s/members/%s/code" % (q(code), member), body)
                out({"status": st, "pushed": True, "pickupCode": pickup, **res})
                pushed = True
                break
        if a.once:
            break
        time.sleep(interval)
    if not pushed:
        out({"status": 0, "pushed": False, "note": "check 未产出取餐码"})


def build_parser():
    p = argparse.ArgumentParser(prog="shaomai_client", description="捎麦后端客户端（零依赖）")
    sub = p.add_subparsers(dest="cmd", required=True)

    pc = sub.add_parser("create", help="发车：发一个顺路单")
    pc.add_argument("--name", required=True, help="发车人昵称")
    pc.add_argument("--office", required=True, help="办公/收餐点楼栋标签（跨用户展示）")
    pc.add_argument("--store", required=True, help="麦当劳 storeCode（必须与乘客一致）")
    pc.add_argument("--store-name", default="", help="门店名称（展示用）")
    pc.add_argument("--floor", default="", help="发车人楼层")
    pc.add_argument("--addr", default="", help="完整办公地址（私有，仅本人可见）")
    pc.add_argument("--max", type=int, default=6, help="最多上车人数，默认 6")
    pc.add_argument("--note", default="", help="备注，如出发时间")
    pc.add_argument("--order", default="", help="团长自己的麦当劳订单号（带上则启动 15 分钟支付倒计时）")
    pc.add_argument("--paid", action="store_true", help="团长已支付（默认视为待支付）")
    pc.add_argument("--ttl", type=int, default=0, help="有效期（分钟），默认 120；须覆盖到出发时刻")
    pc.set_defaults(func=cmd_create)

    pa = sub.add_parser("active", help="列出发车中的顺路单")
    pa.add_argument("--store", default="", help="只看该 storeCode 的单（同店顺路车查询）")
    pa.add_argument("--office", default="", help="只看该办公点楼栋标签的单")
    pa.set_defaults(func=cmd_active)

    pg = sub.add_parser("get", help="查看某个顺路单详情")
    pg.add_argument("code", help="6 位单号")
    pg.set_defaults(func=cmd_get)

    pj = sub.add_parser("join", help="上车：加入一个顺路单")
    pj.add_argument("code", help="6 位单号")
    pj.add_argument("--name", required=True, help="乘客昵称")
    pj.add_argument("--return-label", dest="return_label", required=True, help="我的收餐点楼栋标签（用于 LLM 判顺带）")
    pj.add_argument("--floor", default="")
    pj.add_argument("--addr", default="")
    pj.add_argument("--order", default="", help="麦当劳订单号（下单后填）")
    pj.set_defaults(func=cmd_join)

    pk = sub.add_parser("code", help="推送取餐码/柜码给看板")
    pk.add_argument("code", help="6 位单号")
    pk.add_argument("member", help="成员 ID（join 返回）")
    pk.add_argument("--pickup", default="", help="取餐码 pickupCode")
    pk.add_argument("--locker", default="", help="取餐柜密码 lockerCode")
    pk.add_argument("--locker-qr", dest="locker_qr", default="", help="取餐柜二维码 lockerQrCode")
    pk.add_argument("--order", default="")
    pk.add_argument("--order-status", dest="order_status", default="")
    pk.set_defaults(func=cmd_code)

    ps = sub.add_parser("status", help="发车人改状态")
    ps.add_argument("code", help="6 位单号")
    ps.add_argument("status", choices=["RECRUITING", "CLOSED", "PICKING_UP", "DELIVERING", "DONE"])
    ps.set_defaults(func=cmd_status)

    pp = sub.add_parser("pay", help="团长标记自己的订单已支付（取消 15 分钟倒计时，自动带 driverSecret）")
    pp.add_argument("code", help="6 位单号")
    pp.add_argument("--order", default="", help="麦当劳订单号（发车时未带可在此补）")
    pp.set_defaults(func=cmd_pay)

    pl = sub.add_parser("leave", help="下车/取消（成员自退，自动带 memberSecret）")
    pl.add_argument("code", help="6 位单号")
    pl.add_argument("member", help="成员 ID")
    pl.set_defaults(func=cmd_leave)

    pk2 = sub.add_parser("kick", help="司机踢人下车（自动带 driverSecret）")
    pk2.add_argument("code", help="6 位单号")
    pk2.add_argument("member", help="成员 ID")
    pk2.set_defaults(func=cmd_kick)

    pw = sub.add_parser("watch", help="后台盯码：每 N 秒跑一次 --check，出码自动推看板")
    pw.add_argument("code", help="6 位单号")
    pw.add_argument("member", help="成员 ID（join 返回）")
    pw.add_argument("--check", required=True,
                    help="取餐码检测命令：输出取餐码文本，或 JSON {pickupCode,lockerCode}")
    pw.add_argument("--interval", type=int, default=10, help="轮询间隔秒，默认 10")
    pw.add_argument("--timeout", type=int, default=10, help="单次命令超时秒，默认 10")
    pw.add_argument("--once", action="store_true", help="只检测一次后退出")
    pw.set_defaults(func=cmd_watch)
    return p


if __name__ == "__main__":
    args = build_parser().parse_args()
    args.func(args)
