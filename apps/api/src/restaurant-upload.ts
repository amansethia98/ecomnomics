import { createHmac, timingSafeEqual } from "node:crypto";

export const UPLOAD_TTL_MS = 15 * 60 * 1000;
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export interface UploadSignatureInput {
  restaurantId: string;
  kind: string;
  parentId: string;
  fileName: string;
  contentType: string;
  exp: number;
}

export function uploadSignature(secret: string, input: UploadSignatureInput): string {
  const payload = [
    input.restaurantId,
    input.kind,
    input.parentId,
    input.fileName,
    input.contentType,
    String(input.exp),
  ].join("\n");
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function uploadSignatureMatches(
  secret: string,
  input: UploadSignatureInput,
  signature: string,
): boolean {
  const expected = Buffer.from(uploadSignature(secret, input));
  const received = Buffer.from(signature);
  if (expected.length !== received.length) return false;
  return timingSafeEqual(expected, received);
}
