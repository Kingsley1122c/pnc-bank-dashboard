import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const rootUrl = new URL('../', import.meta.url);

test('deployment and public metadata use only the approved Nevora Core domain', async () => {
  const [renderConfig, document, rootEnvironment, serverEnvironment] = await Promise.all([
    readFile(new URL('render.yaml', rootUrl), 'utf8'),
    readFile(new URL('index.html', rootUrl), 'utf8'),
    readFile(new URL('.env.example', rootUrl), 'utf8'),
    readFile(new URL('server/.env.example', rootUrl), 'utf8'),
  ]);
  const activeConfiguration = [renderConfig, document, rootEnvironment, serverEnvironment].join('\n');

  assert.match(renderConfig, /APP_BASE_URL\s*\n\s*value: https:\/\/nevoracore\.com/);
  assert.match(renderConfig, /ALLOWED_ORIGINS\s*\n\s*value: https:\/\/nevoracore\.com,https:\/\/www\.nevoracore\.com/);
  assert.match(renderConfig, /EMAIL_MODE\s*\n\s*value: disabled/);
  assert.match(document, /<link rel="canonical" href="https:\/\/nevoracore\.com" \/>/);
  assert.doesNotMatch(activeConfiguration, /pnc-core\.com/i);
  assert.doesNotMatch(activeConfiguration, /nivoracore\.com/i);
});