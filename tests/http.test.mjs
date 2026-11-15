// jira-board over Streamable HTTP. Everything on 127.0.0.1 with port 0; the Jira side is the recorded fixture fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PORT, createHttpServer, hostAllowed, originAllowed, portFrom } from '../mcp/jira-board/http.mjs';
import { loadOrCreateToken, tokenPath } from '../mcp/jira-board/localtoken.mjs';
import { FAKE_ENV, ROOT, SECRETS, recordedJira } from './helpers.mjs';

const TOKEN = 'local-test-token-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

/** A raw HTTP request, so Host and Origin can be set freely. */
function post(port, { body, headers = {}, method = 'POST', path = '/mcp' } = {}) {
  const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: Object.fromEntries(
          Object.entries({
            Host: `127.0.0.1:${port}`,
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            Authorization: `Bearer ${TOKEN}`,
            'Content-Length': Buffer.byteLength(text),
            ...headers,
          }).filter(([, v]) => v !== null), // null removes a header
        ),
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: data, json: data ? JSON.parse(data) : undefined }));
      },
    );
    req.on('error', reject);
    req.end(text);
  });
}

async function started(t, deps = { env: FAKE_ENV, fetch: recordedJira() }) {
  const http = createHttpServer({ token: TOKEN, deps });
  const address = await http.listen(0);
  t.after(() => http.close());
  return { http, address, port: address.port };
}

const rpc = (id, method, params = {}) => ({ jsonrpc: '2.0', id, method, params });

function assertClean(t, text) {
  for (const s of [...SECRETS, TOKEN]) if (String(text).includes(s)) t.assert.fail(`a secret-like string (${s.length} chars) leaked`);
}

test('binds only to 127.0.0.1', async (t) => {
  const { address } = await started(t);
  assert.equal(address.address, '127.0.0.1');
  assert.equal(address.family, 'IPv4');
});

test('lists the one read-only tool and answers a call from the recorded Jira', async (t) => {
  const { port } = await started(t);
  const init = await post(port, { body: rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } }) });
  assert.equal(init.status, 200);
  assert.equal(init.json.result.serverInfo.name, 'jira-board');
  const note = await post(port, { body: { jsonrpc: '2.0', method: 'notifications/initialized' } });
  assert.equal(note.status, 202);
  assert.equal(note.text, '');
  const list = await post(port, { body: rpc(2, 'tools/list') });
  assert.deepEqual(list.json.result.tools.map((x) => x.name), ['jira_board_csv']);
  assert.equal(list.json.result.tools[0].annotations.readOnlyHint, true);
  const call = await post(port, { body: rpc(3, 'tools/call', { name: 'jira_board_csv', arguments: { project: 'HB' } }) });
  assert.equal(call.status, 200);
  assert.equal(call.json.result.structuredContent.issueCount, 19);
  assert.match(call.json.result.content[0].text, /^Issue key,Summary,Story Points,/);
  assert.equal(call.headers['cache-control'], 'no-store');
  assertClean(t, JSON.stringify([init, list, call]));
});

test('refuses a Host that is not 127.0.0.1 or localhost (DNS rebinding)', async (t) => {
  const { port } = await started(t);
  for (const host of ['evil.example', `evil.example:${port}`, `127.0.0.1.nip.io:${port}`, `localhost:${port + 1}`, '0.0.0.0', '[::1]', 'localhost@evil.example']) {
    const r = await post(port, { body: rpc(1, 'tools/list'), headers: { Host: host } });
    assert.equal(r.status, 403, host);
    assert.equal(r.json.result, undefined);
  }
  for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, 'localhost', 'LOCALHOST']) {
    assert.equal((await post(port, { body: rpc(1, 'tools/list'), headers: { Host: host } })).status, 200, host);
  }
});

test('refuses a foreign Origin; accepts none or a local one', async (t) => {
  const { port } = await started(t);
  for (const origin of ['https://evil.example', 'null', 'http://localhost.evil.example', 'file://']) {
    assert.equal((await post(port, { body: rpc(1, 'tools/list'), headers: { Origin: origin } })).status, 403, origin);
  }
  assert.equal((await post(port, { body: rpc(1, 'tools/list'), headers: { Origin: `http://127.0.0.1:${port}` } })).status, 200);
});

test('refuses a missing, wrong or malformed bearer token, before reading the body', async (t) => {
  const fetch = recordedJira();
  const { port } = await started(t, { env: FAKE_ENV, fetch });
  const call = rpc(1, 'tools/call', { name: 'jira_board_csv', arguments: { project: 'HB' } });
  for (const auth of [null, '', 'Bearer', `Bearer ${TOKEN}x`, `Bearer ${TOKEN.slice(0, -1)}`, `Basic ${TOKEN}`, TOKEN, `Bearer ${TOKEN} extra`]) {
    const r = await post(port, { body: call, headers: { Authorization: auth } });
    assert.equal(r.status, 401, String(auth));
    assert.equal(r.headers['www-authenticate'], 'Bearer');
    assertClean(t, r.text);
  }
  assert.equal(fetch.calls.length, 0, 'Jira was never called');
});

