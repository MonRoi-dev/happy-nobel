import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../../utils/logger.ts';
import type { GamingMode, IConfigStore, SafeResult } from '../config-store/index.ts';

const logger = createLogger('GamingMode');

export type LlmProviderType = 'gpu' | 'npu';

export type GamingRoutingReason =
  | 'manual_on'
  | 'manual_off'
  | 'gpu_busy_auto'
  | 'gpu_cooldown_auto'
  | 'gpu_idle_auto'
  | 'npu_offline_fallback';

export interface GpuTelemetryPayload {
  readonly gpu3dLoadPct: number;
  readonly vramUsedMb: number;
  readonly npuReady: boolean;
  readonly device?: string;
  readonly model?: string;
}

export interface LlmRoutingTarget {
  readonly provider: LlmProviderType;
  readonly baseUrl: string;
  readonly model: string;
  readonly numCtx: number;
  readonly reason: GamingRoutingReason;
  readonly gpu3dLoadPct: number;
  readonly vramUsedMb: number;
  readonly npuReady: boolean;
}

export interface GamingModeStatusSnapshot {
  readonly gamingMode: GamingMode;
  readonly activeProvider: LlmProviderType;
  readonly activeModel: string;
  readonly activeBaseUrl: string;
  readonly reason: GamingRoutingReason;
  readonly gpu3dLoadPct: number;
  readonly vramUsedMb: number;
  readonly npuOnline: boolean;
  readonly npuReady: boolean;
  readonly cooldownRemainingSec: number;
}

export interface GamingModeServiceOptions {
  readonly customFetch?: typeof fetch;
  readonly cooldownMs?: number;
  readonly vramBusyThresholdMb?: number;
  readonly nowFn?: () => number;
  readonly autoSpawnDaemon?: boolean;
  readonly windowsModelDirWsl?: string;
  readonly windowsModelDirWin?: string;
  readonly windowsPythonExeWin?: string;
  readonly windowsPythonExeWsl?: string;
}

export interface IGamingModeService {
  start(): Promise<SafeResult<boolean>>;
  stop(): Promise<void>;
  resolveRoutingTarget(): Promise<SafeResult<LlmRoutingTarget>>;
  getStatusSnapshot(): Promise<SafeResult<GamingModeStatusSnapshot>>;
  cycleGamingMode(): SafeResult<GamingMode>;
}

const DEFAULT_COOLDOWN_MS = 180_000;
const DEFAULT_VRAM_BUSY_MB = 6144;
const GPU_DEFAULT_CTX = 65536;
const NPU_DEFAULT_CTX = 4096;

export class GamingModeService implements IGamingModeService {
  private readonly configStore: IConfigStore;
  private readonly fetchFn: typeof fetch;
  private readonly cooldownMs: number;
  private readonly vramBusyThresholdMb: number;
  private readonly nowFn: () => number;
  private readonly autoSpawnDaemon: boolean;
  private readonly windowsModelDirWsl: string;
  private readonly windowsModelDirWin: string;
  private readonly windowsPythonExeWin: string;
  private readonly windowsPythonExeWsl: string;

  private lastActiveProvider: LlmProviderType = 'gpu';
  private lastGpuBusyAt: number | null = null;
  private daemonProcess: ChildProcess | null = null;

  constructor(configStore: IConfigStore, options?: GamingModeServiceOptions) {
    this.configStore = configStore;
    this.fetchFn = options?.customFetch ?? globalThis.fetch;
    this.cooldownMs = options?.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.vramBusyThresholdMb = options?.vramBusyThresholdMb ?? DEFAULT_VRAM_BUSY_MB;
    this.nowFn = options?.nowFn ?? (() => Date.now());
    this.autoSpawnDaemon = options?.autoSpawnDaemon ?? true;
    this.windowsModelDirWsl = options?.windowsModelDirWsl ?? '/mnt/c/models/qwen2.5-3b-npu';
    this.windowsModelDirWin = options?.windowsModelDirWin ?? 'C:\\models\\qwen2.5-3b-npu';
    this.windowsPythonExeWin =
      options?.windowsPythonExeWin ?? 'C:\\Users\\monro\\npu_env\\Scripts\\python.exe';
    this.windowsPythonExeWsl =
      options?.windowsPythonExeWsl ?? '/mnt/c/Users/monro/npu_env/Scripts/python.exe';
  }

