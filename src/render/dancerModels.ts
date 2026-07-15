/** The VRM avatars the attract dancer can use, shared by settings, the Options UI,
 *  and the renderer. All live in public/models/ (see public/models/README.md and
 *  MODELS_LICENSE.md for licensing — `miku` is a license-compliant edited Tda Miku
 *  V4X derivative (non-commercial Piapro); `ps1` is our own original; the
 *  AvatarSample_* are redistributable VRoid CC0 samples). */
export interface DancerModelDef {
  id: string;
  label: string;
  url: string;
}

export const DANCER_MODELS: readonly DancerModelDef[] = [
  { id: 'miku', label: 'MIKU', url: '/models/Miku4.vrm' },
  { id: 'ps1', label: 'PS1 MIKU', url: '/models/PS1Miku.vrm' },
  { id: 'suit', label: 'SUIT', url: '/models/AvatarSample_A.vrm' },
  { id: 'goth', label: 'GOTH', url: '/models/AvatarSample_B.vrm' },
  { id: 'coat', label: 'COAT', url: '/models/AvatarSample_C.vrm' },
];

export const DANCER_MODEL_IDS: readonly string[] = DANCER_MODELS.map((m) => m.id);

/** The shipped default. Miku4.vrm now ships as a compliant, optimized (~5.6 MB)
 *  edited Tda Miku V4X derivative, so it's the out-of-the-box dancer. NOTE: it
 *  carries non-commercial Piapro terms (see MODELS_LICENSE.md); if this project
 *  ever goes commercial, switch this back to 'ps1' (free) and drop Miku4.vrm. */
export const DEFAULT_DANCER_MODEL = 'miku';

export function dancerModelUrl(id: string): string {
  return (DANCER_MODELS.find((m) => m.id === id) ?? DANCER_MODELS[0]).url;
}

export function dancerModelLabel(id: string): string {
  return (DANCER_MODELS.find((m) => m.id === id) ?? DANCER_MODELS[0]).label;
}
