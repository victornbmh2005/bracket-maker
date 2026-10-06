import { app, allowedOrigins } from './app.js';

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`API listening on http://localhost:${port}`);
  console.log(`Swagger docs:   http://localhost:${port}/api/docs`);
  console.log(`Accepting requests from: ${allowedOrigins.join(', ')}`);
});
