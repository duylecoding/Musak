import React, { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { drawWaveformCanvas } from '../utils';
import styles from './LaneWaveform.module.css';

export interface LaneWaveformProps {
  peaks: number[];
  colorVar: string;
  opacity?: number;
  muted?: boolean;
  beats?: number[];
  duration: number;
  processingOverlay?: boolean;
}

export const LaneWaveform: React.FC<LaneWaveformProps> = ({
  peaks,
  colorVar,
  opacity = 0.9,
  muted = false,
  beats,
  duration,
  processingOverlay = false,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const updateSize = () => {
      const rect = el.getBoundingClientRect();
      const width = Math.max(0, Math.floor(rect.width));
      const height = Math.max(0, Math.floor(rect.height));
      setSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container || size.width <= 0 || size.height <= 0) return;
    drawWaveformCanvas(canvas, container, {
      peaks,
      colorVar,
      opacity,
      muted,
      beats,
      duration,
      width: size.width,
      height: size.height,
    });
  }, [peaks, colorVar, opacity, muted, beats, duration, size]);

  return (
    <div ref={containerRef} className={styles.container}>
      <canvas ref={canvasRef} className={styles.canvas} />
      {processingOverlay && (
        <div className={styles.overlay}>
          <span className={styles.badge}>
            <Loader2 className={styles.spinner} />
            Auto-splitting stems...
          </span>
        </div>
      )}
    </div>
  );
};
