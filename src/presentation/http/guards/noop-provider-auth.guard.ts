import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
import {
  PROVIDER_IDENTITY_PORT,
  type ProviderAuthContext,
  type ProviderIdentityPort,
} from '../../../application/index';

interface HttpRequestWithHeaders {
  headers?: Record<string, string | string[] | undefined>;
  providerAuth?: ProviderAuthContext;
}

/**
 * Default no-op identity adapter matching Challenge Section 2 extension guidance.
 * Swap with an OIDC/JWT + provider signature verifier in production deployments.
 */
@Injectable()
export class NoopProviderIdentityAdapter implements ProviderIdentityPort {
  resolveFromHeaders(headers: Record<string, string | string[] | undefined>): ProviderAuthContext {
    const rawProvider = headers['x-provider-id'];
    const providerId = Array.isArray(rawProvider) ? rawProvider[0] : rawProvider;
    return {
      authenticated: true,
      ...(providerId ? { providerId } : {}),
      mechanism: 'noop',
    };
  }
}

/**
 * Explicit Section 2 auth extension point applied to wagering domain routes
 * (while keeping /health/* and /metrics open).
 */
@Injectable()
export class NoopProviderAuthGuard implements CanActivate {
  private readonly identityPort: ProviderIdentityPort;

  constructor(
    @Optional()
    @Inject(PROVIDER_IDENTITY_PORT)
    identityPort?: ProviderIdentityPort,
  ) {
    this.identityPort = identityPort ?? new NoopProviderIdentityAdapter();
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<HttpRequestWithHeaders>();
    request.providerAuth = this.identityPort.resolveFromHeaders(request.headers ?? {});
    return true;
  }
}
