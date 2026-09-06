import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  PayloadTooLargeException,
} from '@nestjs/common';
import { MulterError } from 'multer';

/** Tên trường multipart duy nhất được chấp nhận cho ảnh bài dạy. */
const IMAGE_FIELD = 'images';

@Catch(MulterError, PayloadTooLargeException, BadRequestException)
export class LessonImageUploadFilter implements ExceptionFilter {
  catch(error: MulterError | HttpException, host: ArgumentsHost) {
    const multerError = error instanceof MulterError ? error : undefined;
    const response =
      error instanceof HttpException ? error.getResponse() : undefined;
    // ValidationPipe trả message dạng mảng — chỉ so khớp khi là chuỗi.
    const rawMessage =
      typeof response === 'string'
        ? response
        : (response as { message?: string | string[] })?.message;
    const originalMessage =
      typeof rawMessage === 'string' ? rawMessage : undefined;

    const size =
      multerError?.code === 'LIMIT_FILE_SIZE' ||
      error instanceof PayloadTooLargeException;

    // Vượt quá maxCount của FilesInterceptor cũng báo LIMIT_UNEXPECTED_FILE —
    // phân biệt với "gửi sai tên trường" bằng chính tên trường gây lỗi. Nest bọc
    // MulterError lại nên tên trường có khi chỉ còn trong message.
    const unexpectedField =
      multerError?.code === 'LIMIT_UNEXPECTED_FILE'
        ? multerError.field
        : originalMessage?.startsWith('Unexpected field')
          ? originalMessage.split(' - ')[1] ?? ''
          : undefined;

    const tooMany =
      multerError?.code === 'LIMIT_FILE_COUNT' ||
      unexpectedField === IMAGE_FIELD ||
      originalMessage === 'Too many files';

    const wrongField = unexpectedField !== undefined && !tooMany;

    if (!size && !tooMany && !wrongField && error instanceof HttpException) {
      return host
        .switchToHttp()
        .getResponse()
        .status(error.getStatus())
        .json(response);
    }

    const status =
      size || tooMany ? HttpStatus.PAYLOAD_TOO_LARGE : HttpStatus.BAD_REQUEST;
    const body = {
      statusCode: status,
      code: size
        ? 'LESSON_IMAGE_TOO_LARGE'
        : tooMany
          ? 'LESSON_IMAGE_LIMIT_EXCEEDED'
          : wrongField
            ? 'LESSON_IMAGE_FIELD_INVALID'
            : 'LESSON_IMAGE_UPLOAD_INVALID',
      message: size
        ? 'Mỗi ảnh hoặc video không được vượt quá 50 MB'
        : tooMany
          ? 'Chỉ được tải lên tối đa 10 ảnh'
          : wrongField
            ? `Minh chứng phải gửi ở trường "${IMAGE_FIELD}"`
            : 'Dữ liệu minh chứng không hợp lệ',
    };
    host.switchToHttp().getResponse().status(status).json(body);
  }
}
