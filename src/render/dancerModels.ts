/** The VRM avatars the attract dancer can use, shared by settings, the Options UI,
 *  and the renderer. All live in public/models/ (see public/models/README.md for
 *  licensing — the Miku models are non-commercial Piapro; the AvatarSample_* are the
 *  redistributable VRoid CC0 samples). */
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

export function dancerModelUrl(id: string): string {
  return (DANCER_MODELS.find((m) => m.id === id) ?? DANCER_MODELS[0]).url;
}

export function dancerModelLabel(id: string): string {
  return (DANCER_MODELS.find((m) => m.id === id) ?? DANCER_MODELS[0]).label;
}
