import {
    ArgumentsHost,
    Catch,
    ExceptionFilter,
    HttpException,
    HttpStatus,
    PayloadTooLargeException,
} from '@nestjs/common';
import { MulterError } from 'multer';

/**
 * Multer ném lỗi thô ("File too large") trước khi request tới được service, nên
 * không có filter thì Nhân sự nhận một câu tiếng Anh không có mã lỗi — trong
 * khi mọi lỗi khác của module đều trả `{ statusCode, code, message }` tiếng
 * Việt. Filter này giữ hình dạng lỗi đồng nhất cho FE.
 */
@Catch(MulterError, PayloadTooLargeException)
export class TimetableUploadFilter implements ExceptionFilter {
    catch(error: MulterError | HttpException, host: ArgumentsHost) {
        const multerError = error instanceof MulterError ? error : undefined;

        const tooLarge =
            multerError?.code === 'LIMIT_FILE_SIZE' ||
            error instanceof PayloadTooLargeException;

        const wrongField = multerError?.code === 'LIMIT_UNEXPECTED_FILE';

        const status = tooLarge
            ? HttpStatus.PAYLOAD_TOO_LARGE
            : HttpStatus.BAD_REQUEST;

        host
            .switchToHttp()
            .getResponse()
            .status(status)
            .json({
                statusCode: status,
                code: tooLarge
                    ? 'TIMETABLE_IMAGE_TOO_LARGE'
                    : wrongField
                      ? 'TIMETABLE_IMAGE_FIELD_INVALID'
                      : 'TIMETABLE_IMAGE_UPLOAD_INVALID',
                message: tooLarge
                    ? 'Ảnh không được vượt quá 15 MB'
                    : wrongField
                      ? 'Ảnh phải gửi ở trường "image"'
                      : 'Dữ liệu ảnh không hợp lệ',
            });
    }
}
