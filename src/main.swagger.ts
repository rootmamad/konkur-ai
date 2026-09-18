import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = new DocumentBuilder()
    .setTitle('Konkur AI API')
    .setDescription('API documentation for Konkur AI')
    .setVersion('1.0')
    .addTag('konkur')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api-docs', app, document);
  await app.listen(3001);
  console.log(`Swagger UI is running on: http://localhost:3001/api-docs`);
}
bootstrap();