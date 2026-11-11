"""
Lokal o'zbek STT servisi (Doniyor'ning GigaAM s1 + tinish belgisi modeli).

  stt/.venv/bin/python stt/serve.py            # odatda: cd harness && npm run stt:start
  stt/.venv/bin/python stt/serve.py --self-test

- FAQAT 127.0.0.1 da tinglaydi (0.0.0.0 EMAS). Port: STT_PORT (default 5190).
- Model BIR MARTA yuklanadi, keyin "isitish" chaqiruvi (birinchi GPU chaqiruvi sekin).
- POST /transcribe — tana: xom audio baytlar (webm/opus/wav/mp3/ogg ...);
  ffmpeg bilan 16 kHz mono WAV ga o'tkaziladi.
  Javob: {"text", "raw", "punctuated", "duration_s", "stt_ms", "model", "device"}.
- GET /health — {"ok", "model", "device", "load_s"}.
- So'rovlar BITTADAN (lock) bajariladi.
- Tarmoq yopiq (HF_HUB_OFFLINE); kesh va vaqtinchalik fayllar stt/ ICHIDA.
- Checkpoint: torch.load(weights_only=True).

Matn: paketning tinish belgisi bosqichi (gigaam_local.norm) raqam, kirill
harflari va belgilarni O'CHIRADI. Shuning uchun tinish belgisi faqat xom matnda
norm() o'chiradigan belgi BO'LMAGANDA qo'llanadi; aks holda xom matn qaytadi.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.join(HERE, "doniyor-model")
TMP = os.path.join(HERE, ".tmp")
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
os.environ["HF_HOME"] = os.path.join(HERE, ".hf-cache")
# CUDA/torch JIT keshlari ham stt/ ichida.
os.environ.setdefault("CUDA_CACHE_PATH", os.path.join(HERE, ".cuda-cache"))
os.environ.setdefault("TORCHINDUCTOR_CACHE_DIR", os.path.join(HERE, ".torch-cache"))

import argparse  # noqa: E402
import json  # noqa: E402
import re  # noqa: E402
import subprocess  # noqa: E402
import tempfile  # noqa: E402
import threading  # noqa: E402
import time  # noqa: E402
import types  # noqa: E402
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer  # noqa: E402

HOST = "127.0.0.1"
MAX_BYTES = 25 * 1024 * 1024
MODEL_NAME = "gigaam-s1"

# norm() bilan bir xil qoida: apostrof turlari ' ga, keyin [a-z' ] dan boshqasi o'chadi.
_APOS = "ʻʼ’‘`´"
_STRIPPED = re.compile(r"[^a-z' \s]")


def norm_would_strip(text: str) -> list:
    """norm() O'CHIRADIGAN belgilar (takrorsiz). Bo'sh ro'yxat — tinish belgisi xavfsiz."""
    t = text.lower()
    for a in _APOS:
        t = t.replace(a, "'")
    return sorted(set(_STRIPPED.findall(t)))


def safe_text(raw: str, punctuate) -> dict:
    """Miya uchun eng xavfsiz matn: tinish belgisi faqat hech narsa yo'qolmasa."""
    raw = raw.strip()
    lost = norm_would_strip(raw)
    if not raw:
        return {"text": "", "raw": "", "punctuated": False, "stripped_chars": []}
    if lost:
        return {"text": raw, "raw": raw, "punctuated": False, "stripped_chars": lost}
    return {"text": punctuate(raw), "raw": raw, "punctuated": True, "stripped_chars": []}


def self_test() -> None:
    fake = lambda s: s.capitalize() + "."  # noqa: E731
    cases = [
        ("assalomu alaykum o'quv markazi", True),
        ("narxi 690 ming", False),            # raqam
        ("ha заявка qoldirgansiz", False),    # kirill
        ("o‘g‘il maʼlumot", True),            # apostrof turlari — saqlanadi
        ("soat 9:00 da", False),              # raqam + belgi
        ("", False),
    ]
    for text, ok in cases:
        r = safe_text(text, fake)
        assert r["punctuated"] == ok, (text, r)
        if not ok and text:
            assert r["text"] == text.strip(), (text, r)  # xom matn O'ZGARMAYDI
    print("self-test: OK (%d holat)" % len(cases))


