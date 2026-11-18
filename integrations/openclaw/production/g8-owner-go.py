#!/usr/bin/env python3
"""G8 — Owner Approval: chủ hệ thống (SYSTEM OWNER) tự cấp GO cho từng cổng C0 / C1 / C2.

    python3 -I g8-owner-go.py approve c0|c1|c2      # Owner gõ trực tiếp trong terminal → in mã GO của cổng đó
    python3 -I g8-owner-go.py list                  # các GO: mã, cổng, người duyệt, thời gian, trạng thái
    python3 -I g8-owner-go.py revoke <mã>           # thu hồi một GO chưa dùng (Owner gõ trực tiếp)
    python3 -I g8-owner-go.py check <mã> <cổng>     # activate-g8.sh gọi: GO hợp lệ cho cổng → exit 0
    python3 -I g8-owner-go.py consume <mã> <cổng> [nhật ký]   # activate-g8.sh gọi sau khi mở cổng thành công
    python3 -I g8-owner-go.py approve c2s <outbox_id>                  # GO C2S: cho phép gửi ĐÚNG tin AI đã được HR duyệt
    python3 -I g8-owner-go.py grant-dispatch <mã GO C2S> <outbox_id>   # dùng GO C2S (1 lần) → grant đúng 1 lần dispatch
    python3 -I g8-owner-go.py revoke-dispatch <grant_id>              # thu hồi grant chưa dùng
    python3 -I g8-owner-go.py list-dispatch                           # các grant dispatch
    python3 -I g8-owner-go.py approve prod          # GO PROD: Owner duyệt chuyển production (hạn mức, artifact, OA)
    python3 -I g8-owner-go.py authorize-prod <mã GO PROD> [nhật ký]   # activate-g8.sh prod gọi: tạo uỷ quyền DB
    python3 -I g8-owner-go.py revoke-prod <authorization_id>          # Owner thu hồi uỷ quyền production (dừng gửi)
    python3 -I g8-owner-go.py end-prod "<lý do>"                      # activate-g8.sh pilot gọi: kết thúc uỷ quyền
    python3 -I g8-owner-go.py list-prod                               # các uỷ quyền production

Nguyên tắc
- GO chỉ được tạo khi có người gõ trực tiếp trong terminal (stdin và stdout đều là TTY) và gõ đúng câu xác nhận;
  công cụ tự động / agent không cấp được GO và không ai được tạo GO thay Owner.
- Mỗi GO: mã riêng, đúng 1 cổng, hiệu lực 12 giờ, dùng 1 lần. Bản ghi JSON 600 root (không đổi sau khi tạo) + sổ
  `ledger.jsonl` (chỉ ghi thêm) cho các sự kiện approve / consume / revoke kèm sha256 của bản ghi.
- C1 (bắt đầu tốn chi phí model) và C2 (gửi tin thật): Owner xác nhận ngay lúc duyệt rằng khoá production thuộc
  đúng project OpenAI có hạn mức USD chặn cứng, và đúng tài khoản Zalo pilot (fingerprint).
- Không thay cổng duyệt tin của HR: mọi tin AI gửi Zalo vẫn phải được Nhân sự duyệt trong kido-app.
- Không in khoá / token: khoá OpenAI chỉ hiện dạng rút gọn như dashboard OpenAI (đầu…4 ký tự cuối) để đối chiếu.
- Single dispatch guard (C2): sender chỉ gửi tin AI có grant trong `recruitment_outbound_dispatch_grants`. Grant do
  Owner cấp ở đây (superuser postgres — app `sales_app` không có quyền INSERT), tiêu đúng 1 lần trong transaction ghi
  dispatch; chỉ cấp khi hàng đợi có ĐÚNG một dòng chưa xong là tin đó.
- Hai GO tách biệt: GO C2 CHỈ để `activate-g8.sh c2` (không cấp grant); GO C2S (`approve c2s <outbox_id>`, tạo sau khi
  HR duyệt) gắn đúng 1 outbox + OA + fingerprint pilot + sha256 nội dung + version điều khiển + version bản duyệt, hạn =
  min(hạn bản duyệt, 30 phút), dùng đúng 1 lần cho `grant-dispatch`. Một GO C2S → tối đa một grant (DB
  `UQ_dispatch_grant_go`); trạng thái GO C2S tính theo DB nên crash giữa chừng không làm GO trở lại VALID.
- Không ghi mã GO vào log: sự kiện ledger mới và audit DB (`activity_log`) chỉ ghi sha256 của mã.
- GO PROD (`approve prod`, sau khi OA đã nâng cấp gói và một lần gửi nghiệm thu đã SENT): gắn hạn mức trong
  `3010-production.env`, hash artifact đang chạy, OA, outbox nghiệm thu; 12 giờ, dùng 1 lần — `activate-g8.sh prod`
  dùng nó để tạo ĐÚNG MỘT uỷ quyền `recruitment_production_authorizations` (app chỉ đọc). Production mode của 3010
  không claim/gửi tin nào khi không có uỷ quyền ACTIVE; hạn mức hiệu lực = min(env, uỷ quyền) — đổi env không bật
  hay nới được production. Không dùng lại GO C2 / C2S.
"""
import datetime as dt
import fcntl
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
CODE_RE = re.compile(r"^G8-(C[012]|C2S|PROD)-\d{8}-\d{6}-[0-9a-f]{4}$")
C2S_MAX_MINUTES = 30
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
    "c2": "Bật OUTBOUND + single dispatch guard (KHÔNG cấp quyền gửi): chỉ tin AI HR đã duyệt và có grant từ một "
          "GO C2S riêng mới được gửi, đúng 1 lần, chỉ tới pilot; tin HR / tin khác giữ chờ. Restart 3010 (~10–20 giây).",
    "c2s": "Cho phép gửi ĐÚNG MỘT tin AI đã được HR duyệt (outbox cố định, nội dung/người nhận/OA/version cố định); "
           "chỉ dùng 1 lần cho grant-dispatch, hết hạn cùng bản duyệt (tối đa 30 phút).",
    "prod": "Chuyển 3010 sang production: PILOT=false, bỏ single dispatch grant; mọi tin vẫn qua HR duyệt (AI) / HR viết, "
            "chỉ tới ứng viên có tương tác hợp lệ, trong hạn mức đã duyệt (ledger bền), ngân sách tin tính phí, dừng khẩn. "
            "Tạo 1 uỷ quyền DB (app chỉ đọc). Restart 3010 (~10–20 giây). Gửi Zalo vẫn DỪNG cho tới khi HR mở lại.",
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


def code_fp(code):
    return hashlib.sha256((code or "").encode()).hexdigest()


