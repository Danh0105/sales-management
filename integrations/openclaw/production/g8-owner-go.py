#!/usr/bin/env python3
"""G8 — Owner Approval: chủ hệ thống (SYSTEM OWNER) tự cấp GO cho từng cổng C0 / C1 / C2.

    python3 -I g8-owner-go.py approve c0|c1|c2      # Owner gõ trực tiếp trong terminal → in mã GO của cổng đó
    python3 -I g8-owner-go.py list                  # các GO: mã, cổng, người duyệt, thời gian, trạng thái
    python3 -I g8-owner-go.py revoke <mã>           # thu hồi một GO chưa dùng (Owner gõ trực tiếp)
    python3 -I g8-owner-go.py check <mã> <cổng>     # activate-g8.sh gọi: GO hợp lệ cho cổng → exit 0
    python3 -I g8-owner-go.py consume <mã> <cổng> [nhật ký]   # activate-g8.sh gọi sau khi mở cổng thành công
    python3 -I g8-owner-go.py grant-dispatch <mã GO C2> <outbox_id>   # cấp ĐÚNG 1 lần dispatch cho 1 tin AI đã duyệt
    python3 -I g8-owner-go.py revoke-dispatch <grant_id>              # thu hồi grant chưa dùng
    python3 -I g8-owner-go.py list-dispatch                           # các grant dispatch

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
  Owner cấp ở đây (superuser postgres — app `sales_app` không có quyền INSERT), mỗi GO C2 một grant, gắn đúng 1
  outbox, tiêu đúng 1 lần trong transaction ghi dispatch; chỉ cấp khi hàng đợi có ĐÚNG một dòng chưa xong là tin đó.
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
    "c2": "Bật OUTBOUND + single dispatch guard: chỉ tin AI HR đã duyệt VÀ Owner cấp grant (grant-dispatch) mới "
          "được gửi, đúng 1 lần, chỉ tới tài khoản pilot; tin HR / tin khác giữ chờ. Restart 3010 (~10–20 giây).",
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


GRANT_TABLE = "recruitment_outbound_dispatch_grants"
OA_ENV = "/root/recruitment-oa.env"
UNFINISHED = "('AWAITING_APPROVAL', 'PENDING', 'SENDING', 'RETRY', 'UNKNOWN')"
FP_SQL = "left(encode(sha256(convert_to(o.channel_account_id || ':' || o.external_recipient_id, 'UTF8')), 'hex'), 16)"


def psql(sql, **variables):
    """psql (postgres) đọc SQL từ stdin; biến chèn qua -v (:'ten' / :ten), không ghép chuỗi."""
    args = ["runuser", "-u", "postgres", "--", "psql", "-XAtq", "-v", "ON_ERROR_STOP=1", "-d", "sales_db"]
    for key, value in variables.items():
        args += ["-v", f"{key}={value}"]
    out = subprocess.run(args, input=sql, capture_output=True, text=True, check=False)
    if out.returncode != 0:
        die("psql lỗi: " + (out.stderr.strip().splitlines() or ["?"])[-1][:240])
    return out.stdout.strip()


def grant_preflight(outbox_id):
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
  'approval', (SELECT json_build_object('state', a.state, 'sha', a.approved_text_sha256, 'oa', a.approved_oa_id,
       'cv', a.approved_control_version, 'msg_ok', a.approved_message_id = o.recruitment_message_id,
       'recipient_ok', a.approved_recipient_id = o.external_recipient_id,
       'expires', to_char(a.expires_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'HH24:MI:SS'),
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
  'guard_trigger', EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'TRG_dispatch_grant_guard' AND NOT tgisinternal)
)""", outbox=outbox_id)
    return json.loads(raw)


