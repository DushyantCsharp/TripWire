// Generated from packages/contracts/schema by `pnpm generate`. Do not edit.

export interface paths {
  '/v1/healthz': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Liveness probe
     * @description Returns 200 while the API process is up. Does not check dependencies.
     */
    get: operations['getHealth'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/webhooks/alertmanager': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Ingest an Alertmanager notification
     * @description Accepts the Alertmanager webhook payload (version 4) as Alertmanager sends it. Alertmanager
     *     cannot sign requests, so it posts through a signing relay that adds `X-Tripwire-Signature`
     *     and `Idempotency-Key`.
     *
     *     Checks run in this order, cheapest first: load shedding (503), size and media type
     *     (413, 415), signature (401), body validation (400), idempotency (202 replay or 409), enqueue (202).
     */
    post: operations['ingestAlertmanagerWebhook'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/webhooks/generic': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Ingest alerts in Tripwire's generic format
     * @description For senders other than Alertmanager. Accepts a batch of 1–1000 alerts.
     *
     *     Checks run in this order, cheapest first: load shedding (503), size and media type
     *     (413, 415), signature (401), body validation (400), idempotency (202 replay or 409), enqueue (202).
     */
    post: operations['ingestGenericWebhook'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/incidents': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * List incidents, most recently active first
     * @description Cursor-paginated, ordered by `last_seen_at` descending, then `id`. Pass `next_cursor` from
     *     one page as `cursor` to get the next; `next_cursor` is null on the last page.
     */
    get: operations['listIncidents'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
}
export type webhooks = Record<string, never>;
export interface components {
  schemas: {
    Health: {
      /** @constant */
      status: 'ok';
    };
    /** @description Opaque ingest identifier. */
    IngestId: string;
    /** @description Opaque incident identifier, the same as the GraphQL `Incident.id`. */
    IncidentId: string;
    IngestAccepted: {
      ingest_id: components['schemas']['IngestId'];
      /** Format: date-time */
      received_at: string;
      /** @description Number of alerts accepted from the payload. */
      alert_count: number;
    };
    /** @enum {string} */
    Severity: 'critical' | 'warning' | 'info';
    LabelSet: {
      [key: string]: string;
    };
    GenericWebhook: {
      /** @description The sending system, e.g. `k6` or `datadog`. */
      source: string;
      alerts: components['schemas']['GenericAlert'][];
    };
    GenericAlert: {
      name: string;
      /** @enum {string} */
      status: 'firing' | 'resolved';
      severity: components['schemas']['Severity'];
      service?: string;
      summary?: string;
      description?: string;
      labels?: components['schemas']['LabelSet'];
      /** Format: date-time */
      starts_at: string;
      /** Format: date-time */
      ends_at?: string;
      /** @description The sender's stable id for this alert. Used as a deduplication hint. */
      external_id?: string;
      /** Format: uri */
      url?: string;
    };
    /** @description Alertmanager webhook payload, version 4. Unknown fields are accepted for forward compatibility. */
    AlertmanagerWebhook: {
      /** @constant */
      version: '4';
      groupKey: string;
      truncatedAlerts?: number;
      /** @enum {string} */
      status: 'firing' | 'resolved';
      receiver: string;
      groupLabels: components['schemas']['LabelSet'];
      commonLabels: components['schemas']['LabelSet'];
      commonAnnotations: components['schemas']['LabelSet'];
      externalURL: string;
      alerts: components['schemas']['AlertmanagerAlert'][];
    };
    AlertmanagerAlert: {
      /** @enum {string} */
      status: 'firing' | 'resolved';
      labels: components['schemas']['LabelSet'];
      annotations: components['schemas']['LabelSet'];
      /** Format: date-time */
      startsAt: string;
      /**
       * Format: date-time
       * @description `0001-01-01T00:00:00Z` while the alert is firing.
       */
      endsAt: string;
      generatorURL?: string;
      fingerprint: string;
    };
    IncidentPage: {
      data: components['schemas']['Incident'][];
      /** @description Cursor for the next page; null on the last page. */
      next_cursor: string | null;
    };
    Incident: {
      id: components['schemas']['IncidentId'];
      title: string;
      /** @enum {string} */
      status: 'open' | 'triaging' | 'triaged' | 'resolved';
      severity: components['schemas']['Severity'];
      /** @description Primary affected service, when the alerts agree on one. */
      service: string | null;
      alert_count: number;
      /** Format: date-time */
      first_seen_at: string;
      /** Format: date-time */
      last_seen_at: string;
    };
    /** @description RFC 9457 problem details. Extension members may be present. */
    Problem: {
      /**
       * Format: uri-reference
       * @description Identifies the problem type. Stable; branch on this.
       */
      type: string;
      /** @description Short human-readable summary of the problem type. */
      title: string;
      status: number;
      /** @description Human-readable explanation of this occurrence. */
      detail?: string;
      /**
       * Format: uri-reference
       * @description The request path of this occurrence.
       */
      instance?: string;
      /** @description W3C trace id of the request, for finding its logs and spans. */
      trace_id?: string;
    };
    ValidationProblem: components['schemas']['Problem'] & {
      /** @constant */
      type?: '/problems/validation-failed';
      /** @constant */
      status?: 400;
      errors: {
        /** @description JSON Pointer (RFC 6901) into the body, or `#/header/<name>` / `#/query/<name>`. */
        pointer: string;
        detail: string;
      }[];
    };
    InvalidSignatureProblem: components['schemas']['Problem'] & {
      /** @constant */
      type?: '/problems/invalid-signature';
      /** @constant */
      status?: 401;
      /** @enum {string} */
      reason: 'missing' | 'malformed' | 'expired' | 'mismatch';
    };
    UnauthorizedProblem: components['schemas']['Problem'] & {
      /** @constant */
      type?: '/problems/unauthorized';
      /** @constant */
      status?: 401;
    };
    IdempotencyConflictProblem: components['schemas']['Problem'] & {
      /** @constant */
      type?: '/problems/idempotency-key-reused';
      /** @constant */
      status?: 409;
      idempotency_key: string;
      first_ingest_id: components['schemas']['IngestId'];
      /** Format: date-time */
      first_received_at: string;
    };
    PayloadTooLargeProblem: components['schemas']['Problem'] & {
      /** @constant */
      type?: '/problems/payload-too-large';
      /** @constant */
      status?: 413;
    };
    UnsupportedMediaTypeProblem: components['schemas']['Problem'] & {
      /** @constant */
      type?: '/problems/unsupported-media-type';
      /** @constant */
      status?: 415;
    };
    OverloadedProblem: components['schemas']['Problem'] & {
      /** @constant */
      type?: '/problems/overloaded';
      /** @constant */
      status?: 503;
    };
  };
  responses: {
    /**
     * @description Verified and enqueued; clustering and triage happen asynchronously. Retrying with the same
     *     Idempotency-Key and body (including concurrently) returns this same response, with the same
     *     `ingest_id`, and adds `Idempotent-Replayed: true`.
     */
    Accepted: {
      headers: {
        /** @description Present, with value `true`, when this response replays an earlier request. */
        'Idempotent-Replayed'?: 'true';
        [name: string]: unknown;
      };
      content: {
        'application/json': components['schemas']['IngestAccepted'];
      };
    };
    /** @description The request is malformed. `errors` points at each offending field. */
    ValidationFailed: {
      headers: {
        [name: string]: unknown;
      };
      content: {
        'application/problem+json': components['schemas']['ValidationProblem'];
      };
    };
    /** @description The signature is missing, malformed, outside the 300-second window, or does not match. */
    InvalidSignature: {
      headers: {
        [name: string]: unknown;
      };
      content: {
        'application/problem+json': components['schemas']['InvalidSignatureProblem'];
      };
    };
    /** @description The bearer token is missing or invalid. */
    Unauthorized: {
      headers: {
        [name: string]: unknown;
      };
      content: {
        'application/problem+json': components['schemas']['UnauthorizedProblem'];
      };
    };
    /**
     * @description The Idempotency-Key was already used with a different body: the SHA-256 of this request's
     *     raw body differs from the first request's. Nothing was enqueued. A new payload needs a new
     *     key; retrying the original body with this key still returns the original 202.
     */
    IdempotencyConflict: {
      headers: {
        [name: string]: unknown;
      };
      content: {
        /**
         * @example {
         *       "type": "/problems/idempotency-key-reused",
         *       "title": "Idempotency key reused with a different body",
         *       "status": 409,
         *       "detail": "Key 'am-6f1c2b0e-5d1a-4c55-9a8e-2f4c3b9d7e10' was first used at 2026-10-11T18:05:48.780Z with a different body.",
         *       "instance": "/v1/webhooks/alertmanager",
         *       "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
         *       "idempotency_key": "am-6f1c2b0e-5d1a-4c55-9a8e-2f4c3b9d7e10",
         *       "first_ingest_id": "ing_01k7a3x9m2q8r4t6v0w5y7z9b1",
         *       "first_received_at": "2026-10-11T18:05:48.780Z"
         *     }
         */
        'application/problem+json': components['schemas']['IdempotencyConflictProblem'];
      };
    };
    /** @description The body exceeds 1 MiB. */
    PayloadTooLarge: {
      headers: {
        [name: string]: unknown;
      };
      content: {
        'application/problem+json': components['schemas']['PayloadTooLargeProblem'];
      };
    };
    /** @description The body is not `application/json`. */
    UnsupportedMediaType: {
      headers: {
        [name: string]: unknown;
      };
      content: {
        'application/problem+json': components['schemas']['UnsupportedMediaTypeProblem'];
      };
    };
    /**
     * @description Load shedding: the ingest queue is above its high-water mark. Nothing was enqueued and the
     *     Idempotency-Key was not recorded, so retrying the identical request (same key and body)
     *     after Retry-After is safe.
     */
    Overloaded: {
      headers: {
        'Retry-After': components['headers']['RetryAfter'];
        [name: string]: unknown;
      };
      content: {
        /**
         * @example {
         *       "type": "/problems/overloaded",
         *       "title": "Ingest is shedding load",
         *       "status": 503,
         *       "detail": "The ingest queue is above its high-water mark. Retry after the Retry-After delay.",
         *       "instance": "/v1/webhooks/generic",
         *       "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736"
         *     }
         */
        'application/problem+json': components['schemas']['OverloadedProblem'];
      };
    };
    /** @description An unexpected server error. Safe to retry with the same Idempotency-Key. */
    UnexpectedError: {
      headers: {
        [name: string]: unknown;
      };
      content: {
        'application/problem+json': components['schemas']['Problem'];
      };
    };
  };
  parameters: {
    /**
     * @description Webhook signature; see the `webhookSignature` security scheme.
     * @example t=1791741772,v1=5257a869e7ecebeda32affa62cdca3fa51cad7e77a0e56ff536d0ce8e108d8bd
     */
    Signature: string;
    /**
     * @description Unique per logical delivery; reuse it on every retry of that delivery. Keys are remembered
     *     for 24 hours. Printable ASCII, no spaces.
     * @example am-6f1c2b0e-5d1a-4c55-9a8e-2f4c3b9d7e10
     */
    IdempotencyKey: string;
    /** @description Page size. */
    Limit: number;
    /** @description The `next_cursor` of the previous page. Opaque; do not construct or parse it. */
    Cursor: string;
  };
  requestBodies: never;
  headers: {
    /** @description Seconds to wait before retrying (RFC 9110 delay-seconds). Includes jitter. */
    RetryAfter: number;
  };
  pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
  getHealth: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description The API process is up. */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Health'];
        };
      };
    };
  };
  ingestAlertmanagerWebhook: {
    parameters: {
      query?: never;
      header: {
        /**
         * @description Webhook signature; see the `webhookSignature` security scheme.
         * @example t=1791741772,v1=5257a869e7ecebeda32affa62cdca3fa51cad7e77a0e56ff536d0ce8e108d8bd
         */
        'X-Tripwire-Signature': components['parameters']['Signature'];
        /**
         * @description Unique per logical delivery; reuse it on every retry of that delivery. Keys are remembered
         *     for 24 hours. Printable ASCII, no spaces.
         * @example am-6f1c2b0e-5d1a-4c55-9a8e-2f4c3b9d7e10
         */
        'Idempotency-Key': components['parameters']['IdempotencyKey'];
      };
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['AlertmanagerWebhook'];
      };
    };
    responses: {
      202: components['responses']['Accepted'];
      400: components['responses']['ValidationFailed'];
      401: components['responses']['InvalidSignature'];
      409: components['responses']['IdempotencyConflict'];
      413: components['responses']['PayloadTooLarge'];
      415: components['responses']['UnsupportedMediaType'];
      503: components['responses']['Overloaded'];
      default: components['responses']['UnexpectedError'];
    };
  };
  ingestGenericWebhook: {
    parameters: {
      query?: never;
      header: {
        /**
         * @description Webhook signature; see the `webhookSignature` security scheme.
         * @example t=1791741772,v1=5257a869e7ecebeda32affa62cdca3fa51cad7e77a0e56ff536d0ce8e108d8bd
         */
        'X-Tripwire-Signature': components['parameters']['Signature'];
        /**
         * @description Unique per logical delivery; reuse it on every retry of that delivery. Keys are remembered
         *     for 24 hours. Printable ASCII, no spaces.
         * @example am-6f1c2b0e-5d1a-4c55-9a8e-2f4c3b9d7e10
         */
        'Idempotency-Key': components['parameters']['IdempotencyKey'];
      };
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['GenericWebhook'];
      };
    };
    responses: {
      202: components['responses']['Accepted'];
      400: components['responses']['ValidationFailed'];
      401: components['responses']['InvalidSignature'];
      409: components['responses']['IdempotencyConflict'];
      413: components['responses']['PayloadTooLarge'];
      415: components['responses']['UnsupportedMediaType'];
      503: components['responses']['Overloaded'];
      default: components['responses']['UnexpectedError'];
    };
  };
  listIncidents: {
    parameters: {
      query?: {
        /** @description Page size. */
        limit?: components['parameters']['Limit'];
        /** @description The `next_cursor` of the previous page. Opaque; do not construct or parse it. */
        cursor?: components['parameters']['Cursor'];
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description One page of incidents. */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['IncidentPage'];
        };
      };
      400: components['responses']['ValidationFailed'];
      401: components['responses']['Unauthorized'];
      default: components['responses']['UnexpectedError'];
    };
  };
}
