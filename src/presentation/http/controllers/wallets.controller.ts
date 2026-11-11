import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  GetWalletLedgerUseCase,
  GetWalletUseCase,
  type OpenWalletResult,
  OpenWalletUseCase,
  ReconcileWalletUseCase,
  type WalletDetailsDto,
  type WalletLedgerPageDto,
  type WalletReconciliationResult,
} from '../../../application/index';
import { parseLedgerLimitQuery, parseOpenWalletBody } from '../dtos/wagering.dto';

@Controller('wallets')
export class WalletsController {
  constructor(
    @Inject(OpenWalletUseCase) private readonly openWalletUseCase: OpenWalletUseCase,
    @Inject(GetWalletUseCase) private readonly getWalletUseCase: GetWalletUseCase,
    @Inject(GetWalletLedgerUseCase)
    private readonly getWalletLedgerUseCase: GetWalletLedgerUseCase,
    @Inject(ReconcileWalletUseCase)
    private readonly reconcileWalletUseCase: ReconcileWalletUseCase,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async openWallet(@Body() body: unknown): Promise<OpenWalletResult> {
    const dto = parseOpenWalletBody(body);
    return this.openWalletUseCase.execute(dto);
  }

  @Get(':walletId')
  @HttpCode(HttpStatus.OK)
  async getWallet(@Param('walletId') walletId: string): Promise<WalletDetailsDto> {
    return this.getWalletUseCase.execute(walletId);
  }

  @Get(':walletId/ledger')
  @HttpCode(HttpStatus.OK)
  async getWalletLedger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limitRaw?: string,
  ): Promise<WalletLedgerPageDto> {
    const limit = parseLedgerLimitQuery(limitRaw);
    return this.getWalletLedgerUseCase.execute({
      walletId,
      cursor,
      limit,
    });
  }

  @Post(':walletId/reconciliation')
  @HttpCode(HttpStatus.OK)
  async reconcileWallet(@Param('walletId') walletId: string): Promise<WalletReconciliationResult> {
    return this.reconcileWalletUseCase.execute(walletId);
  }
}
