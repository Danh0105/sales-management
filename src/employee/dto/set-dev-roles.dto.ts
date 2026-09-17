import { ArrayUnique, IsArray, IsIn, IsString } from 'class-validator';

import { ALL_BUSINESS_ROLES } from '../employee-roles';

/** Body của PATCH /employees/me/dev-roles — chỉ tài khoản có role `dev`. */
export class SetDevRolesDto {
    @IsArray()
    @ArrayUnique()
    @IsString({ each: true })
    @IsIn(ALL_BUSINESS_ROLES, {
        each: true,
        message: 'roles chứa giá trị không hợp lệ',
    })
    roles!: string[];
}
