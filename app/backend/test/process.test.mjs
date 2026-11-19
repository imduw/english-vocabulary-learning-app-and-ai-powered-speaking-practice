import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';

async function unusedPort() {
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}

test('compiled application boots, logs JSON and reports real pg connection failure safely', { timeout: 25000 }, async () => {
  const port = await unusedPort();
  const closedDatabasePort = await unusedPort();
  const child = spawn(process.execPath, ['dist/src/main.js'], {
    cwd: new URL('../', import.meta.url), windowsHide: true,
    env: {
      ...process.env, NODE_ENV: 'test', PORT: String(port), DATABASE_SSL: 'false',
      DATABASE_URL: `postgresql://fixture:never-log-this-password@127.0.0.1:${closedDatabasePort}/fixture`,
      DATABASE_TIMEOUT_MS: '200', DATABASE_POOL_MAX: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const exited = once(child, 'exit');
  try {
    let ready = false;
    // Allow slow Windows cold starts while schema tests initialize their WASM engine.
    for (let i = 0; i < 200; i++) {
      try {
        ready = (await fetch(`http://127.0.0.1:${port}/health/live`)).status === 200;
        if (ready) break;
      } catch { /* wait for the child to listen */ }
      if (child.exitCode !== null) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(ready, 'compiled application must become live');
    const down = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(down.status, 503);
    assert.match(await down.text(), /SERVICE_UNAVAILABLE/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/health/live`)).status, 200);
  } finally {
    child.kill();
    await exited;
  }
  assert.doesNotMatch(output, /never-log-this-password|postgresql:\/\//);
  const records = output.trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.ok(records.some(record => record.message?.event === 'request_completed'));
});
