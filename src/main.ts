import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      exceptionFactory: (errors) => {
        const firstError = errors[0];
        const firstMessage = firstError.constraints
          ? Object.values(firstError.constraints)[0]
          : 'Validation failed';
        return new BadRequestException(firstMessage);
      },
    }),
  );

  const config = new DocumentBuilder()
    .setTitle('Konkur AI API')
    .setDescription('API documentation for Konkur AI')
    .setVersion('1.0')
    .addTag('konkur')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        name: 'Authorization',
        description: 'Enter JWT token (بدون کلمه Bearer)',
        in: 'header',
      },
      'access-token',
    )
    .build();

  const document = SwaggerModule.createDocument(app, config);

  document.security = [{ 'access-token': [] }];

  const publicOperations: Array<{ path: string; method: 'get' | 'post' }> = [
    { path: '/auth/login', method: 'post' },
    { path: '/auth/register', method: 'post' }, 
  ];

  for (const op of publicOperations) {
    const pathItem = document.paths?.[op.path];
    const operation = pathItem?.[op.method];
    if (operation) {
      operation.security = []; 
    }
  }

  SwaggerModule.setup('api-docs', app, document, {
    swaggerOptions: {
      persistAuthorization: true,
    },
  });

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  console.log(` docs: http://localhost:${port}/api-docs`);
}
bootstrap();