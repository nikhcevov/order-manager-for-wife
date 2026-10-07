import { loadConfig } from './config.js';
import { createPool, migrate } from './db.js';
import { createApp } from './app.js';
import { expireOrders } from './orders.js';
import { cleanupMedia } from './media.js';
const config = loadConfig();
const pool = createPool(config.databaseUrl);
try {
  await migrate(pool);
  await expireOrders(pool);
  await cleanupMedia(pool,config);
  const app = await createApp(pool,config);
  let housekeepingRunning = false;
  const timer = setInterval(async()=>{
    if (housekeepingRunning) return;
    housekeepingRunning=true;
    try {await expireOrders(pool);await cleanupMedia(pool,config);} catch {console.error('Housekeeping failed');} finally {housekeepingRunning=false;}
  },30_000);
  timer.unref();
  await app.listen({port:config.port,host:config.host});
  console.log(`Shop API listening on ${config.host}:${config.port}`);
  const close = async()=>{clearInterval(timer);await app.close();await pool.end();};
  process.once('SIGTERM',()=>void close());process.once('SIGINT',()=>void close());
} catch (error) {await pool.end();throw error;}
