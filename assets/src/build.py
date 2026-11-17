"""Render the README images and the demo video from the fixture server.

Run from the repo root:  python3 assets/src/build.py
Needs Google Chrome and ffmpeg. Starts assets/src/serve.mjs if it is not running.
"""
import subprocess, time, urllib.parse, urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ASSETS = HERE.parent
FRAMES = HERE / "frames"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
BASE = "http://127.0.0.1:47900"

# (file, page, width, height)
STILLS = [
    ("hero.png", "/pages/hero.html", 1280, 720),
    ("anatomy.png", "/pages/anatomy.html", 1280, 560),
    ("pace.png", "/pages/pace.html", 1280, 360),
]
# Video frames: (stage, flags, caption). Also saved as README stills where named.
STEPS = [
    ("idle", {}, "The HUD sits <em>above your prompt box.</em>"),
    ("plan", {}, "Send a task. The main agent <em>starts planning.</em>"),
    ("build", {}, "Each helper agent gets <em>its own element.</em>"),
    ("build", {"expand": 1}, "Click the arrow to see <em>every agent and quota.</em>"),
    ("review", {"expand": 1}, "A Claude reviewer joins as a <em>guest element.</em>"),
    ("done", {}, "The bar stays green while your quota <em>outruns the clock.</em>"),
    ("done", {"mini": 1}, "Need room? Minimize it to a <em>quota dial.</em>"),
    ("build", {"panel": 1}, "Want the full view? Open the <em>side panel.</em>"),
]
NAMED = {3: "hud-expanded.png", 7: "panel.png"}


def server_up():
    try:
        urllib.request.urlopen(BASE + "/__stage", timeout=1)
        return True
    except OSError:
        return False


def shot(url, out, w, h):
    subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars",
                    "--force-dark-mode", "--force-device-scale-factor=1",
                    f"--window-size={w},{h}", "--virtual-time-budget=6000",
                    f"--screenshot={out}", url],
                   check=True, capture_output=True)
    print("wrote", out.relative_to(ASSETS.parent))


def main():
    proc = None
    if not server_up():
        proc = subprocess.Popen(["node", str(HERE / "serve.mjs")])
        time.sleep(1)
    try:
        FRAMES.mkdir(exist_ok=True)
        for name, page, w, h in STILLS:
            shot(BASE + page, ASSETS / name, w, h)
        for i, (stage, flags, cap) in enumerate(STEPS):
            q = {"stage": stage, "step": i + 1, "cap": cap, **flags}
            out = FRAMES / f"{i:02d}.png"
            shot(f"{BASE}/pages/frame.html?{urllib.parse.urlencode(q)}", out, 1280, 720)
            if i in NAMED:
                (ASSETS / NAMED[i]).write_bytes(out.read_bytes())
        make_video()
    finally:
        if proc:
            proc.terminate()


def make_video(hold=3.0, fade=0.5):
    frames = sorted(FRAMES.glob("*.png"))
    inputs, chain = [], []
    for f in frames:
        inputs += ["-loop", "1", "-t", str(hold + fade), "-i", str(f)]
    prev = "0:v"
    for i in range(1, len(frames)):
        tag = f"x{i}"
        chain.append(f"[{prev}][{i}:v]xfade=transition=fade:duration={fade}:offset={i * hold}[{tag}]")
        prev = tag
    graph = ";".join(chain) + f";[{prev}]format=yuv420p[v]"
    mp4 = ASSETS / "demo.mp4"
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", *inputs, "-filter_complex", graph,
                    "-map", "[v]", "-r", "30", "-c:v", "libx264", "-crf", "23",
                    "-movflags", "+faststart", str(mp4)], check=True)
    gif = ASSETS / "demo.gif"
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(mp4), "-filter_complex",
                    "fps=10,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer:bayer_scale=4",
                    str(gif)], check=True)
    print("wrote", mp4.name, gif.name)


if __name__ == "__main__":
    main()