def grant_dispatch(code, outbox_arg):
    require_owner_terminal()
    if not re.fullmatch(r"[1-9]\d{0,9}", outbox_arg or ""):
        die("outbox_id phải là số nguyên dương")
    outbox_id = int(outbox_arg)
    record, state, why = status(code)
    if record is None or record.get("stage") != "c2":
        die(f"cần mã GO C2 hợp lệ ({why or 'không phải cổng c2'})")
    if state not in ("VALID", "USED") or now() > dt.datetime.fromisoformat(record["expires_at"]):
        die(f"GO {code} không còn hiệu lực ({why or state})")
    if any(e.get("event") == "grant" and e.get("code") == code for e in ledger_events()):
        die(f"GO {code} đã dùng để cấp một grant — mỗi GO C2 chỉ cho đúng một lần dispatch")

    conf = read_env(CONF)
    pilots = [x.strip() for x in conf.get("RECRUITMENT_PILOT_SENDER_FINGERPRINTS", "").split(",") if x.strip()]
    oa = read_env(OA_ENV).get("RECRUITMENT_ZALO_OA_ID", "")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", oa):
        die(f"không đọc được RECRUITMENT_ZALO_OA_ID trong {OA_ENV}")
    pf = grant_preflight(outbox_id)
    o, a = pf.get("outbox"), pf.get("approval")
    problems = []
    if not pf.get("guard_trigger"):
        problems.append("chưa có migration single dispatch guard (trigger TRG_dispatch_grant_guard)")
    if not o:
        problems.append(f"không có outbox #{outbox_id} gắn với tin canonical")
    else:
        if o["source"] != "AI_REPLY": problems.append(f"outbox là {o['source']}, chỉ cấp cho AI_REPLY")
        if o["status"] != "PENDING": problems.append(f"outbox đang {o['status']} (cần PENDING sau khi HR duyệt)")
        if o["dispatched"]: problems.append("outbox đã có dispatched_at")
        if o["oa"] != oa: problems.append("OA của tin khác OA tuyển dụng đang cấu hình")
        if o["fp"] not in pilots: problems.append(f"người nhận {o['fp']} không thuộc pilot {pilots}")
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
        problems.append("Gửi Zalo đang MỞ — cấp grant khi còn dừng khẩn, rồi HR mới mở lại")

    print(f"\n=== GRANT DISPATCH — outbox #{outbox_id} · GO {code} ===")
    if o:
        print(f"Tin: {o['source']} · {o['status']} · {o['text_len']} ký tự · sha {o['text_sha'][:12]}… · người nhận fp {o['fp']} · version {o['cv']}")
    if a:
        print(f"Bản duyệt HR: {a['state']} · hết hạn {a['expires']} (còn {a['seconds_left']} giây)")
    print(f"Hàng đợi chưa xong: {pf['unfinished']} · grant ACTIVE: {pf['active_grants']} · runtime: {pf.get('runtime')}")
    if problems:
        die("không cấp grant:\n  - " + "\n  - ".join(problems))

    owner = ask("Họ tên SYSTEM OWNER: ", lambda v: len(v) >= 3, "nhập họ tên đầy đủ")
    ask(f"Gõ CHO PHEP GUI {outbox_id} để cấp đúng 1 lần dispatch cho tin này: ",
        lambda v: v == f"CHO PHEP GUI {outbox_id}", f"phải gõ đúng: CHO PHEP GUI {outbox_id}")
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
    AND o.channel_account_id = :'oa' AND {FP_SQL} = :'fp'
    AND a.state = 'APPROVED' AND a.expires_at > now() + interval '2 minutes'
    AND a.approved_oa_id = o.channel_account_id AND a.approved_recipient_id = o.external_recipient_id
    AND a.approved_message_id = o.recruitment_message_id AND a.approved_control_version = o.control_version
    AND c.control_mode = 'AI_ACTIVE' AND c.control_version = o.control_version
    AND m.content = o.message_text
    AND a.approved_text_sha256 = encode(sha256(convert_to(m.content, 'UTF8')), 'hex')
    AND NOT EXISTS (SELECT 1 FROM recruitment_channel_outbox x WHERE x.id <> o.id AND x.status IN {UNFINISHED})
  FOR UPDATE OF o, a
)
INSERT INTO {GRANT_TABLE} (go_code, outbox_id, channel_account_id, recipient_fingerprint, approved_text_sha256,
                           approved_control_version, created_by, expires_at, reason)
