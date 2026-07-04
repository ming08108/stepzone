/**
 * StepsType -> column count. The column count is the number of characters per
 * grid row. See spec doc 5 (§5.4). From ITGmania `g_StepsTypeInfos`.
 */

export type StepsCategory = 'Single' | 'Double' | 'Couple' | 'Routine';

export interface StepsTypeInfo {
  numTracks: number;
  category: StepsCategory;
}

export const STEPS_TYPES: Readonly<Record<string, StepsTypeInfo>> = {
  'dance-single': { numTracks: 4, category: 'Single' },
  'dance-double': { numTracks: 8, category: 'Double' },
  'dance-couple': { numTracks: 8, category: 'Couple' },
  'dance-solo': { numTracks: 6, category: 'Single' },
  'dance-threepanel': { numTracks: 3, category: 'Single' },
  'dance-routine': { numTracks: 8, category: 'Routine' },
  'pump-single': { numTracks: 5, category: 'Single' },
  'pump-halfdouble': { numTracks: 6, category: 'Double' },
  'pump-double': { numTracks: 10, category: 'Double' },
  'pump-couple': { numTracks: 10, category: 'Couple' },
  'pump-routine': { numTracks: 10, category: 'Routine' },
  'techno-single4': { numTracks: 4, category: 'Single' },
  'techno-single5': { numTracks: 5, category: 'Single' },
  'techno-single8': { numTracks: 8, category: 'Single' },
  'techno-double4': { numTracks: 8, category: 'Double' },
  'techno-double5': { numTracks: 10, category: 'Double' },
  'techno-double8': { numTracks: 16, category: 'Double' },
};

/** Number of note tracks for a steps-type name, or -1 if unknown. */
export function stepsTypeNumTracks(name: string): number {
  return STEPS_TYPES[name]?.numTracks ?? -1;
}
