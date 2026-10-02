/** Internal: the media type rule the validator enforces, shared so adapters never produce an event it rejects. */
export const MEDIA_TYPE = /^[\w.+-]{1,64}\/[\w.+-]{1,128}$/;

/** `Text/Plain; charset=utf-8` → `text/plain`; undefined when the essence is not a valid media type. */
export function mediaTypeEssence(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const essence = value.split(';', 1)[0].trim().toLowerCase();
  return MEDIA_TYPE.test(essence) ? essence : undefined;
}