class Engine:
    def __init__(self, device: str, model: str):
        sys.path.insert(0, PKG)
        # pyannote o'rnatilmaydi (diarizatsiya kerak emas). transformers modul
        # faylidagi import qatorini statik tekshiradi — bo'sh modul bilan o'tamiz.
        # Haqiqiy chaqiruv (transcribe_longform/VAD) bo'lsa — aniq xato chiqadi.
        sys.modules.setdefault("pyannote", types.ModuleType("pyannote"))
        import torch
        from transformers import AutoModel, AutoModelForTokenClassification, AutoTokenizer

        import gigaam_local as G

        if device == "auto":
            device = "cuda" if torch.cuda.is_available() else "cpu"
        if device == "cuda" and not torch.cuda.is_available():
            raise SystemExit("STT_DEVICE=cuda, lekin CUDA mavjud emas (CPU uchun: STT_DEVICE=cpu)")
        self.torch, self.G, self.device = torch, G, device
        G.DEV = device  # paketning punctuate() shu globalni ishlatadi

        t0 = time.perf_counter()
        m = AutoModel.from_pretrained(os.path.join(PKG, "base_model"), trust_remote_code=True)
        pth = os.path.join(PKG, "weights", "gigaam_%s.pt" % model)
        ck = torch.load(pth, map_location="cpu", weights_only=True)
        sd = ck["model"] if isinstance(ck, dict) and "model" in ck else ck
        sd = {(k[6:] if k.startswith("model.") else k): v for k, v in sd.items()}
        r = m.model.load_state_dict(sd, strict=False)
        if r.missing_keys:
            raise SystemExit("%s: %d ta kalit yetishmaydi" % (pth, len(r.missing_keys)))
        self.m = m.to(device).eval()
        self.tok = AutoTokenizer.from_pretrained(os.path.join(PKG, "punct_model"))
        self.pm = AutoModelForTokenClassification.from_pretrained(os.path.join(PKG, "punct_model")).to(device).eval()
        self.load_s = round(time.perf_counter() - t0, 2)
        self.lock = threading.Lock()

    def _sync(self) -> None:
        if self.device == "cuda":
            self.torch.cuda.synchronize()

    def transcribe_bytes(self, data: bytes) -> dict:
        os.makedirs(TMP, exist_ok=True)
        with self.lock, tempfile.TemporaryDirectory(dir=TMP) as d:
            src = os.path.join(d, "in.bin")
            wav = os.path.join(d, "in.wav")
            with open(src, "wb") as fh:
                fh.write(data)
            try:
                subprocess.run(
                    ["ffmpeg", "-nostdin", "-y", "-loglevel", "error", "-i", src, "-ar", "16000", "-ac", "1", wav],
                    check=True,
                    capture_output=True,
                    timeout=60,
                )
            except FileNotFoundError:
                raise RuntimeError("ffmpeg topilmadi (o'rnating: sudo apt install ffmpeg)")
            except subprocess.CalledProcessError as e:
                raise ValueError("audio o'qilmadi (ffmpeg): %s" % e.stderr.decode(errors="replace")[:200])
            import soundfile as sf

            info = sf.info(wav)
            duration = info.frames / info.samplerate
            self._sync()
            t0 = time.perf_counter()
            raw = self.G.asr(self.m, wav)  # 24 s dan uzun — paketning o'zi bo'laklaydi
            out = safe_text(raw, lambda s: self.G.punctuate(s, self.tok, self.pm))
            self._sync()
            stt_ms = round((time.perf_counter() - t0) * 1000)
        out.update({"duration_s": round(duration, 2), "stt_ms": stt_ms, "model": MODEL_NAME, "device": self.device})
        return out

    def warm_up(self) -> float:
        """Birinchi chaqiruv (ayniqsa GPU) sekin — startda bir marta bajaramiz."""
        import io

        import numpy as np
        import soundfile as sf

        buf = io.BytesIO()
        t = np.linspace(0, 2.0, 32000, endpoint=False)
        sf.write(buf, (0.05 * np.sin(2 * np.pi * 220 * t)).astype("float32"), 16000, format="WAV")
        t0 = time.perf_counter()
        self.transcribe_bytes(buf.getvalue())
        return round(time.perf_counter() - t0, 2)


def make_handler(engine: Engine):
    class Handler(BaseHTTPRequestHandler):
        server_version = "doniyor-stt/1"

        def _json(self, code: int, obj: dict) -> None:
            body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):  # noqa: N802
            if self.path.split("?")[0] == "/health":
                self._json(200, {"ok": True, "model": MODEL_NAME, "device": engine.device, "load_s": engine.load_s})
            else:
                self._json(404, {"error": "topilmadi"})

        def do_POST(self):  # noqa: N802
            if self.path.split("?")[0] != "/transcribe":
                return self._json(404, {"error": "topilmadi"})
            n = int(self.headers.get("Content-Length") or 0)
            if n <= 0:
                return self._json(400, {"error": "bo'sh audio"})
            if n > MAX_BYTES:
                return self._json(413, {"error": "audio juda katta (%d MB dan oshmasin)" % (MAX_BYTES // 2**20)})
            data = self.rfile.read(n)
            try:
                return self._json(200, engine.transcribe_bytes(data))
            except ValueError as e:
                return self._json(400, {"error": str(e)})
            except Exception as e:  # noqa: BLE001
                return self._json(500, {"error": "%s: %s" % (type(e).__name__, str(e)[:300])})

        def log_message(self, fmt, *args):  # qisqa log (audio/matn chiqmaydi)
            sys.stderr.write("[stt] %s %s\n" % (self.address_string(), fmt % args))

    return Handler


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--self-test", action="store_true", help="matn qoidasini modelsiz tekshiradi")
    ap.add_argument("--port", type=int, default=int(os.environ.get("STT_PORT", "5190")))
    ap.add_argument("--device", default=os.environ.get("STT_DEVICE", "auto"), choices=["auto", "cpu", "cuda"])
    ap.add_argument("--model", default=os.environ.get("STT_MODEL", "s1"))
    a = ap.parse_args()
    if a.self_test:
        return self_test()

    print("[stt] model yuklanmoqda (%s, qurilma=%s) ..." % (a.model, a.device), flush=True)
    engine = Engine(a.device, a.model)
    print("[stt] yuklandi: %.2f s · qurilma=%s" % (engine.load_s, engine.device), flush=True)
    print("[stt] isitish: %.2f s" % engine.warm_up(), flush=True)
    srv = ThreadingHTTPServer((HOST, a.port), make_handler(engine))
    print("[stt] tayyor: http://%s:%d  (POST /transcribe, GET /health)" % (HOST, a.port), flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()


if __name__ == "__main__":
    main()
