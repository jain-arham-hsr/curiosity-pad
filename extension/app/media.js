// Compression happens at capture time, so storage stays small everywhere.

const MAX_SIDE = 1600;

// Downscale to at most 1600px on the long side and re-encode as WebP.
// Keeps the original if that is already smaller, and never touches GIFs.
export async function compressImage(file) {
  if (file.type === 'image/gif') return file;
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const out = await canvas.convertToBlob({ type: 'image/webp', quality: 0.82 });
  return out.size < file.size ? out : file;
}

// Voice notes as Opus at 24 kbps: clear speech at about 0.2 MB a minute.
export class Recorder {
  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4']
      .find((t) => MediaRecorder.isTypeSupported(t));
    this.recorder = new MediaRecorder(this.stream, { mimeType, audioBitsPerSecond: 24000 });
    this.chunks = [];
    this.recorder.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data); };
    this.startedAt = performance.now();
    this.recorder.start();
  }

  elapsed() {
    return (performance.now() - this.startedAt) / 1000;
  }

  stop() {
    const duration = this.elapsed();
    return new Promise((resolve) => {
      this.recorder.onstop = () => {
        this.release();
        resolve({ blob: new Blob(this.chunks, { type: this.recorder.mimeType }), duration });
      };
      this.recorder.stop();
    });
  }

  cancel() {
    this.recorder.onstop = null;
    if (this.recorder.state !== 'inactive') this.recorder.stop();
    this.release();
  }

  release() {
    this.stream?.getTracks().forEach((t) => t.stop());
  }
}
