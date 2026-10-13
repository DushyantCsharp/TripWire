import { err, ok, type Result } from '@tripwire/result';
import { z } from 'zod';

// The demo's flagd configuration (src/flagd/demo.flagd.json), edited one flag at a time. Most
// flags switch on through defaultVariant. productCatalogFailure is targeted: it fails only for one
// product, so it switches on by making that product's branch of the rule return the variant.

const flagSchema = z.looseObject({
  defaultVariant: z.string(),
  variants: z.record(z.string(), z.unknown()),
  targeting: z.unknown().optional(),
});

export const flagdConfigSchema = z.looseObject({
  flags: z.record(z.string(), flagSchema),
});

export type FlagdConfig = z.output<typeof flagdConfigSchema>;

/** Flags whose targeting rule, not their default, decides when they fire. */
const TARGETED = new Set(['productCatalogFailure']);

const targetedRule = z.object({ if: z.tuple([z.unknown(), z.string(), z.string()]) });

export type FlagError = {
  readonly kind: 'unknown_flag' | 'unknown_variant' | 'unexpected_rule';
  readonly message: string;
};

/** The configuration with `flag` set to `variant` ('off' switches it off). */
export function setFlag(
  config: FlagdConfig,
  flag: string,
  variant: string,
): Result<FlagdConfig, FlagError> {
  const current = config.flags[flag];
  if (!current) return err({ kind: 'unknown_flag', message: `flagd has no flag ${flag}` });
  if (!(variant in current.variants)) {
    return err({ kind: 'unknown_variant', message: `${flag} has no variant ${variant}` });
  }
  let updated: z.output<typeof flagSchema>;
  if (TARGETED.has(flag)) {
    const rule = targetedRule.safeParse(current.targeting);
    if (!rule.success) {
      return err({
        kind: 'unexpected_rule',
        message: `${flag}'s targeting isn't the expected if/then/else`,
      });
    }
    const [condition, , otherwise] = rule.data.if;
    updated = { ...current, targeting: { if: [condition, variant, otherwise] } };
  } else {
    updated = { ...current, defaultVariant: variant };
  }
  return ok({ ...config, flags: { ...config.flags, [flag]: updated } });
}

/** Which variant a flag is serving: for a targeted flag, the targeted branch's. */
export function flagState(config: FlagdConfig, flag: string): string | undefined {
  const current = config.flags[flag];
  if (!current) return undefined;
  if (TARGETED.has(flag)) return targetedRule.safeParse(current.targeting).data?.if[1];
  return current.defaultVariant;
}

/** The flags that aren't off: a capture starts only from a demo with every fault off. */
export function flagsOn(config: FlagdConfig): string[] {
  return Object.keys(config.flags)
    .filter((flag) => {
      const state = flagState(config, flag);
      return state !== undefined && state !== 'off';
    })
    .sort();
}
