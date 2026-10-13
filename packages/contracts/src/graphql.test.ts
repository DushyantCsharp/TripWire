import { describe, it } from '@jest/globals';
import { expectTypeOf } from 'expect-type';
import type { ApproveActionMutationVariables } from './graphql.js';
import type {
  ActionDecisionResult,
  ApproveActionInput,
  RejectActionInput,
} from './graphql-server.js';

// Type-level checks, enforced by `tsc` (typecheck) rather than at runtime.
describe('action decision contract', () => {
  it('approval requires the reviewed payloadHash and a reason', () => {
    expectTypeOf<ApproveActionInput>().toEqualTypeOf<{
      actionId: string;
      payloadHash: string;
      reason: string;
    }>();
  });

  it('rejection requires a reason', () => {
    expectTypeOf<RejectActionInput>().toEqualTypeOf<{ actionId: string; reason: string }>();
  });

  it('the console mutation carries the same required fields', () => {
    expectTypeOf<ApproveActionMutationVariables['input']>().toExtend<ApproveActionInput>();
  });

  it('expected refusals are data, not GraphQL errors', () => {
    expectTypeOf<ActionDecisionResult['__typename']>().toEqualTypeOf<
      'ActionDecided' | 'ActionDecisionError' | undefined
    >();
  });
});
