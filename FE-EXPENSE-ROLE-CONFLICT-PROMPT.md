# PROMPT: FRONTEND — PHÂN TÁCH NHIỆM VỤ TRONG LUỒNG ĐỀ XUẤT CHI

Bạn là Senior Frontend Developer. Backend vừa bịt một lỗ hổng kiểm soát nội bộ: **người tạo đề xuất chi không được tự thực hiện các bước kiểm soát của người khác trên chính đề xuất đó**, kể cả khi họ có đủ role.

Hãy cập nhật màn **Đề xuất chi** theo tài liệu này.

> ⚠️ **Đây là breaking change về hành vi, không phải về API.** Không endpoint nào đổi, không field nào đổi. Nhưng những nút mà FE đang hiện sẽ bắt đầu trả **403** trong một số trường hợp — nếu không cập nhật, người dùng bấm vào và nhận lỗi.

## 0. Vì sao

`employee.roles` là mảng, nên một người giữ được nhiều vai. Trong dữ liệu thật đang có:

| Nhân viên | Roles | Rủi ro |
|---|---|---|
| Nguyễn Thị Cẩm Nhung | `sales` + `thuquy` | Tự lên đề xuất rồi tự xuất tiền cho mình |
| Vũ Hợp | `ketoan_congno` + `thuquy` | Vừa lên lệnh chi vừa xuất tiền |
| 3 người khác | `accountant` + `thuquy` | |

Luồng chi tiền được thiết kế để **hai người khác nhau kiểm chéo**: thủ quỹ xuất tiền, người nhận xác nhận đã nhận. Trước đây backend chỉ hỏi "có role không", nên hai chốt đó sụp vào một người.

Giờ quy tắc là: **mỗi bước hoặc là việc của chủ đề xuất, hoặc là việc của người khác — không có ở giữa.**

## 1. Bảng quyền mới

| Bước | Endpoint | Role | Chủ đề xuất làm được? |
|---|---|---|---|
| Kiểm duyệt chính sách | `POST /expense-requests/:id/sale-admin-review` | `saleadmin` | ❌ **không** |
| Duyệt | `POST /expense-requests/:id/approve` | `director` | ❌ **không** |
| Từ chối | `POST /expense-requests/:id/reject` | `director` | ❌ **không** |
| Lên lệnh chi | `POST /expense-requests/:id/payment-order` | `ketoan_congno` | ❌ **không** |
| Xác nhận xuất tiền | `POST /expense-requests/:id/cash-released` | `thuquy` | ❌ **không** |
| Xác nhận nhận lại quỹ | `POST /expense-requests/:id/fund-returned` | `thuquy` | ❌ **không** |
| Xác nhận đã nhận tiền | `POST /expense-requests/:id/cash-received` | `sales` | ✅ **chỉ** chủ đề xuất |
| Xác nhận đã chi | `POST /expense-requests/:id/confirm-spent` | `sales` | ✅ **chỉ** chủ đề xuất |
| Xác nhận chưa chi | `POST /expense-requests/:id/confirm-not-spent` | `sales` | ✅ **chỉ** chủ đề xuất |

**Kiêm nhiệm không bị tước quyền.** Người vừa `sales` vừa `thuquy` vẫn xuất tiền bình thường cho đề xuất của người khác — chỉ không tự làm cho đề xuất của chính mình.

## 2. Điều kiện hiện nút

Đây là toàn bộ thay đổi cần làm ở FE. Hiện tại nút hiển thị theo công thức:

```ts
// CŨ — thiếu vế chủ đề xuất
const canRelease = user.roles.includes("thuquy")
  && request.status === "PAYMENT_ORDERED";
```

Thêm vế so sánh người tạo:

