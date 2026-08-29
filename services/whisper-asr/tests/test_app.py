from __future__ import annotations

import asyncio
from io import BytesIO
import importlib.util
import os
from pathlib import Path
import sys
import threading
import time
from types import SimpleNamespace
import wave

import pytest
from fastapi.testclient import TestClient


os.environ.setdefault("WHISPER_INTERNAL_TOKEN", "b" * 64)
MODULE_PATH = Path(__file__).resolve().parents[1] / "app.py"
SPEC = importlib.util.spec_from_file_location("whisper_asr_app", MODULE_PATH)
assert SPEC and SPEC.loader
whisper_asr = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = whisper_asr
SPEC.loader.exec_module(whisper_asr)


TOKEN = "a" * 64
AUTH = {"Authorization": f"Bearer {TOKEN}"}


class FakeSegment:
    def __init__(self, start: float, end: float, text: str):
        self.start = start
        self.end = end
        self.text = text


class FakeModel:
    def __init__(self, *_args, **_kwargs):
        self.calls = []

    def transcribe(self, path, **kwargs):
        self.calls.append((path, kwargs))
        info = SimpleNamespace(
            language="zh",
            language_probability=0.98765,
            duration=2.5,
            duration_after_vad=2.25,
        )
        return iter(
            [FakeSegment(0, 1.25, " 你好 "), FakeSegment(1.25, 2.5, "English test ")]
        ), info


class BlockingModel(FakeModel):
    def __init__(self, *_args, **_kwargs):
        super().__init__()
        self.started = threading.Event()
        self.release = threading.Event()

    def transcribe(self, path, **kwargs):
        self.started.set()
        if not self.release.wait(timeout=5):
            raise RuntimeError("test release timed out")
        return super().transcribe(path, **kwargs)


class FailingModel(FakeModel):
    def transcribe(self, path, **kwargs):
        raise RuntimeError("sensitive decoder detail")


def settings(tmp_path: Path, **overrides):
    values = {
        "internal_token": TOKEN,
        "model_directory": tmp_path / "models",
        "job_directory": tmp_path / "jobs",
        "cleanup_interval_seconds": 3600,
    }
    values.update(overrides)
    return whisper_asr.Settings(**values)


def make_client(tmp_path: Path, model_factory=FakeModel, probe=None, **overrides):
    duration_probe = probe or (lambda _path, _maximum: 2.5)
    app = whisper_asr.create_app(
        settings(tmp_path, **overrides),
        model_factory=model_factory,
        duration_probe=duration_probe,
    )
    return TestClient(app), app


def submit(client: TestClient, content=b"audio", headers=None):
    return client.post(
        "/jobs",
        headers=AUTH if headers is None else headers,
        files={"audio": ("recording.webm", content, "audio/webm")},
    )


def wait_for_status(client: TestClient, job_id: str, expected: str, timeout=2.0):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        response = client.get(f"/jobs/{job_id}", headers=AUTH)
        assert response.status_code == 200
        last = response.json()
        if last["status"] == expected:
            return last
        time.sleep(0.01)
    pytest.fail(f"job did not reach {expected}; last response: {last}")


def test_health_is_private_safe_and_job_routes_require_token(tmp_path):
    client, _app = make_client(tmp_path)
    with client:
        health = client.get("/health")
        assert health.status_code == 200
        body = health.json()
        assert body["status"] == "ready"
        assert body["model"] == "medium"
        assert body["queueCapacity"] == 10
        assert TOKEN not in health.text

        missing = submit(client, headers={})
        assert missing.status_code == 401
        assert missing.json()["error"]["code"] == "AUTH_REQUIRED"

        wrong = submit(client, headers={"Authorization": "Bearer wrong"})
        assert wrong.status_code == 401
        assert wrong.json()["error"]["code"] == "AUTH_REQUIRED"


