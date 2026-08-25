import { HttpStatus,Post,Controller,Body, HttpCode } from "@nestjs/common";
import {LoginDto} from './dto/login.dto'
import {AuthService} from './auth.service'
@Controller('auth')
export class AuthController {
    constructor(private readonly authService:AuthService) {}
    @Post('login')
    @HttpCode(HttpStatus.OK)
    login(@Body() data: LoginDto) {
    return this.authService.login(
        data.phoneNumber,
        data.password,
    );
    }
}