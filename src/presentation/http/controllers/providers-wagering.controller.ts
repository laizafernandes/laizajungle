import { Controller, Get, HttpCode, HttpStatus, Inject, Param, UseGuards } from '@nestjs/common';
import {
  GetWagerTransactionUseCase,
  type WagerTransactionDetailsDto,
} from '../../../application/index';
import { NoopProviderAuthGuard } from '../guards/noop-provider-auth.guard';

@Controller('providers')
@UseGuards(NoopProviderAuthGuard)
export class ProvidersWageringController {
  constructor(
    @Inject(GetWagerTransactionUseCase)
    private readonly getWagerTransactionUseCase: GetWagerTransactionUseCase,
  ) {}

  @Get(':providerId/wagering/transactions/:externalTransactionId')
  @HttpCode(HttpStatus.OK)
  async getProviderTransaction(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ): Promise<WagerTransactionDetailsDto> {
    return this.getWagerTransactionUseCase.byProviderExternalId(providerId, externalTransactionId);
  }
}
