// @vitest-environment node
import { createServer } from 'node:http';
import { createClient } from '@supabase/supabase-js';
import { expect, it } from 'vitest';

it('o SDK encerra o download também quando o corpo trava depois dos headers', async () => {
  let headersSent = false;
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'audio/ogg' });
    response.flushHeaders();
    headersSent = true;
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing local address');
  const client = createClient(`http://127.0.0.1:${address.port}`, 'synthetic-key', {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  try {
    const download = client.storage.from('whatsapp-media').download('held.ogg', {}, {
      signal: AbortSignal.timeout(100),
    });
    await expect(Promise.resolve(download)).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(headersSent).toBe(true);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
