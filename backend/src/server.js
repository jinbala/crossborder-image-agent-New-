import app from './app.js';
import { ensureStorage } from './services/db.js';

const port = process.env.PORT || 4000;

await ensureStorage();

app.listen(port, () => {
  console.log(`API server listening on http://localhost:${port}`);
});