def events_for(code):
    """Sự kiện của một GO: sự kiện cũ ghi mã thô, sự kiện mới chỉ ghi sha256 của mã."""
    fp = code_fp(code)
    return [e for e in ledger_events() if e.get("code") == code or e.get("code_fp") == fp]


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
    events = events_for(code)
    approve = [e for e in events if e.get("event") == "approve"]
    if not approve or approve[0].get("sha256") != canonical(record):
        return record, "INVALID", "bản ghi không khớp ledger (bị sửa hoặc thiếu sự kiện approve)"
    if any(e.get("event") == "revoke" for e in events):
        return record, "REVOKED", "GO đã bị thu hồi"
    if any(e.get("event") == "consume" for e in events):
        return record, "USED", "GO đã dùng (mỗi GO chỉ dùng 1 lần)"
    # GO C2S: DB là nguồn sự thật — đã có grant mang mã này thì GO đã dùng (kể cả khi chưa kịp ghi ledger).
    if record.get("stage") == "c2s" and grant_count_for_go(code) > 0:
        return record, "USED", "GO C2S đã dùng để cấp grant"
    # GO PROD: tương tự — đã có uỷ quyền mang fingerprint mã này thì GO đã dùng.
    if record.get("stage") == "prod" and prod_count_for_go(code) > 0:
        return record, "USED", "GO PROD đã dùng để tạo uỷ quyền production"
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
    append_ledger({"event": "approve", "code_fp": code_fp(code), "stage": stage, "approver": owner,
                   "at": at.isoformat(), "sha256": canonical(record)})
    print(f"\nĐÃ CẤP GO: {code}  (cổng {stage.upper()}, hết hạn {record['expires_at']}, dùng 1 lần)")
    print(f"Bản ghi: {GO_DIR}/{code}.json · ledger: {LEDGER}")
    print(f"Kích hoạt: ./activate-g8.sh {stage} --go {code}")


GRANT_TABLE = "recruitment_outbound_dispatch_grants"
OA_ENV = "/root/recruitment-oa.env"
UNFINISHED = "('AWAITING_APPROVAL', 'PENDING', 'SENDING', 'RETRY', 'UNKNOWN')"
FP_SQL = "left(encode(sha256(convert_to(o.channel_account_id || ':' || o.external_recipient_id, 'UTF8')), 'hex'), 16)"
LOCK_FILE = ".dispatch.lock"


def psql(sql, **variables):
    """psql (postgres) đọc SQL từ stdin; biến chèn qua -v (:'ten' / :ten), không ghép chuỗi."""
    args = ["runuser", "-u", "postgres", "--", "psql", "-XAtq", "-v", "ON_ERROR_STOP=1", "-d", "sales_db"]
    for key, value in variables.items():
        args += ["-v", f"{key}={value}"]
    out = subprocess.run(args, input=sql, capture_output=True, text=True, check=False)
    if out.returncode != 0:
        die("psql lỗi: " + (out.stderr.strip().splitlines() or ["?"])[-1][:240])
    return out.stdout.strip()


def grant_count_for_go(code):
    """Số grant mang mã GO này (DB là nguồn sự thật cho GO C2S)."""
    out = psql(f"SELECT count(*) FROM {GRANT_TABLE} WHERE go_code = :'go'", go=code)
    return int(out or "0")


