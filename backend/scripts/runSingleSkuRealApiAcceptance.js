#!/usr/bin/env node
import '../src/config/env.js';
import { runSingleSkuRealApiAcceptance } from '../src/services/realApiAcceptanceService.js';

function parseArgs(argv = []) {
  const options = {};
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const [key, rawValue = 'true'] = arg.slice(2).split('=');
    const value = rawValue === 'true' ? true : rawValue === 'false' ? false : rawValue;
    if (key === 'imageTypes') {
      options.imageTypes = String(rawValue || '').split(',').map((item) => item.trim()).filter(Boolean);
    } else if (key === 'maxRealApiCalls') {
      options.maxRealApiCalls = Number(rawValue);
    } else {
      options[key] = value;
    }
  }
  return options;
}

try {
  const report = await runSingleSkuRealApiAcceptance(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(error.message || error);
  process.exitCode = error.statusCode || 1;
}
