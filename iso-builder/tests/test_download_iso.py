"""download-iso.sh: GHCR flow against a fake curl (no network)."""

import hashlib
import json
import os
import stat
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "download-iso.sh"
ISO = "claudeos-26.04.1-amd64.iso"


def _fake_curl(bindir: Path, payload: bytes, sha_line: bytes, good_digest: bool = True) -> None:
    digest = "sha256:" + hashlib.sha256(payload).hexdigest()
    if not good_digest:
        digest = "sha256:" + "0" * 64
    sum_digest = "sha256:" + hashlib.sha256(sha_line).hexdigest()
    manifest = {
        "layers": [
            {"digest": digest, "annotations": {"org.opencontainers.image.title": ISO}},
            {"digest": sum_digest, "annotations": {"org.opencontainers.image.title": ISO + ".sha256"}},
        ]
    }
    (bindir / "payload.bin").write_bytes(payload)
    (bindir / "sha.txt").write_bytes(sha_line)
    (bindir / "manifest.json").write_text(json.dumps(manifest))
    curl = bindir / "curl"
    curl.write_text(
        f"""#!/usr/bin/env bash
args=("$@"); out=""; url=""
for ((i=0;i<${{#args[@]}};i++)); do
  [ "${{args[i]}}" = "-o" ] && out="${{args[i+1]}}"
  case "${{args[i]}}" in http*) url="${{args[i]}}" ;; esac
done
case "$url" in
  *ghcr.io/token*) echo '{{"token":"t"}}' ;;
  */manifests/*) cat "{bindir}/manifest.json" ;;
  */blobs/{sum_digest}) cat "{bindir}/sha.txt" > "$out" ;;
  */blobs/*) cat "{bindir}/payload.bin" > "$out" ;;
  *) echo "unexpected url $url" >&2; exit 22 ;;
esac
"""
    )
    curl.chmod(curl.stat().st_mode | stat.S_IEXEC)


def _run(tmp_path: Path, *extra: str) -> subprocess.CompletedProcess:
    env = {**os.environ, "PATH": f"{tmp_path / 'bin'}:{os.environ['PATH']}"}
    return subprocess.run(
        ["bash", str(SCRIPT), "--repo", "Owner/ClaudeOS", "--out", str(tmp_path / "out"), *extra],
        capture_output=True, text=True, env=env, check=False,
    )


def test_ghcr_download_verifies_and_writes_iso(tmp_path):
    (tmp_path / "bin").mkdir()
    payload = os.urandom(4096)
    sha_line = f"{hashlib.sha256(payload).hexdigest()}  {ISO}\n".encode()
    _fake_curl(tmp_path / "bin", payload, sha_line)
    r = _run(tmp_path)
    assert r.returncode == 0, r.stderr + r.stdout
    assert (tmp_path / "out" / ISO).read_bytes() == payload
    assert "OK:" in r.stdout


def test_ghcr_digest_mismatch_fails(tmp_path):
    (tmp_path / "bin").mkdir()
    payload = os.urandom(1024)
    _fake_curl(tmp_path / "bin", payload, b"x  y\n", good_digest=False)
    r = _run(tmp_path)
    assert r.returncode != 0
    assert "digest mismatch" in r.stderr


def test_rejects_bad_arguments(tmp_path):
    (tmp_path / "bin").mkdir()
    assert _run(tmp_path, "--version", "1;rm").returncode != 0
    assert _run(tmp_path, "--source", "carrier-pigeon").returncode != 0
    r = subprocess.run(["bash", str(SCRIPT), "--help"], capture_output=True, text=True, check=False)
    assert r.returncode == 0 and "ghcr" in r.stdout