def test_job_completes_with_structured_transcript_and_audio_is_deleted(tmp_path):
    model = FakeModel()
    client, app = make_client(tmp_path, model_factory=lambda *_args, **_kwargs: model)
    with client:
        response = submit(client)
        assert response.status_code == 202
        job_id = response.json()["jobId"]
        completed = wait_for_status(client, job_id, "completed")
        assert completed["result"] == {
            "text": "你好 English test",
            "language": "zh",
            "languageProbability": 0.9877,
            "durationSeconds": 2.5,
            "durationAfterVadSeconds": 2.25,
            "segments": [
                {"start": 0.0, "end": 1.25, "text": "你好"},
                {"start": 1.25, "end": 2.5, "text": "English test"},
            ],
        }
        assert model.calls[0][1] == {"task": "transcribe", "vad_filter": True}
        assert list(app.state.manager.settings.job_directory.iterdir()) == []


def test_transcript_concatenation_preserves_model_spacing(tmp_path):
    class ChineseBoundaryModel(FakeModel):
        def transcribe(self, path, **kwargs):
            self.calls.append((path, kwargs))
            info = SimpleNamespace(
                language="zh",
                language_probability=1.0,
                duration=2.0,
                duration_after_vad=2.0,
            )
            return iter(
                [
                    FakeSegment(0, 0.5, "今日天氣"),
                    FakeSegment(0.5, 1.0, "非常好"),
                    FakeSegment(1.0, 1.5, "，適合測試"),
                    FakeSegment(1.5, 2.0, " English words"),
                ]
            ), info

    client, _app = make_client(tmp_path, model_factory=ChineseBoundaryModel)
    with client:
        created = submit(client)
        completed = wait_for_status(client, created.json()["jobId"], "completed")
        assert completed["result"]["text"] == "今日天氣非常好，適合測試 English words"


def test_upload_and_duration_limits_cleanup_rejected_files(tmp_path):
    client, app = make_client(tmp_path, max_upload_bytes=4)
    with client:
        exact_limit = submit(client, b"1234")
        assert exact_limit.status_code == 202
        wait_for_status(client, exact_limit.json()["jobId"], "completed")

        too_large = submit(client, b"12345")
        assert too_large.status_code == 413
        assert too_large.json()["error"]["code"] == "UPLOAD_TOO_LARGE"
        assert list(app.state.manager.settings.job_directory.iterdir()) == []

    def too_long(_path, maximum):
        raise whisper_asr.ServiceError(
            413, "AUDIO_TOO_LONG", f"Recordings must be no longer than {maximum} seconds."
        )

    client, app = make_client(tmp_path, probe=too_long)
    with client:
        response = submit(client)
        assert response.status_code == 413
        assert response.json()["error"]["code"] == "AUDIO_TOO_LONG"
        assert app.state.manager.admitted_jobs == 0
        assert list(app.state.manager.settings.job_directory.iterdir()) == []


def test_request_body_limit_rejects_before_multipart_parsing(tmp_path):
    probe_calls = 0

    def counting_probe(_path, _maximum):
        nonlocal probe_calls
        probe_calls += 1
        return 1.0

    client, _app = make_client(tmp_path, probe=counting_probe, max_upload_bytes=4)
    maximum_body = 4 + whisper_asr.MULTIPART_OVERHEAD_BYTES
    with client:
        declared_too_large = client.post(
            "/jobs",
            headers={
                **AUTH,
                "Content-Type": "multipart/form-data; boundary=test",
                "Content-Length": str(maximum_body + 1),
            },
            content=b"ignored",
        )
        assert declared_too_large.status_code == 413
        assert declared_too_large.json()["error"]["code"] == "UPLOAD_TOO_LARGE"

        boundary = "chunked-test"
        prefix = (
            f"--{boundary}\r\n"
            'Content-Disposition: form-data; name="audio"; filename="large.webm"\r\n'
            "Content-Type: audio/webm\r\n\r\n"
        ).encode()
        suffix = f"\r\n--{boundary}--\r\n".encode()
        chunked_too_large = client.post(
            "/jobs",
            headers={
                **AUTH,
                "Content-Type": f"multipart/form-data; boundary={boundary}",
                "Transfer-Encoding": "chunked",
            },
            content=iter([prefix, b"x" * maximum_body, suffix]),
        )
        assert chunked_too_large.status_code == 413
        assert chunked_too_large.json()["error"]["code"] == "UPLOAD_TOO_LARGE"
        assert probe_calls == 0


