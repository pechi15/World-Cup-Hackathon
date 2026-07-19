/** Probability helpers shared by theo providers. */

export function logit(p: number): number {
  const clipped = Math.min(1 - 1e-9, Math.max(1e-9, p));
  return Math.log(clipped / (1 - clipped));
}

export function invLogit(x: number): number {
  if (x >= 0) {
    const z = Math.exp(-x);
    return 1 / (1 + z);
  }
  const z = Math.exp(x);
  return z / (1 + z);
}

export function softmax(logits: number[]): number[] {
  const max = Math.max(...logits);
  const exps = logits.map((v) => Math.exp(v - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((v) => v / sum);
}

export function proportionalDevig(
  implied: number[],
  semantics: "RAW_BOOK_IMPLIED" | "ALREADY_DEMARGINED",
): number[] {
  if (semantics === "ALREADY_DEMARGINED") {
    throw new Error("DOUBLE_DEVIG_FORBIDDEN: already de-margined probabilities must not be de-vigged");
  }
  const sum = implied.reduce((a, b) => a + b, 0);
  if (sum <= 0) return implied.map(() => 0);
  return implied.map((p) => p / sum);
}

export function cleanDemarginedProbabilities(probabilities: number[], tolerance = 0.02): number[] {
  if (probabilities.length === 0 || probabilities.some((p) => !Number.isFinite(p) || p < 0 || p > 1)) {
    throw new Error("INVALID_DEMARGINED_PROBABILITIES");
  }
  const mass = probabilities.reduce((sum, probability) => sum + probability, 0);
  if (Math.abs(mass - 1) > tolerance) {
    throw new Error(`INVALID_DEMARGINED_PROBABILITY_MASS:${mass}`);
  }
  return probabilities.map((probability) => probability / mass);
}

export function overround(implied: number[]): number {
  return implied.reduce((a, b) => a + b, 0) - 1;
}

export function decimalToImplied(odds: number): number {
  if (!Number.isFinite(odds) || odds <= 1) return 0;
  return 1 / odds;
}
