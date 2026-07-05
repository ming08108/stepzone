import { useEffect, useRef } from 'react';
import { subscribeControls, type ControlEvent } from '../input/inputBus';

/**
 * Subscribe this component to the unified input bus (keyboard + gamepad
 * resolved to ControlRole press/release events — see src/input/inputBus.ts).
 * Subscribes on mount, unsubscribes on unmount; the handler is kept in a ref
 * so the latest closure always runs without re-subscribing.
 */
export function useControls(handler: (e: ControlEvent) => void): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => subscribeControls((e) => ref.current(e)), []);
}
