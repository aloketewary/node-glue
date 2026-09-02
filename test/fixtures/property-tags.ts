export const FEATURE_TAG = 'Feature: node-glue-mvp';

export function propertyTag(propertyNumber: number, description?: string): string {
  if (!Number.isInteger(propertyNumber) || propertyNumber < 1 || propertyNumber > 12) {
    throw new RangeError('Property number must be between 1 and 12');
  }
  return `${FEATURE_TAG}, Property ${propertyNumber}${description === undefined ? '' : `: ${description}`}`;
}

export interface GeneratedPropertyCase<T> {
  readonly label: string;
  readonly value: T;
}

export function generatedPropertyCase<T>(propertyNumber: number, value: T, description?: string): GeneratedPropertyCase<T> {
  return { label: propertyTag(propertyNumber, description), value };
}
