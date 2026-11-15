// Starts jira-board over HTTP on 127.0.0.1, in the user's own terminal:   node mcp/jira-board/serve-http.mjs
// The one startup line on stderr names the address and which JIRA_* variables are present. Nothing else is printed:
// no credential, no token, no Jira data.

import { checkEnv } from './board.mjs';
import { PATH, createHttpServer, portFrom } from './http.mjs';
import { loadOrCreateToken } from './localtoken.mjs';

try {
  const port = portFrom(process.env);
  const { token } = loadOrCreateToken();
  const http = createHttpServer({ token });
  const address = await http.listen(port);
  const env = Object.entries(checkEnv(process.env))
    .map(([name, v]) => `${name} ${v.present ? 'present' : 'absent'}`)
    .join(', ');
  process.stderr.write(`jira-board listening on http://${address.address}:${address.port}${PATH} (${env})\n`);
  const stop = () => http.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
} catch (error) {
  const text = error?.code === 'EADDRINUSE' ? 'the port is already in use (set DSC_JIRA_BOARD_PORT)' : error instanceof Error ? error.message : 'unexpected error';
  process.stderr.write(`jira-board could not start: ${text}\n`);
  process.exit(1);
}
