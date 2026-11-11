import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Global, Module } from '@nestjs/common';
import { buildMikroOrmOptions } from './mikro-orm.config';

@Global()
@Module({
  imports: [
    MikroOrmModule.forRootAsync({
      useFactory: () => ({
        ...buildMikroOrmOptions(),
        registerRequestContext: true,
      }),
    }),
  ],
})
export class DatabaseModule {}
