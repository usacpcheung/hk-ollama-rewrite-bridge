"""Private, single-worker Faster Whisper transcription service."""

from __future__ import annotations

import asyncio
from collections import deque
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
import hmac
import json
import logging
import os
from pathlib import Path
import re
import tempfile
import time
from typing import Any, Awaitable, Callable
import uuid

import av
from fastapi import Depends, FastAPI, File, Header, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from faster_whisper import WhisperModel


LOGGER = logging.getLogger("whisper-asr")
SERVICE_VERSION = "0.2.0"
TERMINAL_STATUSES = {"completed", "failed", "cancelled"}
ACTIVE_STATUSES = {"queued", "running", "cancelling"}
INTERNAL_TOKEN_PATTERN = re.compile(r"[0-9a-f]{64}")
MULTIPART_OVERHEAD_BYTES = 64 * 1024
MAX_CONCURRENT_DURATION_PROBES = 2
ADMISSION_SCOPE_KEY = "whisper_asr.admission_reserved"


class ServiceError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


class RequestBodyLimitMiddleware:
    def __init__(
        self,
        app: Any,
        maximum_bytes: int,
        internal_token: str,
        reserve_admission: Callable[[], Awaitable[bool]],
        release_admission: Callable[[], Awaitable[None]],
        upload_timeout_seconds: int,
    ):
        self.app = app
        self.maximum_bytes = maximum_bytes
        self.internal_token = internal_token.encode("ascii")
        self.reserve_admission = reserve_admission
        self.release_admission = release_admission
        self.upload_timeout_seconds = upload_timeout_seconds

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        if (
            scope.get("type") != "http"
            or scope.get("method") != "POST"
            or scope.get("path") != "/jobs"
        ):
            await self.app(scope, receive, send)
            return

        headers = {key.lower(): value for key, value in scope.get("headers", [])}
        authorization = headers.get(b"authorization", b"")
        prefix = b"Bearer "
        supplied = authorization[len(prefix):] if authorization.startswith(prefix) else b""
        if not supplied or not hmac.compare_digest(supplied, self.internal_token):
            await self._reject(
                send,
                401,
                "AUTH_REQUIRED",
                "Internal authentication is required.",
            )
            return

        raw_content_length = headers.get(b"content-length")
        if raw_content_length is not None:
            try:
                content_length = int(raw_content_length)
            except ValueError:
                content_length = None
            if content_length is not None and content_length > self.maximum_bytes:
                await self._reject(
                    send,
                    413,
                    "UPLOAD_TOO_LARGE",
                    "The upload request is too large.",
                )
                return

        if not await self.reserve_admission():
            await self._reject(
                send,
                503,
                "QUEUE_FULL",
                "The transcription queue is full. Please try again later.",
            )
            return

        scope[ADMISSION_SCOPE_KEY] = True
        received_bytes = 0
        spool: Any | None = None
        try:
            spool = tempfile.SpooledTemporaryFile(max_size=1024 * 1024, mode="w+b")
            try:
                async with asyncio.timeout(self.upload_timeout_seconds):
                    while True:
                        message = await receive()
                        if message.get("type") == "http.disconnect":
                            return
                        if message.get("type") != "http.request":
                            continue
                        body = message.get("body", b"")
                        received_bytes += len(body)
                        if received_bytes > self.maximum_bytes:
                            await self._reject(
                                send,
                                413,
                                "UPLOAD_TOO_LARGE",
                                "The upload request is too large.",
                            )
                            return
                        spool.write(body)
                        if not message.get("more_body", False):
                            break
            except TimeoutError:
                await self._reject(
                    send,
                    408,
                    "UPLOAD_TIMEOUT",
                    "The upload did not complete in time.",
                )
                return

            spool.seek(0)

            async def replay_receive() -> dict[str, Any]:
                body = spool.read(1024 * 1024)
                return {
                    "type": "http.request",
                    "body": body,
                    "more_body": spool.tell() < received_bytes,
                }

            await self.app(scope, replay_receive, send)
        finally:
            if spool is not None:
                spool.close()
            if scope.pop(ADMISSION_SCOPE_KEY, False):
                await self.release_admission()

    @staticmethod
    async def _reject(send: Any, status: int, code: str, message: str) -> None:
        body = json.dumps(
            {
                "ok": False,
                "error": {
                    "code": code,
                    "message": message,
                },
            },
            separators=(",", ":"),
        ).encode("utf-8")
        await send(
            {
                "type": "http.response.start",
                "status": status,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(body)).encode("ascii")),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body})


