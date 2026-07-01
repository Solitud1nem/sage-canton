// Zero-dependency .env loader (side-effect import). Reads backend/.env into
// process.env WITHOUT overriding vars already set in the real environment.
// Kept tiny on purpose — we avoid a dotenv dependency to match the repo's no-dep stance.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
// src/ at dev (tsx) and dist/ at build both sit one level under backend/.
const envPath = join(here, '..', '.env');

try {
  const text = readFileSync(envPath, 'utf8');
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    // strip matching surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = val;
  }
} catch {
  // no .env file — fine (LocalNet runs on baked-in defaults)
}
