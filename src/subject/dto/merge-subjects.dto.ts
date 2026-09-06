import { Type } from 'class-transformer';
import {
    ArrayMaxSize,
    ArrayMinSize,
    IsArray,
    IsBoolean,
    IsInt,
    IsOptional,
    Min,
} from 'class-validator';

export class MergeSubjectsDto {
    /** Môn được giữ lại; mọi tham chiếu sẽ trỏ về đây. */
    @Type(() => Number)
    @IsInt()
    @Min(1)
    keepId!: number;

    /** Các môn bị gộp rồi xoá. Tối đa 20 — gộp hơn thế gần như luôn là gõ nhầm. */
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(20)
    @Type(() => Number)
    @IsInt({ each: true })
    @Min(1, { each: true })
    mergeIds!: number[];

    /**
     * Mặc định **true**: gọi mà quên tham số thì chỉ xem trước, không xoá gì.
     * Muốn chạy thật phải gửi `false` một cách có ý thức.
     */
    @IsOptional()
    @Type(() => Boolean)
    @IsBoolean()
    dryRun?: boolean = true;
}
