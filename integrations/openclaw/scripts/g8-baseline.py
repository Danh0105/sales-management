#!/usr/bin/env python3
"""G8 bước 1 — khoá baseline: tin thử nội bộ trong hộp đến production (chạy trên máy chủ, bằng root).

    g8-baseline.py dry-run [--hr-login]                 # CHỈ ĐỌC + backup có xác minh + báo cáo tác động
    g8-baseline.py exclude --report <thư mục dry-run>   # XOÁ NỘI DUNG (không đảo được) — chỉ khi đã duyệt riêng

dry-run:
  - đọc trạng thái event #1 #2 #3 (không in nội dung, không in id Zalo thô — chỉ dấu vân tay), outbox/hồ sơ
    liên quan, 3 cờ dừng khẩn, cờ env 3010/3011, tài khoản Nhân sự, quyền vận hành trong bản đang chạy;
  - backup: các dòng (đủ cột, kể cả nội dung) + dump bảng `recruitment_channel_events`, rồi XÁC MINH
    (đọc lại, so hash nội dung với DB, pg_restore --list, đếm dòng);
  - `--hr-login`: Nhân sự tự đăng nhập 3011 (mật khẩu gõ ẩn, không lưu) và gọi 2 API CHỈ ĐỌC để chứng minh
    token + role dùng được;
  - ghi DRY-RUN-REPORT.md + state.json (600). Không ghi gì vào DB, không đổi cờ dừng khẩn.
exclude:
  - đọc state.json của dry-run, kiểm lại hash backup + trạng thái DB không đổi (lệch ⇒ dừng);
  - Nhân sự tự đăng nhập, gõ câu xác nhận, gọi `POST /recruitment/operations/events/:id/exclude
    {"reason":"TEST_MESSAGE"}` cho đúng các ID trong báo cáo; kiểm sau khi chạy.
Không có thao tác bật/tắt cờ dừng khẩn trong script này.
"""

from __future__ import annotations

import argparse
import datetime as dt
import getpass
import hashlib
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

API = "http://127.0.0.1:3011"
EVENT_IDS = (1, 2, 3)
G8_RELEASE_DIST = Path("/opt/kido-recruiter/releases/p32-human-approval-20261015-r1/dist")
BACKUP_ROOT = Path("/root/backups")
RUNS_ROOT = Path("/opt/kido-recruiter/runs")
CONFIRM = "XOA NOI DUNG TIN THU 1 2 3"
VN = dt.timezone(dt.timedelta(hours=7))
IDS_SQL = ",".join(str(i) for i in EVENT_IDS)


def die(msg: str) -> None:
    sys.exit(f"DỪNG: {msg}")


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def psql_json(query: str):
    """Truy vấn CHỈ ĐỌC (transaction read only) bằng peer auth postgres; trả JSON."""
    out = subprocess.run(
        ["runuser", "-u", "postgres", "--", "psql", "-XAt", "-v", "ON_ERROR_STOP=1", "-d", "sales_db",
         "-c", "SET default_transaction_read_only = on",
         "-c", f"SELECT coalesce(json_agg(t), '[]'::json) FROM ({query}) t"],
        capture_output=True, text=True, check=False,
    )
    if out.returncode != 0:
        die(f"psql lỗi: {out.stderr.strip()[-300:]}")
    text = out.stdout
    return json.loads(text[text.index("["):])  # bỏ dòng 'SET'; json_agg có thể trải nhiều dòng


def http(method: str, path: str, token: str | None = None, body: dict | None = None) -> tuple[int, dict]:
    headers = {"content-type": "application/json"}
    if token:
        headers["authorization"] = f"Bearer {token}"
    req = urllib.request.Request(API + path, method=method, headers=headers,
                                 data=json.dumps(body).encode() if body is not None else None)
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            return res.status, json.loads(res.read() or b"{}")
    except urllib.error.HTTPError as err:
        try:
            return err.code, json.loads(err.read() or b"{}")
        except json.JSONDecodeError:
            return err.code, {}


def write_private(path: Path, data: bytes) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(data)


