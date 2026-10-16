#!/usr/bin/env python3
"""Xác minh CHỈ ĐỌC API HR console trên 3010 bằng tài khoản Nhân sự thật (G8).

    python3 -I integrations/openclaw/production/hr-verify-3010.py [--base http://127.0.0.1:3010]

- Nhân sự tự gõ SĐT + mật khẩu; mật khẩu nhập ẩn (getpass). Mật khẩu và token chỉ nằm trong bộ nhớ
  tiến trình: không in, không ghi file, không đưa vào tham số dòng lệnh / biến môi trường.
- Sau đăng nhập chỉ gọi GET. Không duyệt / từ chối / dừng / mở gì, không đổi cờ dừng khẩn.
- Chỉ in mã HTTP, mã vai trò và số đếm — không in nội dung tin nhắn, tên, SĐT ứng viên.
"""
import argparse
import getpass
import json
import subprocess
import sys
import urllib.error
import urllib.request

ROLES_JS = "/var/www/sales-management/dist/recruitment/recruitment.roles.js"


def call(base, method, path, token=None, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method)
    req.add_header("accept", "application/json")
    if data is not None:
        req.add_header("content-type", "application/json")
    if token:
        req.add_header("authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            raw = r.read()
            status = r.status
    except urllib.error.HTTPError as e:
        raw, status = e.read(), e.code
    try:
        return status, json.loads(raw or b"null")
    except ValueError:
        return status, None


def roles_from_running_build():
    js = (f"const r=require('{ROLES_JS}');"
          "console.log(JSON.stringify({view:r.RECRUITMENT_VIEW_ROLES,ops:r.RECRUITMENT_OPERATIONS_ROLES}))")
    out = subprocess.run(["node", "-e", js], capture_output=True, text=True, check=False)
    return json.loads(out.stdout) if out.returncode == 0 else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:3010")
    base = ap.parse_args().base.rstrip("/")
    if not sys.stdin.isatty():
        sys.exit("Chạy trực tiếp trong terminal (cần nhập mật khẩu ẩn).")

    phone = input("SĐT đăng nhập (tài khoản Nhân sự): ").strip()
    password = getpass.getpass("Mật khẩu (không hiện): ")
    status, body = call(base, "POST", "/auth/login", body={"phone": phone, "password": password})
    password = None
    token = (body or {}).get("access_token") if isinstance(body, dict) else None
    if status not in (200, 201) or not token:
        sys.exit(f"FAIL đăng nhập (HTTP {status})")
    roles = list(((body or {}).get("user") or {}).get("roles") or [])
    body = None
    print(f"PASS đăng nhập (HTTP {status}) · vai trò: {', '.join(roles) or '-'}")

    allowed = roles_from_running_build()
    if allowed:
        can_view = any(r in allowed["view"] for r in roles)
        can_ops = any(r in allowed["ops"] for r in roles)
        print(f"     quyền theo bản đang chạy: xem={'có' if can_view else 'KHÔNG'} · vận hành={'có' if can_ops else 'KHÔNG'}")

    checks = []

    def get(label, path, summarize):
        st, js = call(base, "GET", path, token=token)
        ok = st == 200
        info = ""
        if ok:
            try:
                info = summarize(js)
            except Exception:  # noqa: BLE001 — chỉ là phần tóm tắt
                info = "(không tóm tắt được)"
        checks.append(ok)
        print(f"{'PASS' if ok else 'FAIL'} GET {path} → {st} {info}")

    get("overview", "/recruitment/operations/overview", lambda j: "· khối: " + ", ".join(sorted(j.keys())))
    get("approvals", "/recruitment/operations/approvals?view=pending", lambda j: f"· chờ duyệt: {j.get('total')}")
    get("approvals-all", "/recruitment/operations/approvals?view=all", lambda j: f"· tổng bản duyệt: {j.get('total')}")
    get("conversations", "/recruitment/conversations?limit=1", lambda j: f"· hội thoại: {j.get('total')}")
    get("runtime", "/recruitment/operations/runtime-controls",
        lambda j: "· dừng khẩn AI/WORKER/OUTBOUND = "
                  f"{j['aiHalted']}/{j['workerHalted']}/{j['outboundHalted']} · failsafe {j['failsafeHalted']}")
    get("ai-usage", "/recruitment/operations/ai-usage",
        lambda j: f"· hôm nay {j['today']['turns']} lượt / {j['today']['tokens']} token · trần {json.dumps(j['limits'])}"
                  f" · pilot {j['pilot']['senders']} người")
    token = None

    total, passed = len(checks), sum(checks)
    print(f"\nKẾT QUẢ: {passed}/{total} API đọc PASS — {'PASS' if passed == total else 'FAIL'}")
    sys.exit(0 if passed == total else 1)


if __name__ == "__main__":
    main()
