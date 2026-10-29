"""Check the complete encoded release film and its downloadable GIF."""
import json
from pathlib import Path
import subprocess
import sys

from PIL import Image


def main():
    directory = Path(sys.argv[1] if len(sys.argv) > 1 else "dist/media")
    release = sys.argv[2] if len(sys.argv) > 2 else "1.1.8"
    name = "CVML-GPU-Timeline-v" + release + "-60s"
    mp4 = directory / (name + ".mp4")
    probe = json.loads(subprocess.check_output([
        "ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(mp4)
    ]))
    videos = [stream for stream in probe["streams"] if stream["codec_type"] == "video"]
    assert len(videos) == 1
    video = videos[0]
    assert video["codec_name"] == "h264"
    assert (video["width"], video["height"]) == (1280, 720)
    assert abs(float(probe["format"]["duration"]) - 60) < 0.05
    assert not any(stream["codec_type"] == "audio" for stream in probe["streams"])
    subprocess.run(["ffmpeg", "-v", "error", "-i", str(mp4), "-f", "null", "-"], check=True)
    with Image.open(directory / (name + ".gif")) as gif:
        assert gif.size == (960, 540)
        milliseconds = 0
        for frame in range(gif.n_frames):
            gif.seek(frame)
            milliseconds += gif.info.get("duration", 0)
        assert abs(milliseconds - 60000) <= 100
    with Image.open(directory / ("poster-v" + release + ".jpg")) as poster:
        assert poster.size == (1280, 720)
    print("Promo verified: H.264 1280x720, 60 seconds; GIF 960x540, 60 seconds; complete decode passed.")


if __name__ == "__main__":
    main()
