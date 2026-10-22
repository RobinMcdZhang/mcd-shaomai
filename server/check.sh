#!/usr/bin/env bash
# 看板前端自检：node --check worker.js 只检查 Worker 源码，
# 但看板是一个内嵌 <script> 的 HTML 字符串，语法错误会静默导致整页 JS 不执行（卡片全不渲染）。
# 这个脚本额外把DASHBOARD 模板里的内联 JS 抽出来单独做语法检查。
set -euo pipefail
cd "$(dirname "$0")"

PY="python"
for c in python python3 py; do command -v "$c" >/dev/null 2>&1 && { PY="$c"; break; }; done
command -v node >/dev/null 2>&1 || { echo "需要 node"; exit 1; }

echo "== 1/3 Worker 源码语法 =="
node --check worker.js && echo "   OK"

echo "== 2/3 看板内联 JS 语法 =="
"$PY" - <<'PYEOF'
import re, sys
s = open('worker.js', encoding='utf-8').read()
m = re.search(r'const DASHBOARD = `(.*?)`;', s, re.S)
if not m:
    sys.exit('   未找到 DASHBOARD 模板')
scripts = re.findall(r'<script>(.*?)</script>', m.group(1), re.S)
open('.board_check.js', 'w', encoding='utf-8').write('\n'.join(scripts))
print(f'   抽出 {len(scripts)} 个 script 块')
PYEOF
node --check .board_check.js && echo "   OK"
rm -f .board_check.js

echo "== 3/3 内联 onclick 引号嵌套检查 =="
if grep -n "onclick=\"[^\"]*\\\\'" worker.js >/dev/null 2>&1; then
  echo "   ❌ 发现内联 onclick 内嵌转义单引号（会导致看板 JS 语法错误）"
  grep -n "onclick=\"[^\"]*\\\\'" worker.js
  exit 1
fi
echo "   OK（无高危嵌套）"
echo
echo "全部通过。"