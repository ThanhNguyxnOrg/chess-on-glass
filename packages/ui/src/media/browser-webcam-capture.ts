import type { WebcamCapture } from "./webcam-uploader.js";

const MAX_CAPTURE_WIDTH = 1280;
const JPEG_QUALITY = 0.85;

/**
 * Browser DOM implementation of WebcamCapture using getUserMedia + offscreen
 * canvas JPEG encoding. Works with built-in webcams, USB cameras and UVC
 * smart-glasses cameras exposed to the browser.
 */
export function createBrowserWebcamCapture(): WebcamCapture {
  let stream: MediaStream | null = null;
  let video: HTMLVideoElement | null = null;
  let canvas: HTMLCanvasElement | null = null;

  return {
    async start(deviceId: string | null): Promise<void> {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Camera access is not available in this browser");
      }
      const constraints: MediaStreamConstraints = {
        audio: false,
        video:
          deviceId !== null && deviceId !== ""
            ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
            : { width: { ideal: 1280 }, height: { ideal: 720 } }
      };
      stream = await navigator.mediaDevices.getUserMedia(constraints);
      video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      await video.play();
      canvas = document.createElement("canvas");
    },

    stop(): void {
      if (stream !== null) {
        for (const track of stream.getTracks()) {
          track.stop();
        }
        stream = null;
      }
      if (video !== null) {
        video.srcObject = null;
        video = null;
      }
      canvas = null;
    },

    async grab(): Promise<Blob | null> {
      if (video === null || canvas === null) {
        return null;
      }
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (vw <= 0 || vh <= 0) {
        return null;
      }
      const scale = vw > MAX_CAPTURE_WIDTH ? MAX_CAPTURE_WIDTH / vw : 1;
      const width = Math.max(1, Math.round(vw * scale));
      const height = Math.max(1, Math.round(vh * scale));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      const ctx = canvas.getContext("2d");
      if (ctx === null) {
        return null;
      }
      ctx.drawImage(video, 0, 0, width, height);
      return new Promise<Blob | null>((resolve) => {
        canvas!.toBlob((blob) => resolve(blob), "image/jpeg", JPEG_QUALITY);
      });
    }
  };
}