  public async start(): Promise<SafeResult<boolean>> {
    const npuBaseUrl = this.getNpuBaseUrl();
    const probe = await this.probeGpuTelemetry(npuBaseUrl);
    if (probe.online && probe.npuReady) {
      logger.info(`Windows NPU демон уже запущен на ${npuBaseUrl} (NPU Ready: ${probe.npuReady})`);
      return { data: true, error: null };
    }

    if (!this.autoSpawnDaemon) {
      return { data: probe.online, error: null };
    }

    try {
      const localWorkerScript = path.resolve(process.cwd(), 'scripts', 'npu-worker.py');
      const targetWorkerScript = path.join(this.windowsModelDirWsl, 'npu_worker.py');

      if (!fs.existsSync(localWorkerScript)) {
        return { data: false, error: 'scripts/npu-worker.py not found' };
      }

      if (fs.existsSync(this.windowsModelDirWsl)) {
        fs.copyFileSync(localWorkerScript, targetWorkerScript);
      }

      if (!probe.online) {
        const parsedUrl = new URL(npuBaseUrl);
        const port = parsedUrl.port || '11435';

        if (fs.existsSync(this.windowsPythonExeWsl) && fs.existsSync(this.windowsModelDirWsl)) {
          this.daemonProcess = spawn(
            this.windowsPythonExeWsl,
            ['npu_worker.py', '--port', port, '--model-dir', this.windowsModelDirWin],
            {
              cwd: this.windowsModelDirWsl,
              stdio: 'ignore',
              detached: true,
              windowsHide: true,
            }
          );
        } else {
          const cmdLine = `cd /d ${this.windowsModelDirWin} && ${this.windowsPythonExeWin} npu_worker.py --port ${port} --model-dir ${this.windowsModelDirWin}`;
          this.daemonProcess = spawn('cmd.exe', ['/c', cmdLine], {
            cwd: '/mnt/c',
            stdio: 'ignore',
            detached: true,
            windowsHide: true,
          });
        }
        this.daemonProcess.unref();

        this.daemonProcess.on('exit', (code) => {
          logger.info(`Процесс Windows NPU демона завершился (код: ${code ?? 'unknown'})`);
          this.daemonProcess = null;
        });

        logger.info(`Запущен фоновый демон OpenVINO NPU (${this.windowsModelDirWin} -> ${npuBaseUrl})`);
      }

      for (let attempt = 0; attempt < 16; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        const status = await this.probeGpuTelemetry(npuBaseUrl);
        if (status.online && status.npuReady) {
          logger.info(`Демон OpenVINO NPU готов к работе на ${npuBaseUrl}`);
          return { data: true, error: null };
        }
      }

      return { data: true, error: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to spawn Windows NPU daemon';
      logger.warn(`Не удалось запустить демон NPU: ${message}`);
      return { data: false, error: message };
    }
  }

  public async stop(): Promise<void> {
    const cleanBase = this.getNpuBaseUrl().replace(/\/+$/, '');
    try {
      await this.fetchFn(`${cleanBase}/shutdown`, {
        method: 'POST',
        signal: AbortSignal.timeout(1500),
      });
    } catch {}

    if (this.daemonProcess) {
      try {
        this.daemonProcess.kill('SIGTERM');
      } catch {}
      this.daemonProcess = null;
    }
  }

  public cycleGamingMode(): SafeResult<GamingMode> {
    const current = this.getConfiguredGamingMode();
    const nextMode: GamingMode =
      current === 'auto' ? 'on' : current === 'on' ? 'off' : 'auto';

    if (typeof this.configStore.setGamingMode === 'function') {
      return this.configStore.setGamingMode(nextMode);
    }

    const saved = this.configStore.set('GAMING_MODE', nextMode);
    if (saved.error) {
      return { data: null, error: saved.error };
    }
    return { data: nextMode, error: null };
  }

  public async resolveRoutingTarget(): Promise<SafeResult<LlmRoutingTarget>> {
    const mode = this.getConfiguredGamingMode();
    const gpuBaseUrl = this.getGpuBaseUrl();
    const gpuModel = this.getGpuModelName();
    const npuBaseUrl = this.getNpuBaseUrl();
    const npuModel = this.getNpuModelName();
    const threshold = this.getGpuLoadThreshold();

    if (mode === 'off') {
      this.lastActiveProvider = 'gpu';
      this.lastGpuBusyAt = null;
      return {
        data: {
          provider: 'gpu',
          baseUrl: gpuBaseUrl,
          model: gpuModel,
          numCtx: GPU_DEFAULT_CTX,
          reason: 'manual_off',
          gpu3dLoadPct: 0,
          vramUsedMb: 0,
          npuReady: false,
        },
        error: null,
      };
    }

    const telemetry = await this.probeGpuTelemetry(npuBaseUrl);

    if (mode === 'on') {
      if (!telemetry.online || !telemetry.npuReady) {
        this.lastActiveProvider = 'gpu';
        return {
          data: {
            provider: 'gpu',
            baseUrl: gpuBaseUrl,
            model: gpuModel,
            numCtx: 8192,
            reason: 'npu_offline_fallback',
            gpu3dLoadPct: telemetry.gpu3dLoadPct,
            vramUsedMb: telemetry.vramUsedMb,
            npuReady: false,
          },
          error: null,
        };
      }
      if (this.lastActiveProvider === 'gpu') {
        this.lastActiveProvider = 'npu';
        await this.evictOllamaVram(gpuBaseUrl, gpuModel);
      }
      return {
        data: {
          provider: 'npu',
          baseUrl: npuBaseUrl,
          model: npuModel,
          numCtx: NPU_DEFAULT_CTX,
          reason: 'manual_on',
          gpu3dLoadPct: telemetry.gpu3dLoadPct,
          vramUsedMb: telemetry.vramUsedMb,
          npuReady: telemetry.npuReady,
        },
        error: null,
      };
    }

    const now = this.nowFn();
    const is3dBusy = telemetry.gpu3dLoadPct >= threshold;
    const isVramBusyWhileNpu =
      this.lastActiveProvider === 'npu' && telemetry.vramUsedMb >= this.vramBusyThresholdMb;

    if (is3dBusy || isVramBusyWhileNpu) {
      this.lastGpuBusyAt = now;
      if (!telemetry.online || !telemetry.npuReady) {
        this.lastActiveProvider = 'gpu';
        return {
          data: {
            provider: 'gpu',
            baseUrl: gpuBaseUrl,
            model: gpuModel,
            numCtx: 8192,
            reason: 'npu_offline_fallback',
            gpu3dLoadPct: telemetry.gpu3dLoadPct,
            vramUsedMb: telemetry.vramUsedMb,
            npuReady: false,
          },
          error: null,
        };
      }
      if (this.lastActiveProvider === 'gpu') {
        this.lastActiveProvider = 'npu';
        logger.info(
          `Обнаружена 3D-нагрузка на GPU (${telemetry.gpu3dLoadPct.toFixed(1)}%, VRAM: ${Math.round(
            telemetry.vramUsedMb
          )} МБ). Переключение на NPU (${npuModel}) и очистка VRAM Ollama...`
        );
        await this.evictOllamaVram(gpuBaseUrl, gpuModel);
      }
      return {
        data: {
          provider: 'npu',
          baseUrl: npuBaseUrl,
          model: npuModel,
          numCtx: NPU_DEFAULT_CTX,
          reason: 'gpu_busy_auto',
          gpu3dLoadPct: telemetry.gpu3dLoadPct,
          vramUsedMb: telemetry.vramUsedMb,
          npuReady: telemetry.npuReady,
        },
        error: null,
      };
    }

    if (this.lastGpuBusyAt !== null && now - this.lastGpuBusyAt < this.cooldownMs) {
      if (!telemetry.online || !telemetry.npuReady) {
        this.lastActiveProvider = 'gpu';
        return {
          data: {
            provider: 'gpu',
            baseUrl: gpuBaseUrl,
            model: gpuModel,
            numCtx: 8192,
            reason: 'npu_offline_fallback',
            gpu3dLoadPct: telemetry.gpu3dLoadPct,
            vramUsedMb: telemetry.vramUsedMb,
            npuReady: false,
          },
          error: null,
        };
      }
      this.lastActiveProvider = 'npu';
      return {
        data: {
          provider: 'npu',
          baseUrl: npuBaseUrl,
          model: npuModel,
          numCtx: NPU_DEFAULT_CTX,
          reason: 'gpu_cooldown_auto',
          gpu3dLoadPct: telemetry.gpu3dLoadPct,
          vramUsedMb: telemetry.vramUsedMb,
          npuReady: telemetry.npuReady,
        },
        error: null,
      };
    }

    if (this.lastActiveProvider === 'npu') {
      logger.info('Нагрузка на GPU завершилась (выдержан гистерезис 3 мин). Возврат на основную модель GPU (Ollama).');
    }
    this.lastActiveProvider = 'gpu';
    this.lastGpuBusyAt = null;

    return {
      data: {
        provider: 'gpu',
        baseUrl: gpuBaseUrl,
        model: gpuModel,
        numCtx: GPU_DEFAULT_CTX,
        reason: 'gpu_idle_auto',
        gpu3dLoadPct: telemetry.gpu3dLoadPct,
        vramUsedMb: telemetry.vramUsedMb,
        npuReady: telemetry.npuReady,
      },
      error: null,
    };
  }

  public async getStatusSnapshot(): Promise<SafeResult<GamingModeStatusSnapshot>> {
    const mode = this.getConfiguredGamingMode();
    const npuBaseUrl = this.getNpuBaseUrl();
    const telemetry = await this.probeGpuTelemetry(npuBaseUrl);
    const targetRes = await this.resolveRoutingTarget();

    if (targetRes.error || !targetRes.data) {
      return { data: null, error: targetRes.error ?? 'Failed to resolve gaming mode status' };
    }

    const now = this.nowFn();
    let cooldownRemainingSec = 0;
    if (
      targetRes.data.reason === 'gpu_cooldown_auto' &&
      this.lastGpuBusyAt !== null &&
      now - this.lastGpuBusyAt < this.cooldownMs
    ) {
      cooldownRemainingSec = Math.max(0, Math.ceil((this.cooldownMs - (now - this.lastGpuBusyAt)) / 1000));
    }

    return {
      data: {
        gamingMode: mode,
        activeProvider: targetRes.data.provider,
        activeModel: targetRes.data.model,
        activeBaseUrl: targetRes.data.baseUrl,
        reason: targetRes.data.reason,
        gpu3dLoadPct: telemetry.gpu3dLoadPct,
        vramUsedMb: telemetry.vramUsedMb,
        npuOnline: telemetry.online,
        npuReady: telemetry.npuReady,
        cooldownRemainingSec,
      },
      error: null,
    };
  }

  private async probeGpuTelemetry(
    npuBaseUrl: string
  ): Promise<{ online: boolean; gpu3dLoadPct: number; vramUsedMb: number; npuReady: boolean }> {
    const cleanBase = npuBaseUrl.replace(/\/+$/, '');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);

    try {
      const response = await this.fetchFn(`${cleanBase}/gpu/status`, {
        method: 'GET',
        signal: controller.signal,
      });
      if (!response.ok) {
        return { online: false, gpu3dLoadPct: 0, vramUsedMb: 0, npuReady: false };
      }
      const payload = (await response.json()) as Partial<GpuTelemetryPayload>;
      return {
        online: true,
        gpu3dLoadPct: typeof payload.gpu3dLoadPct === 'number' ? payload.gpu3dLoadPct : 0,
        vramUsedMb: typeof payload.vramUsedMb === 'number' ? payload.vramUsedMb : 0,
        npuReady: Boolean(payload.npuReady),
      };
    } catch {
      return { online: false, gpu3dLoadPct: 0, vramUsedMb: 0, npuReady: false };
    } finally {
      clearTimeout(timer);
    }
  }