def dispatch_lock():
    """Khoá loại trừ cho mọi thao tác cấp / dùng / thu hồi quyền gửi (hai tiến trình không chạy chồng)."""
    os.makedirs(GO_DIR, mode=0o700, exist_ok=True)
    fd = os.open(os.path.join(GO_DIR, LOCK_FILE), os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(fd)
        die("đang có một thao tác cấp/dùng quyền gửi khác — thử lại sau")
    return fd


def db_audit(method, actor, context, success=True, sql_only=False):
    """Audit vào activity_log (actorId -1, actor = Owner). Không ghi mã GO — chỉ sha256 trong context."""
    sql = ('INSERT INTO activity_log ("actorId", "actorName", method, path, resource, "statusCode", success, context) '
           "VALUES (-1, :'audit_actor', :'audit_method', '/recruitment-owner-go', 'recruitment-owner-go', "
           ":audit_status, :audit_ok, :'audit_ctx'::jsonb);")
    params = {"audit_actor": f"SYSTEM OWNER {actor} (g8-owner-go)", "audit_method": method,
              "audit_status": 200 if success else 409, "audit_ok": "true" if success else "false",
              "audit_ctx": json.dumps(context, ensure_ascii=False)}
    if sql_only:
        return sql, params
    psql(sql, **params)


def refuse(action, actor, outbox_id, problems, code=None):
    """Từ chối có audit (ledger + activity_log) rồi dừng."""
    ctx = {"action": action, "outboxId": outbox_id, "problems": problems[:12]}
    if code:
        ctx["goFp"] = code_fp(code)[:16]
    append_ledger({"event": "reject", "action": action, "outbox_id": outbox_id, "problems": problems[:12],
                   "code_fp": code_fp(code) if code else None, "by": actor, "at": now().isoformat()})
    try:
        db_audit("OWNER_DISPATCH_REJECT", actor, ctx, success=False)
    finally:
        die(f"không {action}:\n  - " + "\n  - ".join(problems))


def dispatch_preflight(outbox_id):
    raw = psql(f"""
SELECT json_build_object(
  'outbox', (SELECT json_build_object('id', o.id, 'source', o.source_type, 'status', o.status,
       'oa', o.channel_account_id, 'fp', {FP_SQL}, 'cv', o.control_version,
       'dispatched', o.dispatched_at IS NOT NULL, 'text_len', char_length(o.message_text),
       'text_sha', encode(sha256(convert_to(o.message_text, 'UTF8')), 'hex'),
       'msg_sha', encode(sha256(convert_to(m.content, 'UTF8')), 'hex'),
       'conv_mode', c.control_mode, 'conv_cv', c.control_version)
     FROM recruitment_channel_outbox o
     JOIN recruitment_messages m ON m.id = o.recruitment_message_id
     JOIN recruitment_conversations c ON c.id = m.conversation_id
     WHERE o.id = :outbox),
  'approval', (SELECT json_build_object('state', a.state, 'version', a.version, 'sha', a.approved_text_sha256,
       'oa', a.approved_oa_id, 'cv', a.approved_control_version,
       'msg_ok', a.approved_message_id = o.recruitment_message_id,
       'recipient_ok', a.approved_recipient_id = o.external_recipient_id,
       'expires', to_char(a.expires_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'HH24:MI:SS'),
       'expires_iso', to_char(a.expires_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD"T"HH24:MI:SS"+07:00"'),
       'seconds_left', extract(epoch FROM a.expires_at - now())::int)
     FROM recruitment_outbox_approvals a JOIN recruitment_channel_outbox o ON o.id = a.outbox_id
     WHERE a.outbox_id = :outbox),
  'unfinished', (SELECT coalesce(json_agg(json_build_object('id', id, 'source', source_type, 'status', status) ORDER BY id), '[]')
     FROM recruitment_channel_outbox WHERE status IN {UNFINISHED}),
  'active_grants', (SELECT coalesce(json_agg(json_build_object('id', id, 'outbox', outbox_id, 'live', expires_at > now())), '[]')
     FROM {GRANT_TABLE} WHERE status = 'ACTIVE'),
  'prior_grants', (SELECT count(*) FROM {GRANT_TABLE} WHERE outbox_id = :outbox),
  'runtime', (SELECT json_build_object('outbound_halted', outbound_halted, 'failsafe', failsafe_halted)
     FROM recruitment_runtime_controls WHERE id = 1),
  'guard_trigger', EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'TRG_dispatch_grant_guard' AND NOT tgisinternal),
  'c2s_trigger', EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'TRG_dispatch_grant_c2s_only' AND NOT tgisinternal)
)""", outbox=outbox_id)
    return json.loads(raw)


def target_problems(pf, outbox_id, oa, pilots):
    """Điều kiện chung cho cả `approve c2s` và `grant-dispatch` (đọc DB, chưa ghi gì)."""
    o, a = pf.get("outbox"), pf.get("approval")
    problems = []
    if not pf.get("guard_trigger"):
        problems.append("chưa có migration single dispatch guard (TRG_dispatch_grant_guard)")
    if not pf.get("c2s_trigger"):
        problems.append("chưa có migration GO C2S (TRG_dispatch_grant_c2s_only)")
    if not o:
        problems.append(f"không có outbox #{outbox_id} gắn với tin canonical")
    else:
        if o["source"] != "AI_REPLY": problems.append(f"outbox là {o['source']}, chỉ cho AI_REPLY")
        if o["status"] != "PENDING": problems.append(f"outbox đang {o['status']} (cần PENDING sau khi HR duyệt)")
        if o["dispatched"]: problems.append("outbox đã có dispatched_at")
        if o["oa"] != oa: problems.append("OA của tin khác OA tuyển dụng đang cấu hình")
        if o["fp"] not in pilots: problems.append(f"người nhận {o['fp']} không thuộc pilot")
        if not (o["text_sha"] == o["msg_sha"] == (a or {}).get("sha")): problems.append("nội dung / hash không khớp bản đã duyệt")
        if o["conv_mode"] != "AI_ACTIVE": problems.append(f"hội thoại đang {o['conv_mode']}")
        if not (o["cv"] == o["conv_cv"] == (a or {}).get("cv")): problems.append("version điều khiển hội thoại đã đổi")
    if not a or a["state"] != "APPROVED":
        problems.append(f"bản duyệt HR không ở APPROVED ({(a or {}).get('state')})")
    else:
        if not (a["msg_ok"] and a["recipient_ok"] and a["oa"] == oa): problems.append("bản duyệt không khớp tin / người nhận / OA")
        if a["seconds_left"] < 120: problems.append(f"bản duyệt còn {a['seconds_left']} giây (cần ≥ 120)")
    others = [u for u in pf["unfinished"] if u["id"] != outbox_id]
    if others: problems.append(f"hàng đợi còn {len(others)} dòng chưa xong khác: {others}")
    if pf["prior_grants"]: problems.append("outbox này đã từng được cấp grant — không cấp lại")
    live = [g for g in pf["active_grants"] if g["live"]]
    if live: problems.append(f"đang có grant ACTIVE còn hạn: {live}")
    if not (pf.get("runtime") or {}).get("outbound_halted"):
        problems.append("Gửi Zalo đang MỞ — chỉ cấp quyền gửi khi còn dừng khẩn, rồi HR mới mở lại")
    return problems


def dispatch_context():
    conf = read_env(CONF)
    pilots = [x.strip() for x in conf.get("RECRUITMENT_PILOT_SENDER_FINGERPRINTS", "").split(",") if x.strip()]
    oa = read_env(OA_ENV).get("RECRUITMENT_ZALO_OA_ID", "")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", oa):
        die(f"không đọc được RECRUITMENT_ZALO_OA_ID trong {OA_ENV}")
    if conf.get("RECRUITMENT_PILOT_MODE") != "true" or not pilots:
        die(f"{CONF}: pilot chưa bật hoặc chưa có fingerprint")
    return oa, pilots


def parse_id(arg, label):
    if not re.fullmatch(r"[1-9]\d{0,9}", arg or ""):
        die(f"{label} phải là số nguyên dương")
    return int(arg)


def print_target(pf, outbox_id):
    o, a = pf.get("outbox"), pf.get("approval")
    if o:
        print(f"Tin: {o['source']} · {o['status']} · {o['text_len']} ký tự · sha {o['text_sha'][:12]}… · "
              f"người nhận fp {o['fp']} · version {o['cv']}")
    if a:
        print(f"Bản duyệt HR: {a['state']} v{a['version']} · hết hạn {a['expires']} (còn {a['seconds_left']} giây)")
    print(f"Hàng đợi chưa xong: {pf['unfinished']} · grant ACTIVE: {pf['active_grants']} · runtime: {pf.get('runtime')}")


def approve_c2s(outbox_arg):
    """GO C2S: Owner cho phép gửi đúng một tin AI đã được HR duyệt — gắn cố định outbox / nội dung / người nhận."""
    require_owner_terminal()
    outbox_id = parse_id(outbox_arg, "outbox_id")
    oa, pilots = dispatch_context()
    lock = dispatch_lock()
    try:
        pf = dispatch_preflight(outbox_id)
        print(f"\n=== G8 OWNER APPROVAL — GO C2S (gửi 1 tin) · outbox #{outbox_id} ===")
        print(f"Phạm vi: {SCOPE['c2s']}")
        print_target(pf, outbox_id)
        owner = ask("\nHọ tên SYSTEM OWNER: ", lambda v: len(v) >= 3, "nhập họ tên đầy đủ")
        problems = target_problems(pf, outbox_id, oa, pilots)
        if problems:
            refuse("approve-c2s", owner, outbox_id, problems)
        o, a = pf["outbox"], pf["approval"]
        ask(f"  Gõ 4 ký tự cuối fingerprint người nhận ({o['fp']}) để xác nhận đúng tài khoản pilot: ",
            lambda v: v == o["fp"][-4:], "không khớp fingerprint")
        ask(f"Gõ TOI PHE DUYET GUI {outbox_id} để cấp GO C2S: ", lambda v: v == f"TOI PHE DUYET GUI {outbox_id}",
            f"phải gõ đúng: TOI PHE DUYET GUI {outbox_id}")
        at = now()
        approval_expires = dt.datetime.fromisoformat(a["expires_iso"])
        expires = min(approval_expires, at + dt.timedelta(minutes=C2S_MAX_MINUTES))
        code = f"G8-C2S-{at:%Y%m%d-%H%M%S}-{secrets.token_hex(2)}"
        record = {
            "code": code, "stage": "c2s", "scope": SCOPE["c2s"],
            "approver_role": "SYSTEM_OWNER", "approver_name": owner,
            "approved_at": at.isoformat(), "expires_at": expires.isoformat(),
            "single_use": True, "max_real_messages": 1,
            "dispatch": {"outbox_id": outbox_id, "oa": o["oa"], "recipient_fingerprint": o["fp"],
                         "approved_text_sha256": o["text_sha"], "control_version": o["cv"],
                         "approval_version": a["version"], "approval_expires_at": a["expires_iso"]},
            "host": socket.gethostname(), "tty": os.ttyname(0),
            "login": os.environ.get("SUDO_USER") or os.environ.get("LOGNAME") or "root",
        }
        fd = os.open(os.path.join(GO_DIR, code + ".json"), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf8") as f:
            json.dump(record, f, ensure_ascii=False, indent=2)
        append_ledger({"event": "approve", "code_fp": code_fp(code), "stage": "c2s", "approver": owner,
                       "outbox_id": outbox_id, "at": at.isoformat(), "sha256": canonical(record)})
        db_audit("OWNER_GO_C2S_APPROVE", owner, {"goFp": code_fp(code)[:16], "outboxId": outbox_id,
                                                  "expiresAt": expires.isoformat(), "approvalVersion": a["version"]})
    finally:
        os.close(lock)
    print(f"\nĐÃ CẤP GO C2S: {code}  (outbox #{outbox_id}, hết hạn {expires.isoformat()}, dùng 1 lần)")
    print(f"Cấp grant: python3 -I g8-owner-go.py grant-dispatch {code} {outbox_id}")


def grant_dispatch(code, outbox_arg):
    """Dùng GO C2S (VALID, đúng 1 lần) để cấp grant đúng 1 lần dispatch cho đúng outbox đã gắn."""
    require_owner_terminal()
    outbox_id = parse_id(outbox_arg, "outbox_id")
    oa, pilots = dispatch_context()
    lock = dispatch_lock()
    try:
        record, state, why = status(code)
        owner = ask("Họ tên SYSTEM OWNER: ", lambda v: len(v) >= 3, "nhập họ tên đầy đủ")
        if record is None or record.get("stage") != "c2s":
            refuse("grant-dispatch", owner, outbox_id,
                   [f"chỉ GO C2S cấp được grant (mã này: {(record or {}).get('stage') or why})"], code)
        if state != "VALID":
            refuse("grant-dispatch", owner, outbox_id, [f"GO C2S không còn hiệu lực ({why or state})"], code)
        bound = record["dispatch"]
        problems = []
        if bound["outbox_id"] != outbox_id:
            problems.append(f"GO C2S gắn với outbox #{bound['outbox_id']}, không phải #{outbox_id}")
        pf = dispatch_preflight(outbox_id)
        print(f"\n=== GRANT DISPATCH — outbox #{outbox_id} · GO C2S fp {code_fp(code)[:12]} ===")
        print_target(pf, outbox_id)
        problems += target_problems(pf, outbox_id, oa, pilots)
        o, a = pf.get("outbox") or {}, pf.get("approval") or {}
        for label, current, expected in (("OA", o.get("oa"), bound["oa"]),
                                         ("người nhận", o.get("fp"), bound["recipient_fingerprint"]),
                                         ("nội dung (sha256)", o.get("text_sha"), bound["approved_text_sha256"]),
                                         ("version điều khiển", o.get("cv"), bound["control_version"]),
                                         ("version bản duyệt", a.get("version"), bound["approval_version"])):
            if current != expected:
                problems.append(f"{label} đã đổi so với lúc Owner cấp GO C2S")
        if problems:
            refuse("grant-dispatch", owner, outbox_id, problems, code)
        ask(f"Gõ CHO PHEP GUI {outbox_id} để dùng GO C2S cấp đúng 1 lần dispatch: ",
            lambda v: v == f"CHO PHEP GUI {outbox_id}", f"phải gõ đúng: CHO PHEP GUI {outbox_id}")
        grant_id, expires = insert_grant(code, record, owner)
        if grant_id is None:
            refuse("grant-dispatch", owner, outbox_id,
                   ["điều kiện đổi trong lúc xác nhận hoặc GO đã được dùng — đã rollback, không tạo grant"], code)
        # DB đã commit grant (nguồn sự thật cho trạng thái GO C2S); ledger ghi sau.
        append_ledger({"event": "consume", "code_fp": code_fp(code), "stage": "c2s", "at": now().isoformat(),
                       "grant_id": grant_id})
        append_ledger({"event": "grant", "code_fp": code_fp(code), "outbox_id": outbox_id, "grant_id": grant_id,
                       "by": owner, "at": now().isoformat(), "expires": expires})
    finally:
        os.close(lock)
    print(f"\nĐÃ CẤP GRANT #{grant_id} cho outbox #{outbox_id} — đúng 1 lần dispatch, hết hạn {expires}. GO C2S đã dùng.")
    print("Bước tiếp: HR mở lại \"Gửi Zalo\" → sender gửi đúng tin này; mọi tin khác giữ chờ.")


def insert_grant(code, record, owner):
    """Một transaction: kiểm lại MỌI trường đã gắn trong GO C2S + bản duyệt còn hạn → grant + audit, hoặc rollback."""
    b = record["dispatch"]
    audit_sql, audit_params = db_audit("OWNER_DISPATCH_GRANT_CREATE", owner,
                                       {"goFp": code_fp(code)[:16], "outboxId": b["outbox_id"]}, sql_only=True)
    out = psql(f"""
BEGIN;
SELECT pg_advisory_xact_lock(hashtext('{GRANT_TABLE}'));
UPDATE {GRANT_TABLE} SET status = 'REVOKED', revoked_at = now(), revoked_by = :'owner', reason = 'EXPIRED_UNUSED'
 WHERE status = 'ACTIVE' AND expires_at <= now();
WITH target AS (
  SELECT o.id, o.channel_account_id, {FP_SQL} AS fp, a.approved_text_sha256 AS sha,
         o.control_version AS cv, a.expires_at
  FROM recruitment_channel_outbox o
  JOIN recruitment_outbox_approvals a ON a.outbox_id = o.id
  JOIN recruitment_messages m ON m.id = o.recruitment_message_id
  JOIN recruitment_conversations c ON c.id = m.conversation_id
  WHERE o.id = :outbox AND o.source_type = 'AI_REPLY' AND o.status = 'PENDING' AND o.dispatched_at IS NULL
    AND o.channel_account_id = :'oa' AND {FP_SQL} = :'fp' AND o.control_version = :cv
    AND a.state = 'APPROVED' AND a.version = :av AND a.expires_at > now() + interval '2 minutes'
    AND a.approved_oa_id = o.channel_account_id AND a.approved_recipient_id = o.external_recipient_id
    AND a.approved_message_id = o.recruitment_message_id AND a.approved_control_version = o.control_version
    AND a.approved_text_sha256 = :'sha'
    AND c.control_mode = 'AI_ACTIVE' AND c.control_version = o.control_version
    AND m.content = o.message_text
    AND encode(sha256(convert_to(m.content, 'UTF8')), 'hex') = :'sha'
    AND NOT EXISTS (SELECT 1 FROM recruitment_channel_outbox x WHERE x.id <> o.id AND x.status IN {UNFINISHED})
    AND NOT EXISTS (SELECT 1 FROM {GRANT_TABLE} g WHERE g.go_code = :'go')
  FOR UPDATE OF o, a
)
INSERT INTO {GRANT_TABLE} (go_code, outbox_id, channel_account_id, recipient_fingerprint, approved_text_sha256,
                           approved_control_version, created_by, expires_at, reason)
SELECT :'go', id, channel_account_id, fp, sha, cv, :'owner',
       least(expires_at, :'go_expires'::timestamptz, now() + interval '{C2S_MAX_MINUTES} minutes'), 'G8 C2S owner grant'
FROM target
RETURNING id || '|' || to_char(expires_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'HH24:MI:SS');
SELECT (count(*) = 1) AS ok FROM {GRANT_TABLE} WHERE go_code = :'go' AND outbox_id = :outbox AND status = 'ACTIVE' \\gset
\\if :ok
{audit_sql}
COMMIT;
\\else
ROLLBACK;
\\endif
""", outbox=b["outbox_id"], oa=b["oa"], fp=b["recipient_fingerprint"], cv=b["control_version"],
         av=b["approval_version"], sha=b["approved_text_sha256"], go=code, owner=owner,
         go_expires=record["expires_at"], **audit_params)
    rows = [line for line in out.splitlines() if "|" in line]
    if len(rows) != 1 or grant_count_for_go(code) != 1:
        return None, None
    grant_id, expires = rows[0].split("|", 1)
    return int(grant_id), expires


def revoke_dispatch(grant_arg):
    require_owner_terminal()
    grant_id = parse_id(grant_arg, "grant_id")
    lock = dispatch_lock()
    try:
        owner = ask("Họ tên SYSTEM OWNER: ", lambda v: len(v) >= 3, "nhập họ tên")
        ask(f"Gõ THU HOI GRANT {grant_id} để xác nhận: ", lambda v: v == f"THU HOI GRANT {grant_id}",
            f"phải gõ đúng: THU HOI GRANT {grant_id}")
        audit_sql, audit_params = db_audit("OWNER_DISPATCH_GRANT_REVOKE", owner, {"grantId": grant_id}, sql_only=True)
        out = psql(f"""
BEGIN;
UPDATE {GRANT_TABLE} SET status = 'REVOKED', revoked_at = now(), revoked_by = :'owner', reason = 'OWNER_REVOKED'
 WHERE id = :gid AND status = 'ACTIVE' RETURNING id;
SELECT (count(*) = 1) AS ok FROM {GRANT_TABLE} WHERE id = :gid AND status = 'REVOKED' AND reason = 'OWNER_REVOKED' \\gset
\\if :ok
{audit_sql}
COMMIT;
\\else
ROLLBACK;
\\endif
""", gid=grant_id, owner=owner, **audit_params)
        if not out:
            refuse("revoke-dispatch", owner, None, [f"grant #{grant_id} không ở ACTIVE — không thu hồi"])
        append_ledger({"event": "revoke-dispatch", "grant_id": grant_id, "by": owner, "at": now().isoformat()})
    finally:
        os.close(lock)
    print(f"Đã thu hồi grant #{grant_id}")


def list_dispatch():
    out = psql(f"""SELECT id || ' · outbox ' || outbox_id || ' · ' || status || ' · dùng ' || dispatches_used || '/' || max_dispatches
  || ' · cấp ' || to_char(created_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'DD/MM HH24:MI') || ' bởi ' || created_by
  || ' · hết hạn ' || to_char(expires_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'DD/MM HH24:MI')
  || coalesce(' · tiêu ' || to_char(consumed_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'DD/MM HH24:MI:SS'), '')
  || coalesce(' · thu hồi ' || to_char(revoked_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'DD/MM HH24:MI'), '')
  || ' · GO fp ' || left(encode(sha256(convert_to(go_code, 'UTF8')), 'hex'), 12)
FROM {GRANT_TABLE} ORDER BY id""")
    print(out or "Chưa có grant dispatch nào.")


def revoke(code):
    require_owner_terminal()
    record, state, why = status(code)
    if state not in ("VALID", "EXPIRED"):
        die(f"không thu hồi được: {why or state}")
    owner = ask("Họ tên SYSTEM OWNER: ", lambda v: len(v) >= 3, "nhập họ tên")
    ask("Gõ THU HOI để xác nhận: ", lambda v: v == "THU HOI", "phải gõ đúng: THU HOI")
    append_ledger({"event": "revoke", "code_fp": code_fp(code), "stage": record["stage"], "by": owner,
                   "at": now().isoformat()})
    if record["stage"] == "c2s":
        db_audit("OWNER_GO_C2S_REVOKE", owner, {"goFp": code_fp(code)[:16],
                                                 "outboxId": record["dispatch"]["outbox_id"]})
    elif record["stage"] == "prod":
        db_audit("OWNER_GO_PROD_REVOKE", owner, {"goFp": code_fp(code)[:16]})
    print(f"Đã thu hồi GO fp {code_fp(code)[:12]}")


# ---------------------------------------------------------------- GO PROD
PROD_CONF = "/opt/kido-recruiter-prod/3010-production.env"
AUTH_TABLE = "recruitment_production_authorizations"
APP_DIST = "/var/www/sales-management/dist"
RELEASES = "/opt/kido-recruiter/releases"
PROD_LIMITS = (  # khoá env → cột uỷ quyền; giá trị phải khớp ràng buộc CHK_prod_auth_limits
    ("RECRUITMENT_ZALO_MAX_REQUESTS_PER_RECIPIENT_WINDOW", "max_requests_per_recipient_window", 1, 1000),
    ("RECRUITMENT_ZALO_RECIPIENT_WINDOW_HOURS", "recipient_window_hours", 1, 24),
    ("RECRUITMENT_ZALO_MAX_REQUESTS_PER_RECIPIENT_DAY", "max_requests_per_recipient_day", 1, 1000),
    ("RECRUITMENT_ZALO_MAX_REQUESTS_PER_DAY", "max_requests_per_day", 1, 1_000_000),
    ("RECRUITMENT_ZALO_DAILY_COST_BUDGET_VND", "daily_cost_budget_vnd", 0, 2_000_000_000),
    ("RECRUITMENT_ZALO_MONTHLY_COST_BUDGET_VND", "monthly_cost_budget_vnd", 0, 2_000_000_000),
    ("RECRUITMENT_ZALO_INTERACTION_WINDOW_HOURS", "interaction_window_hours", 1, 168),
    ("RECRUITMENT_ZALO_FREE_WINDOW_HOURS", "free_window_hours", 1, 168),
)
PROD_AI_LIMITS = (  # được khoá trong GO + env; dịch vụ AI dùng trực tiếp từ env
    ("RECRUITMENT_AI_MAX_TURNS_PER_SENDER_HOUR", "ai_max_turns_per_sender_hour", 1, 1000),
    ("RECRUITMENT_AI_MAX_TURNS_PER_SENDER_DAY", "ai_max_turns_per_sender_day", 1, 10_000),
    ("RECRUITMENT_AI_MAX_TURNS_PER_DAY", "ai_max_turns_per_day", 1, 1_000_000),
)
PROD_FLAGS = {"RECRUITMENT_PRODUCTION_MODE": "true", "RECRUITMENT_PILOT_MODE": "false",
              "RECRUITMENT_ZALO_DISPATCH_GRANT_REQUIRED": "false", "RECRUITMENT_ZALO_OUTBOUND_ENABLED": "true",
              "RECRUITMENT_AI_ENABLED": "true", "RECRUITMENT_WORKER_ENABLED": "true"}


def prod_count_for_go(code):
    if psql(f"SELECT to_regclass('public.{AUTH_TABLE}') IS NOT NULL") != "t":
        return 0
    return int(psql(f"SELECT count(*) FROM {AUTH_TABLE} WHERE go_code_fp = :'fp'", fp=code_fp(code)) or "0")


def dist_hash(path=None):
    """Cùng cách tính với deploy-3010.sh (h): sha256 của danh sách sha256 từng file, 16 ký tự."""
    path = path or APP_DIST
    stable_env = dict(os.environ, LC_ALL="en_US.utf8")
    out = subprocess.run(["bash", "-c", "cd \"$1\" && find . -type f ! -name '*.tsbuildinfo' -print0 | sort -z | "
                          "xargs -0 sha256sum | sha256sum | cut -c1-16", "_", path],
                         capture_output=True, text=True, check=False, env=stable_env)
    value = out.stdout.strip()
    if out.returncode != 0 or not re.fullmatch(r"[0-9a-f]{16}", value):
        die(f"không tính được hash artifact {path}")
    return value


def prod_config():
    """Đọc + kiểm 3010-production.env (600 root). Trả (conf, hạn mức) — không in secret."""
    st = os.stat(PROD_CONF) if os.path.exists(PROD_CONF) else None
    if not st or st.st_uid != 0 or (st.st_mode & 0o777) != 0o600:
        die(f"{PROD_CONF} phải tồn tại, 600 root")
    conf = read_env(PROD_CONF)
    problems = [f"{k} phải {v}" for k, v in PROD_FLAGS.items() if conf.get(k) != v]
    limits = {}
    for key, column, low, high in PROD_LIMITS + PROD_AI_LIMITS:
        raw = conf.get(key, "")
        if not re.fullmatch(r"\d{1,10}", raw) or not low <= int(raw) <= high:
            problems.append(f"{key} phải là số nguyên {low}–{high}")
            continue
        limits[column] = int(raw)
    if len(limits) == len(PROD_LIMITS) + len(PROD_AI_LIMITS):
        if limits["max_requests_per_recipient_window"] > limits["max_requests_per_recipient_day"]:
            problems.append("hạn mức ứng viên/cửa sổ lớn hơn hạn mức ứng viên/ngày")
        if limits["max_requests_per_recipient_day"] > limits["max_requests_per_day"]:
            problems.append("hạn mức ứng viên/ngày lớn hơn toàn hệ thống/ngày")
        if limits["monthly_cost_budget_vnd"] < limits["daily_cost_budget_vnd"]:
            problems.append("ngân sách tháng nhỏ hơn ngân sách ngày")
        if limits["free_window_hours"] > limits["interaction_window_hours"]:
            problems.append("cửa sổ miễn phí lớn hơn cửa sổ tương tác")
        if limits["ai_max_turns_per_sender_hour"] > limits["ai_max_turns_per_sender_day"]:
            problems.append("trần AI ứng viên/giờ lớn hơn trần AI ứng viên/ngày")
        if limits["ai_max_turns_per_sender_day"] > limits["ai_max_turns_per_day"]:
            problems.append("trần AI ứng viên/ngày lớn hơn trần AI toàn hệ thống/ngày")
    est = conf.get("RECRUITMENT_ZALO_ESTIMATED_PAID_MESSAGE_COST_VND", "")
    if not re.fullmatch(r"[1-9]\d{0,7}", est):
        problems.append("RECRUITMENT_ZALO_ESTIMATED_PAID_MESSAGE_COST_VND phải > 0")
    if "-224" not in conf.get("RECRUITMENT_ZALO_OA_BLOCKING_ERRORS", "-224").split(","):
        problems.append("RECRUITMENT_ZALO_OA_BLOCKING_ERRORS phải gồm -224")
    return conf, limits, problems


def prod_facts(oa):
    raw = psql(f"""
SELECT json_build_object(
  'ledger_mig', EXISTS (SELECT 1 FROM migrations WHERE timestamp = 1793200000000
                        AND name = 'AddRecruitmentOutboundAttemptLedger1793200000000'),
  'prod_mig', EXISTS (SELECT 1 FROM migrations WHERE timestamp = 1793300000000
                      AND name = 'AddRecruitmentProductionAuthorizations1793300000000'),
  'rolling_mig', EXISTS (SELECT 1 FROM migrations WHERE timestamp = 1794000000000
                         AND name = 'AddRecruitmentRecipientRollingQuota1794000000000'),
  'halted', (SELECT outbound_halted FROM recruitment_runtime_controls WHERE id = 1),
  'failsafe', (SELECT failsafe_halted FROM recruitment_runtime_controls WHERE id = 1),
  'unfinished', (SELECT coalesce(json_agg(json_build_object('id', id, 'source', source_type, 'status', status)
                 ORDER BY id), '[]') FROM recruitment_channel_outbox
                 WHERE status IN ('PENDING', 'SENDING', 'RETRY', 'UNKNOWN')),
  'credential_oa', (SELECT count(*) FROM recruitment_zalo_credentials WHERE oa_id = :'oa'),
  'credential_other', (SELECT count(*) FROM recruitment_zalo_credentials WHERE oa_id <> :'oa'),
  'jobs_active', (SELECT count(*) FROM recruitment_jobs WHERE status = 'ACTIVE'),
  'jobs_unpublished', (SELECT count(*) FROM recruitment_jobs WHERE status = 'ACTIVE' AND published_at IS NULL),
  'active_auth', (SELECT CASE WHEN to_regclass('public.{AUTH_TABLE}') IS NULL THEN NULL ELSE
                  (SELECT json_agg(id) FROM {AUTH_TABLE} WHERE status = 'ACTIVE') END)
)""", oa=oa)
    return json.loads(raw)


def prod_problems(facts, limits_ok=True):
    problems = []
    if not facts["ledger_mig"]: problems.append("chưa áp migration ledger 1793200000000")
    if not facts["prod_mig"]: problems.append("chưa áp migration GO PROD 1793300000000")
    if not facts["rolling_mig"]: problems.append("chưa áp migration quota trượt 1794000000000")
    if facts["halted"] is not True: problems.append("Gửi Zalo phải đang DỪNG KHẨN (HR bật lại sau khi kích hoạt)")
    if facts["failsafe"]: problems.append("failsafe đang bật — xử lý trước")
    if facts["unfinished"]: problems.append(f"còn outbox chưa xong {facts['unfinished']} — HR huỷ/đối soát trước")
    if facts["credential_oa"] != 1 or facts["credential_other"]:
        problems.append("credential OA trong DB không đúng một dòng của đúng OA tuyển dụng")
    if facts["jobs_unpublished"]: problems.append("có vị trí ACTIVE chưa published_at")
    if not limits_ok: problems.append("cấu hình production sai")
    try:
        with open(os.path.join(APP_DIST, "recruitment/channels/recruitment-channel-outbox.queue.js"), encoding="utf8") as f:
            if AUTH_TABLE not in f.read():
                problems.append("3010 chưa chạy release có GO PROD")
    except OSError:
        problems.append("không đọc được dist của 3010")
    return problems


def verification_send(outbox_id, oa, pilots):
    """Lượt gửi nghiệm thu sau khi nâng cấp gói OA: outbox SENT có message id Zalo, tới pilot."""
    raw = psql(f"""SELECT json_build_object('status', o.status, 'has_zmsg', o.provider_message_id IS NOT NULL,
  'oa', o.channel_account_id, 'fp', {FP_SQL},
  'sent', to_char(o.sent_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'DD/MM/YYYY HH24:MI'))
FROM recruitment_channel_outbox o WHERE o.id = :outbox""", outbox=outbox_id)
    v = json.loads(raw) if raw else None
    problems = []
    if not v: problems.append(f"không có outbox #{outbox_id}")
    else:
        if v["status"] != "SENT" or not v["has_zmsg"]:
            problems.append(f"outbox #{outbox_id} chưa SENT với message id Zalo ({v['status']})")
        if v["oa"] != oa: problems.append("outbox nghiệm thu không thuộc OA tuyển dụng")
        if v["fp"] not in pilots: problems.append("outbox nghiệm thu không gửi tới tài khoản pilot của Owner")
    return v, problems


def approve_prod():
    require_owner_terminal()
    oa, pilots = dispatch_context()
    conf, limits, conf_problems = prod_config()
    lock = dispatch_lock()
    try:
        facts = prod_facts(oa)
        print("\n=== G8 OWNER APPROVAL — GO PROD (production) ===")
        print(f"Phạm vi: {SCOPE['prod']}")
        print("Hạn mức (3010-production.env): " + " · ".join(f"{k}={v}" for k, v in limits.items()))
        current = dist_hash()
        print(f"Artifact đang chạy: dist {current} · vị trí ACTIVE: {facts['jobs_active']} · "
              f"uỷ quyền ACTIVE hiện có: {facts['active_auth'] or 'không'}")
        owner = ask("\nHọ tên SYSTEM OWNER: ", lambda v: len(v) >= 3, "nhập họ tên đầy đủ")
        problems = conf_problems + prod_problems(facts)
        rollback = ask("  Thư mục release rollback (trong /opt/kido-recruiter/releases): ",
                       lambda v: re.fullmatch(r"[A-Za-z0-9._-]{3,80}", v) is not None, "chỉ tên thư mục")
        if not os.path.isdir(os.path.join(RELEASES, rollback, "dist")):
            problems.append(f"không có {RELEASES}/{rollback}/dist để rollback")
        outbox = parse_id(ask("  Outbox của lượt gửi nghiệm thu (SENT, tới Zalo của Owner): ",
                              lambda v: re.fullmatch(r"[1-9]\d{0,9}", v) is not None, "số outbox"), "outbox")
        v, vp = verification_send(outbox, oa, pilots)
        problems += vp
        if problems:
            refuse("approve-prod", owner, outbox, problems)
        print(f"  Nghiệm thu: outbox #{outbox} SENT {v['sent']} · có message id Zalo · tới pilot fp {v['fp']}")
        package = ask("  Gói OA đang kích hoạt (tên gói + hạn, xem OA Manager): ", lambda v: len(v) >= 3,
                      "ghi tên gói và ngày hết hạn")
        ask("  Gõ OA ICHI SKILL CO QUYEN OPENAPI để xác nhận đúng OA, gói còn hạn, có quyền gửi Tin Tư vấn: ",
            lambda v: v == "OA ICHI SKILL CO QUYEN OPENAPI", "phải gõ đúng: OA ICHI SKILL CO QUYEN OPENAPI")
        tag = (f"HAN MUC {limits['max_requests_per_recipient_window']}/{limits['recipient_window_hours']}H/"
               f"{limits['max_requests_per_recipient_day']}/{limits['max_requests_per_day']}/"
               f"{limits['daily_cost_budget_vnd']}")
        ask(f"  Gõ {tag} để xác nhận hạn mức ứng viên/cửa sổ giờ / ứng viên/ngày / toàn hệ thống/ngày / ngân sách tin tính phí (VND/ngày): ",
            lambda v: v == tag, f"phải gõ đúng: {tag}")
        ai_tag = (f"HAN MUC AI {limits['ai_max_turns_per_sender_hour']}/"
                  f"{limits['ai_max_turns_per_sender_day']}/{limits['ai_max_turns_per_day']}")
        ask(f"  Gõ {ai_tag} để xác nhận lượt AI ứng viên/giờ / ứng viên/ngày / toàn hệ thống/ngày: ",
            lambda v: v == ai_tag, f"phải gõ đúng: {ai_tag}")
        ask("\nGõ TOI PHE DUYET PROD để cấp GO PROD: ", lambda v: v == "TOI PHE DUYET PROD",
            "phải gõ đúng: TOI PHE DUYET PROD")
        at = now()
        code = f"G8-PROD-{at:%Y%m%d-%H%M%S}-{secrets.token_hex(2)}"
        record = {
            "code": code, "stage": "prod", "scope": SCOPE["prod"],
            "approver_role": "SYSTEM_OWNER", "approver_name": owner,
            "approved_at": at.isoformat(), "expires_at": (at + dt.timedelta(hours=VALID_HOURS)).isoformat(),
            "single_use": True, "oa": oa, "limits": limits, "dist_hash": current, "rollback_release": rollback,
            "verification_outbox_id": outbox, "oa_package": package,
            "conditions": {"human_approval_gate": True, "interaction_window": True, "durable_quota": True,
                           "emergency_stop": True, "outbound_halted_until_hr_resume": True},
            "host": socket.gethostname(), "tty": os.ttyname(0),
            "login": os.environ.get("SUDO_USER") or os.environ.get("LOGNAME") or "root",
        }
        os.makedirs(GO_DIR, mode=0o700, exist_ok=True)
        fd = os.open(os.path.join(GO_DIR, code + ".json"), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf8") as f:
            json.dump(record, f, ensure_ascii=False, indent=2)
        append_ledger({"event": "approve", "code_fp": code_fp(code), "stage": "prod", "approver": owner,
                       "at": at.isoformat(), "sha256": canonical(record)})
        db_audit("OWNER_GO_PROD_APPROVE", owner, {"goFp": code_fp(code)[:16], "limits": limits, "distHash": current,
                                                   "verificationOutboxId": outbox, "rollback": rollback})
    finally:
        os.close(lock)
    print(f"\nĐÃ CẤP GO PROD: {code}  (hết hạn {record['expires_at']}, dùng 1 lần)")
    print(f"Kích hoạt: ./activate-g8.sh prod --go {code}")


def authorize_prod(code, log=None):
    """activate-g8.sh prod: kiểm lại mọi điều kiện + GO PROD → đúng một uỷ quyền ACTIVE trong DB (1 transaction)."""
    require_owner_terminal()
    oa, _ = dispatch_context()
    conf, limits, conf_problems = prod_config()
    lock = dispatch_lock()
    try:
        record, state, why = status(code)
        owner = (record or {}).get("approver_name") or "?"
        if record is None or record.get("stage") != "prod":
            refuse("authorize-prod", owner, None, [f"chỉ GO PROD dùng được ({(record or {}).get('stage') or why})"], code)
        if state != "VALID":
            refuse("authorize-prod", owner, None, [f"GO PROD không còn hiệu lực ({why or state})"], code)
        problems = conf_problems + prod_problems(prod_facts(oa))
        if limits != record["limits"]:
            problems.append("hạn mức trong 3010-production.env đã đổi so với lúc Owner cấp GO PROD")
        if dist_hash() != record["dist_hash"]:
            problems.append("artifact 3010 đang chạy khác artifact Owner đã duyệt")
        if oa != record["oa"]:
            problems.append("OA tuyển dụng đã đổi")
        if problems:
            refuse("authorize-prod", owner, None, problems, code)
        reason = f"superseded by GO PROD fp {code_fp(code)[:12]}"
        audit_sql, audit_params = db_audit("OWNER_PROD_AUTHORIZE", owner,
                                           {"goFp": code_fp(code)[:16], "limits": limits,
                                            "distHash": record["dist_hash"]}, sql_only=True)
        L = record["limits"]
        out = psql(f"""
BEGIN;
SELECT pg_advisory_xact_lock(hashtext('{AUTH_TABLE}'));
UPDATE {AUTH_TABLE} SET status = 'SUPERSEDED', ended_at = now(), ended_by = :'owner', end_reason = :'reason'
 WHERE status = 'ACTIVE' AND channel_account_id = :'oa';
INSERT INTO {AUTH_TABLE} (go_code_fp, channel_account_id, max_requests_per_recipient_window, recipient_window_hours,
  max_requests_per_recipient_day, max_requests_per_day,
  daily_cost_budget_vnd, monthly_cost_budget_vnd, interaction_window_hours, free_window_hours,
  release_dist_hash, approved_by, approved_at)
SELECT :'fp', :'oa', :rw, :wh, :rd, :d, :bd, :bm, :iw, :fw, :'dist', :'owner', :'approved'::timestamptz
WHERE NOT EXISTS (SELECT 1 FROM {AUTH_TABLE} WHERE go_code_fp = :'fp')
RETURNING id;
SELECT (count(*) = 1) AS ok FROM {AUTH_TABLE} WHERE go_code_fp = :'fp' AND status = 'ACTIVE' \\gset
\\if :ok
{audit_sql}
COMMIT;
\\else
ROLLBACK;
\\endif
""", fp=code_fp(code), oa=oa, rw=L["max_requests_per_recipient_window"], wh=L["recipient_window_hours"],
            rd=L["max_requests_per_recipient_day"], d=L["max_requests_per_day"],
            bd=L["daily_cost_budget_vnd"], bm=L["monthly_cost_budget_vnd"], iw=L["interaction_window_hours"],
            fw=L["free_window_hours"], dist=record["dist_hash"], owner=owner, approved=record["approved_at"],
            reason=reason, **audit_params)
        ids = [line for line in out.splitlines() if re.fullmatch(r"\d+", line)]
        if len(ids) != 1 or prod_count_for_go(code) != 1:
            refuse("authorize-prod", owner, None, ["không tạo được uỷ quyền (đã rollback) — GO chưa bị dùng"], code)
        append_ledger({"event": "consume", "code_fp": code_fp(code), "stage": "prod", "at": now().isoformat(),
                       "authorization_id": int(ids[0]), "log": log})
    finally:
        os.close(lock)
    print(f"  Uỷ quyền production #{ids[0]} ACTIVE · GO PROD fp {code_fp(code)[:12]} đã dùng")


def end_prod_authorization(actor, reason, method):
    audit_sql, audit_params = db_audit(method, actor, {"reason": reason}, sql_only=True)
    if psql(f"SELECT to_regclass('public.{AUTH_TABLE}') IS NOT NULL") != "t":
        return []
    out = psql(f"""
BEGIN;
SELECT pg_advisory_xact_lock(hashtext('{AUTH_TABLE}'));
UPDATE {AUTH_TABLE} SET status = 'REVOKED', ended_at = now(), ended_by = :'actor', end_reason = :'reason'
 WHERE status = 'ACTIVE' RETURNING id;
{audit_sql}
COMMIT;
""", actor=actor, reason=reason, **audit_params)
    return [line for line in out.splitlines() if re.fullmatch(r"\d+", line)]


def revoke_prod(auth_arg):
    require_owner_terminal()
    auth_id = parse_id(auth_arg, "authorization_id")
    lock = dispatch_lock()
    try:
        owner = ask("Họ tên SYSTEM OWNER: ", lambda v: len(v) >= 3, "nhập họ tên")
        reason = ask("Lý do thu hồi: ", lambda v: 10 <= len(v) <= 300, "10–300 ký tự")
        ask(f"Gõ THU HOI PROD {auth_id} để xác nhận: ", lambda v: v == f"THU HOI PROD {auth_id}",
            f"phải gõ đúng: THU HOI PROD {auth_id}")
        active = psql(f"SELECT count(*) FROM {AUTH_TABLE} WHERE id = :aid AND status = 'ACTIVE'", aid=auth_id)
        if active != "1":
            refuse("revoke-prod", owner, None, [f"uỷ quyền #{auth_id} không ở ACTIVE"])
        ended = end_prod_authorization(owner, reason, "OWNER_PROD_REVOKE")
        append_ledger({"event": "revoke-prod", "authorization_ids": ended, "by": owner, "at": now().isoformat()})
    finally:
        os.close(lock)
    print(f"Đã thu hồi uỷ quyền production {ended} — sender không claim/gửi tin mới (production)")


def end_prod(reason):
    """activate-g8.sh pilot: quay lại pilot → kết thúc uỷ quyền production (thu hẹp quyền, không cần GO)."""
    if os.geteuid() != 0:
        die("cần root")
    if not 5 <= len(reason) <= 300:
        die("lý do 5–300 ký tự")
    lock = dispatch_lock()
    try:
        actor = f"activate-g8.sh pilot ({os.environ.get('SUDO_USER') or os.environ.get('LOGNAME') or 'root'})"
        ended = end_prod_authorization(actor, reason, "OWNER_PROD_END")
        append_ledger({"event": "end-prod", "authorization_ids": ended, "reason": reason, "at": now().isoformat()})
    finally:
        os.close(lock)
    print(f"  Uỷ quyền production đã kết thúc: {ended or 'không có uỷ quyền ACTIVE'}")


def list_prod():
    if psql(f"SELECT to_regclass('public.{AUTH_TABLE}') IS NOT NULL") != "t":
        print("Chưa áp migration GO PROD.")
        return
    if psql("SELECT count(*) FROM information_schema.columns WHERE table_schema='public' "
            f"AND table_name='{AUTH_TABLE}' AND column_name IN "
            "('max_requests_per_recipient_window','recipient_window_hours')") != "2":
        print("Chưa áp migration quota trượt.")
        return
    out = psql(f"""SELECT id || ' · ' || status || ' · OA …' || right(channel_account_id, 4)
  || ' · ' || max_requests_per_recipient_window || '/' || recipient_window_hours || 'h · '
  || max_requests_per_recipient_day || '/' || max_requests_per_day || ' tin/ngày · ngân sách '
  || daily_cost_budget_vnd || '/' || monthly_cost_budget_vnd || ' VND · cửa sổ ' || free_window_hours || '/'
  || interaction_window_hours || 'h · dist ' || release_dist_hash || ' · duyệt ' || approved_by
  || ' · bật ' || to_char(activated_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'DD/MM HH24:MI')
  || coalesce(' · kết thúc ' || to_char(ended_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'DD/MM HH24:MI') || ' bởi '
  || ended_by || ' (' || end_reason || ')', '') || ' · GO fp ' || left(go_code_fp, 12)
FROM {AUTH_TABLE} ORDER BY id""")
    print(out or "Chưa có uỷ quyền production nào.")


def main():
    args = sys.argv[1:]
    cmd = args[0] if args else ""
    if cmd == "approve" and len(args) == 2 and args[1] in ("c0", "c1", "c2"):
        approve(args[1])
    elif cmd == "approve" and len(args) == 3 and args[1] == "c2s":
        approve_c2s(args[2])
    elif cmd == "approve" and len(args) == 2 and args[1] == "prod":
        approve_prod()
    elif cmd == "authorize-prod" and len(args) in (2, 3):
        authorize_prod(args[1], args[2] if len(args) == 3 else None)
    elif cmd == "revoke-prod" and len(args) == 2:
        revoke_prod(args[1])
    elif cmd == "end-prod" and len(args) == 2:
        end_prod(args[1])
    elif cmd == "list-prod" and len(args) == 1:
        list_prod()
    elif cmd == "check" and len(args) == 3:
        record, state, why = status(args[1])
        if state != "VALID":
            die(f"GO {args[1]}: {why}")
        if record["stage"] != args[2]:
            die(f"GO {args[1]} cấp cho cổng {record['stage']}, không phải {args[2]}")
        print(f"  GO hợp lệ: fp {code_fp(args[1])[:12]} · cổng {record['stage']} · Owner {record['approver_name']} · "
              f"duyệt {record['approved_at']} · hết hạn {record['expires_at']}")
    elif cmd == "consume" and len(args) in (3, 4):
        record, state, why = status(args[1])
        if state != "VALID" or record["stage"] != args[2] or args[2] in ("c2s", "prod"):
            die(f"không đánh dấu được GO fp {code_fp(args[1])[:12]}: {why or 'sai cổng'}")
        append_ledger({"event": "consume", "code_fp": code_fp(args[1]), "stage": args[2], "at": now().isoformat(),
                       "log": args[3] if len(args) == 4 else None})
        print(f"  GO fp {code_fp(args[1])[:12]} đã ghi nhận là đã dùng")
    elif cmd == "revoke" and len(args) == 2:
        revoke(args[1])
    elif cmd == "grant-dispatch" and len(args) == 3:
        grant_dispatch(args[1], args[2])
    elif cmd == "revoke-dispatch" and len(args) == 2:
        revoke_dispatch(args[1])
    elif cmd == "list-dispatch" and len(args) == 1:
        list_dispatch()
    elif cmd == "list" and len(args) == 1:
        codes = sorted(f[:-5] for f in os.listdir(GO_DIR) if CODE_RE.match(f[:-5]) and f.endswith(".json")) \
            if os.path.isdir(GO_DIR) else []
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
