'use strict';
try { process.loadEnvFile?.('.env'); } catch { /* no .env file: use real environment */ }
const { createApp } = require('./src/app');
const app = createApp();
const port = +process.env.PORT || 3000;
app.server.listen(port, () => console.log(`Quantum Market running on http://localhost:${port}`));
process.on('SIGTERM', () => app.close());
