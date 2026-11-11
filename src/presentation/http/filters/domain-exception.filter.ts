import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import {
  ApplicationError,
  DuplicateWalletError,
  ExternalTransactionConflictError,
  IdempotencyConflictError,
  TransactionNotFoundError,
  TransientInfrastructureError,
  ValidationApplicationError,
  WalletNotFoundError,
} from '../../../application/index';

interface HttpResponse {
  setHeader(name: string, value: string): void;
  status(code: number): { json(body: unknown): void };
}
import {
  CurrencyMismatchError,
  DomainError,
  InsufficientBalanceError,
  InvalidDomainArgumentError,
  InvalidMoneyError,
  InvalidTransactionStateError,
} from '../../../domain/index';

interface ErrorResponseBody {
  statusCode: number;
  errorCode: string;
  message: string;
}

@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<HttpResponse>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const res = exception.getResponse();
      if (typeof res === 'object' && res !== null) {
        response.status(status).json(res);
      } else {
        response.status(status).json({
          statusCode: status,
          errorCode: 'HTTP_ERROR',
          message: String(res),
        });
      }
      return;
    }

    if (exception instanceof TransientInfrastructureError) {
      response.setHeader('Retry-After', String(exception.retryAfterSeconds));
    }

    const mapped = this.mapError(exception);
    response.status(mapped.statusCode).json(mapped);
  }

  private mapError(exception: unknown): ErrorResponseBody {
    if (exception instanceof ValidationApplicationError) {
      return {
        statusCode: HttpStatus.BAD_REQUEST,
        errorCode: exception.errorCode,
        message: exception.message,
      };
    }

    if (exception instanceof InvalidMoneyError || exception instanceof InvalidDomainArgumentError) {
      return {
        statusCode: HttpStatus.BAD_REQUEST,
        errorCode: exception.code,
        message: exception.message,
      };
    }

    if (exception instanceof WalletNotFoundError || exception instanceof TransactionNotFoundError) {
      return {
        statusCode: HttpStatus.NOT_FOUND,
        errorCode: exception.errorCode,
        message: exception.message,
      };
    }

    if (
      exception instanceof DuplicateWalletError ||
      exception instanceof IdempotencyConflictError ||
      exception instanceof ExternalTransactionConflictError
    ) {
      return {
        statusCode: HttpStatus.CONFLICT,
        errorCode: exception.errorCode,
        message: exception.message,
      };
    }

    if (
      exception instanceof InsufficientBalanceError ||
      exception instanceof CurrencyMismatchError ||
      exception instanceof InvalidTransactionStateError
    ) {
      return {
        statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
        errorCode: exception.code,
        message: exception.message,
      };
    }

    if (exception instanceof TransientInfrastructureError) {
      return {
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        errorCode: exception.errorCode,
        message: exception.message,
      };
    }

    if (exception instanceof ApplicationError) {
      return {
        statusCode: HttpStatus.BAD_REQUEST,
        errorCode: exception.errorCode,
        message: exception.message,
      };
    }

    if (exception instanceof DomainError) {
      return {
        statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
        errorCode: exception.code,
        message: exception.message,
      };
    }

    console.error(
      JSON.stringify({
        level: 'error',
        event: 'unhandled_http_exception',
        errorName: exception instanceof Error ? exception.name : typeof exception,
        errorMessage: exception instanceof Error ? exception.message : String(exception),
        timestamp: new Date().toISOString(),
      }),
    );

    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      errorCode: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected internal error occurred',
    };
  }
}
