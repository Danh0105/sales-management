import {
  Controller,
  Post,
  UploadedFile,
  UseInterceptors,
  Body,
  UseGuards,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AppVersionService } from './version.service';
import { diskStorage } from 'multer';
import { extname } from 'path';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/role-guard';
import { Roles } from '../auth/roles.decorator';

@Controller('admin/version')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AdminVersionController {
  constructor(private service: AppVersionService) { }

  @Post('upload')
  @Roles('director')
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
