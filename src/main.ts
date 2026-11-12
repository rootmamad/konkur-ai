import { NestFactory } from '@nestjs/core';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

const PUBLIC_OPERATIONS: Array<{ path: string; method: 'get' | 'post' }> = [
  { path: '/auth/login', method: 'post' },
  { path: '/auth/register', method: 'post' },
  { path: '/support/tickets', method: 'post' },
];

function setupSwagger(app: Awaited<ReturnType<typeof NestFactory.create>>) {
  const config = new DocumentBuilder()
    .setTitle('Konkur AI API')
    .setDescription('API documentation for Konkur AI')
    .setVersion('1.0')
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', in: 'header' },
      'access-token',
    )
    .build();

  const document = SwaggerModule.createDocument(app, config);
  document.security = [{ 'access-token': [] }];
  for (const op of PUBLIC_OPERATIONS) {
    const operation = document.paths?.[op.path]?.[op.method];
    if (operation) operation.security = [];
  }
  SwaggerModule.setup('api-docs', app, document, {
    swaggerOptions: { persistAuthorization: true },
  });
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      exceptionFactory: (errors) => {
        const first = errors[0];
        const message = first?.constraints
          ? Object.values(first.constraints)[0]
          : 'Validation failed';
        return new BadRequestException(message);
      },
    }),
  );
  app.enableShutdownHooks();

  if (process.env.NODE_ENV !== 'production') setupSwagger(app);

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
}
void bootstrap();
