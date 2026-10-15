import { createInterface } from 'node:readline';
const scenario = process.argv[process.argv.indexOf('--scenario') + 1];
const methods = [];
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line); methods.push(m.method);
  if (m.method === 'initialize') { send({ id: m.id, result: { userAgent: 'test-fixture' } }); return; }
  if (m.id === 2) {
    if (scenario === 'hang') { setInterval(() => {}, 10000); return; }
    if (scenario === 'invalid') { process.stdout.write('invalid\n'); return; }
    if (scenario === 'huge') { send({ id: 2, result: { payload: 'a'.repeat(100000) } }); return; }
    if (scenario === 'reject') { send({ id: 2, error: { code: -32602, message: 'Fixture error; must not fall back to a mutation.' } }); return; }
    send({ id: m.id, result: { data: [], nextCursor: null, methods, params: m.params, args: process.argv.slice(2), envKeys: Object.keys(process.env) } });
  }
});
