// Host-side validation of AIDocs against the shared contract (schema/document.schema.v1.json).
// Rule 4 (AGENTS.md): the schema is the contract; reader and writer validate the SAME file.
// The schema JSON is bundled into the extension by esbuild, so no runtime file read is needed.

import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import schema from "../../schema/document.schema.v1.json";
import type { PaperDoc } from "./protocol";

let validateFn: ValidateFunction | undefined;

function getValidator(): ValidateFunction {
  if (!validateFn) {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    validateFn = ajv.compile(schema);
  }
  return validateFn;
}

export interface DocValidationResult {
  valid: boolean;
  doc?: PaperDoc;
  errors: string[];
}

/** Parse + validate raw file bytes. Returns the typed doc or a list of human-readable errors. */
export function validateDocumentBytes(bytes: Uint8Array): DocValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8").decode(bytes));
  } catch (err) {
    return { valid: false, errors: [`Not valid JSON: ${(err as Error).message}`] };
  }
  const validate = getValidator();
  if (validate(parsed)) {
    return { valid: true, doc: parsed as PaperDoc, errors: [] };
  }
  const errors = (validate.errors ?? []).map((e) => {
    const where = e.instancePath || "(root)";
    return `${where} ${e.message ?? "is invalid"}`.trim();
  });
  return { valid: false, errors: errors.length ? errors : ["Schema validation failed."] };
}
