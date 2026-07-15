/**
 * three.js dancer proving ground (`?vrm`) — a thin wrapper around ThreeVrmDancer
 * (src/render/threeDancer.ts), the same class the in-game attract dancer uses.
 * `?model=` picks the avatar: miku4 (default), a|b|c (VRoid samples), ps1.
 */
import { useEffect, useRef } from 'react';
import { ThreeVrmDancer } from '../render/threeDancer';

const MODELS: Record<string, string> = {
  miku4: '/models/Miku4.vrm',
  a: '/models/AvatarSample_A.vrm',
  b: '/models/AvatarSample_B.vrm',
  c: '/models/AvatarSample_C.vrm',
  ps1: '/models/PS1Miku.vrm',
};

export function VrmTest({ onExit }: { onExit: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const key = new URLSearchParams(location.search).get('model')?.toLowerCase() ?? 'miku4';
    const modelUrl = MODELS[key] ?? MODELS.miku4;

    let raf = 0;
    let dancer: ThreeVrmDancer | null = null;
    let lastT = performance.now();
    const t0 = performance.now();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onExit();
    };
    window.addEventListener('keydown', onKey);

    const d = new ThreeVrmDancer({ modelUrl, canvas });
    dancer = d;
    void d.init().then(() => {
      const loop = () => {
        raf = requestAnimationFrame(loop);
        const now = performance.now();
        const dt = Math.min((now - lastT) / 1000, 1 / 30);
        lastT = now;
        const beat = (((now - t0) / 1000) * 128) / 60;
        d.build((now - t0) / 1000, beat, dt);
        d.render();
      };
      loop();
    });

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKey);
      dancer?.dispose();
    };
  }, [onExit]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: '100vw', height: '100vh', display: 'block', background: '#14162a' }}
    />
  );
}
