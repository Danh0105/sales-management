import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  PayloadTooLargeException,
} from '@nestjs/common';
import { MulterError } from 'multer';

@Catch(MulterError)
export class AvatarUploadFilter implements ExceptionFilter {
  catch(error: MulterError, host: ArgumentsHost) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      const exception = new PayloadTooLargeException(
        'Ảnh đại diện vượt quá 10 MB',
      );
      return host
        .switchToHttp()
        .getResponse()
        .status(413)
        .json(exception.getResponse());
    }
    throw error;
  }
}
