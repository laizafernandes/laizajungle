import { Controller, Get, HttpCode, HttpStatus, Inject, Param } from '@nestjs/common';
import {
  GetWagerTransactionUseCase,
  type WagerTransactionDetailsDto,
} from '../../../application/index';

@Controller('providers')
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
