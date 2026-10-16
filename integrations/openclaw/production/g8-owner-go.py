#!/usr/bin/env python3
"""G8 — Owner Approval: chủ hệ thống (SYSTEM OWNER) tự cấp GO cho từng cổng C0 / C1 / C2.

    python3 -I g8-owner-go.py approve c0|c1|c2      # Owner gõ trực tiếp trong terminal → in mã GO của cổng đó
    python3 -I g8-owner-go.py list                  # các GO: mã, cổng, người duyệt, thời gian, trạng thái
    python3 -I g8-owner-go.py revoke <mã>           # thu hồi một GO chưa dùng (Owner gõ trực tiếp)
    python3 -I g8-owner-go.py check <mã> <cổng>     # activate-g8.sh gọi: GO hợp lệ cho cổng → exit 0
    python3 -I g8-owner-go.py consume <mã> <cổng> [nhật ký]   # activate-g8.sh gọi sau khi mở cổng thành công

Nguyên tắc
- GO chỉ được tạo khi có người gõ trực tiếp trong terminal (stdin và stdout đều là TTY) và gõ đúng câu xác nhận;
  công cụ tự động / agent không cấp được GO và không ai được tạo GO thay Owner.
- Mỗi GO: mã riêng, đúng 1 cổng, hiệu lực 12 giờ, dùng 1 lần. Bản ghi JSON 600 root (không đổi sau khi tạo) + sổ
  `ledger.jsonl` (chỉ ghi thêm) cho các sự kiện approve / consume / revoke kèm sha256 của bản ghi.
- C1 (bắt đầu tốn chi phí model) và C2 (gửi tin thật): Owner xác nhận ngay lúc duyệt rằng khoá production thuộc
  đúng project OpenAI có hạn mức USD chặn cứng, và đúng tài khoản Zalo pilot (fingerprint).
- Không thay cổng duyệt tin của HR: mọi tin AI gửi Zalo vẫn phải được Nhân sự duyệt trong kido-app.
- Không in khoá / token: khoá OpenAI chỉ hiện dạng rút gọn như dashboard OpenAI (đầu…4 ký tự cuối) để đối chiếu.
"""
import datetime as dt
import hashlib
import json
import os
import re
import secrets
import socket
import subprocess
import sys

GO_DIR = "/opt/kido-recruiter-prod/go"
LEDGER = os.path.join(GO_DIR, "ledger.jsonl")
CONF = "/opt/kido-recruiter-prod/3010-g8.env"
GATEWAY_ENV = "/opt/kido-recruiter-prod/.env"
VALID_HOURS = 12
VN = dt.timezone(dt.timedelta(hours=7))
CODE_RE = re.compile(r"^G8-C[012]-\d{8}-\d{6}-[0-9a-f]{4}$")
LIMIT_KEYS = (
    "RECRUITMENT_AI_MAX_TURNS_PER_SENDER_HOUR", "RECRUITMENT_AI_MAX_TURNS_PER_SENDER_DAY",
    "RECRUITMENT_AI_MAX_TURNS_PER_DAY", "RECRUITMENT_AI_DAILY_TOKEN_BUDGET",
    "RECRUITMENT_AI_MONTHLY_TOKEN_BUDGET", "RECRUITMENT_AI_TOKEN_RESERVATION_PER_TURN",
    "RECRUITMENT_PILOT_MODE", "RECRUITMENT_AI_REQUIRE_SUBJECT",
)
SCOPE = {
    "c0": "Nạp cấu hình gateway, pilot, trần lượt/token và APP_SECRET vào 3010 (credential OA đã mã hoá phải có sẵn "
          "trong DB). AI / WORKER / OUTBOUND vẫn false. Restart 3010 (gián đoạn ~10–20 giây).",
    "c1": "Bật AI + WORKER cho tài khoản pilot. Tin AI chỉ thành bản nháp chờ HR duyệt; OUTBOUND vẫn false. "
          "Bắt đầu phát sinh chi phí OpenAI. Restart 3010 (~10–20 giây).",
    "c2": "Bật OUTBOUND: chỉ tin HR đã duyệt được gửi, chỉ tới tài khoản pilot; cổng này cho tối đa 1 tin thật "
          "(HR duyệt đúng 1 bản nháp). Restart 3010 (~10–20 giây).",
}


