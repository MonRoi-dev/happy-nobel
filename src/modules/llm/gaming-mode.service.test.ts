import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createDatabaseContext } from '../../db/index.ts';
import { ConfigStoreService } from '../config-store/index.ts';
import { GamingModeService } from './gaming-mode.service.ts';

describe('GamingModeService routing, hysteresis, and VRAM eviction', () => {
  it('routes to GPU when GAMING_MODE is off', async () => {
    const ctx = createDatabaseContext(':memory:');
    try {
      const store = new ConfigStoreService(ctx.db);
      store.ensureDefaults();
      store.setGamingMode('off');

      const service = new GamingModeService(store, {
        autoSpawnDaemon: false,
        customFetch: async () => new Response(JSON.stringify({ gpu3dLoadPct: 90, vramUsedMb: 9000, npuReady: true }), { status: 200 }),
      });

      const target = await service.resolveRoutingTarget();
      assert.equal(target.error, null);
      assert.equal(target.data?.provider, 'gpu');
      assert.equal(target.data?.baseUrl, 'http://127.0.0.1:11434');
      assert.equal(target.data?.model, 'gemma4:64k');
      assert.equal(target.data?.numCtx, 65536);
      assert.equal(target.data?.reason, 'manual_off');
    } finally {
      ctx.close();
    }
  });

  it('routes to NPU and evicts Ollama VRAM (keep_alive: 0) when GAMING_MODE switches to on', async () => {
    const ctx = createDatabaseContext(':memory:');
    try {
      const store = new ConfigStoreService(ctx.db);
      store.ensureDefaults();
      store.setGamingMode('on');

      const evictionCalls: Array<{ url: string; body: unknown }> = [];
      const service = new GamingModeService(store, {
        autoSpawnDaemon: false,
        customFetch: async (url, init) => {
          const urlStr = String(url);
          if (urlStr.endsWith('/api/generate')) {
            evictionCalls.push({
              url: urlStr,
              body: init?.body ? JSON.parse(String(init.body)) : null,
            });
            return new Response(JSON.stringify({ done: true }), { status: 200 });
          }
          return new Response(
            JSON.stringify({ gpu3dLoadPct: 12, vramUsedMb: 1500, npuReady: true }),
            { status: 200 }
          );
        },
      });

      const target = await service.resolveRoutingTarget();
      assert.equal(target.error, null);
      assert.equal(target.data?.provider, 'npu');
      assert.equal(target.data?.baseUrl, 'http://127.0.0.1:11435');
      assert.equal(target.data?.model, 'qwen2.5-3b-npu');
      assert.equal(target.data?.numCtx, 4096);
      assert.equal(target.data?.reason, 'manual_on');

      assert.equal(evictionCalls.length, 1);
      assert.equal(evictionCalls[0]?.url, 'http://127.0.0.1:11434/api/generate');
      assert.deepEqual(evictionCalls[0]?.body, {
        model: 'gemma4:64k',
        keep_alive: 0,
      });

      await service.resolveRoutingTarget();
      assert.equal(evictionCalls.length, 1);
    } finally {
      ctx.close();
    }
  });

  it('applies 180s hysteresis cooldown in auto mode so loading screens do not reload GPU VRAM', async () => {
    const ctx = createDatabaseContext(':memory:');
    try {
      const store = new ConfigStoreService(ctx.db);
      store.ensureDefaults();
      store.setGamingMode('auto');

      let fakeNowMs = 1_000_000;
      let mockGpuLoad = 45;
      let mockVramMb = 7200;
      let evictionCount = 0;

      const service = new GamingModeService(store, {
        autoSpawnDaemon: false,
        cooldownMs: 180_000,
        nowFn: () => fakeNowMs,
        customFetch: async (url) => {
          if (String(url).endsWith('/api/generate')) {
            evictionCount += 1;
            return new Response(JSON.stringify({ done: true }), { status: 200 });
          }
          return new Response(
            JSON.stringify({ gpu3dLoadPct: mockGpuLoad, vramUsedMb: mockVramMb, npuReady: true }),
            { status: 200 }
          );
        },
      });

      const t1 = await service.resolveRoutingTarget();
      assert.equal(t1.data?.provider, 'npu');
      assert.equal(t1.data?.reason, 'gpu_busy_auto');
      assert.equal(evictionCount, 1);

      mockGpuLoad = 4;
      mockVramMb = 1200;
      fakeNowMs += 30_000;

      const t2 = await service.resolveRoutingTarget();
      assert.equal(t2.data?.provider, 'npu');
      assert.equal(t2.data?.reason, 'gpu_cooldown_auto');

      fakeNowMs += 151_000;
      const t3 = await service.resolveRoutingTarget();
      assert.equal(t3.data?.provider, 'gpu');
      assert.equal(t3.data?.reason, 'gpu_idle_auto');
    } finally {
      ctx.close();
    }
  });

  it('cycles gaming mode auto -> on -> off -> auto', () => {
    const ctx = createDatabaseContext(':memory:');
    try {
      const store = new ConfigStoreService(ctx.db);
      store.ensureDefaults();
      const service = new GamingModeService(store, { autoSpawnDaemon: false });

      assert.equal(store.getGamingMode().data, 'auto');
      assert.equal(service.cycleGamingMode().data, 'on');
      assert.equal(service.cycleGamingMode().data, 'off');
      assert.equal(service.cycleGamingMode().data, 'auto');
    } finally {
      ctx.close();
    }
  });

  it('falls back to GPU with 8192 ctx when NPU is offline even in manual_on or gpu_busy state', async () => {
    const ctx = createDatabaseContext(':memory:');
    try {
      const store = new ConfigStoreService(ctx.db);
      store.ensureDefaults();
      store.setGamingMode('on');
      const service = new GamingModeService(store, {
        customFetch: async () => new Response('offline', { status: 503 }),
        autoSpawnDaemon: false,
      });
      const target = await service.resolveRoutingTarget();
      assert.equal(target.data?.provider, 'gpu');
      assert.equal(target.data?.numCtx, 8192);
      assert.equal(target.data?.reason, 'npu_offline_fallback');
    } finally {
      ctx.close();
    }
  });

  it('does not send POST /shutdown on stop() when no daemon was spawned', async () => {
    const ctx = createDatabaseContext(':memory:');
    try {
      const store = new ConfigStoreService(ctx.db);
      store.ensureDefaults();
      let fetchCallCount = 0;
      const service = new GamingModeService(store, {
        autoSpawnDaemon: false,
        customFetch: async () => {
          fetchCallCount++;
          return new Response(JSON.stringify({ status: 'shutting_down' }), { status: 200 });
        },
      });
      await service.stop();
      assert.equal(fetchCallCount, 0);
    } finally {
      ctx.close();
    }
  });
});
