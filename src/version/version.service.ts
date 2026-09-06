// app-version.service.ts
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AppVersion } from './version.entity';

@Injectable()
export class AppVersionService {
    constructor(
        @InjectRepository(AppVersion)
        private repo: Repository<AppVersion>,
    ) { }

    async getLatest() {
        return this.repo.findOne({
            where: { isActive: true },
            order: { createdAt: 'DESC' },
        });
    }

    async create(data: Partial<AppVersion>) {
        // disable version cũ
        await this.repo.update({ isActive: true }, { isActive: false });

        const version = this.repo.create(data);
        return this.repo.save(version);
    }
}