type PluralSuffix = 'one' | 'few' | 'many' | 'other';

type Stem<Key extends string> = Key extends `${infer Base}_${PluralSuffix}` ? Base : Key;

type Stems<Catalog> = { [Key in keyof Catalog & string as Stem<Key>]: Catalog[Key] };

type StemTree<Catalog> = { [Key in keyof Stems<Catalog> & string]: Stems<Catalog>[Key] extends object ? StemTree<Stems<Catalog>[Key]> : true };

/** Catalog keys that the reference catalog defines but the translation does not. */
export type MissingKeys<Reference, Translation> = {
  [Key in keyof StemTree<Reference> & string]:
    Key extends keyof StemTree<Translation>
      ? StemTree<Reference>[Key] extends object
        ? MissingKeys<StemTree<Reference>[Key], StemTree<Translation>[Key]>
        : never
      : Key;
}[keyof StemTree<Reference> & string];

/**
 * Compile-time check that a translation covers every key of the reference catalog.
 * Plural forms collapse onto their shared stem, so a language may carry more plural
 * forms than the reference without failing. Call it once per catalog area.
 */
export function assertCatalogCovers<Reference, Translation>(
  ..._missing: [MissingKeys<Reference, Translation>] extends [never] ? [] : [missing: MissingKeys<Reference, Translation>]
): void {}
