import {
  Controller,
  Post,
  UploadedFile,
  UseInterceptors,
  Body,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AppVersionService } from './version.service';
import { diskStorage } from 'multer';
import { extname } from 'path';

@Controller('admin/version')
export class AdminVersionController {
  constructor(private service: AppVersionService) { }

  @Post('upload')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: './uploads/apk',
        filename: (req, file, cb) => {
          const unique = Date.now();
          cb(null, `app-${unique}${extname(file.originalname)}`);
        },
      }),
    }),
  )
  async upload(
    @UploadedFile() file: Express.Multer.File,
    @Body() body: any,
  ) {
    const apkUrl = `https://sales.kidoedu.vn/apk/${file.filename}`;

    return this.service.create({
      version: body.version,
      apkUrl,
      isForce: body.force === 'true',
      note: body.note,
    });
  }
}