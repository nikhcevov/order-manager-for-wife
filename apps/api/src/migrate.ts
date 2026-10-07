import { loadConfig } from './config.js';
import { createPool, migrate } from './db.js';
const pool = createPool(loadConfig().databaseUrl);
try {await migrate(pool); console.log('Database migrations applied');} finally {await pool.end();}
