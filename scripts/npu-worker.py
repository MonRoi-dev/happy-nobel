import argparse
import asyncio
from contextlib import asynccontextmanager
from datetime import datetime, timezone
import json
import logging
import os
import re
import subprocess
import threading
import time
import traceback
from typing import Any, AsyncIterator, Dict, List, Optional
import openvino as ov
import openvino_genai as ov_genai
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel
import uvicorn

logger = logging.getLogger("npu_worker")
generation_lock = asyncio.Lock()
init_event = threading.Event()

state: Dict[str, Any] = {
    "pipeline": None,
    "cpu_pipeline": None,
    "tokenizer": None,
    "device": "NPU",
    "model_name": "qwen2.5-3b-npu",
    "model_dir": r"C:\models\qwen2.5-3b-npu",
    "npu_ready": False,
    "init_error": None,
    "gpu_3d_load_pct": 0.0,
    "vram_used_mb": 0.0,
}


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    model: Optional[str] = "qwen2.5-3b-npu"
    messages: List[ChatMessage]
    format: Optional[Any] = None
    stream: Optional[bool] = False
    options: Optional[Dict[str, Any]] = None


class GenerateRequest(BaseModel):
    model: Optional[str] = "qwen2.5-3b-npu"
    system: Optional[str] = ""
    prompt: Optional[str] = ""
    format: Optional[Any] = None
    stream: Optional[bool] = False
    keep_alive: Optional[Any] = None
    options: Optional[Dict[str, Any]] = None


def configure_logging(model_dir: str) -> None:
    try:
        os.makedirs(model_dir, exist_ok=True)
        log_path = os.path.join(model_dir, "npu_worker.log")
        handler = logging.FileHandler(log_path, encoding="utf-8")
        formatter = logging.Formatter("[%(asctime)s] [%(levelname)s] %(message)s")
        handler.setFormatter(formatter)
        logger.setLevel(logging.INFO)
        logger.handlers.clear()
        logger.addHandler(handler)
    except Exception:
        logging.basicConfig(level=logging.INFO)


def extract_json_payload(raw_text: str) -> str:
    cleaned = raw_text.strip()
    fence_match = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", cleaned, re.IGNORECASE)
    if fence_match and fence_match.group(1):
        cleaned = fence_match.group(1).strip()
    start_idx = cleaned.find("{")
    end_idx = cleaned.rfind("}")
    if start_idx != -1 and end_idx != -1 and end_idx > start_idx:
        candidate = cleaned[start_idx : end_idx + 1]
        try:
            parsed = json.loads(candidate)
            return json.dumps(parsed, ensure_ascii=False)
        except Exception:
            return candidate
    if start_idx != -1 and end_idx == -1:
        repaired = cleaned[start_idx:].rstrip()
        if not repaired.endswith('"'):
            repaired += '"'
        repaired += "}"
        try:
            parsed = json.loads(repaired)
            return json.dumps(parsed, ensure_ascii=False)
        except Exception:
            return repaired
    return cleaned


def compact_text_middle(text: str, max_chars: int) -> str:
    stripped = text.strip()
    if len(stripped) <= max_chars:
        return stripped
    head_len = int(max_chars * 0.72)
    tail_len = max(0, max_chars - head_len - 7)
    return f"{stripped[:head_len]}\n...\n{stripped[-tail_len:]}"


def build_qwen_prompt(messages: List[Dict[str, str]], require_json: Any, max_user_chars: int = 4000) -> str:
    parts: List[str] = []
    for msg in messages:
        role = msg.get("role", "user")
        content = msg.get("content", "")
        if role == "system" and require_json:
            if isinstance(require_json, dict):
                schema_str = json.dumps(require_json, ensure_ascii=False)
                schema_hint = (
                    f"\nRespond ONLY with a valid JSON object matching this schema: {schema_str}. "
                    "Keep reasoning concise (1 sentence, under 150 chars). "
                    "Write coverLetter in simple, natural everyday developer Russian (3-4 short sentences, 220-500 chars) in FIRST PERSON ('я', 'пишу на', 'делал', 'настраивал') mentioning specific technologies and concrete tasks from the resume. "
                    "NEVER use robotic AI cliches like 'Меня заинтересовала ваша вакансия', 'позволяет мне эффективно взаимодействовать', 'современные технологии', 'что соответствует требованиям вашей вакансии', or 'Ваше резюме'."
                )
            else:
                schema_hint = "\nRespond ONLY with a valid JSON object without markdown formatting."
            content = f"{content}{schema_hint}"
        elif role == "user":
            content = compact_text_middle(content, max_user_chars)
        parts.append(f"<|im_start|>{role}\n{content}<|im_end|>")
    parts.append("<|im_start|>assistant\n")
    return "\n".join(parts)


