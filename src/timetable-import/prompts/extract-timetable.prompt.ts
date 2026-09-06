/**
 * Prompt + JSON schema cho khâu đọc ảnh thời khoá biểu.
 *
 * Prompt này cố định giữa các lần import nên được đánh dấu `cache_control`:
 * từ ảnh thứ hai trở đi phần này chỉ tính ~10% giá input.
 */

/**
 * Ràng buộc của structured outputs: mọi object phải có `additionalProperties:
 * false` và liệt kê đủ `required`; các ràng buộc số/độ dài (`minimum`,
 * `minLength`…) không được hỗ trợ nên dùng `enum` thay cho khoảng giá trị.
 */
const nullable = (type: 'string') => ({
    anyOf: [{ type }, { type: 'null' }],
});

const DAY_OF_WEEK_VALUES = [2, 3, 4, 5, 6, 7, 8];
const PERIOD_VALUES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

export const MISSING_FIELD_VALUES = [
    'TEACHER_NAME',
    'MORNING_PERIOD_TIMES',
    'AFTERNOON_PERIOD_TIMES',
    'EFFECTIVE_FROM',
    'EFFECTIVE_TO',
    'SCHOOL_NAME',
    'SUBJECT_NAME',
    'SCHOOL_YEAR',
] as const;

export const TIMETABLE_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: [
        'schoolName',
        'subjectName',
        'schoolYear',
        'teacherName',
        'effectiveFrom',
        'effectiveTo',
        'periodTimes',
        'entries',
        'missing',
        'notes',
    ],
    properties: {
        schoolName: nullable('string'),
        subjectName: nullable('string'),
        schoolYear: nullable('string'),
        teacherName: nullable('string'),
        effectiveFrom: nullable('string'),
        effectiveTo: nullable('string'),
        periodTimes: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['session', 'period', 'startTime', 'endTime'],
                properties: {
                    session: { type: 'string', enum: ['SANG', 'CHIEU'] },
                    period: { type: 'integer', enum: PERIOD_VALUES },
                    startTime: { type: 'string' },
                    endTime: { type: 'string' },
                },
            },
        },
        entries: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: [
                    'dayOfWeek',
                    'session',
                    'period',
                    'className',
                    'confidence',
                ],
                properties: {
                    dayOfWeek: { type: 'integer', enum: DAY_OF_WEEK_VALUES },
                    session: { type: 'string', enum: ['SANG', 'CHIEU'] },
                    period: { type: 'integer', enum: PERIOD_VALUES },
                    className: { type: 'string' },
                    confidence: { type: 'string', enum: ['high', 'low'] },
                },
            },
        },
        missing: {
            type: 'array',
            items: { type: 'string', enum: [...MISSING_FIELD_VALUES] },
        },
        notes: nullable('string'),
    },
} as const;

export const EXTRACT_SYSTEM_PROMPT = `Bạn đọc ảnh chụp thời khoá biểu của trường học Việt Nam và trả về đúng những gì in trên đó.

## Cấu trúc tờ thời khoá biểu

Lưới chính: mỗi **cột** là một thứ trong tuần, thường tách đôi thành SÁNG và CHIỀU. Mỗi **hàng** là một tiết. Ô giao nhau ghi tên lớp được dạy vào tiết đó, ví dụ "2/4", "1A", "5/6". Rất nhiều ô để trống — đó là bình thường, chỉ ghi nhận ô có chữ.

Quy ước thứ trong tuần: THỨ HAI = 2, THỨ BA = 3, THỨ TƯ = 4, THỨ NĂM = 5, THỨ SÁU = 6, THỨ BẢY = 7, CHỦ NHẬT = 8.

Phía dưới thường có bảng giờ riêng ("THỜI GIAN B. SÁNG", "THỜI GIAN B. CHIỀU") ánh xạ số tiết sang khung giờ. Dòng "RC" hoặc "Ra chơi" là giờ ra chơi, không phải tiết — bỏ qua nó, và đừng để nó làm lệch số thứ tự các tiết sau.

## Ảnh chụp thường bị nghiêng

Đây là nguồn sai phổ biến nhất. Tờ giấy chụp bằng điện thoại hay bị nghiêng hoặc cong, làm chữ ở các cột bên phải trôi lên hoặc xuống so với cột bên trái. Hãy bám theo **đường kẻ ô của bảng** để biết một chữ nằm ở hàng nào, đừng bám theo độ cao pixel của chữ. Khi một ô nằm giữa hai hàng và bạn không phân định được, vẫn ghi nhận nó nhưng đặt confidence = "low".

## Từng trường

- **teacherName**: chỉ điền khi ảnh ghi **tên người** (ví dụ "Lê Thị Hồng Diễm"). Nhãn chức danh như "GV DẠY GDKNCDS" hay "Giáo viên bộ môn" không phải tên người — khi đó để null và thêm "TEACHER_NAME" vào missing.
- **effectiveFrom**: suy từ dòng kiểu "Áp dụng từ Tuần 10, Từ ngày 10/11/2025" → "2025-11-10". Định dạng ngày trên giấy là DD/MM/YYYY.
- **effectiveTo**: hầu như không được ghi. Để null và thêm "EFFECTIVE_TO" vào missing.
- **periodTimes**: chỉ điền các tiết đọc được giờ. Nếu bảng giờ buổi chiều bị cắt khỏi ảnh hoặc mờ không đọc được, đừng suy đoán theo buổi sáng — bỏ trống và thêm "AFTERNOON_PERIOD_TIMES" vào missing.
- **className**: chép đúng như in, giữ nguyên dấu gạch chéo và chữ cái ("2/4" chứ không phải "24"; "1A" chứ không phải "1a").
- **notes**: mô tả ngắn gọn chỗ nào khó đọc và vì sao. Để null nếu ảnh rõ.

## Nguyên tắc

Không suy đoán để lấp chỗ trống. Một ô bạn không đọc được, hoặc một khung giờ không có trên ảnh, phải đi vào missing hoặc confidence "low" — người dùng sẽ được hỏi lại. Điền bừa một giá trị trông hợp lý sẽ tạo ra lịch dạy sai mà không ai phát hiện.`;

export const EXTRACT_USER_PROMPT =
    'Đọc tờ thời khoá biểu trong ảnh và trả về dữ liệu theo schema.';
