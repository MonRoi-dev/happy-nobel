import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createDatabaseContext } from '../../db/index.ts';
import { ConfigStoreService } from './config-store.service.ts';

describe('ConfigStoreService gaming mode and NPU settings', () => {
  it('initializes default gaming mode and NPU settings via ensureDefaults', () => {
    const ctx = createDatabaseContext(':memory:');
    try {
      const store = new ConfigStoreService(ctx.db);
      const initRes = store.ensureDefaults();
      assert.equal(initRes.error, null);
      assert.equal(initRes.data, true);

      assert.equal(store.get('GAMING_MODE').data, 'auto');
      assert.equal(store.get('NPU_BASE_URL').data, 'http://127.0.0.1:11435');
      assert.equal(store.get('NPU_MODEL_NAME').data, 'qwen2.5-3b-npu');
      assert.equal(store.get('GPU_LOAD_THRESHOLD').data, '25');
      assert.equal(store.getGamingMode().data, 'auto');
    } finally {
      ctx.close();
    }
  });

  it('persists valid gaming modes and rejects invalid ones', () => {
    const ctx = createDatabaseContext(':memory:');
    try {
      const store = new ConfigStoreService(ctx.db);
      store.ensureDefaults();

      const setOn = store.setGamingMode('on');
      assert.equal(setOn.error, null);
      assert.equal(setOn.data, 'on');
      assert.equal(store.getGamingMode().data, 'on');

      const setOff = store.setGamingMode('off');
      assert.equal(setOff.error, null);
      assert.equal(setOff.data, 'off');
      assert.equal(store.getGamingMode().data, 'off');

      const invalidRes = store.set('GAMING_MODE', 'invalid_mode');
      assert.notEqual(invalidRes.error, null);
      assert.equal(invalidRes.data, null);
      assert.equal(store.getGamingMode().data, 'off');
    } finally {
      ctx.close();
    }
  });

  it('validates NPU_BASE_URL and GPU_LOAD_THRESHOLD', () => {
    const ctx = createDatabaseContext(':memory:');
    try {
      const store = new ConfigStoreService(ctx.db);
      store.ensureDefaults();

      const badUrl = store.set('NPU_BASE_URL', 'not-a-url');
      assert.notEqual(badUrl.error, null);

      const goodUrl = store.set('NPU_BASE_URL', 'http://127.0.0.1:11436');
      assert.equal(goodUrl.error, null);
      assert.equal(store.get('NPU_BASE_URL').data, 'http://127.0.0.1:11436');

      const badThreshold = store.set('GPU_LOAD_THRESHOLD', '150');
      assert.notEqual(badThreshold.error, null);

      const goodThreshold = store.set('GPU_LOAD_THRESHOLD', '35');
      assert.equal(goodThreshold.error, null);
      assert.equal(store.getGpuLoadThreshold().data, 35);
    } finally {
      ctx.close();
    }
  });
});
