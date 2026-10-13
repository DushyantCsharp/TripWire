import { toPublicId } from '@tripwire/contracts/ids';
import {
  typeDefs,
  type DeadLetteredTriageJob,
  type Resolvers,
} from '@tripwire/contracts/graphql/server';
import type { components } from '@tripwire/contracts/openapi';
import Fastify, {
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from 'fastify';
import { GraphQLError } from 'graphql';
import { createSchema, createYoga } from 'graphql-yoga';
import type { DeadLetter, DeadLetters } from './dead-letters.js';
import type { IngestDeps } from './ingest/ports.js';
import { webhookRoutes } from './ingest/routes.js';

interface ServerContext {
  req: FastifyRequest;
  reply: FastifyReply;
}

export interface ServerDeps {
  readonly ingest: IngestDeps;
  readonly deadLetters: DeadLetters;
}

const MAX_DEAD_LETTERS = 100;

export async function buildServer(deps: ServerDeps, options: FastifyServerOptions = {}) {
  const app = Fastify(options);

  await app.register(
    (v1, _opts, done) => {
      v1.get('/healthz', (_request, reply) =>
        reply.send({ status: 'ok' } satisfies components['schemas']['Health']),
      );
      done();
    },
    { prefix: '/v1' },
  );
  await app.register(webhookRoutes(deps.ingest), { prefix: '/v1/webhooks' });

  const yoga = createYoga<ServerContext>({
    schema: createSchema<ServerContext>({ typeDefs, resolvers: resolvers(deps) }),
    logging: app.log,
  });

  app.route({
    url: yoga.graphqlEndpoint,
    method: ['GET', 'POST', 'OPTIONS'],
    handler: (req, reply) => yoga.handleNodeRequestAndResponse(req, reply, { req, reply }),
  });

  return app;
}

function resolvers({ deadLetters }: ServerDeps): Resolvers<ServerContext> {
  return {
    Query: {
      ping: () => 'pong',
      deadLetteredTriageJobs: async (_parent, { first }, { req }) => {
        const listed = await deadLetters.list(Math.min(Math.max(first, 1), MAX_DEAD_LETTERS));
        if (!listed.ok) throw unavailable(req, listed.error.message);
        return listed.value.map(toDeadLetteredTriageJob);
      },
    },
    Mutation: {
      // Redrive is only ever a person's decision: nothing in the system calls this on its own.
      redriveTriageJob: async (_parent, { input }, { req }) => {
        const redriven = await deadLetters.redrive(input.id);
        if (redriven.ok) {
          req.log.info(
            { deadLetterId: input.id, jobId: redriven.value.jobId },
            'redrove triage job',
          );
          return {
            __typename: 'TriageJobRedriven',
            jobId: redriven.value.jobId,
            incidentId: toPublicId('inc', redriven.value.incidentId),
          };
        }
        if (redriven.error.kind === 'not_found') {
          return {
            __typename: 'RedriveError',
            code: 'DEAD_LETTER_NOT_FOUND',
            message: `No dead-lettered triage job '${input.id}'. It may already have been redriven.`,
          };
        }
        throw unavailable(req, redriven.error.message);
      },
    },
    RedriveTriageJobResult: {
      __resolveType: (result) => ('code' in result ? 'RedriveError' : 'TriageJobRedriven'),
    },
  };
}

function toDeadLetteredTriageJob(entry: DeadLetter): DeadLetteredTriageJob {
  return {
    id: entry.id,
    incidentId: toPublicId('inc', entry.job.incidentId),
    errorClass: entry.errorClass,
    failedReason: entry.failedReason,
    lastStack: entry.lastStack,
    attempts: entry.attempts,
    failedAt: entry.failedAt,
  };
}

function unavailable(req: FastifyRequest, cause: string) {
  req.log.error({ cause }, 'dead-letter queue unavailable');
  return new GraphQLError('The dead-letter queue is unavailable; try again shortly.', {
    extensions: { code: 'SERVICE_UNAVAILABLE' },
  });
}