```ts
const isOwner = request.createdBy === user.id;

// Bước kiểm soát: có role VÀ không phải chủ đề xuất
const canRelease = user.roles.includes("thuquy")
  && request.status === "PAYMENT_ORDERED"
  && !isOwner;

// Bước của chủ đề xuất: giữ nguyên, đã đúng sẵn
const canConfirmReceived = user.roles.includes("sales")
  && request.status === "CASH_RELEASED"
  && isOwner;
```

Gợi ý gom thành một helper dùng chung cho cả 9 bước, thay vì rải `!isOwner` ở từng chỗ — rải tay thì sót một chỗ là lại hiện nút chết.

```ts
const EXPENSE_STEPS = {
  approve:        { role: "director",      from: ["PENDING_APPROVAL"], owner: false },
  reject:         { role: "director",      from: ["PENDING_APPROVAL"], owner: false },
  saleAdminReview:{ role: "saleadmin",     from: ["PENDING_APPROVAL"], owner: false },
  paymentOrder:   { role: "ketoan_congno", from: ["APPROVED", "FUND_RETURNED"], owner: false },
  cashReleased:   { role: "thuquy",        from: ["PAYMENT_ORDERED"], owner: false },
  fundReturned:   { role: "thuquy",        from: ["NOT_SPENT"], owner: false },
  cashReceived:   { role: "sales",         from: ["CASH_RELEASED"], owner: true },
  confirmSpent:   { role: "sales",         from: ["CASH_RECEIVED"], owner: true },
  confirmNotSpent:{ role: "sales",         from: ["CASH_RECEIVED"], owner: true },
} as const;

export const canDoStep = (
  step: keyof typeof EXPENSE_STEPS,
  request: ExpenseRequest,
  user: { id: number; roles: string[] },
) => {
  const def = EXPENSE_STEPS[step];
  return (
    user.roles.includes(def.role) &&
    def.from.includes(request.status) &&
    (request.createdBy === user.id) === def.owner
  );
};
```

`(isOwner) === def.owner` diễn đạt đúng luật của backend: bước `owner: true` bắt buộc là chủ đề xuất, bước `owner: false` bắt buộc **không** phải chủ đề xuất.

## 3. Ẩn hay disable?

**Ẩn hẳn.** Người dùng không phải chủ đề xuất thì không cần biết nút đó tồn tại; người dùng là chủ đề xuất mà thấy nút "Xác nhận xuất tiền" bị mờ sẽ tưởng hệ thống lỗi.

Ngoại lệ: nếu màn hiện tại đang disable + tooltip cho các bước sai trạng thái, hãy giữ nhất quán kiểu đó, nhưng tooltip phải nói đúng lý do:

> *"Bạn là người tạo đề xuất này. Bước xuất tiền phải do thủ quỹ khác thực hiện."*

Đừng dùng chung tooltip "Bạn không có quyền" — người dùng **có** quyền, chỉ là không trên đề xuất này. Nói sai lý do sẽ khiến họ đi xin cấp thêm role.

## 4. Xử lý 403

Backend trả thông báo đã đủ ngữ cảnh, hiện nguyên văn:

```json
{
  "statusCode": 403,
  "message": "Bạn là người tạo đề xuất này nên không được tự thực hiện bước CONFIRM_CASH_RELEASED. Bước này phải do người khác có role thuquy thực hiện.",
  "error": "Forbidden"
}
```

Với bước kiểm duyệt chính sách:

```json
{
  "statusCode": 403,
  "message": "Bạn là người tạo đề xuất này nên không được tự kiểm duyệt chính sách"
}
```

Nếu người dùng vẫn nhận được 403 sau khi bạn sửa mục 2, đó là dấu hiệu logic hiện nút còn sót chỗ nào đó — **đừng nuốt lỗi**, cứ hiện toast để lộ ra.

## 5. "Việc cần làm của tôi"

**GET** `/expense-requests/my-tasks` đã được sửa cùng lúc: các bước kiểm soát giờ tự loại đề xuất do chính người đó tạo.

