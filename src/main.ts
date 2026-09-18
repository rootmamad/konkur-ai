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

  // Swagger setup
  const config = new DocumentBuilder()
    .setTitle('Konkur AI API')
    .setDescription('API documentation for Konkur AI')
    .setVersion('1.0')
    .addTag('konkur')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api-docs', app, document);

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