def _read_int(env: dict[str, str], name: str, default: int, minimum: int, maximum: int) -> int:
    raw = env.get(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise RuntimeError(f"{name} must be an integer") from exc
    if value < minimum or value > maximum:
        raise RuntimeError(f"{name} must be between {minimum} and {maximum}")
    return value


@dataclass(frozen=True)
class Settings:
    internal_token: str
    model_name: str = "medium"
    model_directory: Path = Path("/var/lib/whisper-asr/models")
    job_directory: Path = Path("/var/lib/whisper-asr/jobs")
    device: str = "cpu"
    compute_type: str = "int8"
    cpu_threads: int = 4
    model_workers: int = 1
    queue_capacity: int = 10
    max_upload_bytes: int = 20 * 1024 * 1024
    max_audio_seconds: int = 60
    result_ttl_seconds: int = 30 * 60
    cleanup_interval_seconds: int = 30
    upload_timeout_seconds: int = 120

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> "Settings":
        source = dict(os.environ if env is None else env)
        token = source.get("WHISPER_INTERNAL_TOKEN", "").strip()
        if not token:
            raise RuntimeError("WHISPER_INTERNAL_TOKEN is required")
        if INTERNAL_TOKEN_PATTERN.fullmatch(token) is None:
            raise RuntimeError(
                "WHISPER_INTERNAL_TOKEN must be exactly 64 lowercase hexadecimal characters"
            )
        return cls(
            internal_token=token,
            model_name=source.get("WHISPER_MODEL", "medium").strip() or "medium",
            model_directory=Path(source.get("WHISPER_MODEL_DIRECTORY", "/var/lib/whisper-asr/models")),
            job_directory=Path(source.get("WHISPER_JOB_DIRECTORY", "/var/lib/whisper-asr/jobs")),
            cpu_threads=_read_int(source, "WHISPER_CPU_THREADS", 4, 1, 32),
            queue_capacity=_read_int(source, "WHISPER_QUEUE_CAPACITY", 10, 1, 100),
            max_upload_bytes=_read_int(
                source, "WHISPER_MAX_UPLOAD_BYTES", 20 * 1024 * 1024, 1024, 100 * 1024 * 1024
            ),
            max_audio_seconds=_read_int(source, "WHISPER_MAX_AUDIO_SECONDS", 60, 1, 3600),
            result_ttl_seconds=_read_int(source, "WHISPER_RESULT_TTL_SECONDS", 1800, 60, 86400),
            cleanup_interval_seconds=_read_int(source, "WHISPER_CLEANUP_INTERVAL_SECONDS", 30, 1, 3600),
            upload_timeout_seconds=_read_int(
                source, "WHISPER_UPLOAD_TIMEOUT_SECONDS", 120, 1, 600
            ),
        )


@dataclass
class Job:
    job_id: str
    path: Path
    size: int
    audio_duration_seconds: float
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    status: str = "queued"
    result: dict[str, Any] | None = None
    error: dict[str, str] | None = None
    cancel_requested: bool = False
    admission_reserved: bool = True


def _iso(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def _safe_suffix(filename: str | None) -> str:
    suffix = Path(filename or "").suffix.lower()
    if suffix and len(suffix) <= 10 and suffix[1:].isalnum():
        return suffix
    return ".audio"


def probe_audio_duration(path: Path, maximum_seconds: int) -> float:
    """Decode audio to validate it and enforce a trustworthy duration bound."""
    duration = 0.0
    try:
        with av.open(str(path), mode="r") as container:
            audio_streams = [stream for stream in container.streams if stream.type == "audio"]
            if not audio_streams:
                raise ServiceError(400, "INVALID_AUDIO", "The uploaded file does not contain audio.")
            stream = audio_streams[0]
            for frame in container.decode(stream):
                sample_rate = frame.sample_rate or stream.codec_context.sample_rate
                if not sample_rate:
                    raise ServiceError(400, "INVALID_AUDIO", "The audio sample rate could not be determined.")
                duration += frame.samples / sample_rate
                if duration > maximum_seconds:
                    raise ServiceError(
                        413,
                        "AUDIO_TOO_LONG",
                        f"Recordings must be no longer than {maximum_seconds} seconds.",
                    )
    except ServiceError:
        raise
    except (av.error.FFmpegError, OSError, ValueError) as exc:
        raise ServiceError(400, "INVALID_AUDIO", "The uploaded audio could not be decoded.") from exc
    if duration <= 0:
        raise ServiceError(400, "INVALID_AUDIO", "The uploaded audio is empty.")
    return duration


class JobManager:
    def __init__(
        self,
        settings: Settings,
        model: Any,
        duration_probe: Callable[[Path, int], float] = probe_audio_duration,
    ):
        self.settings = settings
        self.model = model
        self.duration_probe = duration_probe
        self.jobs: dict[str, Job] = {}
        self.pending: deque[str] = deque()
        self.pending_event = asyncio.Event()
        self.lock = asyncio.Lock()
        self.duration_probe_slots = asyncio.Semaphore(MAX_CONCURRENT_DURATION_PROBES)
        self.admitted_jobs = 0
        self.worker_task: asyncio.Task[None] | None = None
        self.cleanup_task: asyncio.Task[None] | None = None

    async def start(self) -> None:
        self.settings.job_directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.settings.job_directory, 0o700)
        for path in self.settings.job_directory.iterdir():
            if path.is_file() or path.is_symlink():
                path.unlink(missing_ok=True)
        self.worker_task = asyncio.create_task(self._worker(), name="whisper-worker")
        self.cleanup_task = asyncio.create_task(self._cleanup_loop(), name="whisper-cleanup")

    async def stop(self) -> None:
        for task in (self.cleanup_task, self.worker_task):
            if task:
                task.cancel()
        await asyncio.gather(
            *(task for task in (self.cleanup_task, self.worker_task) if task),
            return_exceptions=True,
        )
        async with self.lock:
            paths = [job.path for job in self.jobs.values()]
            self.jobs.clear()
            self.pending.clear()
            self.admitted_jobs = 0
        for path in paths:
            path.unlink(missing_ok=True)
        for path in self.settings.job_directory.iterdir():
            if path.is_file() or path.is_symlink():
                path.unlink(missing_ok=True)

    async def reserve_admission(self) -> bool:
        async with self.lock:
            maximum_admitted = self.settings.queue_capacity + 1
            if self.admitted_jobs < maximum_admitted:
                self.admitted_jobs += 1
                return True
        return False

    async def submit(self, upload: UploadFile, reservation_held: bool = False) -> Job:
        if not reservation_held:
            reservation_held = await self.reserve_admission()

        if not reservation_held:
            await upload.close()
            raise ServiceError(503, "QUEUE_FULL", "The transcription queue is full. Please try again later.")

        path: Path | None = None
        size = 0
        try:
            descriptor, raw_path = tempfile.mkstemp(
                prefix="job-",
                suffix=_safe_suffix(upload.filename),
                dir=self.settings.job_directory,
            )
            os.close(descriptor)
            path = Path(raw_path)
            with path.open("wb") as destination:
                while chunk := await upload.read(1024 * 1024):
                    size += len(chunk)
                    if size > self.settings.max_upload_bytes:
                        raise ServiceError(
                            413,
                            "UPLOAD_TOO_LARGE",
                            f"Audio uploads must not exceed {self.settings.max_upload_bytes} bytes.",
                        )
                    destination.write(chunk)
            if size == 0:
                raise ServiceError(400, "EMPTY_UPLOAD", "An audio file is required.")
            async with self.duration_probe_slots:
                duration = await asyncio.to_thread(
                    self.duration_probe, path, self.settings.max_audio_seconds
                )
            job = Job(
                job_id=str(uuid.uuid4()),
                path=path,
                size=size,
                audio_duration_seconds=round(duration, 3),
            )
            async with self.lock:
                self.jobs[job.job_id] = job
                self.pending.append(job.job_id)
                self.pending_event.set()
                reservation_held = False
            LOGGER.info("job accepted job_id=%s bytes=%d", job.job_id, size)
            return job
        except BaseException:
            if path is not None:
                path.unlink(missing_ok=True)
            if reservation_held:
                await self.release_admission()
            raise
        finally:
            await upload.close()

    async def get(self, job_id: str) -> Job:
        async with self.lock:
            job = self.jobs.get(job_id)
            if job is None:
                raise ServiceError(404, "JOB_NOT_FOUND", "The transcription job was not found.")
            return job

    async def cancel_or_delete(self, job_id: str) -> str:
        path: Path | None = None
        async with self.lock:
            job = self.jobs.get(job_id)
            if job is None:
                raise ServiceError(404, "JOB_NOT_FOUND", "The transcription job was not found.")
            if job.status == "running" or job.status == "cancelling":
                job.cancel_requested = True
                job.status = "cancelling"
                job.updated_at = time.time()
                LOGGER.info("job cancellation requested job_id=%s", job_id)
                return "cancelling"
            if job.status == "queued":
                job.cancel_requested = True
                job.status = "cancelled"
                job.updated_at = time.time()
                try:
                    self.pending.remove(job_id)
                except ValueError:
                    pass
                if not self.pending:
                    self.pending_event.clear()
                path = job.path
                self._release_job_admission_locked(job)
                LOGGER.info("queued job cancelled job_id=%s", job_id)
                outcome = "cancelled"
            else:
                path = job.path
                del self.jobs[job_id]
                LOGGER.info("terminal job deleted job_id=%s", job_id)
                outcome = "deleted"
        if path:
            path.unlink(missing_ok=True)
        return outcome

    def public_job(self, job: Job) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "ok": True,
            "jobId": job.job_id,
            "status": job.status,
            "createdAt": _iso(job.created_at),
            "updatedAt": _iso(job.updated_at),
        }
        if job.status in TERMINAL_STATUSES:
            payload["expiresAt"] = _iso(job.updated_at + self.settings.result_ttl_seconds)
        if job.status == "completed":
            payload["result"] = job.result
        elif job.status == "failed":
            payload["error"] = job.error
        return payload

    async def _worker(self) -> None:
        while True:
            await self.pending_event.wait()
            async with self.lock:
                if not self.pending:
                    self.pending_event.clear()
                    continue
                job_id = self.pending.popleft()
                if not self.pending:
                    self.pending_event.clear()
                job = self.jobs.get(job_id)
                if job is None or job.status != "queued":
                    continue
                job.status = "running"
                job.updated_at = time.time()
                path = job.path
            LOGGER.info("job started job_id=%s", job_id)
            try:
                result = await asyncio.to_thread(self._transcribe, path)
            except Exception as exc:  # provider errors are deliberately not exposed
                async with self.lock:
                    job = self.jobs.get(job_id)
                    if job is not None:
                        if job.cancel_requested:
                            job.status = "cancelled"
                        else:
                            job.status = "failed"
                            job.error = {
                                "code": "TRANSCRIPTION_FAILED",
                                "message": "The recording could not be transcribed.",
                            }
                        job.updated_at = time.time()
                LOGGER.error("job failed job_id=%s error_type=%s", job_id, type(exc).__name__)
            else:
                async with self.lock:
                    job = self.jobs.get(job_id)
                    if job is not None:
                        if job.cancel_requested:
                            job.status = "cancelled"
                            job.result = None
                        else:
                            job.status = "completed"
                            job.result = result
                        job.updated_at = time.time()
                LOGGER.info("job finished job_id=%s", job_id)
            finally:
                async with self.lock:
                    job = self.jobs.get(job_id)
                    if job is not None:
                        self._release_job_admission_locked(job)
                path.unlink(missing_ok=True)

    def _transcribe(self, path: Path) -> dict[str, Any]:
        segments_iter, info = self.model.transcribe(
            str(path),
            task="transcribe",
            vad_filter=True,
        )
        segments = []
        raw_text_parts = []
        for segment in segments_iter:
            raw_text = str(segment.text)
            text = raw_text.strip()
            raw_text_parts.append(raw_text)
            segments.append(
                {
                    "start": round(float(segment.start), 3),
                    "end": round(float(segment.end), 3),
                    "text": text,
                }
            )
        return {
            "text": "".join(raw_text_parts).strip(),
            "language": getattr(info, "language", None),
            "languageProbability": round(float(getattr(info, "language_probability", 0.0)), 4),
            "durationSeconds": round(float(getattr(info, "duration", 0.0)), 3),
            "durationAfterVadSeconds": round(float(getattr(info, "duration_after_vad", 0.0)), 3),
            "segments": segments,
        }

    async def sweep_expired(self, now: float | None = None) -> int:
        current = time.time() if now is None else now
        paths: list[Path] = []
        async with self.lock:
            expired_ids = [
                job_id
                for job_id, job in self.jobs.items()
                if job.status in TERMINAL_STATUSES
                and current - job.updated_at >= self.settings.result_ttl_seconds
            ]
            for job_id in expired_ids:
                paths.append(self.jobs.pop(job_id).path)
        for path in paths:
            path.unlink(missing_ok=True)
        if paths:
            LOGGER.info("expired jobs removed count=%d", len(paths))
        return len(paths)

    async def _cleanup_loop(self) -> None:
        while True:
            await asyncio.sleep(self.settings.cleanup_interval_seconds)
            await self.sweep_expired()

    async def diagnostics(self) -> dict[str, int]:
        async with self.lock:
            counts = {status: 0 for status in ("queued", "running", "cancelling")}
            for job in self.jobs.values():
                if job.status in counts:
                    counts[job.status] += 1
        return {
            "queuedJobs": counts["queued"],
            "runningJobs": counts["running"],
            "cancellingJobs": counts["cancelling"],
            "admittedJobs": self.admitted_jobs,
            "queueCapacity": self.settings.queue_capacity,
        }

    async def release_admission(self) -> None:
        async with self.lock:
            if self.admitted_jobs <= 0:
                raise RuntimeError("admission reservation underflow")
            self.admitted_jobs -= 1

    def _release_job_admission_locked(self, job: Job) -> None:
        if not job.admission_reserved:
            return
        if self.admitted_jobs <= 0:
            raise RuntimeError("admission reservation underflow")
        job.admission_reserved = False
        self.admitted_jobs -= 1


