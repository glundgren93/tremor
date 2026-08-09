# Versioned CLI schemas

`cli-envelope-v1.schema.json` (ID `https://github.com/glundgren93/tremor/schemas/cli-envelope-v1.schema.json`) is a JSON Schema draft 2020-12 contract for stdout digests, persisted/`--full` success envelopes, and error envelopes.

Version 1 may gain optional fields and enum-free extension data. Stable required fields, types, and documented enums do not change incompatibly. A breaking change requires a new `schemaVersion` and a new versioned schema file. Object boundaries generally allow additional properties so older consumers can ignore additive facts. Schemas contain no captured response bodies, credentials, or secret examples.