SELECT :'go', id, channel_account_id, fp, sha, cv, :'owner', least(expires_at, now() + interval '30 minutes'), 'G8 C2 owner grant'
FROM target
RETURNING id || '|' || to_char(expires_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'HH24:MI:SS');
SELECT (count(*) = 1) AS ok FROM {GRANT_TABLE} WHERE outbox_id = :outbox AND status = 'ACTIVE' \\gset
\\if :ok
COMMIT;
\\else
ROLLBACK;
\\endif
""", outbox=outbox_id, oa=oa, fp=(o or {}).get("fp", ""), go=code, owner=owner)
    rows = [line for line in out.splitlines() if "|" in line]
    if len(rows) != 1:
        die("không cấp được grant (điều kiện đổi trong lúc xác nhận) — đã rollback")
    grant_id, expires = rows[0].split("|", 1)
    append_ledger({"event": "grant", "code": code, "outbox_id": outbox_id, "grant_id": int(grant_id),
                   "by": owner, "at": now().isoformat(), "expires": expires})
    print(f"\nĐÃ CẤP GRANT #{grant_id} cho outbox #{outbox_id} — đúng 1 lần dispatch, hết hạn {expires}.")
    print("Bước tiếp: HR mở lại \"Gửi Zalo\" → sender gửi đúng tin này; mọi tin khác giữ chờ.")


def revoke_dispatch(grant_arg):
    require_owner_terminal()
    if not re.fullmatch(r"[1-9]\d{0,9}", grant_arg or ""):
        die("grant_id phải là số nguyên dương")
    owner = ask("Họ tên SYSTEM OWNER: ", lambda v: len(v) >= 3, "nhập họ tên")
    ask(f"Gõ THU HOI GRANT {grant_arg} để xác nhận: ", lambda v: v == f"THU HOI GRANT {grant_arg}",
        f"phải gõ đúng: THU HOI GRANT {grant_arg}")
    out = psql(f"""UPDATE {GRANT_TABLE} SET status = 'REVOKED', revoked_at = now(), revoked_by = :'owner', reason = 'OWNER_REVOKED'
 WHERE id = :gid AND status = 'ACTIVE' RETURNING id""", gid=int(grant_arg), owner=owner)
    if not out:
        die(f"grant #{grant_arg} không ở ACTIVE — không thu hồi")
    append_ledger({"event": "revoke-dispatch", "grant_id": int(grant_arg), "by": owner, "at": now().isoformat()})
    print(f"Đã thu hồi grant #{grant_arg}")


def list_dispatch():
    out = psql(f"""SELECT id || ' · outbox ' || outbox_id || ' · ' || status || ' · dùng ' || dispatches_used || '/' || max_dispatches
  || ' · cấp ' || to_char(created_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'DD/MM HH24:MI') || ' bởi ' || created_by
  || ' · hết hạn ' || to_char(expires_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'DD/MM HH24:MI')
  || coalesce(' · tiêu ' || to_char(consumed_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'DD/MM HH24:MI:SS'), '')
  || coalesce(' · thu hồi ' || to_char(revoked_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'DD/MM HH24:MI'), '')
  || ' · GO ' || go_code
FROM {GRANT_TABLE} ORDER BY id""")
    print(out or "Chưa có grant dispatch nào.")


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
    elif cmd == "grant-dispatch" and len(args) == 3:
        grant_dispatch(args[1], args[2])
    elif cmd == "revoke-dispatch" and len(args) == 2:
        revoke_dispatch(args[1])
    elif cmd == "list-dispatch" and len(args) == 1:
        list_dispatch()
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
