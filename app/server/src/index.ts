import dotenv from 'dotenv';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { serve } from '@hono/node-server';
import {
  OptimizeToursRequest,
  RouteOptimizationError,
  optimizeTours,
} from './route-optimization';

dotenv.config();

const PROJECT_ID = process.env.GOOGLE_PROJECT_ID;
const PORT = Number(process.env.PORT ?? 3000);

if (!PROJECT_ID) {
  console.error('環境変数 GOOGLE_PROJECT_ID が必要です');
  process.exit(1);
}

const app = new Hono();

app.use('*', logger());
app.use('*', cors({ origin: '*' }));

app.get('/health', (c) => c.json({ status: 'ok' }));

app.post('/optimize', async (c) => {
  let body: OptimizeToursRequest;
  try {
    body = await c.req.json<OptimizeToursRequest>();
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }

  try {
    const data = await optimizeTours(PROJECT_ID, body);
    return c.json(data);
  } catch (error) {
    if (error instanceof RouteOptimizationError) {
      return c.json(
        { error: error.message, details: error.details },
        error.status as 400 | 401 | 403 | 404 | 500,
      );
    }
    console.error('予期しないエラー:', error);
    return c.json({ error: 'internal server error' }, 500);
  }
});

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`Server listening on http://localhost:${info.port}`);
  console.log(`  GET  /health`);
  console.log(`  POST /optimize`);
});