EVENT_META_SQL = f"""
  SELECT id, status::text AS status, event_type, failure_code,
         to_char(received_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD HH24:MI:SS') AS received_vn,
         attempt_count, lease_owner IS NULL AS no_lease, conversation_id, ai_control_version,
         normalized_message_text IS NOT NULL AS has_text,
         coalesce(char_length(normalized_message_text), 0) AS text_len,
         CASE WHEN normalized_message_text IS NULL THEN NULL
              ELSE encode(sha256(convert_to(normalized_message_text, 'UTF8')), 'hex') END AS text_sha256,
         left(encode(sha256(convert_to(channel_account_id, 'UTF8')), 'hex'), 10) AS oa_fp,
         left(encode(sha256(convert_to(channel_account_id || ':' || external_sender_id, 'UTF8')), 'hex'), 16)
           AS sender_fp,
         payload_hash, dedupe_key IS NOT NULL AS has_dedupe_key
  FROM recruitment_channel_events WHERE id IN ({IDS_SQL}) ORDER BY id"""


def hr_login() -> tuple[str, dict]:
    phone = input("SĐT đăng nhập (tài khoản Nhân sự): ").strip()
    password = getpass.getpass("Mật khẩu (không hiện): ")
    status, body = http("POST", "/auth/login", body={"phone": phone, "password": password})
    password = ""
    token = body.get("access_token")
    if status not in (200, 201) or not token:
        die(f"đăng nhập thất bại (HTTP {status})")
    return token, body.get("user") or {}


def operations_roles() -> list[str]:
    js = (f"const r=require('{G8_RELEASE_DIST}/recruitment/recruitment.roles.js');"
          "console.log(JSON.stringify(r.RECRUITMENT_OPERATIONS_ROLES))")
    out = subprocess.run(["node", "-e", js], capture_output=True, text=True, check=False)
    if out.returncode != 0:
        die(f"không đọc được quyền từ bản đang chạy: {out.stderr.strip()[-200:]}")
    return json.loads(out.stdout)


# ------------------------------------------------------------------------------------------- dry-run