def die(msg, code=1):
    print(f"DỪNG: {msg}", file=sys.stderr)
    sys.exit(code)


def now():
    return dt.datetime.now(VN).replace(microsecond=0)


def read_env(path):
    out = {}
    with open(path, encoding="utf8") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                out[k.strip()] = v.strip().strip("\"'")
    return out


def canonical(record):
    return hashlib.sha256(json.dumps(record, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def ledger_events():
    if not os.path.exists(LEDGER):
        return []
    with open(LEDGER, encoding="utf8") as f:
        return [json.loads(line) for line in f if line.strip()]


def append_ledger(event):
    fd = os.open(LEDGER, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    with os.fdopen(fd, "a", encoding="utf8") as f:
        f.write(json.dumps(event, ensure_ascii=False) + "\n")


def load(code):
    if not CODE_RE.match(code or ""):
        return None, "mã GO sai định dạng"
    path = os.path.join(GO_DIR, code + ".json")
    if not os.path.exists(path):
        return None, "không có bản ghi GO này"
    with open(path, encoding="utf8") as f:
        record = json.load(f)
    return record, None


def status(code):
    """(record, trạng thái, lý do) — trạng thái: VALID | USED | REVOKED | EXPIRED | INVALID."""
    record, err = load(code)
    if err:
        return None, "INVALID", err
    events = [e for e in ledger_events() if e.get("code") == code]
    approve = [e for e in events if e.get("event") == "approve"]
    if not approve or approve[0].get("sha256") != canonical(record):
        return record, "INVALID", "bản ghi không khớp ledger (bị sửa hoặc thiếu sự kiện approve)"
    if any(e.get("event") == "revoke" for e in events):
        return record, "REVOKED", "GO đã bị thu hồi"
    if any(e.get("event") == "consume" for e in events):
        return record, "USED", "GO đã dùng (mỗi GO chỉ dùng 1 lần)"
    if now() > dt.datetime.fromisoformat(record["expires_at"]):
        return record, "EXPIRED", f"GO hết hạn lúc {record['expires_at']}"
    return record, "VALID", ""


def require_owner_terminal():
    if os.geteuid() != 0:
        die("cần root")
    if not (sys.stdin.isatty() and sys.stdout.isatty()):
        die("GO chỉ được cấp khi Owner gõ trực tiếp trong terminal (không chạy qua pipe / công cụ tự động)")


def ask(prompt, check, hint):
    for _ in range(3):
        value = input(prompt).strip()
        if check(value):
            return value
        print(f"  {hint}")
    die("nhập sai quá 3 lần — không tạo GO")


def pilot_activity(fingerprints):
    """Số tin đến + lần cuối theo fingerprint sha256(oa:user)[:16] — không nội dung, không định danh."""
    if not fingerprints:
        return {}
    fps = ",".join("'" + fp + "'" for fp in fingerprints if re.fullmatch(r"[0-9a-f]{16}", fp))
    sql = ("SELECT fp, count(*), to_char(max(received_at) AT TIME ZONE 'Asia/Ho_Chi_Minh', 'DD/MM/YYYY HH24:MI') FROM "
           "(SELECT left(encode(sha256(convert_to(channel_account_id || ':' || external_sender_id, 'UTF8')), 'hex'), 16)"
           f" AS fp, received_at FROM recruitment_channel_events) t WHERE fp IN ({fps}) GROUP BY fp")
    out = subprocess.run(["runuser", "-u", "postgres", "--", "psql", "-XAt", "-F", "|", "-d", "sales_db", "-c", sql],
                         capture_output=True, text=True, check=False)
    rows = {}
    for line in out.stdout.splitlines():
        parts = line.split("|")
        if len(parts) == 3:
            rows[parts[0]] = (parts[1], parts[2])
    return rows


def redacted_openai_key():
    key = read_env(GATEWAY_ENV).get("OPENAI_API_KEY", "")
    if not key:
        die(f"không thấy OPENAI_API_KEY trong {GATEWAY_ENV}")
    return key[:8] + "…" + key[-4:], hashlib.sha256(key.encode()).hexdigest()[:12]


def approve(stage):
    require_owner_terminal()
    conf = read_env(CONF)
    pilots = [x.strip() for x in conf.get("RECRUITMENT_PILOT_SENDER_FINGERPRINTS", "").split(",") if x.strip()]
    limits = {k: conf.get(k, "") for k in LIMIT_KEYS}
    if conf.get("RECRUITMENT_PILOT_MODE") != "true" or not pilots:
        die(f"{CONF}: pilot chưa bật hoặc chưa có fingerprint — không cấp GO")

    print(f"\n=== G8 OWNER APPROVAL — cổng {stage.upper()} ===")
    print(f"Phạm vi: {SCOPE[stage]}")
    print("Không bao gồm C3 / mở rộng ứng viên. Giữ nguyên: HR duyệt mọi tin AI (TTL 30 phút) · pilot · trần · "
          "dừng khẩn · failsafe · rollback.")
    print("Trần đang cấu hình: " + " · ".join(f"{k.replace('RECRUITMENT_', '')}={v}" for k, v in limits.items()))
    owner = ask("\nHọ tên SYSTEM OWNER: ", lambda v: len(v) >= 3, "nhập họ tên đầy đủ")

    openai = pilot = None
    if stage in ("c1", "c2"):
        shown, fp = redacted_openai_key()
        print(f"\n[OpenAI] Khoá production (dạng dashboard): {shown}  · fp {fp}")
        print("  Mở dashboard OpenAI → API keys: khoá trên phải thuộc project có hạn mức chi phí CHẶN CỨNG.")
        budget = ask("  Hạn mức USD/chu kỳ của project đó: ",
                     lambda v: re.fullmatch(r"\d+(\.\d+)?", v) is not None and float(v) > 0, "nhập số USD > 0")
        ask("  Gõ DUNG PROJECT để xác nhận khoá trên thuộc đúng project này, hạn mức chặn cứng (hard limit enforced): ",
            lambda v: v == "DUNG PROJECT", "phải gõ đúng: DUNG PROJECT")
        openai = {"key_redacted": shown, "key_fingerprint": fp, "budget_usd": float(budget),
                  "hard_limit_enforced": True, "confirmed_by": owner}

        activity = pilot_activity(pilots)
        print("\n[Zalo pilot] Chỉ các tài khoản sau được AI xử lý / nhận tin:")
        for p in pilots:
            n, last = activity.get(p, ("0", "-"))
            print(f"  fp {p} · đã nhắn OA {n} lần · lần cuối {last}")
        label = ask("  Tài khoản Zalo nội bộ tương ứng (ghi rõ chủ tài khoản): ", lambda v: len(v) >= 3,
                    "ghi tên tài khoản / người giữ")
        ask(f"  Gõ 4 ký tự cuối của fingerprint ({len(pilots)} tài khoản, gõ của tài khoản đầu) để xác nhận: ",
            lambda v: v == pilots[0][-4:], "không khớp fingerprint")
        pilot = {"fingerprints": pilots, "account_label": label, "confirmed_by": owner}

    ask(f"\nGõ TOI PHE DUYET {stage.upper()} để cấp GO: ", lambda v: v == f"TOI PHE DUYET {stage.upper()}",
        f"phải gõ đúng: TOI PHE DUYET {stage.upper()}")

    at = now()
    code = f"G8-{stage.upper()}-{at:%Y%m%d-%H%M%S}-{secrets.token_hex(2)}"
    record = {
        "code": code, "stage": stage, "scope": SCOPE[stage],
        "approver_role": "SYSTEM_OWNER", "approver_name": owner,
        "approved_at": at.isoformat(), "expires_at": (at + dt.timedelta(hours=VALID_HOURS)).isoformat(),
        "single_use": True, "max_real_messages": 1 if stage == "c2" else 0,
        "conditions": {"human_approval_gate": True, "pilot_only": True, "emergency_stop": True,
                       "failsafe": True, "rollback": "activate-g8.sh off / rollback-3010.sh", "limits": limits},
        "openai": openai, "pilot": pilot,
        "host": socket.gethostname(), "tty": os.ttyname(0), "login": os.environ.get("SUDO_USER") or os.environ.get("LOGNAME") or "root",
    }
    os.makedirs(GO_DIR, mode=0o700, exist_ok=True)
    os.chmod(GO_DIR, 0o700)
    fd = os.open(os.path.join(GO_DIR, code + ".json"), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf8") as f:
        json.dump(record, f, ensure_ascii=False, indent=2)
    append_ledger({"event": "approve", "code": code, "stage": stage, "approver": owner,
                   "at": at.isoformat(), "sha256": canonical(record)})
    print(f"\nĐÃ CẤP GO: {code}  (cổng {stage.upper()}, hết hạn {record['expires_at']}, dùng 1 lần)")
    print(f"Bản ghi: {GO_DIR}/{code}.json · ledger: {LEDGER}")
    print(f"Kích hoạt: ./activate-g8.sh {stage} --go {code}")


def revoke(code):
    require_owner_terminal()
    record, state, why = status(code)
    if state not in ("VALID", "EXPIRED"):
        die(f"không thu hồi được: {why or state}")
    owner = ask("Họ tên SYSTEM OWNER: ", lambda v: len(v) >= 3, "nhập họ tên")
    ask("Gõ THU HOI để xác nhận: ", lambda v: v == "THU HOI", "phải gõ đúng: THU HOI")
    append_ledger({"event": "revoke", "code": code, "stage": record["stage"], "by": owner, "at": now().isoformat()})
    print(f"Đã thu hồi {code}")


def main():
    args = sys.argv[1:]
    cmd = args[0] if args else ""
    if cmd == "approve" and len(args) == 2 and args[1] in SCOPE:
        approve(args[1])
    elif cmd == "check" and len(args) == 3:
        record, state, why = status(args[1])
        if state != "VALID":
            die(f"GO {args[1]}: {why}")
        if record["stage"] != args[2]:
            die(f"GO {args[1]} cấp cho cổng {record['stage']}, không phải {args[2]}")
        print(f"  GO hợp lệ: {args[1]} · cổng {record['stage']} · Owner {record['approver_name']} · "
              f"duyệt {record['approved_at']} · hết hạn {record['expires_at']}")
    elif cmd == "consume" and len(args) in (3, 4):
        record, state, why = status(args[1])
        if state != "VALID" or record["stage"] != args[2]:
            die(f"không đánh dấu được GO {args[1]}: {why or 'sai cổng'}")
        append_ledger({"event": "consume", "code": args[1], "stage": args[2], "at": now().isoformat(),
                       "log": args[3] if len(args) == 4 else None})
        print(f"  GO {args[1]} đã ghi nhận là đã dùng")
    elif cmd == "revoke" and len(args) == 2:
        revoke(args[1])
    elif cmd == "list" and len(args) == 1:
        codes = sorted({e["code"] for e in ledger_events() if e.get("event") == "approve"})
        if not codes:
            print("Chưa có GO nào.")
        for code in codes:
            record, state, why = status(code)
            name = record["approver_name"] if record else "-"
            at = record["approved_at"] if record else "-"
            print(f"{code}  {state:8} Owner {name} · {at}" + (f" · {why}" if why and state != "VALID" else ""))
    else:
        print(__doc__.strip().split("\n\n")[1])
        sys.exit(2)


if __name__ == "__main__":
    main()
