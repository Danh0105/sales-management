"""Kiểm thử GO PROD của g8-owner-go.py trên PostgreSQL TẠM — KHÔNG BAO GIỜ trỏ vào production.

    G8_PG_CONTAINER=g8-prod-pg G8_PG_DB=g8prod python3 -I owner_go_prod_test.py

DB tạm: schema production (pg_dump -s) + g8-production-outbound-ledger-up.sql + g8-production-go-prod-up.sql.
Nạp công cụ thật; chỉ thay: psql → container tạm, kiểm TTY/input → kịch bản, GO_DIR / ledger / env / dist /
releases → thư mục tạm. Xoá (TRUNCATE) dữ liệu recruitment của DB tạm. Không gọi Zalo.
"""
import builtins, contextlib, hashlib, importlib.util, io, json, os, subprocess, sys, tempfile

S = os.environ.get('G8_TEST_DIR') or tempfile.mkdtemp(prefix='g8-prod-test-')
TOOL = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'g8-owner-go.py')
CONTAINER = os.environ.get('G8_PG_CONTAINER', '')
DATABASE = os.environ.get('G8_PG_DB', '')
if not CONTAINER or not DATABASE or DATABASE in ('sales_db', 'postgres'):
    sys.exit('cần G8_PG_CONTAINER + G8_PG_DB của DB tạm (không phải sales_db)')
OA, PILOT = '1705071610099849262', '8812000000000000001'
FP = hashlib.sha256(f'{OA}:{PILOT}'.encode()).hexdigest()[:16]
RESULTS = []


