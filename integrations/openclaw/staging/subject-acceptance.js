// Acceptance P3-2 (mức HTTP) — chạy BÊN TRONG container staging-api, đọc key từ env
// của chính container (không truyền key qua tham số).
//
//   node - full <runId> <jobId> <slotId>    # mọi case subject/ownership
//   node - required <runId>                 # instance bật RECRUITMENT_AI_REQUIRE_SUBJECT
//
// In ra một dòng JSON cuối: { results: [{name, ok, detail}], ids: {...} }.
const MODE = process.argv[2];
const RUN = process.argv[3];
const PORT = process.env.TARGET_PORT || process.env.PORT || 3021;
const BASE = `http://localhost:${PORT}/recruitment/ai`;
const AI = process.env.RECRUITMENT_AI_API_KEY;
const CH = process.env.RECRUITMENT_CHANNEL_API_KEY;
const results = [];
const ids = {};

async function call(method, path, { key = CH, subject, body, idem } = {}) {
  const headers = { Authorization: `Bearer ${key}`, Accept: 'application/json' };
  if (subject !== undefined) headers['X-Recruitment-Subject'] = subject;
  if (body) headers['Content-Type'] = 'application/json';
  if (idem) headers['Idempotency-Key'] = idem;
  const res = await fetch(`${BASE}/${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text.slice(0, 200) };
  }
  return { status: res.status, data };
}

/** Chi tiết lỗi gọn: nhiều lời gọi → {bước: status/code}; một lời gọi → status/code/message. */
function summarize(detail) {
  if (detail && typeof detail === 'object' && 'status' in detail) {
    return { status: detail.status, code: detail.data?.code, message: String(detail.data?.message ?? '').slice(0, 160) };
  }
  if (detail && typeof detail === 'object') {
    return Object.fromEntries(Object.entries(detail).map(([k, v]) => [k, v && typeof v === 'object' && 'status' in v ? `${v.status}${v.data?.code ? '/' + v.data.code : ''}` : v]));
  }
  return detail;
}

function check(name, ok, detail) {
  results.push(ok ? { name, ok: true } : { name, ok: false, detail: JSON.stringify(summarize(detail)).slice(0, 400) });
}

/** 403 đúng mã và KHÔNG kèm dữ liệu nào khác ngoài code/message. */
function denied(r, code) {
  return (
    r.status === 403 &&
    r.data?.code === code &&
    Object.keys(r.data).every((k) => ['code', 'message'].includes(k))
  );
}

async function full(jobId, slotId) {
  const oaA = `oaa${RUN}`;
  const oaB = `oab${RUN}`;
  const sA = `zalo:${oaA}:u1`;
  const sB = `zalo:${oaA}:u2`;
  const sC = `zalo:${oaB}:u1`;
  ids.subjects = { sA, sB, sC };

  // --- Danh tính kênh
  const a1 = await call('POST', 'candidates/find-or-create', { subject: sA, body: { fullName: 'Ứng viên A', source: 'ZALO' } });
  const a2 = await call('POST', 'candidates/find-or-create', { subject: sA, body: { source: 'ZALO' } });
  ids.A = a1.data?.candidate?.id;
  check('cùng OA + cùng user → cùng ứng viên', a1.status === 200 && a1.data.outcome === 'CREATED' && a2.data?.outcome === 'EXISTING' && a2.data.candidate.id === ids.A, { a1, a2 });
  const b = await call('POST', 'candidates/find-or-create', { subject: sB, body: { fullName: 'Ứng viên B', source: 'ZALO' } });
  ids.B = b.data?.candidate?.id;
  check('cùng OA + khác user → khác ứng viên', b.status === 200 && ids.B && ids.B !== ids.A, b);
  const c = await call('POST', 'candidates/find-or-create', { subject: sC, body: { fullName: 'Ứng viên C', source: 'ZALO' } });
  ids.C = c.data?.candidate?.id;
  check('khác OA + cùng user id → khác danh tính kênh', c.status === 200 && ids.C && ids.C !== ids.A, c);

  // --- Subject thiếu / sai / không tin cậy / model khai khác
  check('key kênh thiếu subject → SUBJECT_REQUIRED', denied(await call('GET', 'jobs/active'), 'SUBJECT_REQUIRED'), null);
  check('subject sai định dạng → SUBJECT_INVALID', denied(await call('GET', 'jobs/active', { subject: 'zalo:x' }), 'SUBJECT_INVALID'), null);
  check('subject tự nhận OA legacy → SUBJECT_INVALID', denied(await call('GET', 'jobs/active', { subject: 'zalo:legacy:u1' }), 'SUBJECT_INVALID'), null);
  check('key AI chung tự gửi subject → SUBJECT_NOT_TRUSTED', denied(await call('GET', 'jobs/active', { key: AI, subject: sA }), 'SUBJECT_NOT_TRUSTED'), null);
  const claim = await call('POST', 'candidates/find-or-create', { subject: sA, body: { zaloUserId: 'u2', source: 'ZALO' } });
  check('model khai zaloUserId khác subject → SUBJECT_MISMATCH', denied(claim, 'SUBJECT_MISMATCH'), claim);

  // --- Dữ liệu của B (chủ sở hữu tự tạo)
  const appA = await call('POST', 'applications/find-or-create', { subject: sA, body: { candidateId: ids.A, jobId } });
  ids.appA = appA.data?.application?.id;
  const appB = await call('POST', 'applications/find-or-create', { subject: sB, body: { candidateId: ids.B, jobId } });
  ids.appB = appB.data?.application?.id;
  const phoneB = `096${String(RUN).slice(-7).padStart(7, '0')}`;
  const start = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  const upd = await call('PATCH', `candidates/${ids.B}`, {
    subject: sB,
    body: { phone: phoneB, location: 'TP Cà Mau', totalExperienceMonths: 24, skills: ['sales', 'CRM'], expectedSalary: 12000000, availableFrom: start },
  });
  ids.phoneB = upd.data?.candidate?.phone ?? phoneB;
  const scr = await call('POST', `applications/${ids.appB}/screen`, {
    subject: sB,
    body: { extractedSkills: ['sales', 'CRM'], totalExperienceMonths: 24, expectedSalary: 12000000, availableFrom: start, location: 'Cà Mau', aiSummary: 'acceptance' },
  });
  const prop = await call('POST', 'interviews/propose', { subject: sB, body: { applicationId: ids.appB, slotId }, idem: `acc-${RUN}-propose-b` });
  ids.ivB = prop.data?.interview?.id;
  const msgB = await call('POST', 'conversations/message', {
    subject: sB,
    body: { candidateId: ids.B, applicationId: ids.appB, channel: 'ZALO', externalMessageId: `acc-${RUN}-b1`, senderType: 'CANDIDATE', direction: 'INBOUND', content: 'Xin chào' },
  });
  ids.convB = msgB.data?.conversationId;
  check('B tự làm việc với dữ liệu của mình (hồ sơ, sàng lọc, lịch, tin nhắn)', [appA, appB, upd, scr, prop, msgB].every((r) => r.status === 200) && ids.ivB && ids.convB, { appA, appB, upd, scr, prop, msgB });

  // --- A đòi dữ liệu của B → bị chặn
  const attacks = [
    ['candidateId người khác: getCandidate', () => call('GET', `candidates/${ids.B}`, { subject: sA })],
    ['candidateId người khác: updateCandidate', () => call('PATCH', `candidates/${ids.B}`, { subject: sA, body: { phone: '0900000000' } })],
    ['candidateId người khác: requestCandidateDeletion', () => call('POST', `candidates/${ids.B}/deletion-request`, { subject: sA, body: {} })],
    ['candidateId người khác: findOrCreateApplication', () => call('POST', 'applications/find-or-create', { subject: sA, body: { candidateId: ids.B, jobId } })],
    ['applicationId người khác: getApplicationContext', () => call('GET', `applications/${ids.appB}/context`, { subject: sA })],
    ['applicationId người khác: screenCandidate', () => call('POST', `applications/${ids.appB}/screen`, { subject: sA, body: { aiSummary: 'x' } })],
    ['applicationId người khác: handoffToHR', () => call('POST', `applications/${ids.appB}/handoff`, { subject: sA, body: { reason: 'AI_UNCERTAIN', summary: 'x' } })],
    ['candidateId người khác: saveMessage', () => call('POST', 'conversations/message', { subject: sA, body: { candidateId: ids.B, channel: 'ZALO', externalMessageId: `acc-${RUN}-x1`, senderType: 'CANDIDATE', direction: 'INBOUND', content: 'x' } })],
    ['applicationId người khác gắn vào tin của mình: saveMessage', () => call('POST', 'conversations/message', { subject: sA, body: { candidateId: ids.A, applicationId: ids.appB, channel: 'ZALO', externalMessageId: `acc-${RUN}-x2`, senderType: 'CANDIDATE', direction: 'INBOUND', content: 'x' } })],
    ['conversationId người khác: getConversationContext', () => call('GET', `conversations/${ids.convB}/context`, { subject: sA })],
    ['applicationId người khác: proposeInterview', () => call('POST', 'interviews/propose', { subject: sA, body: { applicationId: ids.appB, slotId }, idem: `acc-${RUN}-propose-x` })],
    ['interviewId người khác: confirmInterview', () => call('POST', `interviews/${ids.ivB}/confirm`, { subject: sA })],
    ['id không tồn tại → chặn như của người khác (không dò được id)', () => call('GET', 'candidates/999999999', { subject: sA })],
    ['khác OA cùng user id đọc hồ sơ A', () => call('GET', `candidates/${ids.A}`, { subject: sC })],
  ];
  ids.deniedAttempts = 0;
  for (const [name, run] of attacks) {
    const r = await run();
    if (r.status === 403) ids.deniedAttempts++;
    check(`${name} → SUBJECT_MISMATCH`, denied(r, 'SUBJECT_MISMATCH'), r);
  }

  // --- Dữ liệu của chính mình + dữ liệu chung
  const ownCand = await call('GET', `candidates/${ids.A}`, { subject: sA });
  const ownCtx = await call('GET', `applications/${ids.appA}/context`, { subject: sA });
  const ownMsg = await call('POST', 'conversations/message', {
    subject: sA,
    body: { candidateId: ids.A, applicationId: ids.appA, channel: 'WEB', externalConversationId: 'model-khai-bua', externalMessageId: `acc-${RUN}-a1`, senderType: 'CANDIDATE', direction: 'INBOUND', content: 'Chào' },
  });
  ids.convA = ownMsg.data?.conversationId;
  const ownConv = await call('GET', `conversations/${ids.convA}/context`, { subject: sA });
  // Cùng user id ở OA khác nhắn tin → hội thoại riêng (không đụng hội thoại của A).
  const msgC = await call('POST', 'conversations/message', {
    subject: sC,
    body: { candidateId: ids.C, channel: 'ZALO', externalMessageId: `acc-${RUN}-c1`, senderType: 'CANDIDATE', direction: 'INBOUND', content: 'Chào' },
  });
  check('cùng user id, khác OA → hội thoại riêng', msgC.status === 200 && msgC.data.conversationId && msgC.data.conversationId !== ids.convA, msgC);
  check('dữ liệu của chính mình → PASS', [ownCand, ownCtx, ownMsg, ownConv].every((r) => r.status === 200), { ownCand, ownCtx, ownMsg, ownConv });
  const jobs = await call('GET', 'jobs/active', { subject: sA });
  const job = await call('GET', `jobs/${jobId}`, { subject: sA });
  const slots = await call('GET', `interview-slots?jobId=${jobId}`, { subject: sA });
  check('vị trí + slot (dữ liệu chung, chỉ đọc) → PASS', [jobs, job, slots].every((r) => r.status === 200), { jobs: jobs.status, job: job.status, slots: slots.status });
}

async function required() {
  const s = `zalo:oareq${RUN}:u1`;
  check('REQUIRE_SUBJECT=true: key AI chung → SUBJECT_REQUIRED', denied(await call('GET', 'jobs/active', { key: AI }), 'SUBJECT_REQUIRED'), null);
  check('REQUIRE_SUBJECT=true: key kênh + subject → PASS', (await call('GET', 'jobs/active', { subject: s })).status === 200, null);
}

(async () => {
  if (MODE === 'full') await full(Number(process.argv[4]), Number(process.argv[5]));
  else if (MODE === 'required') await required();
  else throw new Error('mode: full|required');
  console.log(JSON.stringify({ results, ids }));
})().catch((error) => {
  console.log(JSON.stringify({ results, ids, error: error.message }));
  process.exitCode = 1;
});
