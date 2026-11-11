import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import {
  GetWagerTransactionUseCase,
  type ProcessWagerTransactionResult,
  ProcessWagerTransactionUseCase,
  ValidationApplicationError,
  type WagerTransactionDetailsDto,
} from '../../../application/index';
import { WagerTransactionStatus } from '../../../domain/index';
import { parseSubmitWagerTransactionBody } from '../dtos/wagering.dto';

interface HttpResponse {
  status(code: number): unknown;
}

@Controller('wagering/transactions')
export class WageringController {
  constructor(
    @Inject(ProcessWagerTransactionUseCase)
    private readonly processWagerTransactionUseCase: ProcessWagerTransactionUseCase,
    @Inject(GetWagerTransactionUseCase)
    private readonly getWagerTransactionUseCase: GetWagerTransactionUseCase,
  ) {}

  @Post()
  async submitTransaction(
    @Headers('idempotency-key') idempotencyKeyHeader: string | string[] | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<ProcessWagerTransactionResult> {
    const idempotencyKey = Array.isArray(idempotencyKeyHeader)
      ? idempotencyKeyHeader[0]
      : idempotencyKeyHeader;

    if (!idempotencyKey || idempotencyKey.trim().length === 0) {
      throw new ValidationApplicationError('Idempotency-Key header is required');
    }

    const dto = parseSubmitWagerTransactionBody(body);
    const result = await this.processWagerTransactionUseCase.execute({
      idempotencyKey: idempotencyKey.trim(),
      ...dto,
    });

    if (result.status === WagerTransactionStatus.Rejected) {
      response.status(HttpStatus.UNPROCESSABLE_ENTITY);
    } else if (result.status === WagerTransactionStatus.PendingReference) {
      response.status(HttpStatus.ACCEPTED);
    } else {
      response.status(HttpStatus.OK);
    }

    return result;
  }

  @Get(':transactionId')
  @HttpCode(HttpStatus.OK)
  async getTransaction(
    @Param('transactionId') transactionId: string,
  ): Promise<WagerTransactionDetailsDto> {
    return this.getWagerTransactionUseCase.byId(transactionId);
  }
}
