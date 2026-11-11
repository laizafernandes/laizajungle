import { Body, Controller, HttpCode, HttpStatus, Inject, Post } from '@nestjs/common';
import { type OpenWalletResult, OpenWalletUseCase } from '../../../application/index';
import { parseOpenWalletBody } from '../dtos/wagering.dto';

@Controller('wallets')
export class WalletsController {
  constructor(@Inject(OpenWalletUseCase) private readonly openWalletUseCase: OpenWalletUseCase) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async openWallet(@Body() body: unknown): Promise<OpenWalletResult> {
    const dto = parseOpenWalletBody(body);
    return this.openWalletUseCase.execute(dto);
  }
}
