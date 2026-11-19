import 'reflect-metadata';
import { ConsoleLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApiDocs } from './api-docs';
import { configureHttp } from './common/http';
import { AppConfig, readConfig } from './config';
import { APP_CONFIG } from './database/database.service';

async function bootstrap(): Promise<void> {
  readConfig(); // Validate before Nest bootstrap; never print the environment on failure.
  const app = await NestFactory.create(AppModule, { logger: new ConsoleLogger({ json: true }) });
  configureHttp(app,{corsOrigins:app.get<AppConfig>(APP_CONFIG).corsOrigins});
  configureApiDocs(app);
  app.enableShutdownHooks();
  await app.listen(app.get<AppConfig>(APP_CONFIG).port, '0.0.0.0');
}

void bootstrap().catch(() => {
  process.stderr.write(JSON.stringify({ level: 'error', event: 'startup_failed', message: 'Check environment configuration and port availability' }) + '\n');
  process.exitCode = 1;
});