Trước đây người kiêm `sales`+`thuquy` thấy đề xuất của chính mình nằm trong danh sách việc cần làm ở vai thủ quỹ, bấm vào thì 403. Giờ danh sách trả về **đúng những việc họ thật sự làm được**.

FE không phải đổi gì ở đây, nhưng cần biết để **không tự lọc lại lần nữa** — lọc hai lần sẽ giấu mất việc hợp lệ.

## 6. Điểm dễ bỏ sót

**Đề xuất do chính mình tạo vẫn phải xem được.** Chỉ ẩn *nút thao tác*, không ẩn đề xuất khỏi danh sách hay chặn mở chi tiết. Chủ đề xuất cần theo dõi tiến độ đơn của mình.

**Giám đốc không tự huỷ được đơn của mình nữa.** `REJECT` giờ cấm chủ đề xuất, mà hệ thống chưa có action "rút đơn". Giám đốc tự lên đề xuất thì phải nhờ giám đốc khác từ chối (hiện có 3 người). Nếu Nhân sự phản ánh, đó là hành vi đúng thiết kế chứ không phải bug — backend sẽ bổ sung `WITHDRAW` sau.

**`createdBy` phải có trong payload.** Kiểm tra type `ExpenseRequest` ở FE đã có field này chưa; thiếu thì không tính được `isOwner`. API danh sách và chi tiết đều trả `createdBy` cùng `createdByUser`.

**Thông báo nhắc hạn vẫn gửi theo role.** Chủ đề xuất kiêm thủ quỹ có thể nhận thông báo nhắc về chính đơn của mình. Chưa sửa ở backend; nếu gây khó chịu thì báo lại, không phải việc FE tự lọc.

## 7. Nghiệm thu

- [ ] Đăng nhập tài khoản vừa `sales` vừa `thuquy`, mở đề xuất **của chính mình** ở trạng thái `PAYMENT_ORDERED` → **không** thấy nút "Xác nhận xuất tiền".
- [ ] Cùng tài khoản đó, mở đề xuất **của người khác** cùng trạng thái → **thấy** nút và bấm thành công.
- [ ] Cùng tài khoản đó, đề xuất của mình ở `CASH_RELEASED` → **thấy** nút "Xác nhận đã nhận tiền" (bước của chủ đề xuất, không bị ảnh hưởng).
- [ ] Tài khoản `director` mở đề xuất của chính mình ở `PENDING_APPROVAL` → không thấy nút Duyệt và Từ chối.
- [ ] "Việc cần làm của tôi" của tài khoản kiêm nhiệm không còn chứa đề xuất của chính họ ở các bước kiểm soát.
- [ ] Mọi đề xuất của chính mình vẫn mở xem chi tiết được bình thường.
- [ ] Gọi thẳng API bằng Postman với chủ đề xuất → nhận 403 kèm message tiếng Việt, FE hiện nguyên văn.
- [ ] Build không lỗi TypeScript.

## 8. Kiểm chứng phía backend

Thay đổi đã được kiểm end-to-end trên tài khoản seed (tạm cấp `thuquy` cho `Kinh doanh (test)` rồi trả lại):

```
Tạo đơn → duyệt → lên lệnh chi
  chủ đơn kiêm thủ quỹ tự xuất tiền  → 403 ✓
  thủ quỹ khác xuất tiền             → 201 ✓
  chủ đơn xác nhận đã nhận tiền      → 201 ✓
  thủ quỹ khác xác nhận đã nhận      → 403 ✓
```

Thêm 8 unit test cho máy trạng thái; toàn bộ 443 test của backend đang pass.

Không có đề xuất nào đang chạy dở bị kẹt: hiện chưa có đề xuất chi nào do nhân viên đa role tạo, và mỗi vai kiểm soát đều còn đủ người không kiêm `sales` (thủ quỹ 5/6, giám đốc 3/3, kế toán công nợ 2/2, sales admin 2/2).