def count_prompt_tokens(pipe: Any, prompt: str) -> int:
    try:
        tok = state.get("tokenizer")
        if tok is None:
            tok = pipe.get_tokenizer()
            state["tokenizer"] = tok
        encoded = tok.encode(prompt)
        shape = getattr(encoded.input_ids, "shape", None)
        if shape and len(shape) >= 2:
            return int(shape[1])
    except Exception:
        pass
    return len(prompt) // 2


def ensure_cpu_fallback_pipeline() -> Any:
    if state.get("cpu_pipeline") is not None:
        return state["cpu_pipeline"]
    model_dir = state["model_dir"]
    cache_dir = os.path.join(model_dir, "cache")
    os.makedirs(cache_dir, exist_ok=True)
    logger.info("Initializing fallback OpenVINO CPU pipeline...")
    cpu_pipe = ov_genai.LLMPipeline(model_dir, "CPU", CACHE_DIR=cache_dir)
    state["cpu_pipeline"] = cpu_pipe
    return cpu_pipe


def run_sync_generation(
    messages: List[Dict[str, str]],
    require_json: Any,
    temperature: float,
    max_new_tokens: int,
) -> str:
    if not init_event.is_set():
        init_event.wait(timeout=90.0)

    pipe = state.get("pipeline")
    if pipe is None:
        err_msg = state.get("init_error") or "NPU pipeline is not initialized"
        logger.error(f"Pipeline unavailable after wait: {err_msg}")
        pipe = ensure_cpu_fallback_pipeline()

    max_user_chars = 4000
    prompt = build_qwen_prompt(messages, require_json, max_user_chars=max_user_chars)
    while count_prompt_tokens(pipe, prompt) > 1800 and max_user_chars > 1000:
        max_user_chars -= 600
        prompt = build_qwen_prompt(messages, require_json, max_user_chars=max_user_chars)

    gen_config = ov_genai.GenerationConfig()
    gen_config.max_new_tokens = max(32, min(int(max_new_tokens), 480))
    if temperature <= 0.05:
        gen_config.do_sample = False
    else:
        gen_config.do_sample = True
        gen_config.temperature = float(temperature)
        gen_config.top_p = 0.9

    try:
        result = pipe.generate(prompt, gen_config)
        return str(result)
    except Exception as exc:
        logger.error(f"NPU generation failed ({exc}), falling back to OpenVINO CPU pipeline:\n{traceback.format_exc()}")
        cpu_pipe = ensure_cpu_fallback_pipeline()
        result = cpu_pipe.generate(prompt, gen_config)
        return str(result)