def create_app(
    settings: Settings | None = None,
    model_factory: Callable[..., Any] = WhisperModel,
    duration_probe: Callable[[Path, int], float] = probe_audio_duration,
) -> FastAPI:
    config = settings or Settings.from_env()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        started = time.monotonic()
        app.state.ready = False
        app.state.model = model_factory(
            config.model_name,
            device=config.device,
            compute_type=config.compute_type,
            cpu_threads=config.cpu_threads,
            num_workers=config.model_workers,
            download_root=str(config.model_directory),
            local_files_only=True,
        )
        app.state.model_load_seconds = time.monotonic() - started
        app.state.started_at = time.monotonic()
        app.state.manager = JobManager(config, app.state.model, duration_probe)
        await app.state.manager.start()
        app.state.ready = True
        try:
            yield
        finally:
            app.state.ready = False
            await app.state.manager.stop()
            app.state.model = None

    application = FastAPI(
        title="Private Whisper ASR Service",
        version=SERVICE_VERSION,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=lifespan,
    )

    async def reserve_admission() -> bool:
        return await application.state.manager.reserve_admission()

    async def release_admission() -> None:
        await application.state.manager.release_admission()

    application.add_middleware(
        RequestBodyLimitMiddleware,
        maximum_bytes=config.max_upload_bytes + MULTIPART_OVERHEAD_BYTES,
        internal_token=config.internal_token,
        reserve_admission=reserve_admission,
        release_admission=release_admission,
        upload_timeout_seconds=config.upload_timeout_seconds,
    )

    @application.exception_handler(ServiceError)
    async def service_error_handler(_request: Request, exc: ServiceError):
        return JSONResponse(
            status_code=exc.status,
            content={"ok": False, "error": {"code": exc.code, "message": exc.message}},
        )

    @application.exception_handler(RequestValidationError)
    async def validation_error_handler(_request: Request, _exc: RequestValidationError):
        return JSONResponse(
            status_code=400,
            content={
                "ok": False,
                "error": {"code": "INVALID_REQUEST", "message": "A multipart audio file is required."},
            },
        )

    async def require_internal_token(authorization: str | None = Header(default=None)) -> None:
        prefix = "Bearer "
        supplied = authorization[len(prefix):] if authorization and authorization.startswith(prefix) else ""
        if not supplied or not hmac.compare_digest(supplied, config.internal_token):
            raise ServiceError(401, "AUTH_REQUIRED", "Internal authentication is required.")

    @application.get("/health")
    async def health(request: Request):
        diagnostics = await request.app.state.manager.diagnostics()
        return {
            "status": "ready" if request.app.state.ready else "starting",
            "service": "whisper-asr",
            "version": SERVICE_VERSION,
            "model": config.model_name,
            "device": config.device,
            "computeType": config.compute_type,
            "cpuThreads": config.cpu_threads,
            "modelWorkers": config.model_workers,
            "modelLoadSeconds": round(request.app.state.model_load_seconds, 2),
            "uptimeSeconds": round(time.monotonic() - request.app.state.started_at, 2),
            **diagnostics,
        }

    @application.post("/jobs", status_code=202, dependencies=[Depends(require_internal_token)])
    async def create_job(request: Request, audio: UploadFile = File(...)):
        reservation_held = bool(request.scope.pop(ADMISSION_SCOPE_KEY, False))
        job = await request.app.state.manager.submit(audio, reservation_held=reservation_held)
        return request.app.state.manager.public_job(job)

    @application.get("/jobs/{job_id}", dependencies=[Depends(require_internal_token)])
    async def get_job(request: Request, job_id: str):
        job = await request.app.state.manager.get(job_id)
        return request.app.state.manager.public_job(job)

    @application.delete("/jobs/{job_id}", dependencies=[Depends(require_internal_token)])
    async def delete_job(request: Request, job_id: str):
        status = await request.app.state.manager.cancel_or_delete(job_id)
        return {"ok": True, "jobId": job_id, "status": status}

    return application


app = create_app()
