export interface ThumbnailResult {
  thumbnail: string | null;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
}

/**
 * Capture a centered-square JPEG thumbnail from a local File or a URL (e.g. presigned R2).
 * Also returns duration_ms extracted from the video element.
 * Returns null values if the browser cannot decode the video (e.g. HEVC without codec).
 * Sets crossOrigin="anonymous" so it works with CORS-enabled R2 presigned URLs.
 */
export async function generateThumbnail(source: File | string): Promise<ThumbnailResult> {
  return new Promise((resolve) => {
    const isFile = source instanceof File;
    const url = isFile ? URL.createObjectURL(source) : source;
    const video = document.createElement("video");
    let done = false;

    function finish(thumbnail: string | null, duration_ms: number | null, width: number | null = null, height: number | null = null) {
      if (done) return;
      done = true;
      if (isFile) URL.revokeObjectURL(url);
      resolve({ thumbnail, duration_ms, width, height });
    }

    const timer = setTimeout(() => finish(null, null), 6000);

    video.addEventListener("loadedmetadata", () => {
      // Seek slightly in so we don't get a black first frame
      video.currentTime = Math.min(1.5, video.duration * 0.08 || 1.5);
    });

    video.addEventListener("seeked", () => {
      try {
        const vw = video.videoWidth;
        const vh = video.videoHeight;
        if (!vw || !vh) { clearTimeout(timer); finish(null, null); return; }

        const canvas = document.createElement("canvas");
        const SIZE = 160;
        canvas.width = SIZE;
        canvas.height = SIZE;
        const ctx = canvas.getContext("2d");
        if (!ctx) { clearTimeout(timer); finish(null, null); return; }

        // Center-crop to square
        const side = Math.min(vw, vh);
        const sx = (vw - side) / 2;
        const sy = (vh - side) / 2;
        ctx.drawImage(video, sx, sy, side, side, 0, 0, SIZE, SIZE);

        const duration_ms =
          video.duration && isFinite(video.duration)
            ? Math.round(video.duration * 1000)
            : null;

        clearTimeout(timer);
        finish(canvas.toDataURL("image/jpeg", 0.65), duration_ms, vw, vh);
      } catch {
        clearTimeout(timer);
        finish(null, null);
      }
    });

    video.addEventListener("error", () => {
      const err = video.error;
      // MediaError codes: 1=ABORTED, 2=NETWORK, 3=DECODE, 4=SRC_NOT_SUPPORTED (codec missing)
      console.error("[thumbnail] video error", {
        code: err?.code,
        message: err?.message,
        src: typeof source === "string" ? source.substring(0, 80) + "..." : "File",
        meaning: err?.code === 4 ? "codec not supported (likely HEVC/H.265)" :
                 err?.code === 2 ? "network error (check CORS / presigned URL)" :
                 err?.code === 3 ? "decode error" : "unknown",
      });
      clearTimeout(timer);
      finish(null, null);
    });

    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";
    video.crossOrigin = "anonymous"; // required for R2 presigned URLs with CORS
    video.src = url;
  });
}
