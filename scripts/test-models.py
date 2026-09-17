#!/usr/bin/env python3
"""Rate-aware reliability probe for every configured Harmony model.

This sends a tiny, read-only chat request directly to each configured model. It
never sends repository contents, never prints API keys, and persists results as
JSONL so interrupted runs can be resumed.

Examples:
  python3 scripts/test-models.py --dry-run
  python3 scripts/test-models.py --confirm --probe-count 1
  python3 scripts/test-models.py --confirm --resume
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from collections import defaultdict
from pathlib import Path
from typing import Any

PROVIDERS: dict[str, dict[str, Any]] = {
    "openrouter": {"url": "https://openrouter.ai/api/v1", "key": "OPENROUTER_API_KEY", "rpm": 20, "rpd": 50, "scope": "provider"},
    "inceptionlabs": {"url": "https://api.inceptionlabs.ai/v1", "key": "INCEPTIONLABS_API_KEY", "rpm": 1000, "scope": "provider"},
    "tokenreply": {"url": "https://api.tokenreply.com/v1", "key": "TOKENREPLY_API_KEY", "rpm": 3, "scope": "provider"},
    "requesty": {"url": "https://router.requesty.ai/v1", "key": "REQUESTY_API_KEY", "rpd": 200, "scope": "provider"},
    "logfare": {"url": "https://logfare.ai/v1", "key": "LOGFARE_API_KEY", "rpm": 20, "scope": "provider"},
    "pollinations": {"url": "https://gen.pollinations.ai/v1", "key": "POLLINATIONS_API_KEY", "scope": "model"},
    "llmgateway": {"url": "https://api.llmgateway.io/v1", "key": "LLMGATEWAY_API_KEY", "scope": "model"},
    "agnes": {"url": "https://apihub.agnes-ai.com/v1", "key": "AGNES_API_KEY", "rpm": 20, "scope": "provider"},
    "eden": {"url": "https://api.edenai.run/v3", "key": "EDEN_API_KEY", "rpm": 60, "scope": "provider"},
    "poolside": {"url": "https://inference.poolside.ai/v1", "key": "POOLSIDE_API_KEY", "scope": "provider"},
    "orcarouter": {"url": "https://api.orcarouter.ai/v1", "key": "ORCAROUTER_API_KEY", "rpm": 20, "scope": "provider"},
}

DEFAULT_PROMPT = (
    "Reliability probe. Reply with exactly the word READY and nothing else. "
    "Do not use tools, do not modify files, and do not include markdown."
)


def config_path() -> Path:
    return Path(os.environ.get("HARMONY_CONFIG", os.environ.get("SNEEZE_CONFIG", Path.home() / ".config/harmony/config.json")))


def load_config() -> dict[str, Any]:
    path = config_path()
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        raise SystemExit(f"Harmony config not found: {path}")
    except json.JSONDecodeError as exc:
        raise SystemExit(f"Invalid Harmony config {path}: {exc}")


def secret_for(provider: str, config: dict[str, Any]) -> str | None:
    definition = PROVIDERS.get(provider)
    if not definition:
        return None
    return os.environ.get(definition["key"]) or config.get("apiKeys", {}).get(provider)


def identity(model: dict[str, Any]) -> str:
    return f"{model.get('provider', '?')}/{model.get('model', '?')}"


def bucket(model: dict[str, Any]) -> str:
    definition = PROVIDERS.get(model.get("provider", ""), {})
    return model.get("provider", "") if definition.get("scope") == "provider" else identity(model)


def request_once(model: dict[str, Any], api_key: str, prompt: str, timeout: float) -> tuple[int, str, int]:
    provider = model["provider"]
    definition = PROVIDERS[provider]
    payload = {
        "model": model["model"],
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 32,
        "temperature": 0,
        "stream": False,
    }
    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"}
    if provider == "openrouter":
        headers.update({"HTTP-Referer": "https://github.com/harmony", "X-Title": "harmony-model-probe"})
    request = urllib.request.Request(
        f"{definition['url']}/chat/completions",
        data=json.dumps(payload).encode(),
        headers=headers,
        method="POST",
    )
    started = time.monotonic()
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read(1_000_000).decode("utf-8", "replace")
            return response.status, body, round((time.monotonic() - started) * 1000)
    except urllib.error.HTTPError as exc:
        body = exc.read(8_000).decode("utf-8", "replace")
        return exc.code, body, round((time.monotonic() - started) * 1000)
    except Exception as exc:  # network errors and timeouts are probe results
        return 0, f"{type(exc).__name__}: {exc}", round((time.monotonic() - started) * 1000)


def classify(status: int, body: str) -> str:
    if status == 200:
        try:
            content = json.loads(body).get("choices", [{}])[0].get("message", {}).get("content", "")
            return "success" if content.strip() else "empty_response"
        except (ValueError, TypeError, AttributeError, IndexError):
            return "invalid_json"
    if status == 0:
        return "network_or_timeout"
    if status == 429:
        return "rate_limited"
    if status in (401, 403):
        return "auth_or_forbidden"
    if status in (404, 410):
        return "model_unavailable"
    if status >= 500:
        return "provider_error"
    return "request_error"


def safe_error(body: str) -> str:
    try:
        parsed = json.loads(body)
        if isinstance(parsed, dict):
            error = parsed.get("error", parsed)
            if isinstance(error, dict):
                return str(error.get("message", error))[:300]
        return str(parsed)[:300]
    except ValueError:
        return body[:300]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--confirm", action="store_true", help="actually send probes; without this, only show the plan")
    parser.add_argument("--dry-run", action="store_true", help="show the plan without sending requests")
    parser.add_argument("--resume", action="store_true", help="skip model identities already present in the output file")
    parser.add_argument("--probe-count", type=int, default=1, help="probes per model (default: 1)")
    parser.add_argument("--timeout", type=float, default=15, help="per-request timeout seconds (default: 15)")
    parser.add_argument("--output", type=Path, default=Path(".agent-recordings/model-reliability.jsonl"))
    parser.add_argument("--prompt", default=DEFAULT_PROMPT)
    args = parser.parse_args()
    if args.probe_count < 1 or args.probe_count > 5:
        parser.error("--probe-count must be between 1 and 5")

    config = load_config()
    models = [m for m in config.get("models", []) if m.get("provider") in PROVIDERS]
    if not models:
        raise SystemExit("No supported configured models found.")

    missing = sorted({m["provider"] for m in models if not secret_for(m["provider"], config)})
    output = args.output
    completed: set[str] = set()
    if args.resume and output.exists():
        for line in output.read_text().splitlines():
            try:
                row = json.loads(line)
                if row.get("probe", 1) >= args.probe_count:
                    completed.add(row.get("model", ""))
            except json.JSONDecodeError:
                continue
    planned = [m for m in models if identity(m) not in completed]
    print(f"Configured models: {len(models)} | to test: {len(planned)} | probes/model: {args.probe_count}")
    if missing:
        print("Skipped providers with no key:", ", ".join(missing), file=sys.stderr)
    if args.dry_run or not args.confirm:
        print("Dry run only. Re-run with --confirm to send requests.")
        for model in planned:
            definition = PROVIDERS[model["provider"]]
            limit = f"{definition.get('rpm', '?')} rpm" if definition.get("rpm") else "undocumented rpm"
            print(f"  {identity(model)} ({limit}, bucket={bucket(model)})")
        return 0

    args.output.parent.mkdir(parents=True, exist_ok=True)
    last_request: dict[str, float] = defaultdict(float)
    request_count: dict[str, int] = defaultdict(int)
    day = time.strftime("%Y-%m-%d", time.gmtime())
    for model in planned:
        provider = model["provider"]
        api_key = secret_for(provider, config)
        if not api_key:
            continue
        definition = PROVIDERS[provider]
        rate_bucket = bucket(model)
        rpm = model.get("rpm") or definition.get("rpm")
        interval = 60.0 / rpm if rpm else 0.0
        for probe in range(1, args.probe_count + 1):
            wait = interval - (time.monotonic() - last_request[rate_bucket])
            if wait > 0:
                time.sleep(wait)
            status, body, latency = request_once(model, api_key, args.prompt, args.timeout)
            last_request[rate_bucket] = time.monotonic()
            request_count[rate_bucket] += 1
            result = classify(status, body)
            row = {
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "day": day,
                "model": identity(model),
                "provider": provider,
                "model_id": model["model"],
                "probe": probe,
                "status": result,
                "http_status": status,
                "latency_ms": latency,
                "error": None if result == "success" else safe_error(body),
            }
            with output.open("a", encoding="utf-8") as stream:
                stream.write(json.dumps(row) + "\n")
            print(f"{result:20} {latency:6}ms {identity(model)}")
            if status == 429 and probe < args.probe_count:
                retry_after = 60.0
                try:
                    retry_after = float(json.loads(body).get("retry_after", retry_after))
                except (ValueError, TypeError, AttributeError):
                    pass
                time.sleep(min(max(retry_after, 1), 300))
    print(f"Results written to {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
