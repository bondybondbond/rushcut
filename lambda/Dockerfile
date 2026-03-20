FROM public.ecr.aws/lambda/python:3.12

# Install curl + xz (needed to download/unpack FFmpeg static build)
RUN dnf install -y xz tar && dnf clean all

# Install FFmpeg 6.x static ARM64 from johnvansickle.com
RUN mkdir -p /tmp/ffmpeg && \
    curl -fsSL https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-arm64-static.tar.xz \
    | tar xJ --strip-components=1 -C /tmp/ffmpeg && \
    mv /tmp/ffmpeg/ffmpeg /tmp/ffmpeg/ffprobe /usr/local/bin/ && \
    chmod +x /usr/local/bin/ffmpeg /usr/local/bin/ffprobe && \
    rm -rf /tmp/ffmpeg

# Verify FFmpeg installed (johnvansickle releases/ now serves 7.x; 6.x and 7.x both confirmed compatible)
RUN ffmpeg -version 2>&1 | grep -E "^ffmpeg version [67]\." \
    || { echo "[ERROR] Unexpected FFmpeg version — got:"; ffmpeg -version 2>&1 | head -1; exit 1; }

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY handler.py .
COPY pipeline/ pipeline/
COPY music/ music/

CMD ["handler.lambda_handler"]