def poll_windows_gpu_metrics() -> None:
    ps_script = (
        "$ErrorActionPreference='SilentlyContinue';"
        "$c3d = (Get-Counter '\\GPU Engine(*engtype_3D)\\Utilization Percentage').CounterSamples | Measure-Object -Property CookedValue -Sum;"
        "$vram = (Get-Counter '\\GPU Adapter Memory(*)\\Dedicated Usage').CounterSamples | Measure-Object -Property CookedValue -Maximum;"
        "$load = if ($c3d.Sum) { [math]::Round($c3d.Sum, 1) } else { 0 };"
        "$memMb = if ($vram.Maximum) { [math]::Round($vram.Maximum / 1MB, 1) } else { 0 };"
        "Write-Output \"$load|$memMb\""
    )
    while True:
        try:
            proc = subprocess.run(
                ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", ps_script],
                capture_output=True,
                text=True,
                timeout=4,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            out = (proc.stdout or "").strip().splitlines()
            if out:
                last_line = out[-1].strip()
                if "|" in last_line:
                    load_str, mem_str = last_line.split("|", 1)
                    state["gpu_3d_load_pct"] = max(0.0, min(100.0, float(load_str.replace(",", "."))))
                    state["vram_used_mb"] = max(0.0, float(mem_str.replace(",", ".")))
        except Exception:
            pass
        time.sleep(3.0)


def initialize_npu_pipeline() -> None:
    try:
        model_dir = str(state["model_dir"]).strip().strip('"').strip("'")
        state["model_dir"] = model_dir
        cache_dir = os.path.join(model_dir, "cache")
        os.makedirs(cache_dir, exist_ok=True)
        logger.info(f"Initializing OpenVINO pipeline from {model_dir} (cache: {cache_dir})...")

        core = ov.Core()
        devices = core.available_devices
        target_device = "NPU" if "NPU" in devices else "CPU"
        state["device"] = target_device

        if target_device == "NPU":
            try:
                pipe = ov_genai.LLMPipeline(
                    model_dir,
                    "NPU",
                    CACHE_DIR=cache_dir,
                    MAX_PROMPT_LEN=2048,
                    MIN_RESPONSE_LEN=512,
                )
            except Exception as npu_exc:
                logger.warning(f"NPU 2048 init failed ({npu_exc}), trying default NPU config...")
                pipe = ov_genai.LLMPipeline(model_dir, "NPU", CACHE_DIR=cache_dir)
        else:
            pipe = ov_genai.LLMPipeline(model_dir, "CPU", CACHE_DIR=cache_dir)

        state["pipeline"] = pipe
        state["tokenizer"] = pipe.get_tokenizer()
        state["npu_ready"] = True
        state["init_error"] = None
        logger.info(f"OpenVINO pipeline ready on device {target_device}")
    except Exception as exc:
        state["npu_ready"] = False
        state["init_error"] = str(exc)
        logger.error(f"Failed to initialize OpenVINO pipeline: {exc}\n{traceback.format_exc()}")
    finally:
        init_event.set()


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    threading.Thread(target=poll_windows_gpu_metrics, daemon=True).start()
    threading.Thread(target=initialize_npu_pipeline, daemon=True).start()
    yield


app = FastAPI(lifespan=lifespan)


@app.get("/gpu/status")
async def get_gpu_status() -> Dict[str, Any]:
    return {
        "gpu3dLoadPct": state["gpu_3d_load_pct"],
        "vramUsedMb": state["vram_used_mb"],
        "npuReady": state["npu_ready"],
        "device": state["device"],
        "model": state["model_name"],
        "error": state["init_error"],
    }


@app.get("/api/tags")
async def list_tags() -> Dict[str, Any]:
    return {
        "models": [
            {
                "name": state["model_name"],
                "model": state["model_name"],
                "size": 3088848141,
                "digest": "openvino-npu-int4-sym",
                "modified_at": datetime.now(timezone.utc).isoformat(),
            }
        ]
    }


@app.get("/api/ps")
async def list_ps() -> Dict[str, Any]:
    models = []
    if state["npu_ready"]:
        models.append(
            {
                "name": state["model_name"],
                "model": state["model_name"],
                "size": 3088848141,
                "size_vram": 0,
                "expires_at": "2099-01-01T00:00:00Z",
            }
        )
    return {"models": models}


@app.post("/api/chat")
async def api_chat(req: ChatRequest) -> Any:
    try:
        messages = [{"role": m.role, "content": m.content} for m in req.messages]
        opts = req.options or {}
        temperature = float(opts.get("temperature", 0.2))
        max_tokens = int(opts.get("num_predict", 450))

        async with generation_lock:
            raw_out = await asyncio.to_thread(
                run_sync_generation,
                messages,
                req.format,
                temperature,
                max_tokens,
            )

        content = extract_json_payload(raw_out) if req.format else raw_out.strip()
        return {
            "model": req.model or state["model_name"],
            "created_at": datetime.now(timezone.utc).isoformat(),
            "message": {
                "role": "assistant",
                "content": content,
            },
            "done": True,
        }
    except Exception as exc:
        logger.error(f"Error in /api/chat: {exc}\n{traceback.format_exc()}")
        return JSONResponse(status_code=500, content={"error": str(exc)})


@app.post("/api/generate")
async def api_generate(req: GenerateRequest) -> Any:
    try:
        if req.keep_alive == 0 and not req.prompt:
            return {
                "model": req.model or state["model_name"],
                "created_at": datetime.now(timezone.utc).isoformat(),
                "response": "",
                "done": True,
            }
        messages: List[Dict[str, str]] = []
        if req.system:
            messages.append({"role": "system", "content": req.system})
        messages.append({"role": "user", "content": req.prompt or ""})
        opts = req.options or {}
        temperature = float(opts.get("temperature", 0.3))
        max_tokens = int(opts.get("num_predict", 450))

        async with generation_lock:
            raw_out = await asyncio.to_thread(
                run_sync_generation,
                messages,
                req.format,
                temperature,
                max_tokens,
            )

        content = extract_json_payload(raw_out) if req.format else raw_out.strip()
        return {
            "model": req.model or state["model_name"],
            "created_at": datetime.now(timezone.utc).isoformat(),
            "response": content,
            "done": True,
        }
    except Exception as exc:
        logger.error(f"Error in /api/generate: {exc}\n{traceback.format_exc()}")
        return JSONResponse(status_code=500, content={"error": str(exc)})


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=11435)
    parser.add_argument("--model-dir", default=r"C:\models\qwen2.5-3b-npu")
    args = parser.parse_args()
    clean_model_dir = str(args.model_dir).strip().strip('"').strip("'")
    state["model_dir"] = clean_model_dir
    configure_logging(clean_model_dir)
    logger.info(f"Starting NPU worker on {args.host}:{args.port} with model_dir={clean_model_dir}")
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")
