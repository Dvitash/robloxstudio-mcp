import { once } from 'node:events';
import type { Server } from 'node:http';
import { claimPrimaryPort, createHttpServer, listenWithRetry, type RobloxStudioHttpApp } from '../http-server.js';
import { BridgeService } from '../bridge-service.js';
import { RobloxStudioTools } from '../tools/index.js';

const token = 'claim-secret';

function portOf(server: Server): number {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a TCP address');
  return address.port;
}

describe('claiming the primary port', () => {
  const apps: RobloxStudioHttpApp[] = [];
  const servers: Server[] = [];

  function makeApp(): RobloxStudioHttpApp {
    const bridge = new BridgeService();
    const app = createHttpServer(new RobloxStudioTools(bridge), bridge, new Set(), undefined, { authToken: token, allowedOrigins: [] });
    apps.push(app);
    return app;
  }

  async function holdPort(onYield?: (server: Server) => void): Promise<number> {
    const app = makeApp();
    const { server } = await listenWithRetry(app, '127.0.0.1', 0, 1);
    servers.push(server);
    if (onYield) app.setPrimaryYieldHandler(() => onYield(server));
    return portOf(server);
  }

  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      if (!server.listening) continue;
      const closed = once(server, 'close');
      server.close();
      server.closeAllConnections();
      await closed;
    }
    for (const app of apps.splice(0)) await app.cleanup();
    jest.restoreAllMocks();
  });

  test('the holding session yields and the claimant binds its port', async () => {
    const yielded = jest.fn((server: Server) => {
      server.close();
      server.closeAllConnections();
    });
    const port = await holdPort(yielded);

    const claimed = await claimPrimaryPort(makeApp(), '127.0.0.1', port, token);
    servers.push(claimed.server);
    expect(claimed.port).toBe(port);
    expect(portOf(claimed.server)).toBe(port);
    expect(yielded).toHaveBeenCalledTimes(1);
  });

  test('a broker that must stay primary keeps the port', async () => {
    const port = await holdPort();
    await expect(claimPrimaryPort(makeApp(), '127.0.0.1', port, token)).rejects.toThrow('did not yield (HTTP 409)');
  });

  test('a yield request without the auth token changes nothing', async () => {
    const yielded = jest.fn();
    const port = await holdPort(yielded);
    await expect(claimPrimaryPort(makeApp(), '127.0.0.1', port, 'wrong-secret')).rejects.toThrow('did not yield (HTTP 401)');
    expect(yielded).not.toHaveBeenCalled();
  });
});
