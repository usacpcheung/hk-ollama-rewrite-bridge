#!/usr/bin/env bash
# Run the verified copy from a root-owned release record during maintenance.
set -euo pipefail
export LC_ALL=C
umask 077
app=/opt/hk-ollama-rewrite-bridge
unit=rewrite-bridge.service
envfile=/etc/default/rewrite-bridge
record=$(cd "$(dirname "$0")" && pwd -P)
[[ $EUID == 0 && $record == /var/backups/rewrite-bridge/pr150-* ]]
[[ $(stat -c '%u:%a' "$record") == 0:700 ]]
cd "$record"
exec 9>/run/rewrite-bridge-acceptance.lock
flock -n 9 || { echo 'STOP: another acceptance operation is active.'; exit 1; }

g() { git -c safe.directory="$app" -C "$app" "$@"; }
base=$(cat baseline)
head=$(cat candidate)
[[ $base =~ ^[0-9a-f]{40}$ && $head =~ ^[0-9a-f]{40}$ ]]
g merge-base --is-ancestor "$base" "$head"
g diff --quiet "$base" "$head" -- package.json package-lock.json
[[ -z $(g status --porcelain) ]]

# Replace the environment atomically with the original file's owner and mode.
use_env() {
  local tmp
  tmp=$(mktemp -- "${envfile}.pr150.XXXXXXXX")
  if cp --preserve=mode,ownership -- "$1" "$tmp" && mv -T -- "$tmp" "$envfile"; then return 0; fi
  rm -f -- "$tmp"
  return 1
}
ready() {
  python3 -I - "$1" "$app" "${2:-any}" <<'PY'
import json, pathlib, subprocess, sys, time, urllib.request
expected, app, hint = sys.argv[1:]
client = urllib.request.build_opener(urllib.request.ProxyHandler({}))
for _ in range(45):
    try:
        with client.open('http://127.0.0.1:3001/healthz', timeout=1) as r:
            assert json.load(r)['ok'] is True
        with client.open('http://127.0.0.1:3001/readyz', timeout=1) as r:
            ready = json.load(r)
            assert ready['ok'] is True and ready['serviceState'] == 'ready'
        pid = subprocess.check_output(['systemctl','show','rewrite-bridge.service','-p','MainPID','--value'], text=True).strip()
        proc = pathlib.Path('/proc', pid)
        assert (proc/'cwd').resolve() == pathlib.Path(app)
        listeners = subprocess.check_output(['ss','-H','-ltnp','sport = :3001'],text=True).splitlines()
        assert len(listeners) == 1 and '127.0.0.1:3001' in listeners[0] and f'pid={pid},' in listeners[0]
        env = dict(i.split(b'=',1) for i in (proc/'environ').read_bytes().split(b'\0') if b'=' in i)
        assert env.get(b'TRANSCRIPTION_ENABLED',b'').lower() in (b'true', b'1')
        assert env.get(b'TRANSCRIPTION_PROVIDER',b'google-speech') == expected.encode()
        assert env.get(b'TRANSCRIPTION_GOOGLE_PROJECT') == b'worksheet-chirp-test'
        assert env.get(b'REWRITE_PROVIDER') == env.get(b'T2A_PROVIDER') == b'google-gemini'
        if expected == 'google-gemini':
            assert env.get(b'TRANSCRIPTION_GEMINI_MODEL',b'gemini-3.5-transcribe') == b'gemini-3.5-transcribe'
            if hint != 'any':
                assert env.get(b'TRANSCRIPTION_GEMINI_LANGUAGE_HINT', b'').decode() == ('' if hint == 'auto' else hint)
                print('PASS: Gemini language hint =', hint)
        print('PASS: healthy, ready, transcription provider =', expected)
        sys.exit(0)
    except (OSError, ValueError, KeyError, AssertionError, subprocess.SubprocessError):
        time.sleep(1)
sys.exit('FAIL: running process, provider or HTTP readiness check.')
PY
}
rollback() {
  (sha256sum --status -c SHA256SUMS) || return 1
  local current
  current=$(g rev-parse HEAD)
  [[ $current == "$head" || $current == "$base" ]] || return 1
  cmp -s original.env "$envfile" || cmp -s trial.env "$envfile" || {
    echo 'STOP: configuration changed outside this trial. Inspect privately before restoring.'
    return 1
  }
  systemctl stop "$unit" || return 1
  use_env original.env || return 1
  local branch
  branch=$(cat original-branch)
  if [[ -n $branch && $(g rev-parse --verify "refs/heads/$branch") == "$base" ]]; then
    (umask 022; g switch "$branch") || return 1
  else
    (umask 022; g switch --detach "$base") || return 1
  fi
  systemctl start "$unit" || return 1
  if [[ -f hint-upgrade ]]; then ready google-gemini auto; else ready google-speech; fi
}
failed() {
  local rc=$?
  trap - EXIT
  if (( rc != 0 )); then
    echo "Trial step failed; restoring previous release from $record."
    rollback || echo 'ROLLBACK FAILED: keep maintenance active and inspect the service.'
  fi
  exit "$rc"
}

case ${1:-} in
  install|install-hint)
    [[ $(g rev-parse HEAD) == "$base" && ! -e SHA256SUMS && ! -e hint-upgrade && -f $envfile && ! -L $envfile ]]
    if [[ $1 == install-hint ]]; then ready google-gemini auto; else ready google-speech; fi
    g branch --show-current >original-branch
    cp --preserve=mode,ownership "$envfile" original.env
    cp --preserve=mode,ownership "$envfile" trial.env
    if [[ $1 == install-hint ]]; then
      # This upgrade starts on the previous trial's Gemini / auto snapshot.
      if grep -Eq '^[[:space:]]*TRANSCRIPTION_GEMINI_LANGUAGE_HINT[[:space:]]*=' original.env; then
        echo 'STOP: existing language hint assignment. Review the original configuration.'
        exit 1
      fi
      printf '\nTRANSCRIPTION_GEMINI_LANGUAGE_HINT=yue-Hant-HK\n' >>trial.env
      printf '%s\n' 'google-gemini/auto' >hint-upgrade
    else
      python3 -I - <<'PY'