test('only POST /mcp with a JSON body', async (t) => {
  const { port } = await started(t);
  assert.equal((await post(port, { method: 'GET' })).status, 405);
  assert.equal((await post(port, { method: 'DELETE' })).status, 405);
  assert.equal((await post(port, { path: '/other', body: rpc(1, 'ping') })).status, 404);
  assert.equal((await post(port, { body: rpc(1, 'ping'), headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await post(port, { body: '{not json' })).json.error.code, -32700);
  assert.equal((await post(port, { body: [rpc(1, 'ping')] })).status, 400);
  assert.equal((await post(port, { body: 'x'.repeat(1_048_577) })).status, 413);
});

test('no credential or token in any response, errors included', async (t) => {
  const { port } = await started(t, { env: FAKE_ENV, fetch: recordedJira({ 'GET /rest/api/3/field': () => new Response(JSON.stringify({ message: FAKE_ENV.JIRA_API_TOKEN }), { status: 401 }) }) });
  const answers = [];
  answers.push(await post(port, { body: rpc(1, 'tools/call', { name: 'jira_board_csv', arguments: { project: 'HB' } }) }));
  answers.push(await post(port, { body: rpc(2, 'tools/call', { name: 'jira_board_csv', arguments: { check: 'env' } }) }));
  answers.push(await post(port, { body: rpc(3, 'tools/call', { name: 'jira_board_csv', arguments: { project: 'hb' } }) }));
  assert.equal(answers[0].json.result.isError, true);
  assert.match(answers[0].json.result.content[0].text, /^auth:/);
  assert.equal(answers[1].json.result.structuredContent.env.JIRA_API_TOKEN.length, FAKE_ENV.JIRA_API_TOKEN.length);
  assertClean(t, JSON.stringify(answers));
});

test('a token must be given, and long enough', () => {
  assert.throws(() => createHttpServer({}), /local token/);
  assert.throws(() => createHttpServer({ token: 'short' }), /local token/);
});

test('header rules', () => {
  assert.equal(hostAllowed('127.0.0.1:5000', 5000), true);
  assert.equal(hostAllowed('127.0.0.1:5001', 5000), false);
  assert.equal(hostAllowed(undefined, 5000), false);
  assert.equal(originAllowed(undefined), true);
  assert.equal(originAllowed('http://user@localhost'), false);
  assert.equal(portFrom({}), DEFAULT_PORT);
  assert.equal(portFrom({ DSC_JIRA_BOARD_PORT: '50123' }), 50123);
  assert.throws(() => portFrom({ DSC_JIRA_BOARD_PORT: '80' }));
  assert.throws(() => portFrom({ DSC_JIRA_BOARD_PORT: '0.0.0.0:1' }));
});

test('the token file lives in the user config folder, never in the repo', () => {
  const win = tokenPath({ APPDATA: 'C:\\Users\\someone\\AppData\\Roaming' }, 'win32');
  assert.equal(win, join('C:\\Users\\someone\\AppData\\Roaming', 'deadline-seance-crew', 'local-token'));
  assert.equal(tokenPath({ XDG_CONFIG_HOME: '/home/someone/.config' }, 'linux'), join('/home/someone/.config', 'deadline-seance-crew', 'local-token'));
  assert.ok(!tokenPath(process.env).startsWith(ROOT) || process.env.DSC_JIRA_BOARD_TOKEN_FILE);
});

test('the token is made once, private, and reused', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsc-token-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, DSC_JIRA_BOARD_TOKEN_FILE: join(dir, 'sub', 'local-token') };
  const first = loadOrCreateToken({ env });
  assert.equal(first.created, true);
  assert.match(first.token, /^[A-Za-z0-9_-]{43}$/);
  const again = loadOrCreateToken({ env });
  assert.equal(again.created, false);
  assert.equal(again.token, first.token);
  assert.equal(readFileSync(first.path, 'utf8').trim(), first.token);
  if (process.platform !== 'win32') assert.equal(statSync(first.path).mode & 0o077, 0);
});

test('the started server prints one line: the address and which variables are present, nothing secret', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsc-serve-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const child = spawn(process.execPath, [join(ROOT, 'mcp', 'jira-board', 'serve-http.mjs')], {
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      USERNAME: process.env.USERNAME,
      USERDOMAIN: process.env.USERDOMAIN,
      DSC_JIRA_BOARD_PORT: '0',
      DSC_JIRA_BOARD_TOKEN_FILE: join(dir, 'local-token'),
      JIRA_BASE_URL: FAKE_ENV.JIRA_BASE_URL,
      JIRA_EMAIL: FAKE_ENV.JIRA_EMAIL,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  let out = '';
  child.stdout.on('data', (c) => (out += c));
  const line = await new Promise((resolve, reject) => {
    let err = '';
    const timer = setTimeout(() => reject(new Error(`no startup line: ${err}`)), 15_000);
    child.stderr.on('data', (c) => {
      err += c;
      if (err.includes('\n')) {
        clearTimeout(timer);
        resolve(err);
      }
    });
    child.on('exit', (code) => reject(new Error(`exited ${code}: ${err}`)));
  });
  assert.match(line, /^jira-board listening on http:\/\/127\.0\.0\.1:\d+\/mcp \(JIRA_BASE_URL present, JIRA_EMAIL present, JIRA_API_TOKEN absent\)\n$/);
  const token = readFileSync(join(dir, 'local-token'), 'utf8').trim();
  assertCleanText(line, token);
  assert.equal(out, '');
  const port = Number(/:(\d+)\/mcp/.exec(line)[1]);
  const unauth = await post(port, { body: rpc(1, 'tools/list'), headers: { Authorization: 'Bearer wrong-token-wrong-token-wrong-token' } });
  assert.equal(unauth.status, 401);
});

function assertCleanText(text, token) {
  for (const s of [...SECRETS, token]) assert.ok(!text.includes(s), 'startup line holds a secret');
}