  private async evictOllamaVram(gpuBaseUrl: string, gpuModel: string): Promise<void> {
    const cleanBase = gpuBaseUrl.replace(/\/+$/, '');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);

    try {
      await this.fetchFn(`${cleanBase}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: gpuModel,
          keep_alive: 0,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Не удалось отправить запрос выгрузки VRAM (keep_alive: 0) в Ollama: ${msg}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private getConfiguredGamingMode(): GamingMode {
    if (typeof this.configStore.getGamingMode === 'function') {
      return this.configStore.getGamingMode().data ?? 'auto';
    }
    const raw = this.configStore.get('GAMING_MODE').data;
    if (raw === 'on' || raw === 'off' || raw === 'auto') {
      return raw;
    }
    return 'auto';
  }

  private getGpuBaseUrl(): string {
    return (this.configStore.get('LLM_BASE_URL').data ?? '').trim() || 'http://127.0.0.1:11434';
  }

  private getGpuModelName(): string {
    return (this.configStore.get('LLM_MODEL_NAME').data ?? '').trim() || 'gemma4:64k';
  }

  private getNpuBaseUrl(): string {
    return (this.configStore.get('NPU_BASE_URL').data ?? '').trim() || 'http://127.0.0.1:11435';
  }

  private getNpuModelName(): string {
    return (this.configStore.get('NPU_MODEL_NAME').data ?? '').trim() || 'qwen2.5-3b-npu';
  }

  private getGpuLoadThreshold(): number {
    if (typeof this.configStore.getGpuLoadThreshold === 'function') {
      return this.configStore.getGpuLoadThreshold().data ?? 25;
    }
    const parsed = Number.parseInt(this.configStore.get('GPU_LOAD_THRESHOLD').data ?? '25', 10);
    return Number.isNaN(parsed) ? 25 : parsed;
  }
}
