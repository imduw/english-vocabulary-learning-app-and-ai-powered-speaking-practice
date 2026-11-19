import { INestApplication } from '@nestjs/common';
import { Response } from 'express';
import swaggerUi from 'swagger-ui-express';
import contract from '../api/openapi.json';

export function configureApiDocs(app: INestApplication): void {
  app.getHttpAdapter().get('/openapi.json', (_request: unknown, response: Response) => {
    response.json(contract);
  });
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(contract, {
    customSiteTitle: 'CAM API — draft contract',
    swaggerOptions: { persistAuthorization: false, validatorUrl: null },
  }));
}
