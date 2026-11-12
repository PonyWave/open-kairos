import { useEffect, useRef, useState } from 'react';
import { AppDialog } from './app-dialog.js';
import { avatarCrop } from './settings-requests.js';

export function AvatarEditor({
  file,
  onApply,
  onClose,
}: {
  file: File;
  onApply: (bytes: Uint8Array) => void;
  onClose: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [image, setImage] = useState<ImageBitmap | null>(null);
  const [zoom, setZoom] = useState(1);
  const [horizontal, setHorizontal] = useState(0.5);
  const [vertical, setVertical] = useState(0.5);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    let bitmap: ImageBitmap | undefined;
    if (!['image/png', 'image/jpeg'].includes(file.type) || file.size > 5 * 1024 * 1024) {
      setError('请选择不超过 5 MiB 的 PNG 或 JPEG 图片。');
      return;
    }
    void createImageBitmap(file)
      .then((result) => {
        bitmap = result;
        if (!active) {
          result.close();
          return;
        }
        if (result.width * result.height > 16_000_000) {
          result.close();
          setError('图片不能超过 1600 万像素。');
          return;
        }
        setImage(result);
      })
      .catch(() => {
        if (active) setError('图片无法读取，请选择其他 PNG 或 JPEG 图片。');
      });
    return () => {
      active = false;
      bitmap?.close();
    };
  }, [file]);
  useEffect(() => {
    const context = canvas.current?.getContext('2d');
    if (!context || !image) return;
    const crop = avatarCrop(image.width, image.height, zoom, horizontal, vertical);
    context.clearRect(0, 0, 256, 256);
    context.drawImage(image, crop.x, crop.y, crop.side, crop.side, 0, 0, 256, 256);
  }, [image, zoom, horizontal, vertical]);
  async function apply() {
    if (!canvas.current || !image) return;
    setBusy(true);
    try {
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.current?.toBlob(
          (result) => (result ? resolve(result) : reject(new Error('头像生成失败。'))),
          'image/png',
        ),
      );
      if (blob.size > 256 * 1024) throw new Error('裁剪后的头像超过 256 KiB，请选择其他图片。');
      onApply(new Uint8Array(await blob.arrayBuffer()));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '头像生成失败。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <AppDialog
      title="调整头像"
      subtitle="调整图片位置与缩放，确认后仍需保存账户资料。"
      onClose={onClose}
      closeDisabled={busy}
      actions={
        <>
          <button type="button" className="device-secondary" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            type="button"
            className="device-primary"
            disabled={!image || busy || error !== null}
            onClick={() => void apply()}
          >
            使用此头像
          </button>
        </>
      }
    >
      {error && (
        <p role="alert" className="settings-error">
          {error}
        </p>
      )}
      <canvas
        ref={canvas}
        width={256}
        height={256}
        className="avatar-crop"
        aria-label="头像裁剪预览"
      />
      <label className="settings-range">
        缩放
        <input
          type="range"
          min="1"
          max="3"
          step="0.05"
          value={zoom}
          onChange={(event) => setZoom(Number(event.target.value))}
        />
      </label>
      <label className="settings-range">
        水平位置
        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={horizontal}
          onChange={(event) => setHorizontal(Number(event.target.value))}
        />
      </label>
      <label className="settings-range">
        垂直位置
        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={vertical}
          onChange={(event) => setVertical(Number(event.target.value))}
        />
      </label>
    </AppDialog>
  );
}