from pathlib import Path
import re
p = Path('trial.env')
data = p.read_bytes()
pattern = rb'(?m)^[ \t]*TRANSCRIPTION_PROVIDER[ \t]*=.*$'
matches = re.findall(pattern, data)
if len(matches) > 1 or (matches and matches[0].rstrip().endswith(b'\\')):
    raise SystemExit('STOP: review complex provider assignment privately.')
line = b'TRANSCRIPTION_PROVIDER=google-gemini'
p.write_bytes(re.sub(pattern, line, data) if matches else data + b'\n' + line + b'\n')
PY
    fi
    sha256sum original.env trial.env baseline candidate original-branch >SHA256SUMS
    if [[ $1 == install-hint ]]; then sha256sum hint-upgrade >>SHA256SUMS; fi
    sha256sum --status -c SHA256SUMS
    trap failed EXIT
    systemctl stop "$unit"
    (umask 022; g switch --detach "$head")
    if [[ $1 == install-hint ]]; then use_env trial.env; fi
    systemctl start "$unit"
    if [[ $1 == install-hint ]]; then ready google-gemini yue-Hant-HK; else ready google-speech; fi
    ;;
  gemini|chirp|auto|hint)
    [[ $(g rev-parse HEAD) == "$head" ]]
    sha256sum --status -c SHA256SUMS
    expected_hint=any
    if [[ -f hint-upgrade ]]; then
      provider=google-gemini
      case $1 in
        auto) cmp -s "$envfile" trial.env; source_env=original.env; expected_hint=auto ;;
        hint) cmp -s "$envfile" original.env; source_env=trial.env; expected_hint=yue-Hant-HK ;;
        *) echo 'Use auto, hint, or rollback for this hint trial.'; exit 2 ;;
      esac
    elif [[ $1 == gemini ]]; then
      cmp -s "$envfile" original.env
      source_env=trial.env; provider=google-gemini
    elif [[ $1 == chirp ]]; then
      cmp -s "$envfile" trial.env
      source_env=original.env; provider=google-speech
    else echo "Use gemini or chirp for this provider trial."; exit 2; fi
    trap failed EXIT
    use_env "$source_env"
    systemctl restart "$unit"
    ready "$provider" "$expected_hint"
    ;;
  smoke|smoke-notebook)
    [[ $(g rev-parse HEAD) == "$head" ]]
    sha256sum --status -c SHA256SUMS
    expected_hint=any
    if [[ -f hint-upgrade ]]; then
      provider=google-gemini
      if cmp -s original.env "$envfile"; then expected_hint=auto
      else cmp -s trial.env "$envfile"; expected_hint=yue-Hant-HK; fi
    elif cmp -s original.env "$envfile"; then provider=google-speech
    else cmp -s trial.env "$envfile"; provider=google-gemini; fi
    ready "$provider" "$expected_hint"
    python3 -I - "${2:?Supply an allowed worksheet email}" "$1" <<'PY'
import http.client, json, pathlib, secrets, subprocess, sys
email = sys.argv[1]
if not email.isascii() or any(c.isspace() or c == ',' for c in email):
    sys.exit('Invalid email.')
if sys.argv[2] == 'smoke-notebook':
    audio, filename, mime = pathlib.Path('notebook-audio'), 'notebook.wav', 'audio/wav'
else:
    audio = pathlib.Path('/root/bridge-acceptance-inputs/acceptance-speech.m4a')
    filename, mime = 'test.m4a', 'audio/mp4'
if not 0 < audio.stat().st_size < 2 * 1024 * 1024:
    sys.exit('Unexpected acceptance recording size.')
pid = subprocess.check_output(['systemctl','show','rewrite-bridge.service','-p','MainPID','--value'],text=True).strip()
env = dict(i.split(b'=',1) for i in pathlib.Path('/proc',pid,'environ').read_bytes().split(b'\0') if b'=' in i)
boundary = secrets.token_hex(20)
body = (f'--{boundary}\r\nContent-Disposition: form-data; name="audio"; filename="{filename}"\r\n'
        f'Content-Type: {mime}\r\n\r\n').encode() + audio.read_bytes() + f'\r\n--{boundary}--\r\n'.encode()
conn = http.client.HTTPConnection('127.0.0.1',3001,timeout=190)
print('START one paid transcription through the running bridge',flush=True)
conn.request('POST','/api/transcriptions',body,headers={
    'Content-Type': 'multipart/form-data; boundary='+boundary,
    'X-Bridge-Auth':env[b'BRIDGE_INTERNAL_AUTH_SECRET'].decode().strip(),'X-Authenticated-Email':email})
response = conn.getresponse()
result = json.loads(response.read(1024 * 1024))
if response.status != 200 or result.get('ok') is not True or not isinstance(result.get('result'),str) or not result['result'].strip():
    sys.exit(f'FAIL: HTTP {response.status}; keep maintenance active.')
print('PASS: transcript for the acceptance recording:', result['result'])
print('Timings (ms):', result.get('timings'))
PY
    ;;
  rollback) rollback ;;
  *) echo 'Use install, install-hint, gemini, chirp, auto, hint, smoke EMAIL, smoke-notebook EMAIL, or rollback.'; exit 2 ;;
esac
