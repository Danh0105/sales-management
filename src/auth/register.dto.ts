import { IsNotEmpty, MinLength, IsPhoneNumber } from 'class-validator';

export class RegisterDto {
    @IsPhoneNumber('VN')
    phone: string;

    @IsNotEmpty()
    name: string;

    @MinLength(6)
    password: string;
}