import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createDatabaseContext } from '../../db/index.ts';
import { ConfigStoreService } from '../config-store/index.ts';
import { GamingModeService } from '../llm/gaming-mode.service.ts';
import { LlmService, type OllamaChatPort } from '../llm/llm.service.ts';
import { buildLlmStatusKeyboard, buildLlmStatusText } from './telegram-wizards.ts';

describe('Telegram LLM Status UI with Gaming Mode', () => {
  it('displays active NPU provider, gaming mode, and GPU 3D load in buildLlmStatusText and keyboard', async () => {
    const ctx = createDatabaseContext(':memory:');
    try {
      const store = new ConfigStoreService(ctx.db);
      store.ensureDefaults();
      store.setGamingMode('auto');

      const gamingMode = new GamingModeService(store, {
        autoSpawnDaemon: false,
        customFetch: async () =>
          new Response(
            JSON.stringify({ gpu3dLoadPct: 68.5, vramUsedMb: 9200, npuReady: true }),
            { status: 200 }
          ),
      });

      const fakeClient: OllamaChatPort = {
        chat: async () => {
          throw new Error('not used');
        },
        list: async () => ({
          models: [
            {
              name: 'qwen2.5-3b-npu',
              model: 'qwen2.5-3b-npu',
              modified_at: new Date(),
              size: 3088848141,
              digest: 'npu',
              expires_at: new Date(),
              size_vram: 0,
              details: {
                parent_model: '',
                format: 'openvino',
                family: 'qwen2',
                families: ['qwen2'],
                parameter_size: '3B',
                quantization_level: 'INT4',
              },
            },
          ],
        }),
        ps: async () => ({
          models: [],
        }),
      };

      const llm = new LlmService(store, fakeClient, gamingMode);
      const statusText = await buildLlmStatusText(llm);

      assert.match(statusText, /Игровой режим:/);
      assert.match(statusText, /NPU/);
      assert.match(statusText, /68\.5%/);

      const kb = buildLlmStatusKeyboard(store);
      const allCallbacks = kb.inline_keyboard
        .flat()
        .map((btn) => ('callback_data' in btn ? btn.callback_data : ''));
      assert.ok(allCallbacks.includes('menu:llm_toggle_gaming_mode'));
    } finally {
      ctx.close();
    }
  });
});
