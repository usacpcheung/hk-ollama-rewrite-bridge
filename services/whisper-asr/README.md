# Private Faster Whisper ASR companion service

This directory is the source of truth for the private transcription daemon used by
`hk-ollama-rewrite-bridge`. It is not a public API. It listens only on
`127.0.0.1:8020`; the Node bridge will own browser authentication, per-user limits,
job ownership and public responses.

## Production profile

| Setting | Value |
|---|---|
| Model | `medium` |
| Device / compute | CPU / int8 |
| CPU threads | 4 |
| Model and application workers | 1 each |
| Waiting queue | 10 jobs |
| Upload / duration limits | 20 MiB / 60 decoded seconds |
| Terminal-result lifetime | 30 minutes |
| Recognition | `task=transcribe`, automatic language detection, VAD enabled |

Do not force `language=yue`: mixed Cantonese/English testing was more faithful with
automatic detection. Do not run multiple Uvicorn workers; each would load another
model and create a separate in-memory job store.

## Internal API

`GET /health` is token-free for local monitoring. `POST /jobs`, `GET /jobs/{jobId}`
and `DELETE /jobs/{jobId}` require `Authorization: Bearer <WHISPER_INTERNAL_TOKEN>`.
Create requests use multipart field `audio` and return `202` with a UUID.

Statuses are `queued`, `running`, `cancelling`, `completed`, `failed`, and
`cancelled`. Completed jobs contain the combined text, detected language, durations
and timestamped segments. Failures expose stable errors but not decoder internals.

Cancellation is best-effort and asynchronous. A queued job is cancelled and cleaned
immediately. A running job becomes `cancelling`; native inference finishes privately,
its output is discarded, audio is deleted, then the job becomes `cancelled`. A
terminal job is deleted immediately.

## Privacy and cleanup

- Audio and transcript contents are never logged.
- Uploads have random names in a mode-`0700` runtime directory.
- Audio is removed after success, failure or completed cancellation.
- Terminal in-memory results expire after 30 minutes.
- Files left by a crash are removed at startup.
- Restarting intentionally loses all in-memory job state.

## Tests

Tests inject a fake model and never load or download model weights.

```bash
cd services/whisper-asr
python3 -m venv .venv
. .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements-test.txt
pytest -q
```

## Manual Ubuntu/Debian deployment

Review every path before running these adaptable examples. Proceed one checkpoint at
a time and stop when verification fails.

### 1. Prerequisites and ownership

```bash
sudo apt update
sudo apt install -y python3 python3-venv python3-pip curl jq openssl
getent passwd whisper-asr || sudo useradd --system \
  --home-dir /var/lib/whisper-asr --create-home \
  --shell /usr/sbin/nologin whisper-asr
sudo install -d -o root -g root -m 0755 /opt/whisper-asr
sudo install -d -o whisper-asr -g whisper-asr -m 0750 /var/lib/whisper-asr
sudo install -d -o whisper-asr -g whisper-asr -m 0750 /var/lib/whisper-asr/models
sudo install -d -o whisper-asr -g whisper-asr -m 0700 /var/lib/whisper-asr/jobs
```

Program files under `/opt` are root-owned/read-only to the daemon. Models, uploads and
runtime data under `/var/lib` are owned by `whisper-asr`.

### 2. Deploy reviewed source and pinned dependencies

From the reviewed repository checkout:

```bash
sudo install -o root -g root -m 0644 services/whisper-asr/app.py /opt/whisper-asr/app.py
sudo install -o root -g root -m 0644 services/whisper-asr/requirements.txt /opt/whisper-asr/requirements.txt
sudo python3 -m venv /opt/whisper-asr/.venv
sudo /opt/whisper-asr/.venv/bin/python -m pip install --upgrade pip
sudo /opt/whisper-asr/.venv/bin/python -m pip install -r /opt/whisper-asr/requirements.txt
sudo chown -R root:root /opt/whisper-asr
sudo chmod -R go-w /opt/whisper-asr
```

Verify versions:

```bash
/opt/whisper-asr/.venv/bin/python -m pip freeze | \
  grep -Ei '^(faster-whisper|ctranslate2|fastapi|uvicorn|onnxruntime|python-multipart|av)=='
```

Never upgrade production automatically. Change pins only after deliberate accuracy,
latency, memory and load tests.

### 3. Model download and offline proof

Download during a controlled network-enabled step, outside the repository:

```bash
sudo -u whisper-asr env HF_HOME=/var/lib/whisper-asr/.cache/huggingface \
  /opt/whisper-asr/.venv/bin/python -c \
  'from faster_whisper import WhisperModel; WhisperModel("medium", device="cpu", compute_type="int8", cpu_threads=4, num_workers=1, download_root="/var/lib/whisper-asr/models")'
```

Then prove offline loading:

```bash
sudo -u whisper-asr env HF_HOME=/var/lib/whisper-asr/.cache/huggingface \
  HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
  /opt/whisper-asr/.venv/bin/python -c \
  'from faster_whisper import WhisperModel; WhisperModel("medium", device="cpu", compute_type="int8", cpu_threads=4, num_workers=1, download_root="/var/lib/whisper-asr/models", local_files_only=True); print("offline model load passed")'
```

### 4. Private configuration

Generate the token on the server without displaying it:

```bash
whisper_env_tmp="$(mktemp)"
printf '%s' 'WHISPER_INTERNAL_TOKEN=' > "$whisper_env_tmp"
openssl rand -hex 32 >> "$whisper_env_tmp"
grep -v '^WHISPER_INTERNAL_TOKEN=' services/whisper-asr/whisper-asr.env.example >> "$whisper_env_tmp"
sudo install -o root -g root -m 0600 "$whisper_env_tmp" /etc/default/whisper-asr
rm -f "$whisper_env_tmp"
```

The Node bridge will later receive the same token through its root-owned configuration.
Never send it to a browser or commit the real environment file.

### 5. Install systemd

```bash
sudo install -o root -g root -m 0644 \
  services/whisper-asr/systemd/whisper-asr.service \
  /etc/systemd/system/whisper-asr.service
sudo systemd-analyze verify /etc/systemd/system/whisper-asr.service
sudo systemctl daemon-reload
sudo systemctl enable whisper-asr.service
sudo systemctl restart whisper-asr.service
sudo systemctl status whisper-asr.service --no-pager -l
sudo ss -ltnp | grep -E '(:8020[[:space:]])'
curl -i -sS --max-time 10 http://127.0.0.1:8020/health
```

The listener must be exactly `127.0.0.1:8020`, never a public address.

### 6. Authentication, transcription, queue and cleanup tests

Load the token without printing it:

```bash
whisper_token="$(sudo sed -n 's/^WHISPER_INTERNAL_TOKEN=//p' /etc/default/whisper-asr)"
```

Confirm an unauthenticated request fails, then submit non-sensitive test audio:

```bash
curl -i -sS http://127.0.0.1:8020/jobs
curl -sS http://127.0.0.1:8020/jobs \
  -H "Authorization: Bearer $whisper_token" \
  -F 'audio=@/path/to/non-sensitive-test.m4a' | jq
read -r -p 'Job UUID: ' whisper_job_id
curl -sS "http://127.0.0.1:8020/jobs/$whisper_job_id" \
  -H "Authorization: Bearer $whisper_token" | jq
```

Submit two jobs close together and observe `running`/`queued`. Test queued and running
cancellation. Also test invalid audio, a file over 20 MiB, audio over 60 seconds and
queue saturation. Expected failures are controlled `4xx` or `503` JSON responses.
After terminal states, verify cleanup:

```bash
sudo find /var/lib/whisper-asr/jobs -maxdepth 1 -type f -ls
```

Run a quiet-speech/long-pause VAD safety recording before general release.

### 7. Logging and privacy

```bash
sudo journalctl -u whisper-asr.service --since '30 minutes ago' --no-pager
```

Logs may contain UUIDs, byte counts, state and exception class names. They must not
contain filenames, audio, transcript text, tokens or decoder details. Configure an
appropriate journald retention policy. Remove acceptance-test recordings when testing
is complete.

## Update and rollback

Before updating, preserve the last working source, pins, unit and secret configuration
in a root-only directory. Do not duplicate recordings or models unnecessarily.

```bash
sudo install -d -o root -g root -m 0700 /root/whisper-asr-backup
sudo cp -a /opt/whisper-asr/app.py /opt/whisper-asr/requirements.txt /root/whisper-asr-backup/
sudo cp -a /etc/systemd/system/whisper-asr.service /root/whisper-asr-backup/
sudo cp -a /etc/default/whisper-asr /root/whisper-asr-backup/
```

Deploy reviewed files, rebuild the pinned environment only when needed, restart and
repeat acceptance tests. Rollback restores those files, rebuilds from the old pins if
needed, runs `systemctl daemon-reload`, and restarts the daemon.

## Removal

Removal is destructive. After confirming exact paths and retention obligations:

```bash
sudo systemctl disable --now whisper-asr.service
sudo rm /etc/systemd/system/whisper-asr.service
sudo systemctl daemon-reload
sudo rm -r /opt/whisper-asr
sudo rm -r /var/lib/whisper-asr
sudo rm /etc/default/whisper-asr
sudo userdel whisper-asr
```

Deleted recordings, models and results are unrecoverable without a separate backup.

## Never commit

Do not commit virtual environments, models, caches, real environment files or tokens,
recordings, temporary jobs, or real transcripts. `.gitignore` provides additional
defence, but does not replace deployment discipline.