def test_queue_capacity_is_bounded(tmp_path):
    model = BlockingModel()
    client, _app = make_client(
        tmp_path,
        model_factory=lambda *_args, **_kwargs: model,
        queue_capacity=1,
    )
    with client:
        first = submit(client)
        assert first.status_code == 202
        assert model.started.wait(timeout=1)
        second = submit(client)
        assert second.status_code == 202
        third = submit(client)
        assert third.status_code == 503
        assert third.json()["error"]["code"] == "QUEUE_FULL"
        model.release.set()
        wait_for_status(client, first.json()["jobId"], "completed")
        wait_for_status(client, second.json()["jobId"], "completed")


def test_admission_is_reserved_before_bounded_duration_validation(tmp_path):
    active_probes = 0
    maximum_active_probes = 0
    probe_started = threading.Event()
    release_probes = threading.Event()
    probe_lock = threading.Lock()

    def blocking_probe(_path, _maximum):
        nonlocal active_probes, maximum_active_probes
        with probe_lock:
            active_probes += 1
            maximum_active_probes = max(maximum_active_probes, active_probes)
            if active_probes == 2:
                probe_started.set()
        if not release_probes.wait(timeout=5):
            raise RuntimeError("test probe release timed out")
        with probe_lock:
            active_probes -= 1
        return 1.0

    async def scenario():
        configured = settings(tmp_path, queue_capacity=3)
        model = BlockingModel()
        manager = whisper_asr.JobManager(configured, model, blocking_probe)
        await manager.start()
        uploads = [
            whisper_asr.UploadFile(file=BytesIO(b"audio"), filename=f"recording-{index}.webm")
            for index in range(5)
        ]
        admitted = [asyncio.create_task(manager.submit(upload)) for upload in uploads[:4]]
        for _attempt in range(100):
            if probe_started.is_set():
                break
            await asyncio.sleep(0.01)
        assert probe_started.is_set()

        with pytest.raises(whisper_asr.ServiceError) as rejected:
            await manager.submit(uploads[4])
        assert rejected.value.code == "QUEUE_FULL"
        assert manager.admitted_jobs == 4
        assert maximum_active_probes == 2

        release_probes.set()
        jobs = await asyncio.gather(*admitted)
        for _attempt in range(100):
            if model.started.is_set():
                break
            await asyncio.sleep(0.01)
        assert model.started.is_set()
        assert len(manager.pending) <= configured.queue_capacity

        model.release.set()
        for _attempt in range(200):
            if manager.admitted_jobs == 0:
                break
            await asyncio.sleep(0.01)
        assert manager.admitted_jobs == 0
        assert all(manager.jobs[job.job_id].status == "completed" for job in jobs)
        await manager.stop()

    asyncio.run(scenario())


def test_running_job_moves_through_cancelling_and_discards_result(tmp_path):
    model = BlockingModel()
    client, app = make_client(tmp_path, model_factory=lambda *_args, **_kwargs: model)
    with client:
        created = submit(client)
        job_id = created.json()["jobId"]
        assert model.started.wait(timeout=1)

        cancelled = client.delete(f"/jobs/{job_id}", headers=AUTH)
        assert cancelled.status_code == 200
        assert cancelled.json()["status"] == "cancelling"
        assert client.get(f"/jobs/{job_id}", headers=AUTH).json()["status"] == "cancelling"

        model.release.set()
        terminal = wait_for_status(client, job_id, "cancelled")
        assert "result" not in terminal
        assert list(app.state.manager.settings.job_directory.iterdir()) == []


