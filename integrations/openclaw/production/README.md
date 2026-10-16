# Gateway OpenClaw production — AI Recruiter (G8 / A3)

Phạm vi: chỉ gateway. Không bật worker, xử lý AI hay outbound — các bước đó là cổng G8.x riêng.

## Kiến trúc

```text
Zalo OA → nginx → 3010 (webhook, worker khi được bật)
                    │  RECRUITMENT_OPENCLAW_URL=http://127.0.0.1:18790   (bước G8 sau)
                    ▼
          127.0.0.1:18790 ──► container gateway 172.31.250.2 (bridge br-kido-prod, 172.31.250.0/29)
                                  │ plugin kido-recruitment, chỉ 15 tool recruitment_*
                                  ├─► 172.31.250.1:3010 /recruitment/ai/*  (key kênh + X-Recruitment-Subject)
                                  └─► api.openai.com:443                   (OPENAI_API_KEY production riêng)
```

| Mục | Giá trị |
|---|---|
| Compose project | `kido-recruiter-prod` (`production/docker-compose.yml`) |
| Secrets | `/opt/kido-recruiter-prod/.env` (thư mục 700, file 600 root): `OPENAI_API_KEY`, `OPENCLAW_GATEWAY_TOKEN`, `RECRUITMENT_CHANNEL_API_KEY`. Không có `RECRUITMENT_AI_API_KEY` |
| Mạng | bridge `br-kido-prod`, `172.31.250.0/29`, cổng host `172.31.250.1` |
| Publish | chỉ `127.0.0.1:18790` |
| Bản chụp | `/opt/kido-recruiter-prod/build/{plugin-build,skills,workspace,SOURCE_COMMIT}` |

Dựng / dựng lại: `integrations/openclaw/production/bootstrap.sh [--verify]` (xem đầu file).

## Đo trước khi có luật ufw (16/10/2026, container tạm trên `br-kido-prod`)

| Đích | Kết quả | Lý do |
|---|---|---|
| `172.31.250.1:3010`, `:3011` | chặn | ufw mặc định deny incoming |
| `172.31.250.1:5432`, `:22`, `:80`, `:443`, `:3001`; IP công khai host `:5432` | **mở** | các luật ufw `ALLOW IN Anywhere` sẵn có |
| Cổng Docker publish (`:5434`, `:6380`, `:3020`), mạng staging | chặn | cách ly bridge của Docker |
| `api.openai.com:443` | mở | cần cho gateway |

⇒ Một luật allow cho 3010 là chưa đủ: phải kèm luật chặn mọi cổng host khác từ `br-kido-prod`.

## Luật ufw — CHỜ DUYỆT (chưa áp)

| | Luật 1 | Luật 2 |
|---|---|---|
| Hành động | ALLOW | DENY (DROP) |
| Interface vào | `br-kido-prod` | `br-kido-prod` |
| Nguồn | `172.31.250.0/29` | `172.31.250.0/29` |
| Đích | `172.31.250.1` (địa chỉ host trên bridge) | mọi địa chỉ host |
| Cổng / giao thức | `3010/tcp` | mọi cổng, mọi giao thức |
| Vị trí | 1 (trên mọi luật hiện có) | 2 (ngay sau luật 1) |

```bash
ufw insert 1 allow in on br-kido-prod from 172.31.250.0/29 to 172.31.250.1 port 3010 proto tcp comment 'kido-recruiter-prod gateway to sales API 3010'
ufw insert 2 deny in on br-kido-prod from 172.31.250.0/29 comment 'kido-recruiter-prod gateway deny other host ports'
```

iptables sinh ra (đã kiểm bằng `ufw --dry-run`):

```text
-A ufw-user-input -i br-kido-prod -p tcp -d 172.31.250.1 --dport 3010 -s 172.31.250.0/29 -j ACCEPT
-A ufw-user-input -i br-kido-prod -s 172.31.250.0/29 -j DROP
```

Tác động:
- Chỉ khớp gói **đi vào host từ `br-kido-prod`** — interface chỉ mạng gateway production dùng. Mọi luồng khác
  (Internet → 80/443, SSH, Tailscale, các app khác, staging) không đổi. Không `ufw reload` / `disable` / `enable`;
  luật có hiệu lực ngay và được lưu trong `/etc/ufw/user.rules`.
- Gateway → `172.31.250.1:3010` được phép; gateway → mọi cổng host khác (5432, 22, 80, 443, 3001, 3011, kể cả qua IP
  công khai của host) bị DROP. Đường ra Internet (chuỗi FORWARD, `api.openai.com:443`) không đổi.
- Chưa bật AI: `/recruitment/ai/*` trên 3010 vẫn trả 503 (`RECRUITMENT_AI_ENABLED` không đặt), worker 3010 chưa trỏ
  gateway ⇒ không có xử lý AI nào sau khi áp.

Rollback (xoá đúng 2 luật, không đụng luật khác):

```bash
ufw delete allow in on br-kido-prod from 172.31.250.0/29 to 172.31.250.1 port 3010 proto tcp
ufw delete deny in on br-kido-prod from 172.31.250.0/29
```

Nghiệm thu sau khi áp: từ container tạm trên `br-kido-prod` — `3010` mở; `3011`, `5432`, `22`, `80`, `443`, `3001`
và IP công khai `:5432` bị chặn; `api.openai.com:443` mở; `ufw status numbered` có đúng 2 dòng `br-kido-prod`
ở vị trí 1–2.

## Sau khi duyệt ufw (vẫn chưa bật AI)

`docker compose -f production/docker-compose.yml --env-file /opt/kido-recruiter-prod/.env up -d openclaw-gateway`
→ chờ healthy → `openclaw security audit` = 0 critical / 0 warn → `docker port` chỉ `127.0.0.1:18790`.

Các bước G8 kế tiếp (mỗi bước duyệt riêng): đưa release lên 3010 (có cổng duyệt tin) → đặt cho 3010
`RECRUITMENT_OPENCLAW_URL`, `RECRUITMENT_OPENCLAW_TOKEN`, `RECRUITMENT_CHANNEL_API_KEY` (cùng giá trị file trên),
`RECRUITMENT_AI_REQUIRE_SUBJECT=true`, cấu hình pilot + trần (kế hoạch P3.2) → mở AI → WORKER (shadow) → HR duyệt
từng tin → OUTBOUND.

## Rủi ro còn lại

- Gateway ra Internet không giới hạn đích (chỉ cần `api.openai.com:443`). Tool policy chặn web/fs/exec nên model không
  tự mở kết nối; muốn khoá thêm cần luật `DOCKER-USER` cho `br-kido-prod` (đề xuất riêng).
- Ngoài phạm vi, phát hiện khi đo: ufw `5432/tcp ALLOW IN Anywhere` + `pg_hba` `host all all 0.0.0.0/0` ⇒ Postgres
  production nhận đăng nhập mật khẩu từ Internet — backlog khẩn, không sửa trong bước này.