def db(sql, **v):
    args = ['docker', 'exec', '-i', CONTAINER, 'psql', '-XAtq', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', DATABASE]
    for k, val in v.items():
        args += ['-v', f'{k}={val}']
    out = subprocess.run(args, input=sql, capture_output=True, text=True)
    if out.returncode:
        raise RuntimeError(out.stderr.strip()[-300:])
    return out.stdout.strip()


def load_tool():
    spec = importlib.util.spec_from_file_location('g8owner', TOOL)
    g = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(g)
    g.GO_DIR = f'{S}/go'; g.LEDGER = f'{S}/go/ledger.jsonl'
    g.CONF, g.OA_ENV, g.PROD_CONF = f'{S}/conf.env', f'{S}/oa.env', f'{S}/prod.env'
    g.APP_DIST, g.RELEASES = f'{S}/dist', f'{S}/releases'
    g.require_owner_terminal = lambda: None

    def psql(sql, **v):
        try:
            return db(sql, **v)
        except RuntimeError as e:
            g.die('psql lỗi: ' + str(e)[-200:])
    g.psql = psql
    return g


answers = []
builtins.input = lambda prompt='': answers.pop(0) if answers else ''
os.ttyname = lambda fd: '/dev/pts/test'
LIMITS = dict(rd=3, d=20, bd=0, bm=0, iw=48, fw=48)


def write_env(**over):
    lim = {**LIMITS, **over}
    open(f'{S}/conf.env', 'w').write(f'RECRUITMENT_PILOT_SENDER_FINGERPRINTS={FP}\nRECRUITMENT_PILOT_MODE=true\n')
    open(f'{S}/oa.env', 'w').write(f'RECRUITMENT_ZALO_OA_ID={OA}\n')
    body = ('RECRUITMENT_PRODUCTION_MODE=true\nRECRUITMENT_PILOT_MODE=false\nRECRUITMENT_ZALO_DISPATCH_GRANT_REQUIRED=false\n'
            'RECRUITMENT_ZALO_OUTBOUND_ENABLED=true\nRECRUITMENT_AI_ENABLED=true\nRECRUITMENT_WORKER_ENABLED=true\n'
            f"RECRUITMENT_ZALO_MAX_REQUESTS_PER_RECIPIENT_DAY={lim['rd']}\nRECRUITMENT_ZALO_MAX_REQUESTS_PER_DAY={lim['d']}\n"
            f"RECRUITMENT_ZALO_DAILY_COST_BUDGET_VND={lim['bd']}\nRECRUITMENT_ZALO_MONTHLY_COST_BUDGET_VND={lim['bm']}\n"
            f"RECRUITMENT_ZALO_INTERACTION_WINDOW_HOURS={lim['iw']}\nRECRUITMENT_ZALO_FREE_WINDOW_HOURS={lim['fw']}\n"
            'RECRUITMENT_ZALO_ESTIMATED_PAID_MESSAGE_COST_VND=500\nRECRUITMENT_ZALO_OA_BLOCKING_ERRORS=-224\n'
            'RECRUITMENT_HR_MESSAGE_TTL_MINUTES=60\n')
    fd = os.open(f'{S}/prod.env', os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.write(fd, body.encode()); os.close(fd); os.chmod(f'{S}/prod.env', 0o600)


def seed(halted=True, unfinished=False, sent=True):
    db('''TRUNCATE recruitment_production_authorizations, recruitment_outbound_attempts, recruitment_outbound_dispatch_grants,
            recruitment_outbox_approvals, recruitment_channel_outbox, recruitment_channel_events, recruitment_messages,
            recruitment_conversations, recruitment_candidates, recruitment_zalo_credentials RESTART IDENTITY CASCADE;
          DELETE FROM recruitment_runtime_controls; DELETE FROM recruitment_jobs;''')
    db(f"INSERT INTO recruitment_runtime_controls (id, ai_halted, worker_halted, outbound_halted, failsafe_halted) VALUES (1,false,false,{str(halted).lower()},false)")
    db(f"INSERT INTO recruitment_zalo_credentials (oa_id, access_token_enc, refresh_token_enc, access_expires_at) VALUES ('{OA}','x','y', now())")
    db(f"""INSERT INTO recruitment_candidates (zalo_oa_id, zalo_user_id, source) VALUES ('{OA}','{PILOT}','ZALO');
      INSERT INTO recruitment_conversations (candidate_id, channel, external_conversation_id, control_mode, control_version) VALUES (1,'ZALO','{OA}:{PILOT}','AI_ACTIVE',3);
      INSERT INTO recruitment_messages (conversation_id, sender_type, direction, content, author_employee_id) VALUES (1,'HR','OUTBOUND','Nghiệm thu',158);
      INSERT INTO recruitment_channel_outbox (channel, channel_account_id, external_recipient_id, message_text, recruitment_message_id, status, source_type, sent_at, provider_message_id)
        VALUES ('ZALO','{OA}','{PILOT}', NULL, 1, '{'SENT' if sent else 'DEAD_LETTER'}', 'HR_MESSAGE', now(), {"'zmsg-1'" if sent else 'NULL'});""")
    if unfinished:
        db(f"""INSERT INTO recruitment_messages (conversation_id, sender_type, direction, content, author_employee_id) VALUES (1,'HR','OUTBOUND','cũ',158);
          INSERT INTO recruitment_channel_outbox (channel, channel_account_id, external_recipient_id, message_text, recruitment_message_id, status, source_type)
            VALUES ('ZALO','{OA}','{PILOT}','cũ',2,'PENDING','HR_MESSAGE');""")


def run(fn, *args, ans=()):
    answers[:] = list(ans)
    buf = io.StringIO()
    ok = True
    with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
        try:
            fn(*args)
        except SystemExit as e:
            ok = not e.code
    return ok, buf.getvalue()


def check(name, cond, detail=''):
    RESULTS.append((name, bool(cond)))
    print(('PASS ' if cond else 'FAIL ') + name + ('' if cond else f'  ← {detail[-300:]}'))


def approve(g, rollback='rollback-test', outbox='1', tag=None):
    tag = tag or 'HAN MUC 3/20/0'
    ok, out = run(g.approve_prod, ans=['Owner Test', rollback, outbox, 'Gói Tăng trưởng hết hạn 31/12/2026',
                                       'OA ICHI SKILL CO QUYEN OPENAPI', tag, 'TOI PHE DUYET PROD'])
    code = next((w for w in out.split() if w.startswith('G8-PROD-')), None)
    return ok, out, code


def main():
    os.makedirs(f'{S}/go', mode=0o700, exist_ok=True)
    for f in os.listdir(f'{S}/go'):
        os.remove(os.path.join(f'{S}/go', f))
    os.makedirs(f'{S}/dist/recruitment/channels', exist_ok=True)
    open(f'{S}/dist/recruitment/channels/recruitment-channel-outbox.queue.js', 'w').write('// recruitment_production_authorizations\n')
    os.makedirs(f'{S}/releases/rollback-test/dist', exist_ok=True)
    write_env()
    db("DELETE FROM activity_log WHERE path = '/recruitment-owner-go'")  # DB test: audit từ lần chạy trước
    g = load_tool()

    # 1. chặn khi điều kiện chưa đủ
    seed(halted=False)
    ok, out, _ = approve(g)
    check('approve prod bị từ chối khi Gửi Zalo đang mở', not ok and 'DỪNG KHẨN' in out, out)
    seed(unfinished=True)
    ok, out, _ = approve(g)
    check('approve prod bị từ chối khi còn outbox PENDING (#7)', not ok and 'chưa xong' in out, out)
    seed(sent=False)
    ok, out, _ = approve(g)
    check('approve prod bị từ chối khi chưa có lượt gửi nghiệm thu SENT', not ok and 'chưa SENT' in out, out)
    seed()
    ok, out, _ = approve(g, rollback='khong-co')
    check('approve prod bị từ chối khi không có release rollback', not ok and 'rollback' in out, out)
    ok, out, _ = approve(g, tag='HAN MUC 3/50/0')
    check('gõ sai hạn mức → không cấp GO', not ok and not os.listdir(f'{S}/go') == [], out)
    rejects = db("select count(*) from activity_log where method = 'OWNER_DISPATCH_REJECT' and context->>'action' = 'approve-prod'")
    check('mỗi lần từ chối có audit OWNER_DISPATCH_REJECT', int(rejects) >= 4, rejects)

    # 2. cấp GO PROD
    ok, out, code = approve(g)
    check('approve prod cấp GO G8-PROD-…', ok and code, out)
    rec, state, why = g.status(code)
    check('GO PROD VALID, gắn hạn mức + dist + outbox nghiệm thu', state == 'VALID' and rec['limits'] ==
          {'max_requests_per_recipient_day': 3, 'max_requests_per_day': 20, 'daily_cost_budget_vnd': 0,
           'monthly_cost_budget_vnd': 0, 'interaction_window_hours': 48, 'free_window_hours': 48}
          and rec['verification_outbox_id'] == 1 and len(rec['dist_hash']) == 16, json.dumps(rec)[:300])
    check('audit OWNER_GO_PROD_APPROVE không chứa mã GO',
          db("select count(*) from activity_log where method='OWNER_GO_PROD_APPROVE' and context::text not like '%G8-PROD-%'") == '1')

    # 3. authorize: env đổi hạn mức → từ chối; artifact đổi → từ chối
    write_env(d=50)
    ok, out = run(g.authorize_prod, code)
    check('authorize-prod từ chối khi hạn mức env khác GO', not ok and 'đã đổi' in out, out)
    write_env()
    open(f'{S}/dist/extra.js', 'w').write('x')
    ok, out = run(g.authorize_prod, code)
    check('authorize-prod từ chối khi artifact khác artifact đã duyệt', not ok and 'artifact' in out, out)
    os.remove(f'{S}/dist/extra.js')
    check('chưa tạo uỷ quyền nào sau các lần từ chối', db('select count(*) from recruitment_production_authorizations') == '0')

    # 4. authorize thành công
    ok, out = run(g.authorize_prod, code, '/tmp/log')
    check('authorize-prod tạo uỷ quyền ACTIVE', ok and db("select count(*) from recruitment_production_authorizations where status='ACTIVE' and max_requests_per_day=20 and max_requests_per_recipient_day=3 and daily_cost_budget_vnd=0 and free_window_hours=48") == '1', out)
    check('GO PROD → USED (DB là nguồn sự thật)', g.status(code)[1] == 'USED')
    ok, out = run(g.authorize_prod, code)
    check('dùng lại GO PROD bị từ chối', not ok and 'không còn hiệu lực' in out, out)
    check('audit OWNER_PROD_AUTHORIZE', db("select count(*) from activity_log where method='OWNER_PROD_AUTHORIZE'") == '1')
    sys.argv = ['x', 'consume', code, 'prod']
    ok, out = run(g.main)
    check('lệnh consume chung không dùng được cho prod', not ok, out)

    # 5. GO PROD thứ hai → uỷ quyền cũ SUPERSEDED, chỉ một ACTIVE
    ok, out, code2 = approve(g)
    ok2, out2 = run(g.authorize_prod, code2)
    check('GO PROD mới thay uỷ quyền cũ (SUPERSEDED), đúng 1 ACTIVE', ok and ok2 and
          db("select string_agg(status, ',' order by id) from recruitment_production_authorizations") == 'SUPERSEDED,ACTIVE', out2)

    # 6. thu hồi / kết thúc
    aid = db("select id from recruitment_production_authorizations where status='ACTIVE'")
    ok, out = run(g.revoke_prod, aid, ans=['Owner Test', 'Kiểm thử thu hồi production', f'THU HOI PROD {aid}'])
    check('revoke-prod → REVOKED + audit', ok and db("select status from recruitment_production_authorizations where id=" + aid) == 'REVOKED'
          and db("select count(*) from activity_log where method='OWNER_PROD_REVOKE'") == '1', out)
    ok, out, code3 = approve(g)
    run(g.authorize_prod, code3)
    ok, out = run(g.end_prod, 'quay lại pilot để kiểm thử')
    check('end-prod (activate-g8.sh pilot) kết thúc uỷ quyền ACTIVE + audit', ok and
          db("select count(*) from recruitment_production_authorizations where status='ACTIVE'") == '0'
          and db("select count(*) from activity_log where method='OWNER_PROD_END'") == '1', out)
    ok, out = run(g.end_prod, 'không còn gì để kết thúc')
    check('end-prod khi không có ACTIVE → không lỗi', ok and 'không có uỷ quyền ACTIVE' in out, out)
    ok, out = run(g.list_prod)
    check('list-prod liệt kê, không lộ mã GO', ok and 'G8-PROD-' not in out and out.count('\n') >= 3, out)

    # 7. GO PROD chưa dùng có thể thu hồi
    ok, out, code4 = approve(g)
    ok, out = run(g.revoke, code4, ans=['Owner Test', 'THU HOI'])
    check('thu hồi GO PROD chưa dùng → REVOKED + audit', ok and g.status(code4)[1] == 'REVOKED'
          and db("select count(*) from activity_log where method='OWNER_GO_PROD_REVOKE'") == '1', out)
    ok, out = run(g.authorize_prod, code4)
    check('GO PROD đã thu hồi không tạo được uỷ quyền', not ok, out)

    passed = sum(1 for _, r in RESULTS if r)
    print(f'\n{passed}/{len(RESULTS)} PASS')
    sys.exit(0 if passed == len(RESULTS) else 1)


if __name__ == '__main__':
    main()
