import { CreateDisplayDto } from './create-display.dto';
import { Repository } from 'typeorm';
import { Display } from './display.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { Injectable } from '@nestjs/common';

@Injectable()
export class DisplayService {
  private isClearing = false;

  constructor(
    @InjectRepository(Display)
    private repo: Repository<Display>,
  ) {}

  async submit(dto: CreateDisplayDto) {
    let item = await this.repo.findOne({
      where: {
        tabletCode: dto.tabletCode,
      },
    });

    if (!item) {
      item = this.repo.create(dto);
    } else {
      item.fullName = dto.fullName;
      item.position = dto.position;
    }

    await this.repo.save(item);

    const total = await this.repo.count();

    // Đủ 20 người
    if (total >= 20 && !this.isClearing) {
      this.isClearing = true;
    }

    return {
      success: true,
      total,
    };
  }

  async findAll() {
    return this.repo.find({
      order: {
        tabletCode: 'ASC',
      },
    });
  }

  async reset() {
    await this.repo.clear();

    return {
      success: true,
    };
  }
}
