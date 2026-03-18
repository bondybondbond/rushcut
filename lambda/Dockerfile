FROM public.ecr.aws/lambda/python:3.12

# Install curl + xz (needed to download/unpack FFmpeg static build)
RUN dnf install -y curl xz tar && dnf clean all

# Install FFmpeg 6.x static ARM64 from johnvansickle.com
RUN mkdir -p /tmp/ffmpeg && \
    curl -fsSL https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-arm64-static.tar.xz \
    | tar xJ --strip-components=1 -C /tmp/ffmpeg && \
    mv /tmp/ffmpeg/ffmpeg /tmp/ffmpeg/ffprobe /usr/local/bin/ && \
    chmod +x /usr/local/bin/ffmpeg /usr/local/bin/ffprobe && \
    rm -rf /tmp/ffmpeg

# Fail build if we didn't get FFmpeg 6.x
RUN ffmpeg -version 2>&1 | grep -E "^ffmpeg version 6\." \
    || { echo "[ERROR] Expected FFmpeg 6.x from johnvansickle.com — got:"; ffmpeg -version 2>&1 | head -1; exit 1; }

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY handler.py .
COPY pipeline/ pipeline/
COPY music/ music/

CMD ["handler.lambda_handler"]