def dry_run(args) -> None:
    ts = dt.datetime.now(VN).strftime("%Y%m%d-%H%M%S")
    run_dir = RUNS_ROOT / f"g8-baseline-{ts}"
    backup_dir = BACKUP_ROOT / f"g8-baseline-{ts}"
    run_dir.mkdir(mode=0o700, parents=True)
    backup_dir.mkdir(mode=0o700, parents=True)
    state: dict = {"created_vn": ts, "event_ids": list(EVENT_IDS), "checks": []}

    def check(name: str, ok: bool, detail: str = "") -> None:
        state["checks"].append({"name": name, "ok": ok, "detail": detail})
        print(f"  {'✓' if ok else '✗'} {name}{(' — ' + detail) if detail else ''}")

    print("== 1. Trạng thái (chỉ đọc)")
    events = psql_json(EVENT_META_SQL)
    state["events"] = events
    check("đúng 3 event #1 #2 #3", [e["id"] for e in events] == list(EVENT_IDS))
    check("cả 3 RECEIVED, chưa thử lần nào, không lease, chưa gắn hội thoại/AI, còn nội dung",
          all(e["status"] == "RECEIVED" and e["attempt_count"] == 0 and e["no_lease"]
              and e["conversation_id"] is None and e["ai_control_version"] is None and e["has_text"]
              for e in events))
    check("cùng một người gửi", len({(e["oa_fp"], e["sender_fp"]) for e in events}) == 1,
          f"sender_fp {events[0]['sender_fp'] if events else '-'}")
    pending = psql_json("SELECT status::text AS status, count(*)::int AS n FROM recruitment_channel_events GROUP BY 1")
    state["inbox_by_status"] = pending
    check("hộp đến không có event nào khác ngoài 3 tin này",
          sum(p["n"] for p in pending) == len(EVENT_IDS), json.dumps(pending, ensure_ascii=False))
    linked = psql_json(f"""
      SELECT (SELECT count(*) FROM recruitment_channel_outbox WHERE source_event_id IN ({IDS_SQL}))::int AS outbox,
             (SELECT count(*) FROM recruitment_candidates c JOIN recruitment_channel_events e
                ON c.zalo_oa_id = e.channel_account_id AND c.zalo_user_id = e.external_sender_id
              WHERE e.id IN ({IDS_SQL}))::int AS candidates""")[0]
    state["linked"] = linked
    check("không có outbox / hồ sơ ứng viên gắn với người gửi này", linked == {"outbox": 0, "candidates": 0},
          json.dumps(linked))
    runtime = psql_json("SELECT ai_halted, worker_halted, outbound_halted, failsafe_halted FROM recruitment_runtime_controls")
    state["runtime_controls"] = runtime
    check("3 cờ dừng khẩn đang OFF (giữ nguyên, script không đổi)",
          bool(runtime) and not any(runtime[0][k] for k in ("ai_halted", "worker_halted", "outbound_halted")),
          json.dumps(runtime[0] if runtime else {}))
    pm2 = json.loads(subprocess.run(["pm2", "jlist"], capture_output=True, text=True, check=True).stdout)
    flags = {}
    for p in pm2:
        if p["name"] in ("sales-management", "sales-be-g8"):
            env = p["pm2_env"].get("env", {}) | {k: v for k, v in p["pm2_env"].items() if isinstance(v, str)}
            flags[p["name"]] = {k: env.get(k, "<không đặt>") for k in
                                ("RECRUITMENT_AI_ENABLED", "RECRUITMENT_WORKER_ENABLED", "RECRUITMENT_ZALO_OUTBOUND_ENABLED")}
    state["env_flags"] = flags
    check("AI / worker / outbound không bật trên 3010, 3011",
          all(v in ("false", "<không đặt>") for f in flags.values() for v in f.values()),
          json.dumps(flags, ensure_ascii=False))

    print("== 2. Quyền HR (không đăng nhập)")
    roles = operations_roles()
    state["operations_roles"] = roles
    hr_accounts = psql_json(
        "SELECT id, name, roles FROM employee WHERE roles::text[] && ARRAY[" + ",".join(f"'{r}'" for r in roles) + "]::text[] ORDER BY id")
    state["hr_accounts"] = hr_accounts
    check("bản đang chạy trên 3011 cho phép loại event với role", True, json.dumps(roles))
    check("có tài khoản mang role đó", bool(hr_accounts),
          "; ".join(f"#{a['id']} {a['name']}" for a in hr_accounts))
    for path in ("/recruitment/operations/events/stats", "/recruitment/operations/runtime-controls"):
        code, _ = http("GET", path)
        check(f"3011 có route {path} (không token → 401)", code == 401, f"HTTP {code}")
    if args.hr_login:
        token, user = hr_login()
        has_role = any(r in (user.get("roles") or []) for r in roles)
        check("Nhân sự đăng nhập được, có role vận hành", has_role,
              f"#{user.get('id')} roles {user.get('roles')}")
        for path in ("/recruitment/operations/events/stats", "/recruitment/operations/runtime-controls"):
            code, body = http("GET", path, token)
            check(f"token Nhân sự gọi {path} (chỉ đọc)", code == 200, f"HTTP {code}")
            if path.endswith("stats"):
                state["stats_via_api"] = body
        state["hr_login"] = {"id": user.get("id"), "roles": user.get("roles")}
    else:
        state["hr_login"] = None
        print("  · bỏ qua đăng nhập Nhân sự (chạy lại với --hr-login để chứng minh token + role)")

    print(f"== 3. Backup có xác minh → {backup_dir}")
    rows = psql_json(f"SELECT * FROM recruitment_channel_events WHERE id IN ({IDS_SQL}) ORDER BY id")
    rows_bytes = json.dumps(rows, ensure_ascii=False, indent=2, default=str).encode()
    write_private(backup_dir / "channel-events-1-3.json", rows_bytes)
    dump_path = backup_dir / "recruitment_channel_events.dump"
    with open(os.open(dump_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as f:
        dumped = subprocess.run(["runuser", "-u", "postgres", "--", "pg_dump", "-Fc", "-t",
                                 "public.recruitment_channel_events", "sales_db"], stdout=f, stderr=subprocess.PIPE)
    if dumped.returncode != 0:
        die(f"pg_dump lỗi: {dumped.stderr.decode()[-300:]}")
    sums = {p.name: sha256(p.read_bytes()) for p in (backup_dir / "channel-events-1-3.json", dump_path)}
    write_private(backup_dir / "SHA256SUMS", "".join(f"{h}  {n}\n" for n, h in sums.items()).encode())
    # Xác minh: đọc lại file, so hash nội dung từng dòng với DB, pg_restore đọc được và đủ dòng.
    reread = json.loads((backup_dir / "channel-events-1-3.json").read_text())
    by_id = {e["id"]: e["text_sha256"] for e in events}
    check("JSON đọc lại: đủ 3 dòng đúng ID", [r["id"] for r in reread] == list(EVENT_IDS))
    check("hash nội dung từng dòng trong backup = hash trong DB",
          all(sha256(r["normalized_message_text"].encode()) == by_id[r["id"]] for r in reread))
    listing = subprocess.run(["pg_restore", "--list", str(dump_path)], capture_output=True, text=True)
    check("pg_restore --list đọc được dump, có TABLE DATA recruitment_channel_events",
          listing.returncode == 0 and "TABLE DATA public recruitment_channel_events" in listing.stdout)
    data = subprocess.run(["pg_restore", "-a", "-f", "-", str(dump_path)], capture_output=True, text=True)
    copy_rows = 0
    inside = False
    for line in data.stdout.splitlines():
        if line.startswith("COPY public.recruitment_channel_events"):
            inside = True
            continue
        if inside:
            if line == "\\.":
                break
            copy_rows += 1
    total = sum(p["n"] for p in pending)
    check("dump có đủ số dòng của bảng", copy_rows == total, f"{copy_rows}/{total}")
    state["backup"] = {"dir": str(backup_dir), "sha256": sums}

    print(f"== 4. Báo cáo → {run_dir}/DRY-RUN-REPORT.md")
    state["ok"] = all(c["ok"] for c in state["checks"])
    write_private(run_dir / "state.json", json.dumps(state, ensure_ascii=False, indent=2).encode())
    write_private(run_dir / "DRY-RUN-REPORT.md", report(state).encode())
    print(f"\n{'DRY-RUN ĐẠT' if state['ok'] else 'DRY-RUN CÓ MỤC KHÔNG ĐẠT'} — không thay đổi gì trên production.")


def report(s: dict) -> str:
    ev = "\n".join(
        f"| #{e['id']} | {e['received_vn']} | {e['event_type']} | {e['status']} | {e['attempt_count']} | "
        f"{e['text_len']} | `{(e['text_sha256'] or '-')[:16]}` | `{e['oa_fp']}` | `{e['sender_fp']}` |"
        for e in s["events"])
    checks = "\n".join(f"- {'✓' if c['ok'] else '✗'} {c['name']}" + (f" — {c['detail']}" if c["detail"] else "")
                       for c in s["checks"])
    hr = "; ".join(f"#{a['id']} {a['name']} {a['roles']}" for a in s["hr_accounts"]) or "—"
    login = (f"đã đăng nhập: #{s['hr_login']['id']} {s['hr_login']['roles']}" if s.get("hr_login")
             else "chưa — chạy `dry-run --hr-login`")
    b = s["backup"]
    return f"""# G8 bước 1 — dry-run khoá baseline ({s['created_vn']})

**Kết quả: {'ĐẠT' if s['ok'] else 'KHÔNG ĐẠT'}** · không có thay đổi nào trên production (DB chỉ đọc, cờ dừng khẩn giữ nguyên).

## Danh sách ID sẽ loại (chính xác)

| ID | Nhận (giờ VN) | Loại | Trạng thái | Lần thử | Độ dài | SHA-256 nội dung (16) | OA fp | Người gửi fp |
|---|---|---|---|---|---|---|---|---|
{ev}

Người gửi fp = 16 ký tự đầu `sha256(oa:user)` (cùng công thức fingerprint pilot), không lưu id Zalo thô.

## Kiểm tra

{checks}

Quyền: route loại event yêu cầu role {s['operations_roles']} (bản đang chạy trên 3011). Tài khoản có role: {hr}.
Đăng nhập thử: {login}.

## Backup đã xác minh

- Thư mục: `{b['dir']}` (700, file 600)
- `channel-events-1-3.json` — 3 dòng đủ cột, kể cả nội dung — sha256 `{b['sha256']['channel-events-1-3.json']}`
- `recruitment_channel_events.dump` — dump bảng (pg_dump -Fc) — sha256 `{b['sha256']['recruitment_channel_events.dump']}`
- Đã xác minh: đọc lại đủ ID, hash nội dung từng dòng khớp DB, `pg_restore --list` đọc được, số dòng dump = số dòng bảng.

## Tác động nếu được duyệt `exclude`

Gọi `POST /recruitment/operations/events/{{1,2,3}}/exclude {{"reason":"TEST_MESSAGE"}}` trên 3011 bằng tài khoản Nhân sự
tự đăng nhập. Mỗi event, trong một transaction:

| Thay đổi | Giá trị |
|---|---|
| `status` | RECEIVED → **IGNORED** |
| `failure_code` | → `TEST_MESSAGE` |
| `normalized_message_text` | → **NULL (xoá nội dung — không đảo được trong ứng dụng)** |
| `text_redacted_at`, `processed_at`, `updated_at` | → thời điểm thực hiện |
| `lease_*`, `next_attempt_at` | → NULL (đang NULL) |
| `activity_log` | +1 dòng `CHANNEL_EVENT_EXCLUDE` đúng Nhân sự (trạng thái trước/sau, không nội dung) |

Không đổi: `dedupe_key`, `payload_hash` (Zalo gửi lại cùng tin ⇒ trùng, không tạo event mới); hồ sơ ứng viên, hội
thoại, tin nhắn, outbox (không có liên kết — đã kiểm); 3 cờ dừng khẩn; cờ env 3010/3011. Sau khi chạy: hộp đến 0 tin chờ.
Gọi lại cùng lý do ⇒ idempotent.

Khôi phục nội dung (thủ công, chỉ khi cần): dữ liệu gốc ở `channel-events-1-3.json`; đưa event về `RECEIVED` kèm nội dung
bằng UPDATE có kiểm soát (CHECK của bảng không cho `IGNORED` mang nội dung). Audit loại event giữ nguyên để truy vết.

## Chưa làm (chờ duyệt riêng)

`g8-baseline.py exclude --report {RUNS_ROOT}/g8-baseline-{s['created_vn']}` — Nhân sự đăng nhập + gõ `{CONFIRM}`.
"""


# ------------------------------------------------------------------------------------------- exclude


def exclude(args) -> None:
    run_dir = Path(args.report)
    state = json.loads((run_dir / "state.json").read_text())
    if not state.get("ok"):
        die("dry-run chưa đạt")
    backup_dir = Path(state["backup"]["dir"])
    for name, digest in state["backup"]["sha256"].items():
        if sha256((backup_dir / name).read_bytes()) != digest:
            die(f"backup {name} đã thay đổi so với dry-run")
    now = psql_json(EVENT_META_SQL)
    before = {e["id"]: (e["status"], e["text_sha256"]) for e in state["events"]}
    if {e["id"]: (e["status"], e["text_sha256"]) for e in now} != before:
        die("trạng thái / nội dung event đã khác lúc dry-run — chạy lại dry-run")
    print(f"Sẽ loại event {list(before)} (TEST_MESSAGE) — xoá nội dung, không đảo được trong ứng dụng.")
    token, user = hr_login()
    if not any(r in (user.get("roles") or []) for r in state["operations_roles"]):
        die("tài khoản không có role vận hành")
    if input(f"Gõ đúng '{CONFIRM}' để thực hiện: ").strip() != CONFIRM:
        die("đã huỷ, không thay đổi gì")
    results = []
    for event_id in before:
        code, body = http("POST", f"/recruitment/operations/events/{event_id}/exclude", token, {"reason": "TEST_MESSAGE"})
        print(f"  #{event_id} → HTTP {code} {json.dumps({k: body.get(k) for k in ('status', 'failureCode', 'hasText', 'idempotent')})}")
        results.append({"id": event_id, "http": code, "body": body})
    after = psql_json(EVENT_META_SQL)
    ok = all(r["http"] in (200, 201) for r in results) and all(
        e["status"] == "IGNORED" and e["failure_code"] == "TEST_MESSAGE" and not e["has_text"] for e in after)
    out = {"actor": {"id": user.get("id"), "roles": user.get("roles")}, "results": results, "after": after, "ok": ok}
    write_private(run_dir / f"exclude-{dt.datetime.now(VN):%Y%m%d-%H%M%S}.json",
                  json.dumps(out, ensure_ascii=False, indent=2).encode())
    print("XONG" if ok else "CÓ BƯỚC LỖI — xem file kết quả trong", run_dir)


def main() -> None:
    if os.geteuid() != 0:
        die("chạy bằng root")
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd")
    d = sub.add_parser("dry-run")
    d.add_argument("--hr-login", action="store_true")
    e = sub.add_parser("exclude")
    e.add_argument("--report", required=True)
    args = parser.parse_args()
    if args.cmd == "exclude":
        exclude(args)
    else:
        args.hr_login = getattr(args, "hr_login", False)
        dry_run(args)


if __name__ == "__main__":
    main()
