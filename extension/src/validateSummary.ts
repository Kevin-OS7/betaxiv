// Host-side validation against the shared contract (schema/summary.schema.v1.json).
// Rule 4 (AGENTS.md): the schema is the contract; reader and writer validate the SAME file.
// The schema JSON is bundled into the extension by esbuild, so no runtime file read is needed.

// The schema declares JSON Schema draft 2020-12, so use Ajv's 2020 build (the default
// `ajv` export only understands draft-07 and throws on the 2020-12 meta-schema).
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import schema from "../../schema/summary.schema.v1.json";
import type { PaperSummary } from "./protocol";

let validateFn: ValidateFunction | undefined;

function getValidator(): ValidateFunction {
  if (!validateFn) {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    // Enables real validation of `format` keywords (e.g. generatedBy.timestamp date-time);
    // without this Ajv silently ignores unknown formats and accepts bad timestamps.
    addFormats(ajv);
    validateFn = ajv.compile(schema);
  }
  return validateFn;
}

export interface ValidationResult {
  valid: boolean;
  summary?: PaperSummary;
  errors: string[];
}

/** Parse + validate raw file bytes. Returns the typed summary or a list of human-readable errors. */
export function validateSummaryBytes(bytes: Uint8Array): ValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8").decode(bytes));
  } catch (err) {
    return { valid: false, errors: [`Not valid JSON: ${(err as Error).message}`] };
  }
  const validate = getValidator();
  if (validate(parsed)) {
    return { valid: true, summary: parsed as PaperSummary, errors: [] };
  }
  const errors = (validate.errors ?? []).map((e) => {
    const where = e.instancePath || "(root)";
    return `${where} ${e.message ?? "is invalid"}`.trim();
  });
  return { valid: false, errors: errors.length ? errors : ["Schema validation failed."] };
}
