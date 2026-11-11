import type { LengthUnit, SizeName } from '../../core/stores/sheetStore';

/** Page sizes and lengths. PDF works in points (1/72 inch); the sheets show inches or millimetres too. */

export const PT_PER_IN = 72;
export const PT_PER_MM = 72 / 25.4;

export const SIZE_PRESETS: Record<Exclude<SizeName, 'custom'>, { width: number; height: number; label: string }> = {
  letter: { width: 612, height: 792, label: 'Letter' },
  a4: { width: 595.28, height: 841.89, label: 'A4' },
  legal: { width: 612, height: 1008, label: 'Legal' },
};

export const UNIT_LABELS: Record<LengthUnit, string> = { in: 'in', mm: 'mm', pt: 'pt' };

/** Points for one value in a unit. */
export function toPoints(value: number, unit: LengthUnit): number {
  if (unit === 'in') return value * PT_PER_IN;
  if (unit === 'mm') return value * PT_PER_MM;
  return value;
}

/** A length in points, shown in a unit, rounded to two decimals. */
export function fromPoints(points: number, unit: LengthUnit): number {
  const value = unit === 'in' ? points / PT_PER_IN : unit === 'mm' ? points / PT_PER_MM : points;
  return Math.round(value * 100) / 100;
}

/**
 * The unit a user expects from a locale: inches in the United States, Liberia and Myanmar, millimetres elsewhere.
 * Points are never a default.
 */
export function defaultUnitFor(locale: string | undefined): LengthUnit {
  const region = (locale ?? '').split(/[-_]/).pop()?.toUpperCase() ?? '';
  return region === 'US' || region === 'LR' || region === 'MM' ? 'in' : 'mm';
}

/** The page size in points for a preset, or for the custom values in their unit. */
export function sizeInPoints(
  size: SizeName,
  custom: { width: number; height: number },
  unit: LengthUnit,
): { width: number; height: number } {
  if (size === 'custom') return { width: toPoints(custom.width, unit), height: toPoints(custom.height, unit) };
  return { width: SIZE_PRESETS[size].width, height: SIZE_PRESETS[size].height };
}

/** "8.5 × 11 in" style text for a size in points. */
export function describeSize(width: number, height: number, unit: LengthUnit): string {
  return `${fromPoints(width, unit)} × ${fromPoints(height, unit)} ${UNIT_LABELS[unit]}`;
}