def test_queued_job_cancels_immediately(tmp_path):
    model = BlockingModel()
    client, _app = make_client(
        tmp_path,
        model_factory=lambda *_args, **_kwargs: model,
        queue_capacity=2,
    )
    with client:
        first = submit(client)
        assert model.started.wait(timeout=1)
        queued = submit(client)
        queued_id = queued.json()["jobId"]
        response = client.delete(f"/jobs/{queued_id}", headers=AUTH)
        assert response.json()["status"] == "cancelled"
        assert client.get(f"/jobs/{queued_id}", headers=AUTH).json()["status"] == "cancelled"
        replacement = submit(client)
        assert replacement.status_code == 202
        model.release.set()
        wait_for_status(client, first.json()["jobId"], "completed")
        wait_for_status(client, replacement.json()["jobId"], "completed")


def test_failure_is_sanitized_and_terminal_delete_removes_record(tmp_path, caplog):
    client, _app = make_client(tmp_path, model_factory=FailingModel)
    with client, caplog.at_level("INFO", logger="whisper-asr"):
        created = submit(client)
        job_id = created.json()["jobId"]
        failed = wait_for_status(client, job_id, "failed")
        assert failed["error"] == {
            "code": "TRANSCRIPTION_FAILED",
            "message": "The recording could not be transcribed.",
        }
        assert "sensitive decoder detail" not in caplog.text
        deleted = client.delete(f"/jobs/{job_id}", headers=AUTH)
        assert deleted.json()["status"] == "deleted"
        missing = client.get(f"/jobs/{job_id}", headers=AUTH)
        assert missing.status_code == 404


def test_expiry_and_startup_cleanup_remove_private_files(tmp_path):
    job_directory = tmp_path / "jobs"
    job_directory.mkdir()
    stale = job_directory / "stale-upload.webm"
    stale.write_bytes(b"private audio")

    client, app = make_client(tmp_path, result_ttl_seconds=60)
    with client:
        assert not stale.exists()
        created = submit(client)
        job_id = created.json()["jobId"]
        wait_for_status(client, job_id, "completed")
        job = app.state.manager.jobs[job_id]
        assert client.portal.call(app.state.manager.sweep_expired, job.updated_at + 61) == 1
        assert client.get(f"/jobs/{job_id}", headers=AUTH).status_code == 404


def test_settings_require_token_and_validate_bounds():
    with pytest.raises(RuntimeError, match="WHISPER_INTERNAL_TOKEN is required"):
        whisper_asr.Settings.from_env({})
    with pytest.raises(RuntimeError, match="WHISPER_QUEUE_CAPACITY"):
        whisper_asr.Settings.from_env(
            {"WHISPER_INTERNAL_TOKEN": TOKEN, "WHISPER_QUEUE_CAPACITY": "0"}
        )
    for invalid_token in (
        "x",
        "A" * 64,
        "g" * 64,
        "<GENERATE_A_RANDOM_64_HEX_CHARACTER_TOKEN>",
    ):
        with pytest.raises(RuntimeError, match="64 lowercase hexadecimal"):
            whisper_asr.Settings.from_env({"WHISPER_INTERNAL_TOKEN": invalid_token})
    assert whisper_asr.Settings.from_env({"WHISPER_INTERNAL_TOKEN": TOKEN}).internal_token == TOKEN


def test_real_audio_probe_decodes_duration_and_rejects_invalid_audio(tmp_path):
    wav_path = tmp_path / "one-second.wav"
    with wave.open(str(wav_path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(8000)
        output.writeframes(b"\0\0" * 8000)
    assert whisper_asr.probe_audio_duration(wav_path, 2) == pytest.approx(1.0)

    invalid = tmp_path / "invalid.audio"
    invalid.write_bytes(b"not audio")
    with pytest.raises(whisper_asr.ServiceError) as error:
        whisper_asr.probe_audio_duration(invalid, 60)
    assert error.value.code == "INVALID_AUDIO"
