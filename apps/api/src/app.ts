import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import staticFiles from '@fastify/static';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { ZodError } from 'zod';
import type { Config } from './config.js';
import { ApiError } from './http.js';
import { registerAuth } from './auth.js';
import { registerMedia } from './media.js';
import { registerCatalog } from './catalog.js';
import { registerOrders } from './orders.js';
import { registerFulfillment } from './fulfillment.js';
export async function createApp(pool:Pool,config:Config) {
  const app = Fastify({logger:false,bodyLimit:1024*1024});
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof ApiError) return reply.code(error.statusCode).send({error:error.code,message:error.message,details:error.details});
    if (error instanceof ZodError) return reply.code(400).send({error:'invalid_input',message:'Check the submitted fields.',details:error.issues.map(i => ({field:i.path.join('.'),message:i.message}))});
    const e = error as {statusCode?:number;code?:string};
    if (e.code === '23505' || e.code === '23503' || e.code === '23514') return reply.code(409).send({error:'conflict',message:'This operation conflicts with current records. Refresh and try again.'});
    if (e.statusCode && e.statusCode>=400 && e.statusCode<500) return reply.code(e.statusCode).send({error:'invalid_request',message:'Invalid or oversized request.'});
    console.error('Request failed', e.code ?? 'internal_error');
    return reply.code(500).send({error:'internal_error',message:'The request could not be completed.'});
  });
  app.addHook('onSend',async (_req,reply,payload)=>{reply.header('X-Content-Type-Options','nosniff');reply.header('Referrer-Policy','no-referrer');reply.header('Cache-Control','no-store');return payload;});
  await app.register(multipart,{limits:{fileSize:10*1024*1024,files:1,fields:2}});
  app.get('/api/health',async()=>({ok:true}));
  await registerAuth(app,pool,config);
  await registerMedia(app,pool,config);
  await registerCatalog(app,pool,config);
  await registerOrders(app,pool,config);
  await registerFulfillment(app,pool,config);
  const root = fileURLToPath(new URL('../../web/dist/',import.meta.url));
  let frontendBuilt = true;
  try {await access(root);} catch {frontendBuilt=false;}
  if (frontendBuilt) {
    await app.register(staticFiles,{root,prefix:'/',index:'index.html'});
    app.setNotFoundHandler((req,reply)=> req.url.startsWith('/api/') ? reply.code(404).send({error:'not_found',message:'Endpoint not found'}) : reply.sendFile('index.html'));
  }
  return app;
}
