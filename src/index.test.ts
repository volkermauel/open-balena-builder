/* eslint-disable indent */
import { strict as assert } from 'node:assert';
import { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

// The server module snapshots DOCKER_HOST_* at import time, and import
// statements are hoisted, so a static import would observe the environment
// before these deletions run. Deleting both vars lets us exercise the
// "no builder available" rejection deterministically.
delete process.env.DOCKER_HOST_AMD64;
delete process.env.DOCKER_HOST_ARM64;

/* eslint-disable-next-line @typescript-eslint/no-var-requires */
const { createHttpServer } = require('./index');

interface BuildMessage {
  message: { message: string; isError?: boolean };
}

const postBuild = async (
  port: number,
  query = '',
  authorization?: string
): Promise<{ status: number; body: BuildMessage }> => {
  const response = await fetch(
    `http://127.0.0.1:${port}/v3/build${query}`,
    authorization
      ? { method: 'POST', headers: { authorization } }
      : { method: 'POST' }
  );
  return {
    status: response.status,
    body: (await response.json()) as BuildMessage,
  };
};

describe('POST /v3/build error handling', () => {
  let server: import('http').Server;
  let port: number;

  before(async () => {
    server = await createHttpServer(0);
    if (!server.listening) {
      await new Promise<void>((resolve) =>
        server.once('listening', () => resolve())
      );
    }
    port = (server.address() as AddressInfo).port;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('rejects a build request without a slug', async () => {
    const { status, body } = await postBuild(port);
    assert.equal(status, 200);
    assert.equal(body.message.message, 'app slug must be specified');
    assert.equal(body.message.isError, true);
  });

  it('rejects a build request without an authorization header', async () => {
    const { body } = await postBuild(port, '?slug=myorg/myapp');
    assert.equal(body.message.message, 'authorization header must be provided');
    assert.equal(body.message.isError, true);
  });

  it('rejects a build request when no docker builders are configured', async () => {
    const { body } = await postBuild(
      port,
      '?slug=myorg/myapp',
      'Bearer test-token'
    );
    assert.equal(body.message.message, 'no builder available');
    assert.equal(body.message.isError, true);
  });
});
